import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult, PortProber } from "@butler/adapter-hermes";
import {
  startWatchHttp,
  type RunbookExecuteOutcome,
  type RunbookResetOutcome,
  type WatchHttp,
  type WatchHttpDeps,
} from "../src/http.js";
import { createWatchApp, type WatchApp } from "../src/watch.js";
import type { FetchLike } from "../src/dashboard-signal.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

/* ------------------------- 注入式依赖（fake scheduler/执行） ------------------------- */

interface FakeState {
  runbooks: WatchHttpDeps["runbooks"];
  executeOutcome: RunbookExecuteOutcome;
  resetOutcome: RunbookResetOutcome;
  resetCalls: Array<{ id: string; instanceId?: string }>;
  executeCalls: Array<{ id: string; instanceId?: string }>;
  runNowResult: boolean;
  runNowCalls: number;
  status: WatchHttpDeps["scheduler"]["status"] extends () => infer S ? S : never;
  connections: NonNullable<WatchHttpDeps["connections"]>;
}

/** 升级服务 stub（本文件不覆盖升级端点，仅满足 WatchHttpDeps.upgrade；升级端点见 http-upgrade.test.ts）。 */
const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};

/** 网关面板服务 stub（本文件不覆盖网关端点，仅满足 WatchHttpDeps.gateway；网关端点见 http-gateway.test.ts）。 */
const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

function makeDeps(initial: Partial<FakeState> = {}): { deps: WatchHttpDeps; state: FakeState } {
  const state: FakeState = {
    runbooks: initial.runbooks ?? (() => []),
    executeOutcome: initial.executeOutcome ?? { status: "started", instanceId: "hermes-main" },
    resetOutcome: { status: "reset", keys: ["rb-restart:hermes-main"] },
    resetCalls: [],
    executeCalls: [],
    runNowResult: initial.runNowResult ?? true,
    runNowCalls: 0,
    status: initial.status ?? { lastAt: null, nextAt: null, intervalMin: 60, inFlight: false },
    connections: {
      status: () => ({ checkedAt: "2026-08-24T00:00:00.000Z", connections: [{ instanceId: "hermes-main", connectionState: "connected" }] }),
      check: async () => ({ status: "checked", connection: { instanceId: "hermes-main", connectionState: "connected", latencyMs: 12 } }),
      connect: async () => ({ status: "connected", connection: { instanceId: "hermes-main", connectionState: "connected" } }),
      disconnect: async () => ({ status: "disconnected", connection: { instanceId: "hermes-main", connectionState: "disconnected" } }),
    },
  };
  const deps: WatchHttpDeps = {
    scheduler: {
      runNow: () => {
        state.runNowCalls += 1;
        return state.runNowResult;
      },
      status: () => state.status,
    },
    connections: state.connections,
    runbooks: () => state.runbooks(),
    executeRunbook: async (id, instanceId) => {
      state.executeCalls.push({ id, instanceId });
      return state.executeOutcome;
    },
    resetRunbookBreaker: async (id, instanceId) => {
      state.resetCalls.push({ id, instanceId });
      return state.resetOutcome;
    },
    upgrade: upgradeStub,
    gateway: gatewayStub,
  };
  return { deps, state };
}

/* ------------------------------ HTTP 单元（fake 依赖） ------------------------------ */

