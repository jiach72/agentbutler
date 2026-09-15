import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHermesControlBridgeServer } from "./hermes-control-bridge.mjs";

function call(server, token, action, endpoint = "/v1/control") {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path: endpoint, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(typeof action === "string" ? { action } : action));
  });
}

describe("Hermes control bridge", () => {
  it("rejects nested command injection, oversized payloads and foreign mutation identities", async () => {
    const calls = [];
    const server = createHermesControlBridgeServer({
      readToken: () => "secret", runCron: async (body) => {
        calls.push(body);
        return { schemaVersion: 1, supported: true, reachable: true, requestId: "other-request-0001", taskId: "abc123", outcome: "succeeded" };
      },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const draft = { name: "Task", prompt: "SECRET", schedule: { kind: "interval", everyMinutes: 30 }, delivery: { enabled: false } };
      for (const body of [
        { action: "create", requestId: "create-request-01", draft: { ...draft, script: "bad.sh" } },
        { action: "create", requestId: "create-request-01", draft: { ...draft, advanced: { args: ["--help"] } } },
        { action: "preview", schedule: { kind: "advanced", expression: "0 9 * * *; touch bad", timezone: "UTC" } },
        { action: "incidents", incidentAction: "ack" },
      ]) expect((await call(server, "secret", body, "/v1/cron")).status).toBe(400);
      expect((await call(server, "secret", { action: "list", prompt: "x".repeat(70000) }, "/v1/cron")).status).toBe(413);
      expect(calls).toHaveLength(0);
      const response = await call(server, "secret", { action: "pause", id: "abc123", requestId: "pause-request-001" }, "/v1/cron");
      expect(response.status).toBe(502);
      expect(JSON.stringify(response)).not.toContain("SECRET");
    } finally { server.close(); }
  });
  it("projects structured fields only and suppresses raw exceptions", async () => {
    let fail = false;
    const server = createHermesControlBridgeServer({
      readToken: () => "secret", runCron: async () => {
        if (fail) throw new Error("SECRET_PROMPT stderr raw");
        return { schemaVersion: 1, supported: true, reachable: true, items: [{
          id: "abc123", name: "Task", enabled: true, scheduleLabel: "every 30m", nextRunAt: null,
          lastRunAt: null, lastStatus: "never", failureStreak: 0, editable: false, deliveryEnabled: false,
          prompt: "SECRET_PROMPT", error: "SECRET_ERROR", base_url: "SECRET_URL",
        }] };
      },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const response = await call(server, "secret", "list", "/v1/cron");
      expect(response.status).toBe(200);
      expect(JSON.stringify(response)).not.toContain("SECRET");
      fail = true;
      const failure = await call(server, "secret", "list", "/v1/cron");
      expect(failure.status).toBe(502);
      expect(JSON.stringify(failure)).not.toContain("SECRET");
    } finally { server.close(); }
  });
  it("authenticates cron and rejects unknown request fields before invoking the host", async () => {
    const calls = [];
    const server = createHermesControlBridgeServer({
      readToken: () => "secret",
      runCron: async (body) => { calls.push(body); return { schemaVersion: 1, supported: true, reachable: true, items: [] }; },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      expect((await call(server, "wrong", "list", "/v1/cron")).status).toBe(401);
      expect((await call(server, "secret", { action: "list", prompt: "SECRET" }, "/v1/cron")).status).toBe(400);
      expect(calls).toHaveLength(0);
      expect((await call(server, "secret", "list", "/v1/cron")).body.items).toEqual([]);
    } finally { server.close(); }
  });
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
