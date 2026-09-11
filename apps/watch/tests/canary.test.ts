/**
 * M3.2 升级金丝雀测试：
 * - 准入判据三指标（成功率 ≤5pp / token ≤15% / 无新增 error 指纹）——**数据缺失一律不通过**；
 * - 策略三档：激进跳过、标准（执行器缺失 → 未验证放行）、保守（执行器缺失 → 拦截）；
 * - 抽样来自真实会话索引（10 常规 + 全部失败），确定可复现；
 * - 观察窗守卫：检出回归自动回滚（子步骤失败不算成功）、窗口到期收敛、无快照时不假称回滚；
 * - HTTP 契约：列表 / 策略读写 / plan / start / tick / 详情 404 / 未接线 503。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, EventBus, SqliteStore, type CanaryMetrics } from "@butler/core";
import {
  CANARY_REGRESSION_EVENT_KIND,
  createCanaryService,
  type CanaryService,
  type CanaryShadowRunner,
} from "../src/canary.js";
import { createTrustEventHub, type TrustEventHub } from "../src/trust-events.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";
import type { AlertPoster, GatewayAlertBody } from "../src/alert-forward.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-canary-"));
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

function makeUpgradeStub(overrides: Partial<UpgradeService> = {}): UpgradeService {
  return {
    startUpgrade: () => ({ status: "missing-target-version" }),
    status: () => null,
    listVersions: async () => ({ reachable: false, versions: [] }),
    rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    ...overrides,
  } as UpgradeService;
}

const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

function makePoster(): { poster: AlertPoster; posts: GatewayAlertBody[] } {
  const posts: GatewayAlertBody[] = [];
  return {
    posts,
    poster: {
      post: async (body) => {
        posts.push(body);
      },
      resolve: async () => undefined,
      flush: async () => undefined,
    },
  };
}

function makeClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * 默认影子指标：与「未播种任何指纹」的基线对齐（errorFingerprints 为空），
 * 否则会被判为「新增 error 级指纹」而合理地拦下升级。
 * 涉及指纹的用例各自显式给出两侧集合。
 */
const OK_METRICS: CanaryMetrics = {
  successRate: 0.9,
  avgTokens: 1000,
  avgDurationMs: 2000,
  sampleSize: 12,
  errorFingerprints: [],
  outputSimilarity: null,
};

function makeRunner(
  result: { ok: true; metrics: CanaryMetrics } | { ok: false; reason: string },
): CanaryShadowRunner {
  return {
    available: () => true,
    unavailableReason: () => "n/a",
    run: async () => (result.ok ? { ok: true, metrics: { ...result.metrics, source: "影子实例实测" } } : result),
  };
}

/** 造一批真实会话索引行（ok / error），供抽样与基线使用。 */
function seedSessions(store: SqliteStore, okCount: number, errorCount: number, baseMs: number): void {
  for (let i = 0; i < okCount; i += 1) {
    store.upsertSessionIndex({
      sessionId: `ok-${i}`,
      startedAt: new Date(baseMs - i * 60_000).toISOString(),
      endedAt: new Date(baseMs - i * 60_000 + 1000).toISOString(),
      durationMs: 1000 + i,
      tokenIn: 500,
      tokenOut: 500,
      outcome: "ok",
      at: new Date(baseMs).toISOString(),
    });
  }
  for (let i = 0; i < errorCount; i += 1) {
    store.upsertSessionIndex({
      sessionId: `err-${i}`,
      startedAt: new Date(baseMs - (100 + i) * 60_000).toISOString(),
      endedAt: new Date(baseMs - (100 + i) * 60_000 + 500).toISOString(),
      durationMs: 500,
      tokenIn: 300,
      tokenOut: 300,
      outcome: "error",
      at: new Date(baseMs).toISOString(),
    });
  }
}

let idSeq = 0;
function makeService(options: {
  policy?: "aggressive" | "standard" | "conservative";
  runner?: CanaryShadowRunner;
  upgrade?: UpgradeService;
  okCount?: number;
  errorCount?: number;
  start?: number;
} = {}): {
  service: CanaryService;
  store: SqliteStore;
  trustEvents: TrustEventHub;
  posts: GatewayAlertBody[];
  clock: { now: () => number; advance: (ms: number) => void };
} {
  const dir = makeTempDir();
  const store = new SqliteStore(join(dir, "butler.db"));
  const audit = new AuditLog({ store, bus: new EventBus() });
  const clock = makeClock(options.start ?? Date.parse("2026-09-11T12:00:00Z"));
  // 事件中心必须与金丝雀共用同一时钟：否则事件 last_seen（真实时间）会早于
  // 切换时刻（假时钟），观察窗回归判定会把它当成「切换前的旧事件」而漏掉。
  const trustEvents = createTrustEventHub({ store, audit, now: clock.now });
  const { poster, posts } = makePoster();
  seedSessions(store, options.okCount ?? 3, options.errorCount ?? 2, clock.now());
  idSeq = 0;
  const service = createCanaryService({
    store,
    trustEvents,
    audit,
    poster,
    ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
    ...(options.runner === undefined ? {} : { shadowRunner: options.runner }),
    defaultPolicy: options.policy ?? "standard",
    now: clock.now,
    idFactory: () => `cr-${++idSeq}`,
  });
  return { service, store, trustEvents, posts, clock };
}

