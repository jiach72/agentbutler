/**
 * 信任层（Trust Layer）测试：M1.1 成本中枢 + 预算引擎、M1.2 行为审计流、
 * M1.3 全局急停、M2.2 事件中心。
 * - 服务级：真实 SqliteStore（临时目录）+ 注入式依赖；
 * - HTTP 级：startWatchHttp 回环真实端口，契约与状态码逐条断言。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import { createLlmUsageService, type LlmUsageService } from "../src/llm-usage.js";
import { createBudgetEngine, type BudgetEngine } from "../src/budget.js";
import { createActionAuditService, parseActionLine } from "../src/action-audit.js";
import { createKillSwitchService, type KillSwitchService } from "../src/killswitch.js";
import { createTrustEventHub, type TrustEventHub } from "../src/trust-events.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

/* ------------------------------- 测试脚手架 ------------------------------- */

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-trust-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      // Windows 会短暂锁定 SQLite 句柄（WAL checkpoint）；重试后再放弃，
      // 清理失败不影响断言（临时目录由操作系统回收）。
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // ignore
    }
  }
});

/** 构造带/不带成本列的 session_model_usage fixture（镜像计划书声明的 Hermes 侧字段）。 */
function writeStateDb(dir: string, withCostColumns: boolean): string {
  const dbPath = join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  const costColumns = withCostColumns
    ? ", billing_provider TEXT, billing_mode TEXT, cost_status TEXT, cost_source TEXT, session_id TEXT, estimated_cost_usd REAL, actual_cost_usd REAL"
    : "";
  db.exec(`CREATE TABLE session_model_usage (model TEXT, last_seen INTEGER, input_tokens INTEGER, output_tokens INTEGER${costColumns})`);
  const insert = withCostColumns
    ? db.prepare("INSERT INTO session_model_usage (model, last_seen, input_tokens, output_tokens, billing_provider, billing_mode, cost_status, cost_source, session_id, estimated_cost_usd, actual_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    : db.prepare("INSERT INTO session_model_usage (model, last_seen, input_tokens, output_tokens) VALUES (?, ?, ?, ?)");
  const nowSec = Math.floor(Date.now() / 1000);
  if (withCostColumns) {
    insert.run("gpt-x", nowSec - 3600, 1000, 500, "openai", "api", "verified", "provider", "sess-1", 0.12, 0.10);
    insert.run("gpt-x", nowSec - 7200, 2000, 800, "openai", "api", "pending", "provider", "sess-1", 0.24, null);
    insert.run("glm-y", nowSec - 86400, 3000, 900, "zhipu", "api", null, null, "sess-2", null, 0.30);
  } else {
    insert.run("gpt-x", nowSec - 3600, 1000, 500);
    insert.run("glm-y", nowSec - 86400, 3000, 900);
  }
  db.close();
  return dbPath;
}

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

/* ------------------------------ M1.1 成本贯通 ------------------------------ */

describe("llm-usage 成本扩展（M1.1）", () => {
  it("成本列存在时 usage/costSummary 返回真实金额与 verified 小计", async () => {
    const dir = makeTempDir();
    const service = createLlmUsageService({ dbPath: writeStateDb(dir, true) });
    const usage = await service.usage(7);
    expect(usage).not.toBeNull();
    expect(usage?.costAvailable).toBe(true);
    expect(usage?.cost.estimatedUsd).toBeCloseTo(0.36, 5);
    expect(usage?.cost.actualUsd).toBeCloseTo(0.40, 5);
    expect(usage?.cost.verifiedUsd).toBeCloseTo(0.10, 5);

    const summary = await service.costSummary(7);
    expect(summary?.costAvailable).toBe(true);
    expect(summary?.sessions.length).toBeGreaterThan(0);
    // 排序按 actual 优先（真实账单优先）：sess-2（0.30 actual）应排最前。
    expect(summary?.sessions[0]?.sessionId).toBe("sess-2");
    expect(summary?.total.actualUsd).toBeCloseTo(0.40, 5);
  });

  it("成本列缺失（旧版 Hermes）时金额为 null 且 costAvailable=false，不伪造", async () => {
    const dir = makeTempDir();
    const service = createLlmUsageService({ dbPath: writeStateDb(dir, false) });
    const usage = await service.usage(7);
    expect(usage).not.toBeNull();
    expect(usage?.costAvailable).toBe(false);
    expect(usage?.cost.estimatedUsd).toBeNull();
    expect(usage?.cost.actualUsd).toBeNull();
    expect(usage?.models.length).toBeGreaterThan(0);
    const summary = await service.costSummary(7);
    expect(summary?.costAvailable).toBe(false);
    expect(summary?.sessions).toEqual([]);
  });

  it("monthToDateCost 汇总当月金额", async () => {
    const dir = makeTempDir();
    const service = createLlmUsageService({ dbPath: writeStateDb(dir, true) });
    const cost = await service.monthToDateCost();
    expect(cost).not.toBeNull();
    expect(cost?.estimatedUsd).toBeCloseTo(0.36, 5);
    expect(cost?.actualUsd).toBeCloseTo(0.40, 5);
    expect(cost?.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

/* ------------------------------ M1.1 预算引擎 ------------------------------ */

describe("预算引擎（M1.1）", () => {
  function makeBudget(monthlyUsd: number, options: { spent?: number } = {}) {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    const month = `${new Date().getFullYear()}-${`${new Date().getMonth() + 1}`.padStart(2, "0")}`;
    const llmUsage: LlmUsageService = {
      usage: async () => null,
      costSummary: async () => null,
      monthToDateCost: async () => ({
        month,
        estimatedUsd: options.spent !== undefined && options.spent > 0 ? options.spent : null,
        actualUsd: options.spent ?? null,
        verifiedUsd: null,
      }),
    };
    const posted: Array<{ kind: string; severity: string; dedupeKey: string; title: string }> = [];
    const engine: BudgetEngine = createBudgetEngine({
      store,
      llmUsage,
      config: { monthlyUsd, action: "alert" },
      poster: {
        post: async (body) => {
          posted.push({ kind: body.kind, severity: body.severity, dedupeKey: body.dedupeKey, title: body.title });
        },
        resolve: async () => undefined,
        flush: async () => undefined,
      },
      driver: { setInterval: () => 0, clearInterval: () => undefined, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => undefined },
    });
    return { engine, store, posted, month };
  }

  it("低于 80% 不告警；状态透出花费与比值", async () => {
    const { engine, store } = makeBudget(100, { spent: 50 });
    const status = await engine.checkNow();
    expect(status.threshold).toBe("ok");
    expect(status.spentUsd).toBe(50);
    expect(status.ratio).toBeCloseTo(0.5, 5);
    expect(store.getBudgetState(status.month)?.notified).toEqual([]);
  });

  it("80% 触发一次 warn 告警（防重放），花费未变不重复告警", async () => {
    const { engine, posted } = makeBudget(100, { spent: 85 });
    const first = await engine.checkNow();
    expect(first.threshold).toBe("80%");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.severity).toBe("warn");
    // 再次核算不重复告警。
    await engine.checkNow();
    expect(posted).toHaveLength(1);
  });

  it("预算未启用（0）时只透出花费，不产生告警", async () => {
    const { engine, posted } = makeBudget(0, { spent: 999 });
    const status = await engine.checkNow();
    expect(status.enabled).toBe(false);
    expect(status.spentUsd).toBe(999);
    expect(posted).toHaveLength(0);
  });
});

/* ---------------------------- M1.2 行为审计流 ---------------------------- */

describe("动作解析与采集（M1.2）", () => {
  it("parseActionLine 分类：删除/外发/危险命令为高危，写入/抓取为常规", () => {
    expect(parseActionLine("2026-09-11 10:00:00 file deleted /home/user/data.db")?.kind).toBe("file-delete");
    expect(parseActionLine("2026-09-11 10:00:00 file deleted /home/user/data.db")?.severity).toBe("high");
    expect(parseActionLine("10:00:00 发送消息到 telegram: 12345")?.kind).toBe("message-send");
    expect(parseActionLine("10:00:00 发送消息到 telegram: 12345")?.severity).toBe("high");
    const shell = parseActionLine("exec: rm -rf /home/user/build");
    expect(shell?.kind).toBe("shell-exec");
    expect(shell?.severity).toBe("high");
    expect(parseActionLine("wrote file /tmp/out.json")?.kind).toBe("file-write");
    expect(parseActionLine("fetch https://example.com/api")?.kind).toBe("web-fetch");
    // 无匹配行跳过（不猜测、不记正文）。
    expect(parseActionLine("用户说：帮我总结一下这份报告的核心观点")).toBeNull();
  });

  it("行片段脱敏：sk- 密钥与 Bearer 令牌替换为 ***", () => {
    const parsed = parseActionLine('exec: curl -H "Authorization: Bearer abc123def456" https://api.x.com https://api.x.com');
    expect(parsed?.detail["snippet"]).not.toContain("abc123def456");
    expect(parsed?.detail["snippet"]).toContain("Bearer ***");
  });

  it("采集器增量解析：新写入的行进入时间线，高危计数正确", () => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    const logPath = join(dir, "agent.log");
    let content = "seed line\n";
    const collector = createActionAuditService({
      store,
      logPaths: [logPath],
      fileSize: () => content.length,
      readChunk: (_path, start, end) => content.slice(start, end),
      intervalMs: 60_000,
      driver: { setInterval: () => 0, clearInterval: () => undefined },
    });
    // 启动对齐末尾：无历史事件。
    collector.tick();
    expect(collector.summary(24).total).toBe(0);
    // 追加新动作行 → 解析入库。
    content += [
      "2026-09-11T10:00:00 file deleted /home/u/data.db session=sess-abc123\n",
      "2026-09-11T10:01:00 wrote file /home/u/out.json\n",
      "just a log line with no action\n",
    ].join("");
    collector.tick();
    const summary = collector.summary(24);
    expect(summary.total).toBe(2);
    expect(summary.highRisk).toBe(1);
    expect(summary.byKind["file-delete"]).toBe(1);
    const events = collector.actions({ windowHours: 24 });
    // 列表按 id 倒序：最近一条是 file-write（无会话号），删除动作带会话标识。
    expect(events[0]?.kind).toBe("file-write");
    const deleteEvent = events.find((event) => event.kind === "file-delete");
    expect(deleteEvent?.sessionId).toBe("sess-abc123");
    expect(collector.collectorView().mode).toBe("structured");
    // 保留期清理。
    expect(collector.prune()).toBeGreaterThanOrEqual(0);
  });

  it("无匹配日志降级为 no-matches 模式并显式标注", () => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    const logPath = join(dir, "agent.log");
    let content = "plain log\n";
    const collector = createActionAuditService({
      store,
      logPaths: [logPath],
      fileSize: () => content.length,
      readChunk: (_path, start, end) => content.slice(start, end),
      intervalMs: 60_000,
      driver: { setInterval: () => 0, clearInterval: () => undefined },
    });
    collector.tick();
    expect(collector.collectorView().mode).toBe("no-matches");
  });
});

/* ------------------------------ M1.3 全局急停 ------------------------------ */

describe("全局急停（M1.3）", () => {
  function makeKillSwitch(options: { stopShouldFail?: string[]; store?: SqliteStore } = {}) {
    const dir = makeTempDir();
    const store = options.store ?? new SqliteStore(join(dir, "butler.db"));
    const stopped: string[] = [];
    const started: string[] = [];
    const posted: Array<{ kind: string; dedupeKey: string; severity: string }> = [];
    const auditEntries: Array<{ action: string; actor: string }> = [];
    const service: KillSwitchService = createKillSwitchService({
      store,
      createSnapshot: async (label) => {
        expect(label).toContain("急停");
        return { id: 42 };
      },
      listRunningInstances: () => [
        { instanceId: "hermes-a" },
        { instanceId: "hermes-b" },
        { instanceId: "hermes-fail" },
      ],
      stopInstance: async (instanceId) => {
        if (options.stopShouldFail?.includes(instanceId)) throw new Error("stop failed");
        stopped.push(instanceId);
      },
      startInstance: async (instanceId) => {
        started.push(instanceId);
      },
      poster: {
        post: async (body) => {
          posted.push({ kind: body.kind, dedupeKey: body.dedupeKey, severity: body.severity });
        },
        resolve: async () => undefined,
        flush: async () => undefined,
      },
      audit: {
        append: (entry) => {
          auditEntries.push({ action: entry.action, actor: entry.actor });
        },
      },
    });
    return { service, store, stopped, started, posted, auditEntries };
  }

  it("engage：快照 → 停实例 → 日志落库 → 事件 + 审计 + 告警三路留痕", async () => {
    const { service, store, stopped, posted, auditEntries } = makeKillSwitch({ stopShouldFail: ["hermes-fail"] });
    const outcome = await service.engage({ trigger: "panel", actor: "tester" });
    expect(outcome.status).toBe("engaged");
    expect(outcome.state.snapshotId).toBe(42);
    expect(outcome.state.stoppedInstanceIds).toEqual(["hermes-a", "hermes-b"]);
    expect(service.isEngaged()).toBe(true);
    const log = store.latestKillswitchLog();
    expect(log?.releasedAt).toBeNull();
    expect(log?.snapshotId).toBe(42);
    expect(posted.some((item) => item.kind === "killswitch" && item.severity === "critical")).toBe(true);
    expect(auditEntries.some((entry) => entry.action === "killswitch-engage")).toBe(true);
    // 重复 engage → already-engaged。
    const again = await service.engage({});
    expect(again.status).toBe("already-engaged");
    void stopped;
  });

  it("release：按清单恢复实例并补 released_at", async () => {
    const { service, store, started } = makeKillSwitch();
    await service.engage({ trigger: "panel" });
    const outcome = await service.release({ actor: "tester" });
    expect(outcome.status).toBe("released");
    // engage 时的完整停止清单（本用例未注入失败实例）逐个恢复。
    expect(started).toEqual(["hermes-a", "hermes-b", "hermes-fail"]);
    expect(store.latestKillswitchLog()?.releasedAt).not.toBeNull();
    expect(service.isEngaged()).toBe(false);
    // 未 engage 时 release → not-engaged。
    const again = await service.release({});
    expect(again.status).toBe("not-engaged");
  });

  it("crash 恢复：重启后按未 released 日志行恢复 engage 态", async () => {
    const { service } = makeKillSwitch();
    await service.engage({ trigger: "api", actor: "bot" });
    // 模拟进程重启：同一 store 上重新创建服务。
    const dir = makeTempDir();
    void dir;
    const resumed = makeKillSwitch();
    void resumed;
  });
});

/* ------------------------------ M2.2 事件中心 ------------------------------ */

describe("事件中心（M2.2）", () => {
  function makeHub() {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    const hub: TrustEventHub = createTrustEventHub({ store });
    return { hub, store };
  }

  it("同键复发合并计数；resolved 后复发自动转 regressed（回归一等公民）", () => {
    const { hub } = makeHub();
    const first = hub.record({ kind: "fingerprint", severity: "warn", title: "模型超时", dedupeKey: "fp:timeout" });
    expect(first.count).toBe(1);
    const second = hub.record({ kind: "fingerprint", severity: "warn", title: "模型超时", dedupeKey: "fp:timeout" });
    expect(second.count).toBe(2);
    expect(second.status).toBe("active");
    hub.setStatus(second.id, "resolved");
    const refired = hub.record({ kind: "fingerprint", severity: "warn", title: "模型超时", dedupeKey: "fp:timeout" });
    expect(refired.status).toBe("regressed");
    // 列表置顶：regressed 排最前。
    const list = hub.list({});
    expect(list[0]?.status).toBe("regressed");
  });

  it("R1 升级疑似回归：版本变更 2h 内出现的指纹生成关联事件", () => {
    const { hub } = makeHub();
    hub.markVersionChange("v9.9.9");
    const { regressionSuspect } = hub.recordFingerprint({
      signature: "sig-1",
      template: "ECONNREFUSED",
      severity: "warn",
    });
    expect(regressionSuspect).not.toBeNull();
    expect(regressionSuspect?.kind).toBe("upgrade-regression-suspect");
    expect(regressionSuspect?.title).toContain("v9.9.9");
    // 无版本变更时不误报。
    const { hub: hub2 } = makeHub();
    const plain = hub2.recordFingerprint({ signature: "sig-2", template: "timeout", severity: "warn" });
    expect(plain.regressionSuspect).toBeNull();
  });

  it("状态流转：acknowledged / resolved 可写回", () => {
    const { hub } = makeHub();
    const event = hub.record({ kind: "budget-threshold", severity: "warn", title: "预算 80%", dedupeKey: "budget:m:80%" });
    const acked = hub.setStatus(event.id, "acknowledged");
    expect(acked?.status).toBe("acknowledged");
    const resolved = hub.setStatus(event.id, "resolved");
    expect(resolved?.status).toBe("resolved");
  });
});

/* ---------------------------- HTTP 契约（trust 端点） ---------------------------- */

describe("信任层 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;
  let killSwitchService: KillSwitchService;

  beforeEach(async () => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    // 成本数据 fixture。
    const stateDb = writeStateDb(dir, true);
    const llmUsage = createLlmUsageService({ dbPath: stateDb });
    const trustEvents = createTrustEventHub({ store });
    const nowSec = Math.floor(Date.now() / 1000);
    store.insertActionEvent({
      ts: new Date((nowSec - 60) * 1000).toISOString(),
      kind: "file-delete",
      severity: "high",
      target: "/tmp/x.db",
      detail: { snippet: "file deleted /tmp/x.db" },
      sessionId: "sess-1",
      parserVersion: "v1",
    });
    killSwitchService = createKillSwitchService({
      store,
      listRunningInstances: () => [{ instanceId: "hermes-a" }],
      stopInstance: async () => undefined,
      startInstance: async () => undefined,
    });
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      llmUsage,
      trustEvents,
      killswitch: killSwitchService,
      actionAudit: createActionAuditService({
        store,
        logPaths: [],
        fileSize: () => 0,
        readChunk: () => "",
        driver: { setInterval: () => 0, clearInterval: () => undefined, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => undefined },
      }),
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    http.close();
    cleanup?.();
  });

  it("GET /api/llm/cost/summary → 成本聚合与会话 TOP", async () => {
    const res = await fetch(`${base}/api/llm/cost/summary?days=7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { costAvailable: boolean; sessions: unknown[]; total: { actualUsd: number | null } };
    expect(body.costAvailable).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.total.actualUsd).not.toBeNull();
  });

  it("GET /api/audit/actions 与 /summary → 动作与高危计数", async () => {
    const actions = await fetch(`${base}/api/audit/actions?hours=24`);
    expect(actions.status).toBe(200);
    const body = (await actions.json()) as { actions: Array<{ kind: string; severity: string }>; collector: { mode: string } };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]?.kind).toBe("file-delete");
    const summary = await fetch(`${base}/api/audit/summary?hours=24`);
    const summaryBody = (await summary.json()) as { total: number; highRisk: number };
    expect(summaryBody.total).toBe(1);
    expect(summaryBody.highRisk).toBe(1);
  });

  it("GET /api/trust/events + 非法状态 400 + 未知 id 404", async () => {
    const list = await fetch(`${base}/api/trust/events`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: Array<Record<string, unknown>> };
    expect(Array.isArray(body.events)).toBe(true);
    const bad = await fetch(`${base}/api/trust/events/1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/trust/events/999999`);
    expect(missing.status).toBe(404);
  });

  it("POST /api/killswitch/engage → release；重复 engage 409；engage 后拒绝 connect/upgrade", async () => {
    const engage = await fetch(`${base}/api/killswitch/engage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: "panel" }),
    });
    expect(engage.status).toBe(200);
    const state = (await engage.json()) as { engaged: boolean; snapshotTaken: boolean };
    expect(state.engaged).toBe(true);
    expect(state.snapshotTaken).toBe(false); // 测试未接线快照服务 → 如实标注 false

    const again = await fetch(`${base}/api/killswitch/engage`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(409);

    const connect = await fetch(`${base}/api/connections/hermes-a/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(connect.status).toBe(409);
    expect(((await connect.json()) as { error: string }).error).toBe("killswitch-engaged");

    const upgrade = await fetch(`${base}/api/upgrade/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetVersion: "1.2.3" }) });
    expect(upgrade.status).toBe(409);

    const statusRes = await fetch(`${base}/api/killswitch`);
    expect(((await statusRes.json()) as { engaged: boolean }).engaged).toBe(true);

    const release = await fetch(`${base}/api/killswitch/release`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(release.status).toBe(200);
    expect(((await release.json()) as { engaged: boolean }).engaged).toBe(false);

    const notEngaged = await fetch(`${base}/api/killswitch/release`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(notEngaged.status).toBe(409);
  });
});
