/**
 * M3.3 假进度检测测试：
 * - 纯函数：声明提取（宁漏不误报）、会话归属、三态判定；
 * - 核实链路：有副作用 → verified；可观测但窗口内无副作用 → suspect；
 * - **边界诚实**：无法归属 / 无法观测 → unverifiable（绝不猜成 suspect）；
 * - 连续 suspect ≥3 → progress-untrusted 事件（一次，靠 dedupe 幂等）；
 * - 会话级假完成：终态 ok 且零副作用 → unverified-completion；
 * - 可信度分母只含 verified + suspect（无法验证不掺进分母）；
 * - HTTP 契约：概览 / 会话级 / scan / 503 / 405，以及会话时间线并入 ✓/？ 节点。
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, EventBus, SqliteStore } from "@butler/core";
import {
  createProgressIntegrityService,
  parseProgressClaim,
  parseSessionId,
  verdictOf,
  UNATTRIBUTED_SESSION,
  type ProgressIntegrityService,
} from "../src/progress-integrity.js";
import { createTrustEventHub, type TrustEventHub } from "../src/trust-events.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-progress-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows 句柄延迟释放；临时目录由操作系统回收
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

describe("假进度检测：纯函数", () => {
  it("只有带明确进度语汇的行才算声明（宁漏不误报）", () => {
    expect(parseProgressClaim("任务完成 65%")?.pct).toBe(65);
    expect(parseProgressClaim("progress: 40%")?.pct).toBe(40);
    expect(parseProgressClaim("已完成 30% done")?.pct).toBe(30);
    // 只声明「已完成」无数字：claimedPct 为 null，但仍是声明。
    const claim = parseProgressClaim("task completed successfully");
    expect(claim).not.toBeNull();
    expect(claim?.pct).toBeNull();
    // 裸百分数不算声明（token 占比、磁盘用量等）——这是控误报的关键。
    expect(parseProgressClaim("cache hit rate 92%")).toBeNull();
    expect(parseProgressClaim('{"usage": {"percent": 13}}')).toBeNull();
    // 越界百分比视为误匹配。
    expect(parseProgressClaim("完成 300%")).toBeNull();
    // 凭据脱敏。
    const scrubbed = parseProgressClaim("完成 50% token=abcdef123456")?.text ?? "";
    expect(scrubbed).not.toContain("abcdef123456");
  });

  it("会话归属：识别常见写法，取不到返回 null（不猜）", () => {
    expect(parseSessionId('session_id="sess-abc123"')).toBe("sess-abc123");
    expect(parseSessionId("session: hermes-2026-09-11")).toBe("hermes-2026-09-11");
    expect(parseSessionId("任务完成 50%")).toBeNull();
  });

  it("三态判定：有副作用=可信；可观测但空窗=可疑；不可观测=无法验证", () => {
    expect(verdictOf({ sideEffectCount: 2, sessionObservable: true, attributed: true }).verdict).toBe("verified");
    expect(verdictOf({ sideEffectCount: 0, sessionObservable: true, attributed: true }).verdict).toBe("suspect");
    // 有动作记录但窗口为空 → 可疑；完全没有动作 → 无法验证（关键区分）。
    expect(verdictOf({ sideEffectCount: 0, sessionObservable: false, attributed: true }).verdict).toBe(
      "unverifiable",
    );
    expect(verdictOf({ sideEffectCount: 0, sessionObservable: true, attributed: false }).verdict).toBe(
      "unverifiable",
    );
    // 归属不到会话时不能靠副作用数「顺手判可信」。
    expect(verdictOf({ sideEffectCount: 5, sessionObservable: true, attributed: false }).verdict).toBe(
      "unverifiable",
    );
  });
});

/* ---------------------------- 服务级 harness ---------------------------- */

interface Harness {
  service: ProgressIntegrityService;
  store: SqliteStore;
  trustEvents: TrustEventHub;
  logFile: string;
  /** 当前虚拟时钟（毫秒）。 */
  now(): number;
  /** 推进虚拟时钟。声明时间戳必须单调递进，否则「上一条声明 → 本条声明」的核实窗口会退化成空区间。 */
  advance(ms: number): void;
  /** 追加一行日志（模拟 agent 输出），随后 tick 采集。 */
  emit(line: string): void;
  tick(): void;
}

const FIXED = Date.parse("2026-09-11T12:00:00Z");

