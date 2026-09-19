import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHermesControlBridgeServer, isSupportedNodeVersion } from "./hermes-control-bridge.mjs";

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
      expect(result.body).toEqual({ active: true, unit: "hermes-gateway.service", supervisor: "systemd" });
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
      expect(result.body).toEqual({ active: true, unit: "hermes-gateway.service", supervisor: "systemd", cleanedPids: [202], mainPid: 101 });
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

  it("reports active:null and rejects mutations with 422 when supervisor is unavailable (macOS)", async () => {
    const server = createHermesControlBridgeServer({
      unit: "hermes-gateway.service",
      readToken: () => "secret",
      runSystemctl: async () => ({ code: 1, stdout: "", stderr: "command not found", notFound: true }),
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const statusRes = await call(server, "secret", "status");
      expect(statusRes.status).toBe(200);
      expect(statusRes.body).toEqual({
        active: null,
        unit: "hermes-gateway.service",
        supervisor: "unavailable",
        supervisorReason: "systemctl_missing",
      });

      const restartRes = await call(server, "secret", "restart-hermes");
      expect(restartRes.status).toBe(422);
      expect(restartRes.body).toEqual({ error: "supervisor_unavailable" });
    } finally {
      server.close();
    }
  });

  it("exposes /v1/health endpoint with token protection and supervisor info", async () => {
    const server = createHermesControlBridgeServer({
      unit: "hermes-gateway.service",
      readToken: () => "secret",
      runSystemctl: async () => ({ code: 0, stdout: "active\n", stderr: "" }),
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const unauth = await new Promise((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: server.address().port, path: "/v1/health", method: "GET" }, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(unauth.status).toBe(401);

      const health = await new Promise((resolve, reject) => {
        const req = request({
          hostname: "127.0.0.1",
          port: server.address().port,
          path: "/v1/health",
          method: "GET",
          headers: { authorization: "Bearer secret" },
        }, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        ok: true,
        bridgeVersion: "0.1.0-beta.260911.13",
        supervisor: "systemd",
        active: true,
        unit: "hermes-gateway.service",
        expectedRevision: "hermes-f94a7a1-cron-v1",
      });
    } finally {
      server.close();
    }
  });

  it("ensures install-hermes-control-bridge.sh locks Hermes node first, restricts PATH, and guards bootstrap race", () => {
    const scriptContent = readFileSync(join(import.meta.dirname, "install-hermes-control-bridge.sh"), "utf8");
    // Node detection priority: .hermes/node/bin/node MUST be checked before command -v node
    const hermesNodeIndex = scriptContent.indexOf('[[ -x "$HOME/.hermes/node/bin/node" ]]');
    const commandVNodeIndex = scriptContent.indexOf('command -v node');
    expect(hermesNodeIndex).toBeGreaterThan(-1);
    expect(commandVNodeIndex).toBeGreaterThan(-1);
    expect(hermesNodeIndex).toBeLessThan(commandVNodeIndex);

    // LaunchAgent PATH must NOT leak host ${PATH:-}
    expect(scriptContent).toContain("<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.hermes/node/bin</string>");
    expect(scriptContent).not.toContain("<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.hermes/node/bin:${PATH:-}</string>");

    // LaunchAgent bootstrap race condition handling & port release polling
    expect(scriptContent).toContain('launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true');
    expect(scriptContent).toContain('lsof -nP -iTCP:8756 -sTCP:LISTEN');
    expect(scriptContent).toContain('kill -TERM "$op"');
    expect(scriptContent).toContain('if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST_FILE" 2>/dev/null; then');
    expect(scriptContent).toContain('launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true');
    expect(scriptContent).toContain('launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1');
    expect(scriptContent).toContain('Hermes host control bridge failed to listen on port 8756');
  });

  it("ensures deploy.sh persists BUTLER_GIT_COMMIT to .env", () => {
    const deployContent = readFileSync(join(import.meta.dirname, "deploy.sh"), "utf8");
    expect(deployContent).toContain('deploy_sha="$(git rev-parse HEAD 2>/dev/null || true)"');
    expect(deployContent).toContain('env_set BUTLER_GIT_COMMIT "$deploy_sha"');
  });

  it("verifies Node.js version >= 22.5.0 requirement logic and install script gates", () => {
    // Exact unit test of isSupportedNodeVersion
    expect(isSupportedNodeVersion("v22.5.0")).toBe(true);
    expect(isSupportedNodeVersion("v22.22.3")).toBe(true);
    expect(isSupportedNodeVersion("v24.1.0")).toBe(true);
    expect(isSupportedNodeVersion("22.5")).toBe(true);
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);

    expect(isSupportedNodeVersion("v22.4.9")).toBe(false);
    expect(isSupportedNodeVersion("v22.0.0")).toBe(false);
    expect(isSupportedNodeVersion("v20.18.0")).toBe(false);
    expect(isSupportedNodeVersion("v18.20.0")).toBe(false);
    expect(isSupportedNodeVersion("")).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
    expect(isSupportedNodeVersion("invalid")).toBe(false);

    // Verify install-hermes-control-bridge.sh has the version check
    const installContent = readFileSync(join(import.meta.dirname, "install-hermes-control-bridge.sh"), "utf8");
    expect(installContent).toContain('node_major="$(echo "$node_version_clean" | cut -d. -f1)"');
    expect(installContent).toContain('node_minor="$(echo "$node_version_clean" | cut -d. -f2)"');
    expect(installContent).toContain('Node.js >= 22.5.0 is required');
  });

  it("preserves drift diagnostic fields (versionExact, driftedFiles, expectedRevision) in cronResponse", async () => {
    const server = createHermesControlBridgeServer({
      readToken: () => "secret",
      runCron: async (body) => {
        if (body.action === "status") {
          return {
            schemaVersion: 1,
            supported: true,
            reachable: true,
            schedulerRunning: true,
            activeCount: 3,
            todayRunCount: 12,
            failedTaskCount: 0,
            nextRunAt: "2026-09-19T10:00:00Z",
            heartbeatAgeSeconds: 15,
            timezone: "UTC",
            writesSupported: false,
            runSupported: false,
            versionExact: false,
            driftedFiles: ["cron/jobs.py", "hermes_cli/cron.py"],
            expectedRevision: "hermes-f94a7a1-cron-v1",
            detectedRevision: "custom-v2",
          };
        }
        if (body.action === "list") {
          return {
            schemaVersion: 1,
            supported: true,
            reachable: true,
            versionExact: false,
            driftedFiles: ["cron/jobs.py"],
            expectedRevision: "hermes-f94a7a1-cron-v1",
            items: [
              {
                id: "job-1",
                name: "Nightly Backup",
                enabled: true,
                scheduleLabel: "every 24h",
                nextRunAt: null,
                lastRunAt: null,
                lastStatus: "never",
                failureStreak: 0,
                deliveryEnabled: false,
                editable: false,
              },
            ],
          };
        }
        return {
          schemaVersion: 1,
          supported: false,
          reachable: true,
          reason: "unsupported_version",
          versionExact: false,
          driftedFiles: ["cron/jobs.py"],
          expectedRevision: "hermes-f94a7a1-cron-v1",
          requestId: body.requestId,
          taskId: body.id ?? null,
          outcome: "failed",
        };
      },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      // 1. Status with drift preserves diagnostic fields
      const statusRes = await call(server, "secret", { action: "status" }, "/v1/cron");
      expect(statusRes.status).toBe(200);
      expect(statusRes.body).toMatchObject({
        schemaVersion: 1,
        supported: true,
        reachable: true,
        writesSupported: false,
        runSupported: false,
        versionExact: false,
        driftedFiles: ["cron/jobs.py", "hermes_cli/cron.py"],
        expectedRevision: "hermes-f94a7a1-cron-v1",
        detectedRevision: "custom-v2",
      });

      // 2. List with drift allows read and preserves items + drift diagnostics
      const listRes = await call(server, "secret", { action: "list" }, "/v1/cron");
      expect(listRes.status).toBe(200);
      expect(listRes.body.supported).toBe(true);
      expect(listRes.body.versionExact).toBe(false);
      expect(listRes.body.driftedFiles).toEqual(["cron/jobs.py"]);
      expect(listRes.body.items).toHaveLength(1);
      expect(listRes.body.items[0].id).toBe("job-1");

      // 3. Write action rejected with unsupported_version returns failure details
      const writeRes = await call(server, "secret", { action: "pause", id: "job-1", requestId: "pause-request-001" }, "/v1/cron");
      expect(writeRes.status).toBe(200);
      expect(writeRes.body).toMatchObject({
        schemaVersion: 1,
        supported: false,
        reachable: true,
        reason: "unsupported_version",
        versionExact: false,
        driftedFiles: ["cron/jobs.py"],
        expectedRevision: "hermes-f94a7a1-cron-v1",
        outcome: "failed",
      });
    } finally {
      server.close();
    }
  });

  it("HERMES_CRON_PYTHON decouples read and write on hash drift and checks BUTLER_ALLOW_CRON_DRIFT", async () => {
    const { HERMES_CRON_PYTHON } = await import("./hermes-control-bridge.mjs");
    expect(HERMES_CRON_PYTHON).toContain('allow_drift = os.environ.get("BUTLER_ALLOW_CRON_DRIFT") == "1"');
    expect(HERMES_CRON_PYTHON).toContain('if is_write and not (is_exact or allow_drift):');
    expect(HERMES_CRON_PYTHON).toContain('reject("unsupported_version")');
    expect(HERMES_CRON_PYTHON).toContain('result["versionExact"] = is_exact');
    expect(HERMES_CRON_PYTHON).toContain('result["driftedFiles"] = drifted_files');
    expect(HERMES_CRON_PYTHON).toContain('result["expectedRevision"] = VERSION');
    expect(HERMES_CRON_PYTHON).toContain('writes_allowed = builtin and (is_exact or allow_drift)');
  });
});