describe("startWatchHttp（注入依赖，回环真实端口）", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const addr = await http.start();
    expect(addr.port).toBeGreaterThan(0);
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    http.close();
    http.close(); // 幂等
  });

  it("GET /healthz → 服务与 schema 版本", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "watch",
      serviceVersion: expect.stringMatching(/^watch@/),
      schemaVersion: "evolution-v2-charts-v1",
    });
  });

  it("GET /api/runbooks → 三段结构（id/label/description/breakerTripped/lastRun 可选）", async () => {
    fake.state.runbooks = () => [
      {
        id: "rb-restart",
        label: "重启实例",
        description: "重启并复验",
        breakerTripped: false,
        lastRun: { at: "2026-08-20T12:00:00.000Z", success: true },
      },
      { id: "rb-cleanup-gateway", label: "清理孤儿网关", description: "仅清理", breakerTripped: true },
    ];
    const res = await fetch(`${base}/api/runbooks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runbooks: unknown[] };
    expect(body.runbooks).toHaveLength(2);
    expect(body.runbooks[0]).toEqual({
      id: "rb-restart",
      label: "重启实例",
      description: "重启并复验",
      breakerTripped: false,
      lastRun: { at: "2026-08-20T12:00:00.000Z", success: true },
    });
    expect(body.runbooks[1]).toEqual({
      id: "rb-cleanup-gateway",
      label: "清理孤儿网关",
      description: "仅清理",
      breakerTripped: true,
    });
    expect("lastRun" in (body.runbooks[1] as object)).toBe(false); // 从未执行 → 无 lastRun 字段
  });

  it("POST /api/runbooks/:id/execute → 202 且 fake runRunbook 被调（body 可带 instanceId）", async () => {
    const res = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ started: true });
    expect(fake.state.executeCalls).toEqual([{ id: "rb-restart", instanceId: "hermes-main" }]);

    // 空 body → instanceId 缺省（undefined 透传）
    const res2 = await fetch(`${base}/api/runbooks/rb-restart/execute`, { method: "POST" });
    expect(res2.status).toBe(202);
    expect(fake.state.executeCalls[1]).toEqual({ id: "rb-restart", instanceId: undefined });
  });

  it("POST /api/runbooks/:id/reset → 200 且透传解除结果；未跳闸 → 409", async () => {
    const res = await fetch(`${base}/api/runbooks/rb-restart/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "reset",
      keys: ["rb-restart:hermes-main"],
    });
    expect(fake.state.resetCalls).toEqual([{ id: "rb-restart", instanceId: "hermes-main" }]);

    fake.state.resetOutcome = { status: "not-tripped" };
    const noTrip = await fetch(`${base}/api/runbooks/rb-restart/reset`, { method: "POST" });
    expect(noTrip.status).toBe(409);
    await expect(noTrip.json()).resolves.toEqual({ error: "circuit-breaker-not-tripped" });
  });

  it("execute 分支：未知 id → 404；熔断跳闸 → 409 circuit-breaker-tripped；无可用实例 → 503", async () => {
    fake.state.executeOutcome = { status: "unknown-runbook" };
    const notFound = await fetch(`${base}/api/runbooks/rb-nope/execute`, { method: "POST" });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: expect.stringContaining("unknown-runbook") });

    fake.state.executeOutcome = { status: "circuit-breaker-tripped" };
    const tripped = await fetch(`${base}/api/runbooks/rb-restart/execute`, { method: "POST" });
    expect(tripped.status).toBe(409);
    await expect(tripped.json()).resolves.toEqual({ error: "circuit-breaker-tripped" });

    fake.state.executeOutcome = { status: "no-servicing-instance" };
    const noInstance = await fetch(`${base}/api/runbooks/rb-restart/execute`, { method: "POST" });
    expect(noInstance.status).toBe(503);
    expect(await noInstance.json()).toMatchObject({ error: expect.any(String) });
  });

  it("POST /api/inspect/run → 202 started；巡检在飞 runNow=false → 409 inspection-in-flight", async () => {
    const res = await fetch(`${base}/api/inspect/run`, { method: "POST" });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ started: true });
    expect(fake.state.runNowCalls).toBe(1); // 只触发一次

    fake.state.runNowResult = false;
    const conflict = await fetch(`${base}/api/inspect/run`, { method: "POST" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "inspection-in-flight" });
  });

  it("GET /api/inspect/status → { lastAt, nextAt, intervalMin, inFlight }", async () => {
    fake.state.status = { lastAt: "2026-08-20T12:00:00.000Z", nextAt: "2026-08-20T13:00:00.000Z", intervalMin: 60, inFlight: false };
    const res = await fetch(`${base}/api/inspect/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      lastAt: "2026-08-20T12:00:00.000Z",
      nextAt: "2026-08-20T13:00:00.000Z",
      intervalMin: 60,
      inFlight: false,
    });
  });

  it("恢复诊断先给根因与分级动作；低风险可执行，高风险必须确认", async () => {
    fake.state.runbooks = () => [
      { id: "rb-restart", label: "重启实例", description: "重启并复验", breakerTripped: false },
      { id: "rb-cleanup-gateway", label: "清理网关", description: "清理并复验", breakerTripped: false },
    ];
    const diagnosis = await fetch(`${base}/api/recovery/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(diagnosis.status).toBe(200);
    const body = (await diagnosis.json()) as { incidentId: string; recommendedActions: Array<{ id: string; risk: string; requiresConfirmation: boolean }> };
    expect(body.incidentId).toMatch(/^incident-/);
    expect(body.recommendedActions.some((action) => action.id === "refresh-probe" && action.risk === "low")).toBe(true);
    expect(body.recommendedActions.some((action) => action.id === "restart-instance" && action.requiresConfirmation)).toBe(true);

    const missingConfirmation = await fetch(`${base}/api/recovery/actions/restart-instance/execute`, { method: "POST" });
    expect(missingConfirmation.status).toBe(400);
    await expect(missingConfirmation.json()).resolves.toMatchObject({ error: "confirmation-required" });

    const refresh = await fetch(`${base}/api/recovery/actions/refresh-probe/execute`, { method: "POST" });
    expect(refresh.status).toBe(202);
    await expect(refresh.json()).resolves.toMatchObject({ actionId: "refresh-probe", status: "running" });
  });

  it("连接管理端点：查询、手动检查、连接和断开均透传结构化状态", async () => {
    const status = await fetch(`${base}/api/connections`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      checkedAt: "2026-08-24T00:00:00.000Z",
      connections: [{ instanceId: "hermes-main", connectionState: "connected" }],
    });

    const check = await fetch(`${base}/api/connections/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(check.status).toBe(200);
    await expect(check.json()).resolves.toMatchObject({ status: "checked", connection: { latencyMs: 12 } });

    const connect = await fetch(`${base}/api/connections/hermes-main/connect`, { method: "POST" });
    expect(connect.status).toBe(200);
    await expect(connect.json()).resolves.toMatchObject({ status: "connected" });

    const disconnect = await fetch(`${base}/api/connections/hermes-main/disconnect`, { method: "POST" });
    expect(disconnect.status).toBe(200);
    await expect(disconnect.json()).resolves.toMatchObject({ status: "disconnected" });
  });

  it("请求体超 16KB → 413；非法 JSON → 400；未知路径 → 404；方法不符 → 405", async () => {
    const tooLarge = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(17 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    const badJson = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);

    const unknown = await fetch(`${base}/api/nope`);
    expect(unknown.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/runbooks`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
  });
});