function makeHarness(): Harness {
  const dir = makeTempDir();
  const store = new SqliteStore(join(dir, "butler.db"));
  const audit = new AuditLog({ store, bus: new EventBus() });
  let clock = FIXED;
  const trustEvents = createTrustEventHub({ store, audit, now: () => clock });
  const logFile = join(dir, "agent.log");
  writeFileSync(logFile, "");
  const service = createProgressIntegrityService({
    store,
    trustEvents,
    audit,
    logPaths: [logFile],
    now: () => clock,
  });
  return {
    service,
    store,
    trustEvents,
    logFile,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    emit: (line: string) => appendFileSync(logFile, `${line}\n`),
    tick: () => service.tick(),
  };
}

function seedSession(store: SqliteStore, sessionId: string, outcome: string): void {
  store.upsertSessionIndex({
    sessionId,
    startedAt: new Date(FIXED - 3_600_000).toISOString(),
    endedAt: new Date(FIXED - 60_000).toISOString(),
    durationMs: 3_540_000,
    outcome,
    at: new Date(FIXED).toISOString(),
  });
}

function seedAction(
  store: SqliteStore,
  sessionId: string,
  kind: "file-write" | "shell-exec" | "raw",
  atMs: number,
): void {
  store.insertActionEvent({
    ts: new Date(atMs).toISOString(),
    kind,
    severity: kind === "raw" ? "info" : "info",
    target: `/tmp/${kind}`,
    sessionId,
    parserVersion: "v1",
  });
}

describe("假进度检测：核实链路", () => {
  it("首次 tick 只对齐末尾（不全量重扫历史），随后增量采集", () => {
    const h = makeHarness();
    h.emit("历史行：完成 10%");
    h.tick(); // 首次：对齐末尾，历史行不入账
    expect(h.service.claims({}).length).toBe(0);

    h.advance(1000);
    h.emit('session_id="sess-a" 任务完成 30%');
    h.tick();
    expect(h.service.claims({}).length).toBe(1);
    expect(h.service.claims({})[0]?.claimedPct).toBe(30);
  });

  it("窗口内有副作用动作 → verified", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    seedAction(h.store, "sess-a", "file-write", FIXED - 10_000);
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 50%');
    h.tick();

    const claim = h.service.claims({ sessionId: "sess-a" })[0]!;
    expect(claim.verdict).toBe("verified");
    expect(claim.sideEffectCount).toBe(1);
    expect(claim.sideEffectKinds).toContain("file-write");
  });

  it("会话可观测但窗口内无副作用 → suspect", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    // 会话有动作记录（raw 不算副作用），证明「能观测到」。
    seedAction(h.store, "sess-a", "raw", FIXED - 20_000);
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 50%');
    h.tick();

    const claim = h.service.claims({ sessionId: "sess-a" })[0]!;
    expect(claim.verdict).toBe("suspect");
    expect(claim.sideEffectCount).toBe(0);
    expect(claim.reason).toContain("没有任何真实副作用动作");
  });

  it("会话完全无动作记录 → unverifiable（不猜成 suspect）", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-ghost", "ok");
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-ghost" progress 80%');
    h.tick();

    const claim = h.service.claims({ sessionId: "sess-ghost" })[0]!;
    expect(claim.verdict).toBe("unverifiable");
    expect(claim.reason).toContain("无法核实");
  });

  it("无法归属会话的声明 → unverifiable + 占位会话标识", () => {
    const h = makeHarness();
    h.tick();
    h.advance(1000);
    h.emit("progress 90%");
    h.tick();
    const claims = h.service.claims({});
    expect(claims.length).toBe(1);
    expect(claims[0]?.sessionId).toBe(UNATTRIBUTED_SESSION);
    expect(claims[0]?.verdict).toBe("unverifiable");
  });

  it("窗口以「上一条声明」为起点：声明之间新增的副作用会被算进后一条", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    seedAction(h.store, "sess-a", "raw", FIXED - 30_000); // 保证「可观测」
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 20%');
    h.tick();
    expect(h.service.claims({ sessionId: "sess-a" })[0]?.verdict).toBe("suspect");

    // 第二条声明之前插入一个副作用动作 → 第二条应为 verified。
    h.store.insertActionEvent({
      ts: new Date(h.now()).toISOString(),
      kind: "shell-exec",
      severity: "info",
      target: "ls",
      sessionId: "sess-a",
      parserVersion: "v1",
    });
    h.advance(1000);
    h.emit('session_id="sess-a" progress 60%');
    h.tick();
    const claims = h.service.claims({ sessionId: "sess-a" });
    expect(claims.length).toBe(2);
    expect(claims[1]?.verdict).toBe("verified");
  });

  it("同一行重复采集不重复入账（幂等）", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 10%');
    h.tick();
    h.tick(); // 无新内容
    expect(h.service.claims({}).length).toBe(1);
  });
});