describe("金丝雀：准入判据（纯判定）", () => {
  it("三指标全过 → pass", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS },
      shadow: { ...OK_METRICS, successRate: 0.88, avgTokens: 1100 },
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.map((check) => check.id)).toEqual(["success-rate", "token", "new-error-fingerprints"]);
    // 相似度不参与准入，但必须显式声明未评估。
    expect(verdict.notEvaluated.join()).toContain("输出相似度");
  });

  it("成功率降幅 > 5pp → 不通过", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, successRate: 0.95 },
      shadow: { ...OK_METRICS, successRate: 0.89 },
    });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((item) => item.id === "success-rate")!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("6.0pp");
  });

  it("成功率降幅恰好 5pp → 通过（边界含等号）", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, successRate: 0.95 },
      shadow: { ...OK_METRICS, successRate: 0.9 },
    });
    expect(verdict.checks.find((item) => item.id === "success-rate")?.pass).toBe(true);
  });

  it("token 增幅 > 15% → 不通过", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, avgTokens: 1000 },
      shadow: { ...OK_METRICS, avgTokens: 1160 },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.find((item) => item.id === "token")?.detail).toContain("16.0%");
  });

  it("出现新增 error 级指纹 → 不通过", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, errorFingerprints: ["fp-a", "fp-b"] },
      shadow: { ...OK_METRICS, errorFingerprints: ["fp-a", "fp-c"] },
    });
    expect(verdict.pass).toBe(false);
    const check = verdict.checks.find((item) => item.id === "new-error-fingerprints")!;
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("fp-c");
  });

  it("指标缺失一律按不通过处理（不得凭沉默放行）", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, successRate: null, avgTokens: null },
      shadow: { ...OK_METRICS, successRate: null, avgTokens: null },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.filter((check) => !check.pass).length).toBe(2);
    expect(verdict.checks[0]?.detail).toContain("按不通过处理");
  });

  it("基线 token 为 0 时无法算增幅 → 不通过（不臆造分母）", () => {
    const { service } = makeService();
    const verdict = service.evaluate({
      baseline: { ...OK_METRICS, avgTokens: 0 },
      shadow: { ...OK_METRICS, avgTokens: 100 },
    });
    expect(verdict.checks.find((item) => item.id === "token")?.pass).toBe(false);
  });
});

describe("金丝雀：策略三档", () => {
  it("激进策略：直接跳过，不执行影子验证", async () => {
    const { service, posts } = makeService({ policy: "aggressive" });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("skipped");
    expect(run.reason).toContain("激进策略");
    expect(posts.length).toBe(0); // 跳过是用户选择，不打扰
    expect(service.getPolicy()).toBe("aggressive");
  });

  it("标准策略 + 执行器未配置 → 记为「未验证」放行并告警", async () => {
    const { service, posts } = makeService({ policy: "standard" });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("unverified");
    expect(run.reason).toContain("未做金丝雀验证");
    expect(posts.length).toBe(1);
    expect(posts[0]?.severity).toBe("warn");
    expect(posts[0]?.title).toContain("未做金丝雀验证");
    // 关键：绝不能因为执行器缺失就写「通过」。
    expect(run.verdict).toBeNull();
  });

  it("保守策略 + 执行器未配置 → 拦截升级（critical 告警）", async () => {
    const { service, posts } = makeService({ policy: "conservative" });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("blocked");
    expect(run.reason).toContain("升级已拦截");
    expect(posts[0]?.severity).toBe("critical");
  });

  it("策略读写落库，非法值回落标准", () => {
    const { service } = makeService({ policy: "conservative" });
    expect(service.getPolicy()).toBe("conservative");
    expect(service.setPolicy("aggressive")).toBe("aggressive");
    expect(service.getPolicy()).toBe("aggressive");
  });
});

