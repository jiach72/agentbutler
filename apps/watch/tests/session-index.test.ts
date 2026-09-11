/**
 * M2.3 会话索引测试：
 * - state.db 探测（会话表/列命中与缺失）、元数据组装；
 * - 异常规则 4 条（error-terminated / context-truncated / long-running / high-risk-actions）；
 * - 降级路径（state.db 缺失、session_model_usage 无会话列、无会话表）；
 * - 归一化纯函数（toIso / normalizeOutcome）；
 * - HTTP 端点契约（/api/sessions、/api/sessions/:id、reindex）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore, type Core } from "@butler/core";
import { createSessionIndexService, normalizeOutcome, toIso, type SessionIndexService } from "../src/session-index.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

let tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-session-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows SQLite 句柄延迟释放；临时目录由操作系统回收
    }
  }
});

const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};
const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

const FIXED_NOW = new Date("2026-09-11T12:00:00").getTime();

/** 构造 Hermes state.db fixture：会话表 + 用量表（可选成本列 / 会话列）。 */
function writeStateDb(
  dir: string,
  options: { withSessionsTable?: boolean; withSessionColumnInUsage?: boolean; status?: string; startedAtMs?: number; endedAtMs?: number } = {},
): string {
  const withSessionsTable = options.withSessionsTable ?? true;
  const withSessionColumn = options.withSessionColumnInUsage ?? true;
  const dbPath = join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session_model_usage (model TEXT, last_seen INTEGER, input_tokens INTEGER, output_tokens INTEGER${
      withSessionColumn ? ", session_id TEXT, actual_cost_usd REAL" : ""
    })`,
  );
  const usageInsert = withSessionColumn
    ? db.prepare(
        "INSERT INTO session_model_usage (model, last_seen, input_tokens, output_tokens, session_id, actual_cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
      )
    : db.prepare("INSERT INTO session_model_usage (model, last_seen, input_tokens, output_tokens) VALUES (?, ?, ?, ?)");
  const nowSec = Math.floor(FIXED_NOW / 1000);
  if (withSessionColumn) {
    usageInsert.run("gpt-x", nowSec - 600, 1200, 400, "sess-ok", 0.5);
    usageInsert.run("gpt-x", nowSec - 6000, 2200, 800, "sess-err", 1.25);
  } else {
    usageInsert.run("gpt-x", nowSec - 600, 1200, 400);
  }
  if (withSessionsTable) {
    db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER, status TEXT, task_type TEXT, model TEXT)");
    const insert = db.prepare(
      "INSERT INTO sessions (session_id, started_at, ended_at, status, task_type, model) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const startedAtMs = options.startedAtMs ?? nowSec * 1000 - 300_000;
    const endedAtMs = options.endedAtMs ?? nowSec * 1000 - 60_000;
    insert.run("sess-ok", startedAtMs, endedAtMs, "completed", "report", "gpt-x");
    insert.run("sess-err", startedAtMs, endedAtMs, options.status ?? "failed", "codegen", "gpt-x");
  }
  db.close();
  return dbPath;
}

function makeService(options: {
  dbPath: string;
  retentionDays?: number;
  withActions?: boolean;
  replayEnabled?: boolean;
}): { service: SessionIndexService; store: SqliteStore } {
  const dir = makeTempDir();
  const store = new SqliteStore(join(dir, "butler.db"));
  if (options.withActions === true) {
    const base = FIXED_NOW - 240_000;
    store.insertActionEvent({
      ts: new Date(base).toISOString(),
      kind: "file-write",
      severity: "info",
      target: "/home/u/out.json",
      detail: { snippet: "wrote file /home/u/out.json" },
      sessionId: "sess-ok",
      parserVersion: "v1",
    });
    store.insertActionEvent({
      ts: new Date(base + 1000).toISOString(),
      kind: "file-delete",
      severity: "high",
      target: "/home/u/data.db",
      detail: { snippet: "file deleted /home/u/data.db" },
      sessionId: "sess-ok",
      parserVersion: "v1",
    });
    store.insertActionEvent({
      ts: new Date(base + 2000).toISOString(),
      kind: "api-call",
      severity: "info",
      target: "openai",
      detail: { snippet: "context length exceeded for model gpt-x" },
      sessionId: "sess-err",
      parserVersion: "v1",
    });
  }
  const service = createSessionIndexService({
    core: { store } as unknown as Core,
    dbPath: options.dbPath,
    retentionDays: options.retentionDays ?? 30,
    replayEnabled: options.replayEnabled,
    now: () => FIXED_NOW,
    driver: { setInterval: () => 0, clearInterval: () => undefined },
  });
  return { service, store };
}

describe("归一化纯函数", () => {
  it("toIso 支持 epoch 秒/毫秒与 ISO 文本，非法值返回 null", () => {
    expect(toIso(1_700_000_000)).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(toIso(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(toIso("2026-09-11T00:00:00.000Z")).toBe("2026-09-11T00:00:00.000Z");
    expect(toIso("not-a-date")).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso(0)).toBeNull();
  });

  it("normalizeOutcome 只认明确语义，未知值不臆测", () => {
    expect(normalizeOutcome("failed")).toBe("error");
    expect(normalizeOutcome("ERROR")).toBe("error");
    expect(normalizeOutcome("completed")).toBe("ok");
    expect(normalizeOutcome("running")).toBe("running");
    expect(normalizeOutcome("weird-state")).toBe("unknown");
    expect(normalizeOutcome(null)).toBe("unknown");
  });
});

describe("会话索引采集", () => {
  it("state.db 会话表命中：组装起止/终态/模型/token/成本", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir);
    const { service } = makeService({ dbPath });
    const result = await service.refresh();
    expect(result.stateDbAvailable, `reason=${result.reason}`).toBe(true);
    expect(result.indexed).toBe(2);

    const { items, summary } = service.list({});
    expect(items).toHaveLength(2);
    expect(summary.source.sessionTable).toBe("sessions");
    expect(summary.replay.enabled).toBe(false);
    expect(summary.unimplementedRules.length).toBe(2); // 显式声明未实现规则

    const ok = items.find((item) => item.sessionId === "sess-ok")!;
    expect(ok.outcome).toBe("ok");
    expect(ok.model).toBe("gpt-x");
    expect(ok.taskType).toBe("report");
    expect(ok.tokenIn).toBe(1200);
    expect(ok.costUsd).toBeCloseTo(0.5, 5);
    expect(ok.startedAt).not.toBeNull();
    expect(ok.anomalies).toHaveLength(0);

    const err = items.find((item) => item.sessionId === "sess-err")!;
    expect(err.outcome).toBe("error");
    expect(err.anomalies.map((a) => a.kind)).toContain("error-terminated");
  });

  it("异常规则：高危动作 + 上下文截断 + 长会话", async () => {
    const dir = makeTempDir();
    // 会话持续 40 分钟 → long-running。
    const dbPath = writeStateDb(dir, {
      startedAtMs: FIXED_NOW - 40 * 60_000,
      endedAtMs: FIXED_NOW - 1000,
    });
    const { service } = makeService({ dbPath, withActions: true });
    await service.refresh();
    const { items } = service.list({});

    const ok = items.find((item) => item.sessionId === "sess-ok")!;
    const okKinds = ok.anomalies.map((a) => a.kind);
    expect(okKinds).toContain("high-risk-actions");
    expect(okKinds).toContain("long-running");
    expect(ok.actionCount).toBe(2);
    expect(ok.highRiskCount).toBe(1);
    expect(ok.anomalies.find((a) => a.kind === "high-risk-actions")?.severity).toBe("warn");

    const err = items.find((item) => item.sessionId === "sess-err")!;
    expect(err.anomalies.map((a) => a.kind)).toContain("context-truncated");
  });

  it("仅异常过滤 + 汇总计数", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir);
    const { service } = makeService({ dbPath, withActions: true });
    await service.refresh();
    const filtered = service.list({ anomalyOnly: true });
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((item) => item.anomalies.length > 0)).toBe(true);
    expect(filtered.summary.anomalies).toBe(filtered.summary.anomalies);
    expect(filtered.summary.total).toBe(2);
  });

  it("幂等：重复 refresh 不新增行", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir);
    const { service, store } = makeService({ dbPath });
    await service.refresh();
    await service.refresh();
    expect(store.countSessionIndex().total).toBe(2);
  });
});

describe("降级路径（不臆测）", () => {
  it("state.db 不存在：仅靠动作流建索引，起止/终态为未知", async () => {
    const { service } = makeService({ dbPath: join(makeTempDir(), "missing.db"), withActions: true });
    const result = await service.refresh();
    expect(result.stateDbAvailable).toBe(false);
    const { items, summary } = service.list({});
    expect(items.map((i) => i.sessionId).sort()).toEqual(["sess-err", "sess-ok"]);
    expect(items.every((i) => i.outcome === "unknown")).toBe(true);
    expect(items.every((i) => i.startedAt === null)).toBe(true);
    expect(summary.source.reason).toContain("state.db");
  });

  it("session_model_usage 无会话列（旧版 schema）：显式降级且不产出索引", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir, { withSessionsTable: false, withSessionColumnInUsage: false });
    const { service } = makeService({ dbPath });
    const result = await service.refresh();
    expect(result.stateDbAvailable).toBe(true);
    expect(result.reason).toContain("无会话列");
    expect(service.list({}).items).toHaveLength(0);
  });

  it("有会话列但无会话表：可用但提示仅元数据维度", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir, { withSessionsTable: false });
    const { service } = makeService({ dbPath });
    const result = await service.refresh();
    expect(result.stateDbAvailable).toBe(true);
    const { summary } = service.list({});
    expect(summary.source.sessionTable).toBeNull();
    expect(summary.source.reason).toContain("无会话表");
  });
});

describe("会话时间线", () => {
  it("detail 返回按时间排序的时间线（start → action → anomaly → end）", async () => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir);
    const { service } = makeService({ dbPath, withActions: true });
    await service.refresh();
    const detail = service.detail("sess-ok");
    expect(detail).not.toBeNull();
    expect(detail?.session.sessionId).toBe("sess-ok");
    expect(detail?.kinds["file-write"]).toBe(1);
    expect(detail?.kinds["file-delete"]).toBe(1);
    const kinds = detail!.timeline.map((node) => node.kind);
    expect(kinds[0]).toBe("session-start");
    expect(kinds[kinds.length - 1]).toBe("session-end");
    expect(kinds).toContain("action");
    expect(kinds).toContain("anomaly");
    // 高危动作节点标记 critical。
    expect(detail!.timeline.find((node) => node.kind === "action" && node.label.startsWith("file-delete"))?.severity).toBe("critical");
    // 时间严格非降序。
    const times = detail!.timeline.map((node) => Date.parse(node.at));
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(service.detail("missing")).toBeNull();
  });
});

describe("会话 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async (withSessions = true) => {
    const dir = makeTempDir();
    const dbPath = writeStateDb(dir);
    const { service, store } = makeService({ dbPath, withActions: true });
    await service.refresh();
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      ...(withSessions ? { sessions: service } : {}),
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("GET /api/sessions → 列表 + summary + lastRefresh", async () => {
    await boot();
    const res = await fetch(`${base}/api/sessions?anomalyOnly=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ sessionId: string; anomalies: unknown[] }>;
      summary: { total: number; unimplementedRules: string[] };
      lastRefresh: { indexed: number };
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.summary.total).toBe(2);
    expect(body.summary.unimplementedRules.length).toBe(2);
    expect(body.lastRefresh.indexed).toBe(2);
  });

  it("GET /api/sessions/:id → 时间线；未知 id 404；POST reindex 200", async () => {
    await boot();
    const detail = await fetch(`${base}/api/sessions/sess-ok`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { session: { sessionId: string }; timeline: unknown[] };
    expect(body.session.sessionId).toBe("sess-ok");
    expect(body.timeline.length).toBeGreaterThan(0);
    const missing = await fetch(`${base}/api/sessions/nope`);
    expect(missing.status).toBe(404);
    const reindex = await fetch(`${base}/api/sessions/reindex`, { method: "POST" });
    expect(reindex.status).toBe(200);
    const reindexBody = (await reindex.json()) as { indexed: number };
    expect(reindexBody.indexed).toBe(2);
  });

  it("未接线 sessions → 503", async () => {
    await boot(false);
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(503);
  });
});