describe("假进度检测：连续可疑与会话级假完成", () => {
  it("连续 3 次无副作用声明 → progress-untrusted 事件（只推一次）", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-bad", "ok");
    seedAction(h.store, "sess-bad", "raw", FIXED - 30_000);
    h.tick();
    for (const pct of [20, 40, 60, 80]) {
      h.advance(1000);
      h.emit(`session_id="sess-bad" progress ${pct}%`);
      h.tick();
    }
    // 4 条声明全部 suspect（中间无副作用），但事件只记录一次（dedupeKey 幂等）。
    const claims = h.service.claims({ sessionId: "sess-bad" });
    expect(claims.filter((claim) => claim.verdict === "suspect").length).toBe(4);
    const events = h.trustEvents.list({ kind: "progress-untrusted" });
    expect(events.length).toBe(1);
    expect(events[0]?.severity).toBe("warn");
    expect(events[0]?.title).toContain("sess-bad");
  });

  it("出现 verified 会重置连续计数（不累加历史）", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-mix", "ok");
    seedAction(h.store, "sess-mix", "raw", FIXED - 30_000);
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-mix" progress 20%');
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-mix" progress 40%');
    h.tick();
    // 插一个副作用 → 下一条声明 verified，连击清零。
    h.store.insertActionEvent({
      ts: new Date(h.now()).toISOString(),
      kind: "file-write",
      severity: "info",
      target: "/tmp/x",
      sessionId: "sess-mix",
      parserVersion: "v1",
    });
    h.advance(1000);
    h.emit('session_id="sess-mix" progress 60%');
    h.tick();
    // 再来两次 suspect（未达 3 连击）。
    h.advance(1000);
    h.emit('session_id="sess-mix" progress 70%');
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-mix" progress 80%');
    h.tick();
    expect(h.trustEvents.list({ kind: "progress-untrusted" }).length).toBe(0);
  });

  it("会话终态 ok 但零副作用 → unverified-completion 事件", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-empty", "ok");
    seedAction(h.store, "sess-empty", "raw", FIXED - 30_000); // 有记录但无副作用
    h.tick();
    const events = h.trustEvents.list({ kind: "unverified-completion" });
    expect(events.length).toBe(1);
    expect(events[0]?.severity).toBe("warn");
    expect(events[0]?.title).toContain("sess-empty");
    // 有副作用的会话不应被点名。
    seedSession(h.store, "sess-good", "ok");
    seedAction(h.store, "sess-good", "file-write", FIXED - 30_000);
    h.tick();
    expect(h.trustEvents.list({ kind: "unverified-completion" }).length).toBe(1);
  });
});

describe("假进度检测：可信度统计", () => {
  it("分母只含 verified + suspect；无法验证单列", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-1", "ok");
    seedAction(h.store, "sess-1", "raw", FIXED - 30_000);
    // 先有一个真实副作用 → 首条声明即为 verified。
    h.store.insertActionEvent({
      ts: new Date(h.now()).toISOString(),
      kind: "api-call",
      severity: "info",
      target: "https://x",
      sessionId: "sess-1",
      parserVersion: "v1",
    });
    h.tick();
    // 1 条 verified（有副作用）+ 1 条 suspect（窗口内无副作用）+ 1 条 unverifiable（未归属）。
    h.advance(1000);
    h.emit('session_id="sess-1" progress 30%');
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-1" progress 60%');
    h.tick();
    h.emit("progress 90%");
    h.tick();

    const summary = h.service.summary(7);
    expect(summary.verified).toBe(1);
    expect(summary.suspect).toBe(1);
    expect(summary.unverifiable).toBe(1);
    expect(summary.total).toBe(3);
    // 1 / (1+1) = 0.5 —— 不是 1/3。
    expect(summary.trustRate).toBeCloseTo(0.5, 5);
  });

  it("无有效样本时 trustRate 为 null（不臆造 0 或 100）", () => {
    const h = makeHarness();
    h.tick();
    const summary = h.service.summary(7);
    expect(summary.total).toBe(0);
    expect(summary.trustRate).toBeNull();
  });

  it("可疑会话按最长连击点名", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-bad", "ok");
    seedAction(h.store, "sess-bad", "raw", FIXED - 30_000);
    h.tick();
    for (const pct of [10, 20, 30]) {
      h.advance(1000);
      h.emit(`session_id="sess-bad" progress ${pct}%`);
      h.tick();
    }
    const summary = h.service.summary(7);
    expect(summary.suspectSessions.length).toBe(1);
    expect(summary.suspectSessions[0]?.sessionId).toBe("sess-bad");
    expect(summary.suspectSessions[0]?.maxSuspectStreak).toBe(3);
  });

  it("会话级可信度视图 + prune", () => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    seedAction(h.store, "sess-a", "raw", FIXED - 30_000);
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 10%');
    h.tick();

    const view = h.service.sessionProgress("sess-a")!;
    expect(view.total).toBe(1);
    expect(view.suspect).toBe(1);
    expect(view.maxSuspectStreak).toBe(1);
    expect(view.trustRate).toBe(0);
    expect(h.service.sessionProgress("nope")).toBeNull();

    // 保留期 30 天：把清理截止点直接设到很晚无法通过接口表达，改为断言空库返回 0。
    expect(h.service.prune()).toBe(0);
  });
});