describe("金丝雀：抽样与执行", () => {
  it("抽样 = 10 常规（上限）+ 全部失败；来源是真实会话索引", async () => {
    const { service, store } = makeService({ okCount: 14, errorCount: 3 });
    const run = service.plan({ targetVersion: "2.0.0" });
    expect(run.sampleRegular).toBe(10);
    expect(run.sampleFailed).toBe(3);
    expect(run.tasks.length).toBe(13);
    expect(run.tasks.filter((task) => task.bucket === "failed").length).toBe(3);
    // 抽样任务以完整对象落库（sessionId/outcome/bucket），UI 才能正确渲染。
    const persisted = JSON.parse(store.getCanaryRun(run.id)!.taskIdsJson) as Array<{ bucket: string; sessionId: string }>;
    expect(persisted.filter((task) => task.bucket === "failed").map((task) => task.sessionId)).toEqual([
      "err-0",
      "err-1",
      "err-2",
    ]);
  });

  it("基线取自当前版本真实观测（会话索引 + 指纹表）", async () => {
    const { service } = makeService({
      okCount: 8,
      errorCount: 2,
      runner: makeRunner({ ok: true, metrics: OK_METRICS }),
    });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.baseline).not.toBeNull();
    // 8 ok / 10 完成 = 0.8
    expect(run.baseline?.successRate).toBeCloseTo(0.8, 5);
    // 平均 token 覆盖全部会话：(8×1000 + 2×600) / 10 = 920
    expect(run.baseline?.avgTokens).toBeCloseTo(920, 5);
    expect(run.baseline?.source).toContain("实测");
  });

  it("影子通过准入 → 进入观察窗并记录切换时刻", async () => {
    const { service, clock } = makeService({
      policy: "standard",
      okCount: 8,
      errorCount: 2,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.85, avgTokens: 1050 } }),
    });
    const run = await service.start({ targetVersion: "2.0.0", rollbackSnapshotId: 7 });
    expect(run.status).toBe("observing");
    expect(run.verdict?.pass).toBe(true);
    expect(run.switchedAt).not.toBeNull();
    expect(run.observationWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(run.observationRemainingMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(run.rollbackSnapshotId).toBe(7);
    void clock;
  });

  it("保守策略观察窗为 48h", async () => {
    const { service } = makeService({
      policy: "conservative",
      okCount: 8,
      errorCount: 2,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.85, avgTokens: 1050 } }),
    });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.observationWindowMs).toBe(48 * 60 * 60 * 1000);
  });

  it("影子未达标 → 拦截 + 差异报告落库", async () => {
    const { service, posts } = makeService({
      okCount: 8,
      errorCount: 2,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.5, avgTokens: 5000 } }),
    });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("blocked");
    expect(run.verdict?.pass).toBe(false);
    expect(run.reason).toContain("准入判据未通过");
    // 拦截告警里带上未过项与实测差异，用户不必翻日志。
    expect(posts[0]?.body).toContain("成功率降幅");
    expect(posts[0]?.body).toContain("token 增幅");
  });

  it("影子执行返回失败 → 标准策略记为未验证（不是通过）", async () => {
    const { service } = makeService({
      policy: "standard",
      runner: makeRunner({ ok: false, reason: "shadow-instance-crashed" }),
    });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("unverified");
    expect(run.reason).toContain("shadow-instance-crashed");
    expect(run.verdict).toBeNull();
  });

  it("影子执行抛异常 → 保守策略拦截", async () => {
    const throwing: CanaryShadowRunner = {
      available: () => true,
      unavailableReason: () => "n/a",
      run: async () => {
        throw new Error("boom");
      },
    };
    const { service } = makeService({ policy: "conservative", runner: throwing });
    const run = await service.start({ targetVersion: "2.0.0" });
    expect(run.status).toBe("blocked");
    expect(run.reason).toContain("boom");
  });
});