/* ------------------------------ createWatchApp 集成 ------------------------------ */

let tmp: string;
let home: string;
let hermesRoot: string;
let app: WatchApp | undefined;
let appBase: string;
let fetchCalls: Array<{ url: string }>;

function writeHermesFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-http-hermes-"));
  mkdirSync(join(dir, "hermes-agent"), { recursive: true });
  mkdirSync(join(dir, "venv", "bin"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "platforms:",
      "  api_server:",
      "    extra:",
      '      host: "127.0.0.1"',
      "      port: 18642",
      '      key: "fixture-secret-key"',
      "dashboard:",
      "  port: 9119",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "hermes-agent", "pyproject.toml"), '[project]\nname = "hermes-agent"\nversion = "0.20.4"\n');
  writeFileSync(join(dir, "venv", "bin", "python"), "");
  writeFileSync(join(dir, "logs", "agent.log"), "agent start\n");
  writeFileSync(join(dir, "logs", "gateway.log"), "gateway start\n");
  writeFileSync(join(dir, "memory_store.db"), "");
  return dir;
}

const fakeExec: CommandExecutor = {
  exec: async (cmd: string, args?: string[]): Promise<CommandResult> => {
    // process-alive 仅匹配实例 rootPath 下的 hermes-agent 路径；孤儿网关模式无进程。
    if (cmd === "pgrep" && args?.[1]?.endsWith("hermes-agent")) return { code: 0, stdout: "4242\n", stderr: "" };
    if (cmd === "ps") return { code: 0, stdout: "40960 1.5\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  },
  spawnDetached: () => {},
};

const fakeProber: PortProber = async () => true;

const fakeFetch: FetchLike = async (url) => {
  fetchCalls.push({ url });
  if (url.endsWith("/api/status")) {
    return { ok: true, status: 200, json: async () => ({ status: "ok", healthy: true }) };
  }
  return { ok: true, status: 202, json: async () => ({ id: 1 }) };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-http-"));
  home = join(tmp, "butler-home");
  hermesRoot = writeHermesFixture();
  fetchCalls = [];
});

afterEach(() => {
  app?.stop();
  app = undefined;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(hermesRoot, { recursive: true, force: true });
});

describe("createWatchApp HTTP 接线（watchHttpPort=0 随机端口）", () => {
  it("healthz / runbooks 元信息 / inspect status 契约", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address();
    expect(addr).not.toBeNull();
    appBase = `http://127.0.0.1:${addr!.port}`;

    await expect((await fetch(`${appBase}/healthz`)).json()).resolves.toMatchObject({
      ok: true,
      service: "watch",
      serviceVersion: expect.stringMatching(/^watch@/),
      schemaVersion: "evolution-v2-charts-v1",
    });

    const runbooks = ((await (await fetch(`${appBase}/api/runbooks`)).json()) as {
      runbooks: Array<{ id: string; description: string; breakerTripped: boolean; lastRun?: unknown }>;
    }).runbooks;
    expect(runbooks.map((r) => r.id)).toEqual(["rb-restart", "rb-reconnect", "rb-cleanup-gateway"]);
    expect(runbooks.every((r) => r.description !== "" && r.breakerTripped === false && r.lastRun === undefined)).toBe(true);

    const status = (await (await fetch(`${appBase}/api/inspect/status`)).json()) as Record<string, unknown>;
    expect(status["intervalMin"]).toBe(5); // 默认巡检间隔满足 10 分钟恢复 SLA
    expect(typeof status["lastAt"]).toBe("string"); // autoStart 已完成首轮
    expect(status["nextAt"]).toBeTypeOf("string");
    expect(status["inFlight"]).toBe(false);
    expect(status["criticalProbe"]).toMatchObject({
      intervalMin: 1,
      slaMin: 10,
      lastStatus: expect.any(String),
      lastWithinSla: true,
      overdue: false,
      inFlight: false,
      runCount: 1,
    });
    expect(app.core.audit.list({ action: "critical-probe-sla" })).toHaveLength(1);
  });

  it("execute：真实接线 202 启动 rb-cleanup-gateway → runbook-started 事件落库", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address()!;
    appBase = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${appBase}/api/runbooks/rb-cleanup-gateway/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ started: true });

    // 异步执行 → 轮询等待 runbook-started 落 events 表
    for (let i = 0; i < 50; i += 1) {
      if (app.core.store.listEvents({ type: "runbook-started" }).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const started = app.core.store.listEvents({ type: "runbook-started" });
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ runbookId: "rb-cleanup-gateway", trigger: "manual" });
  });

  it("execute 分支：未知 id → 404；熔断跳闸 → 409；无 Serving 实例（显式未知 instanceId）→ 503", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address()!;
    appBase = `http://127.0.0.1:${addr.port}`;

    const notFound = await fetch(`${appBase}/api/runbooks/rb-nope/execute`, { method: "POST" });
    expect(notFound.status).toBe(404);

    // 熔断跳闸：对首个实例的 rb-restart 键灌满阈值（5 次失败）
    const instanceId = app.instances[0]!.instanceId;
    for (let i = 0; i < 5; i += 1) app.breaker.recordFailure(`rb-restart:${instanceId}`, "test");
    const tripped = await fetch(`${appBase}/api/runbooks/rb-restart/execute`, { method: "POST" });
    expect(tripped.status).toBe(409);
    await expect(tripped.json()).resolves.toEqual({ error: "circuit-breaker-tripped" });

    const noInstance = await fetch(`${appBase}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "no-such-instance" }),
    });
    expect(noInstance.status).toBe(503);

    // 熔断态反映到 runbooks 列表 breakerTripped
    const runbooks = ((await (await fetch(`${appBase}/api/runbooks`)).json()) as {
      runbooks: Array<{ id: string; breakerTripped: boolean }>;
    }).runbooks;
    expect(runbooks.find((r) => r.id === "rb-restart")!.breakerTripped).toBe(true);
    expect(runbooks.find((r) => r.id === "rb-cleanup-gateway")!.breakerTripped).toBe(false);
  });

  it("inspect/run 立即触发第二轮巡检；stop() 关闭 HTTP（后续请求连接失败）", async () => {
    app = await createWatchApp({
      home,
      config: { hermesRoot, watchHttpPort: 0 },
      exec: fakeExec,
      prober: fakeProber,
      fetchFn: fakeFetch,
    });
    const addr = app.watchHttp.address()!;
    appBase = `http://127.0.0.1:${addr.port}`;
    const before = app.core.store.listEvents({ type: "inspection-completed" }).length;

    const res = await fetch(`${appBase}/api/inspect/run`, { method: "POST" });
    expect([202, 409]).toContain(res.status); // 首轮已完成为 202；极小概率在飞为 409
    if (res.status === 202) {
      for (let i = 0; i < 50; i += 1) {
        if (app.core.store.listEvents({ type: "inspection-completed" }).length > before) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(app.core.store.listEvents({ type: "inspection-completed" }).length).toBe(before + 1);
    }

    app.stop();
    await expect(fetch(`${appBase}/healthz`)).rejects.toThrow();
  }, 15_000);
});