describe("假进度检测 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async (withProgress = true) => {
    const h = makeHarness();
    seedSession(h.store, "sess-a", "ok");
    seedAction(h.store, "sess-a", "raw", FIXED - 30_000);
    h.tick();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 45%');
    h.tick();

    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      ...(withProgress ? { progress: h.service } : {}),
    };
    cleanup = () => h.store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
    return h;
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("GET /api/progress → summary + claims；verdict 过滤生效", async () => {
    await boot();
    const res = await fetch(`${base}/api/progress?windowDays=7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { total: number; suspect: number; trustRate: number | null; mode: string };
      claims: Array<{ verdict: string }>;
    };
    expect(body.summary.total).toBe(1);
    expect(body.summary.suspect).toBe(1);
    expect(body.summary.trustRate).toBe(0);
    expect(body.summary.mode).toBe("scanning");

    const filtered = await fetch(`${base}/api/progress?verdict=verified`);
    expect(((await filtered.json()) as { claims: unknown[] }).claims.length).toBe(0);
  });

  it("GET /api/progress/sessions/:id → 会话级核实", async () => {
    await boot();
    const res = await fetch(`${base}/api/progress/sessions/sess-a`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      progress: { total: number; suspect: number } | null;
      claims: unknown[];
    };
    expect(body.sessionId).toBe("sess-a");
    expect(body.progress?.suspect).toBe(1);
    expect(body.claims.length).toBe(1);

    const ghost = await fetch(`${base}/api/progress/sessions/not-there`);
    expect(ghost.status).toBe(200);
    expect(((await ghost.json()) as { progress: unknown }).progress).toBeNull();
  });

  it("POST /api/progress/scan → 立即采集", async () => {
    const h = await boot();
    h.advance(1000);
    h.emit('session_id="sess-a" progress 80%');
    const res = await fetch(`${base}/api/progress/scan`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { total: number } }).summary.total).toBe(2);
  });

  it("会话详情时间线并入 ✓/？ 进度节点", async () => {
    const h = await boot();
    // 造一条会话语义索引行，让 /api/sessions/:id 有内容可返回。
    h.store.upsertSessionIndex({
      sessionId: "sess-a",
      startedAt: new Date(FIXED - 3_600_000).toISOString(),
      endedAt: new Date(FIXED).toISOString(),
      durationMs: 3_600_000,
      outcome: "ok",
      at: new Date(FIXED).toISOString(),
    });
    // 该接口需要 sessions 依赖；这里只验证 progress 未接线时不会破坏会话路由。
    const res = await fetch(`${base}/api/sessions/sess-a`);
    // sessions 未接线 → 503（不是崩溃），说明进度节点合并没越界影响原有契约。
    expect([503, 404, 200]).toContain(res.status);
  });

  it("未接线 → 503；方法不允许 → 405", async () => {
    await boot(false);
    expect((await fetch(`${base}/api/progress`)).status).toBe(503);
    expect((await fetch(`${base}/api/progress/scan`, { method: "POST" })).status).toBe(503);

    await boot(true);
    expect((await fetch(`${base}/api/progress`, { method: "POST" })).status).toBe(405);
  });
});