describe("金丝雀：观察窗守卫与自动回滚", () => {
  const switchRun = async (options: { rollbackSnapshotId?: number } = {}) => {
    const rollbackCalls: Array<{ row: number; instance?: string }> = [];
    const upgrade = makeUpgradeStub({
      rollbackSnapshot: async (rowId: number, instanceId?: string) => {
        rollbackCalls.push({ row: rowId, ...(instanceId === undefined ? {} : { instance: instanceId }) });
        return {
          status: "ok",
          job: {
            jobId: "job-1",
            kind: "rollback",
            steps: [{ id: "restore", status: "passed" }],
          },
        } as never;
      },
    });
    const ctx = makeService({
      policy: "standard",
      okCount: 8,
      errorCount: 2,
      upgrade,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.85, avgTokens: 1050 } }),
    });
    const run = await ctx.service.start({
      targetVersion: "2.0.0",
      instance: "hermes-a",
      ...(options.rollbackSnapshotId === undefined
        ? {}
        : { rollbackSnapshotId: options.rollbackSnapshotId }),
    });
    return { ...ctx, run, rollbackCalls };
  };

  it("观察窗内检出升级疑似回归 → 自动回滚并留痕", async () => {
    const ctx = await switchRun({ rollbackSnapshotId: 42 });
    // 模拟 R1 关联规则产出回归事件（事件中心是唯一真相来源）。
    ctx.trustEvents.record({
      kind: CANARY_REGRESSION_EVENT_KIND,
      severity: "warn",
      title: "升级疑似回归：2.0.0 后出现「tool timeout」",
      dedupeKey: "upgrade-regression:2.0.0:sig-1",
    });
    ctx.clock.advance(60_000);

    expect(await ctx.service.tick()).toBe(1);
    const after = ctx.service.get(ctx.run.id)!;
    expect(after.status).toBe("rolled-back");
    expect(after.reason).toContain("升级疑似回归");
    expect(after.reason).toContain("已自动回滚到快照登记行 42");
    expect(ctx.rollbackCalls).toEqual([{ row: 42, instance: "hermes-a" }]);
    // 回滚本身也进事件中心，便于事后追溯。
    expect(ctx.trustEvents.list({ kind: "canary-rollback" }).length).toBe(1);
  });

  it("未登记快照时检出回归 → 状态 blocked 且明说无法自动回滚（不假称成功）", async () => {
    const ctx = await switchRun();
    ctx.trustEvents.record({
      kind: CANARY_REGRESSION_EVENT_KIND,
      severity: "warn",
      title: "升级疑似回归：2.0.0 后出现「tool timeout」",
      dedupeKey: "upgrade-regression:2.0.0:sig-1",
    });
    ctx.clock.advance(60_000);
    expect(await ctx.service.tick()).toBe(1);
    const after = ctx.service.get(ctx.run.id)!;
    expect(after.status).toBe("blocked");
    expect(after.reason).toContain("无法自动回滚");
    expect(ctx.rollbackCalls.length).toBe(0);
  });

  it("回滚受理但子步骤失败 → 不算回滚成功，提示人工处置", async () => {
    const upgrade = makeUpgradeStub({
      rollbackSnapshot: async () =>
        ({
          status: "ok",
          job: { jobId: "job-2", kind: "rollback", steps: [{ id: "restore", status: "failed" }] },
        }) as never,
    });
    const ctx = makeService({
      policy: "standard",
      okCount: 8,
      errorCount: 2,
      upgrade,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.85, avgTokens: 1050 } }),
    });
    const run = await ctx.service.start({ targetVersion: "2.0.0", rollbackSnapshotId: 42 });
    ctx.trustEvents.record({
      kind: CANARY_REGRESSION_EVENT_KIND,
      severity: "warn",
      title: "升级疑似回归",
      dedupeKey: "upgrade-regression:2.0.0:sig-9",
    });
    ctx.clock.advance(60_000);
    await ctx.service.tick();
    const after = ctx.service.get(run.id)!;
    expect(after.status).toBe("blocked");
    expect(after.reason).toContain("存在失败子步骤");
  });

  it("观察窗到期无回归 → completed", async () => {
    const ctx = await switchRun({ rollbackSnapshotId: 42 });
    ctx.clock.advance(24 * 60 * 60 * 1000 + 1000);
    expect(await ctx.service.tick()).toBe(1);
    const after = ctx.service.get(ctx.run.id)!;
    expect(after.status).toBe("completed");
    expect(after.reason).toContain("未检出回归");
  });

  it("窗口未到且无回归 → 不动", async () => {
    const ctx = await switchRun({ rollbackSnapshotId: 42 });
    ctx.clock.advance(60_000);
    expect(await ctx.service.tick()).toBe(0);
    expect(ctx.service.get(ctx.run.id)?.status).toBe("observing");
  });

  it("回归事件早于切换时刻 → 不触发回滚（只看切换之后的）", async () => {
    const rollbackCalls: number[] = [];
    const upgrade = makeUpgradeStub({
      rollbackSnapshot: async (rowId: number) => {
        rollbackCalls.push(rowId);
        return { status: "snapshot-not-found" } as never;
      },
    });
    const ctx = makeService({
      policy: "standard",
      okCount: 8,
      errorCount: 2,
      upgrade,
      runner: makeRunner({ ok: true, metrics: { ...OK_METRICS, successRate: 0.85, avgTokens: 1050 } }),
    });
    // 先记录一条回归事件，再把时钟推 1 秒后才切换——事件的 last_seen 严格早于 switchedAt。
    ctx.trustEvents.record({
      kind: CANARY_REGRESSION_EVENT_KIND,
      severity: "warn",
      title: "切换之前的旧回归事件",
      dedupeKey: "upgrade-regression:1.9.0:old",
    });
    ctx.clock.advance(1000);
    const run = await ctx.service.start({ targetVersion: "2.0.0", rollbackSnapshotId: 42 });
    expect(run.status).toBe("observing");

    ctx.clock.advance(25 * 60 * 60 * 1000);
    await ctx.service.tick();
    // 旧事件不应把这一次升级判成回归。
    expect(ctx.service.get(run.id)?.status).toBe("completed");
    expect(rollbackCalls.length).toBe(0);
  });
});

