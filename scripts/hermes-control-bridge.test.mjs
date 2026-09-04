import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHermesControlBridgeServer } from "./hermes-control-bridge.mjs";

function call(server, token, action) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path: "/v1/control", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ action }));
  });
}

describe("Hermes control bridge", () => {
  it("requires the token and rejects non-whitelisted actions", async () => {
    const calls = [];
    const server = createHermesControlBridgeServer({ unit: "hermes-gateway.service", readToken: () => "secret", runSystemctl: async (args) => { calls.push(args); return { code: 0, stdout: "active\n", stderr: "" }; } });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      expect((await call(server, "wrong", "status")).status).toBe(401);
      expect((await call(server, "secret", "exec")).status).toBe(400);
      expect(calls).toHaveLength(0);
    } finally { server.close(); }
  });

  it("executes only the fixed restart action and returns status", async () => {
    const calls = [];
    const server = createHermesControlBridgeServer({ unit: "hermes-gateway.service", readToken: () => "secret", runSystemctl: async (args) => { calls.push(args); return { code: 0, stdout: "active\n", stderr: "" }; } });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const result = await call(server, "secret", "restart-hermes");
      expect(result.status).toBe(200);
      expect(calls).toEqual([["restart", "hermes-gateway.service"], ["is-active", "hermes-gateway.service"]]);
      expect(result.body).toEqual({ active: true, unit: "hermes-gateway.service" });
    } finally { server.close(); }
  });

  it("cleans only fixed-pattern orphan gateway processes on the host", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "butler-control-"));
    const processCalls = [];
    const systemctlCalls = [];
    writeFileSync(join(rootPath, "gateway.pid"), JSON.stringify({ pid: 101, kind: "hermes-gateway" }));
    const server = createHermesControlBridgeServer({
      unit: "hermes-gateway.service",
      rootPath,
      readToken: () => "secret",
      runSystemctl: async (args) => {
        systemctlCalls.push(args);
        return { code: 0, stdout: "active\n", stderr: "" };
      },
      runProcess: async (command, args) => {
        processCalls.push([command, args]);
        if (command === "pgrep" && args[1] === "hermes_cli.main gateway run") {
          return { code: 0, stdout: "101\n202\n", stderr: "" };
        }
        if (command === "kill" && args[0] === "202") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const result = await call(server, "secret", "cleanup-orphan-gateways");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ active: true, unit: "hermes-gateway.service", cleanedPids: [202], mainPid: 101 });
      expect(systemctlCalls).toEqual([["is-active", "hermes-gateway.service"]]);
      expect(processCalls).toEqual([
        ["pgrep", ["-f", "hermes_cli.main gateway run"]],
        ["pgrep", ["-f", "tui_gateway.entry"]],
        ["kill", ["202"]],
      ]);
    } finally {
      server.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