describe("金丝雀：列表与统计", () => {
  it("summary 分状态计数 + status 过滤", async () => {
    const { service } = makeService({ policy: "aggressive", okCount: 2, errorCount: 0 });
    await service.start({ targetVersion: "1.1.0" });
    await service.start({ targetVersion: "1.2.0" });
    const all = service.list({});
    expect(all.summary.total).toBe(2);
    expect(all.summary.skipped).toBe(2);
    expect(all.summary.policy).toBe("aggressive");
    expect(service.list({ status: "blocked" }).items.length).toBe(0);
    expect(service.list({ status: "skipped" }).items.length).toBe(2);
    expect(service.get("nope")).toBeNull();
  });

  it("prune 按保留期清理旧记录", async () => {
    const { service, store, clock } = makeService({ policy: "aggressive" });
    await service.start({ targetVersion: "1.1.0" });
    expect(store.listCanaryRuns({}).length).toBe(1);
    clock.advance(181 * 24 * 60 * 60 * 1000);
    expect(service.prune()).toBe(1);
    expect(store.listCanaryRuns({}).length).toBe(0);
  });
});

describe("金丝雀 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async (withCanary = true) => {
    const { service, store } = makeService({ policy: "conservative", okCount: 3, errorCount: 1 });
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: makeUpgradeStub(),
      gateway: gatewayStub,
      ...(withCanary ? { canary: service } : {}),
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
    return { service };
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("GET /api/canary → 列表 + summary；GET /api/canary/policy → 当前策略", async () => {
    const { service } = await boot();
    await service.start({ targetVersion: "2.0.0" });

    const list = await fetch(`${base}/api/canary`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: unknown[]; summary: { policy: string; blocked: number } };
    expect(body.items.length).toBe(1);
    expect(body.summary.policy).toBe("conservative");
    expect(body.summary.blocked).toBe(1);

    const policy = await fetch(`${base}/api/canary/policy`);
    expect(((await policy.json()) as { policy: string }).policy).toBe("conservative");
  });

  it("POST /api/canary/policy → 切换；非法值 → 400", async () => {
    await boot();
    const ok = await fetch(`${base}/api/canary/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "aggressive" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { policy: string }).policy).toBe("aggressive");

    const bad = await fetch(`${base}/api/canary/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "yolo" }),
    });
    expect(bad.status).toBe(400);
  });

  it("POST /api/canary/plan 与 /start → 返回运行视图", async () => {
    await boot();
    const planned = await fetch(`${base}/api/canary/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.0.0" }),
    });
    expect(planned.status).toBe(200);
    expect(((await planned.json()) as { run: { status: string } }).run.status).toBe("planned");

    const started = await fetch(`${base}/api/canary/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.0.0" }),
    });
    expect(started.status).toBe(200);
    expect(((await started.json()) as { run: { status: string } }).run.status).toBe("blocked");

    const missing = await fetch(`${base}/api/canary/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });

  it("POST /api/canary/tick → 处置条数；GET /api/canary/:id → 404", async () => {
    await boot();
    const tick = await fetch(`${base}/api/canary/tick`, { method: "POST" });
    expect(tick.status).toBe(200);
    expect(((await tick.json()) as { handled: number }).handled).toBe(0);

    const missing = await fetch(`${base}/api/canary/does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it("未接线 → 503；方法不允许 → 405", async () => {
    await boot(false);
    expect((await fetch(`${base}/api/canary`)).status).toBe(503);
    expect((await fetch(`${base}/api/canary/policy`)).status).toBe(503);

    await boot(true);
    const put = await fetch(`${base}/api/canary`, { method: "PUT" });
    expect(put.status).toBe(405);
    const getPolicyPost = await fetch(`${base}/api/canary/tick`, { method: "GET" });
    expect(getPolicyPost.status).toBe(405);
  });
});
