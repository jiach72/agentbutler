/**
 * 网关限流统计与补丁参数面板测试（Task 15.1）：
 * - RATE_LIMIT_TEMPLATE_RE 正则命中/不命中（iLink 限流类模板识别）；
 * - buildRateLimitStats：过滤/聚合/排序/上限 20、24h 窗口截止（注入 nowMs）、
 *   overall 三档；
 * - buildSuggestions：三档（0 无建议 / 1-3 warn +15 / >3 critical +30 与 +10
 *   联动上限）、封顶（已到顶跳过）、下限保护（间隔 45 为 M3 硬边界）、
 *   applied 参数优先于登记默认值；
 * - createGatewayService：stats/patches 视图、apply/reapply/detect 的实例解析
 *   与结果映射（ok / unknown-patch / invalid-params / patch-conflict /
 *   no-instance）、审计落库。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PATCH_REGISTRY,
  type AppliedEntry,
  type ApplyOutcome,
  type DriftReport,
  type PatchManager,
} from "@butler/adapter-hermes";
import { fail, ok, type Result } from "@butler/contract";
import {
  createCore,
  type Core,
  type FingerprintRow,
  type FingerprintWindowRow,
} from "@butler/core";
import {
  buildRateLimitStats,
  buildSuggestions,
  createGatewayService,
  GATEWAY_ACTOR,
  PATCH_APPLY_ACTION,
  PATCH_DETECT_ACTION,
  PATCH_REAPPLY_ACTION,
  RATE_LIMIT_TEMPLATE_RE,
  type GatewayPanelService,
} from "../src/gateway-stats.js";

/* ------------------------------ 正则识别 ------------------------------ */

describe("RATE_LIMIT_TEMPLATE_RE（iLink 限流类模板识别）", () => {
  it("命中：英文限流表述各变体", () => {
    expect(RATE_LIMIT_TEMPLATE_RE.test("weixin send failed: rate limit exceeded")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("Rate-Limit circuit open, cooldown active")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("sendmessage rate_limit triggered")).toBe(true); // 下划线分隔
    expect(RATE_LIMIT_TEMPLATE_RE.test("too many requests, retry later")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("request frequency too high")).toBe(true); // frequen 前缀
  });

  it("命中：ret=-<NUM> 归一化模板（数值已变 <NUM>，只匹配 ret=- 前缀）", () => {
    expect(RATE_LIMIT_TEMPLATE_RE.test("iLink sendmessage ret=-<NUM> errcode=<NUM>")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("api call ret = -<NUM> rejected")).toBe(true); // 等号两侧空白
  });

  it("命中：中文限流表述", () => {
    expect(RATE_LIMIT_TEMPLATE_RE.test("iLink 限流：发送被拒")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("消息发送频率过高")).toBe(true);
    expect(RATE_LIMIT_TEMPLATE_RE.test("网关频控拦截")).toBe(true);
  });

  it("不命中：普通错误/告警模板", () => {
    expect(RATE_LIMIT_TEMPLATE_RE.test("MemoryError: cannot allocate <NUM> bytes")).toBe(false);
    expect(RATE_LIMIT_TEMPLATE_RE.test("Traceback (most recent call last): TypeError")).toBe(false);
    expect(RATE_LIMIT_TEMPLATE_RE.test("cache warning: slow query took <NUM>ms")).toBe(false);
    expect(RATE_LIMIT_TEMPLATE_RE.test("connection reset by peer")).toBe(false);
  });
});

/* ------------------------------ 纯函数夹具 ------------------------------ */

/** 构造指纹行（lastSample = 归一化模板）。 */
function fp(signature: string, lastSample: string | null, count: number): FingerprintRow {
  return {
    id: 1,
    signature,
    firstSeen: "2026-08-19T00:00:00.000Z",
    lastSeen: "2026-08-20T00:00:00.000Z",
    count,
    status: "open",
    lastSample,
  };
}

/** 构造指纹窗口行。 */
function win(signature: string, startedAt: string, count: number): FingerprintWindowRow {
  return { id: 1, signature, startedAt, endedAt: startedAt, count };
}

/** 固定当前时刻：2026-08-21T12:00:00Z。 */
const NOW_MS = Date.parse("2026-08-21T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

describe("buildRateLimitStats（聚合与 24h 截止）", () => {
  it("过滤命中指纹：matched 按 count 降序、上限 20 条；totalEvents 为全部命中合计", () => {
    // 25 条命中（count 1..25）+ 2 条不命中
    const fingerprints = [
      ...Array.from({ length: 25 }, (_, i) =>
        fp(`sig-rl-${i + 1}`, "iLink sendmessage ret=-<NUM>", i + 1),
      ),
      fp("sig-mem", "MemoryError: cannot allocate <NUM> bytes", 999),
      fp("sig-tb", "Traceback (most recent call last): TypeError", 888),
    ];
    const view = buildRateLimitStats(fingerprints, [], { nowMs: NOW_MS });
    expect(view.matched).toHaveLength(20); // 上限 20
    expect(view.matched[0]).toMatchObject({ signature: "sig-rl-25", count: 25 }); // 降序首位
    expect(view.matched[19]).toMatchObject({ signature: "sig-rl-6", count: 6 });
    expect(view.totalEvents).toBe(((1 + 25) * 25) / 2); // 命中合计 325（不命中 999/888 不计）
    expect(view.last24h).toBe(0); // 无窗口 → ok
    expect(view.overall).toBe("ok");
    expect(view.suggestions).toEqual([]); // 由 buildSuggestions 填充
  });

  it("matched 视图字段完整（signature/template/count/firstSeen/lastSeen/status）", () => {
    const view = buildRateLimitStats([fp("sig-a", "rate limit exceeded", 7)], [], {
      nowMs: NOW_MS,
    });
    expect(view.matched).toEqual([
      {
        signature: "sig-a",
        template: "rate limit exceeded",
        count: 7,
        firstSeen: "2026-08-19T00:00:00.000Z",
        lastSeen: "2026-08-20T00:00:00.000Z",
        status: "open",
      },
    ]);
  });

  it("last24h：只统计命中签名集合内 startedAt ≥ nowMs-24h 的窗口", () => {
    const fingerprints = [
      fp("sig-rl", "iLink 限流：发送被拒", 10),
      fp("sig-other", "MemoryError", 5),
    ];
    const windows = [
      win("sig-rl", new Date(NOW_MS - 23 * HOUR_MS).toISOString(), 3), // 23h 前 → 计入
      win("sig-rl", new Date(NOW_MS - 25 * HOUR_MS).toISOString(), 9), // 25h 前 → 截止外
      win("sig-rl", new Date(NOW_MS - 1 * HOUR_MS).toISOString(), 1), // 1h 前 → 计入
      win("sig-other", new Date(NOW_MS - 1 * HOUR_MS).toISOString(), 50), // 非命中签名 → 不计
    ];
    const view = buildRateLimitStats(fingerprints, windows, { nowMs: NOW_MS });
    expect(view.last24h).toBe(4);
    expect(view.totalEvents).toBe(10);
    expect(view.overall).toBe("critical"); // 1-3 warn、>3 critical；4 > 3 → critical
  });

  it("overall 三档：0 → ok；1-3 → warn；>3 → critical", () => {
    const fingerprints = [fp("sig-rl", "too many requests", 1)];
    const at = (hoursAgo: number, count: number) => [
      win("sig-rl", new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString(), count),
    ];
    expect(buildRateLimitStats(fingerprints, at(1, 0), { nowMs: NOW_MS }).overall).toBe("ok");
    expect(buildRateLimitStats(fingerprints, at(1, 1), { nowMs: NOW_MS }).overall).toBe("warn");
    expect(buildRateLimitStats(fingerprints, at(1, 3), { nowMs: NOW_MS }).overall).toBe("warn");
    expect(buildRateLimitStats(fingerprints, at(1, 4), { nowMs: NOW_MS }).overall).toBe("critical");
  });
});

/* ------------------------------ 画像建议 ------------------------------ */

const APPLIED_ENTRY = (params: Record<string, number>): AppliedEntry => ({
  params,
  appliedAt: "2026-08-20T00:00:00.000Z",
  targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
});

describe("buildSuggestions（观察模式三档建议）", () => {
  it("last24h = 0 → 空数组", () => {
    expect(buildSuggestions({ last24h: 0, registry: PATCH_REGISTRY, applied: {} })).toEqual([]);
  });

  it("1-3 条（warn）：发送间隔 +15（默认值 45 → 60），单条建议", () => {
    const suggestions = buildSuggestions({ last24h: 2, registry: PATCH_REGISTRY, applied: {} });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      patchId: "wx-send-throttle",
      param: "minSendIntervalSec",
      current: 45,
      suggested: 60,
      level: "warn",
    });
    expect(suggestions[0]!.reason).toContain("近 24 小时限流事件 2 条");
  });

  it(">3 条（critical）：间隔 +30（45 → 75）且静默延迟 +10（20 → 30，≤ 建议后间隔）", () => {
    const suggestions = buildSuggestions({ last24h: 5, registry: PATCH_REGISTRY, applied: {} });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      patchId: "wx-send-throttle",
      param: "minSendIntervalSec",
      current: 45,
      suggested: 75,
      level: "critical",
    });
    expect(suggestions[1]).toMatchObject({
      patchId: "wx-silent-first-delay",
      param: "silentFirstDelaySec",
      current: 20,
      suggested: 30,
      level: "critical",
    });
    // 联动不变式：延迟建议值 ≤ 间隔建议值
    expect(suggestions[1]!.suggested).toBeLessThanOrEqual(suggestions[0]!.suggested);
  });

  it("联动上限：延迟建议封顶到建议后的发送间隔（70 → 75 而非 80）", () => {
    const suggestions = buildSuggestions({
      last24h: 9,
      registry: PATCH_REGISTRY,
      applied: { "wx-silent-first-delay": APPLIED_ENTRY({ silentFirstDelaySec: 70 }) },
    });
    const delay = suggestions.find((s) => s.param === "silentFirstDelaySec")!;
    expect(delay.suggested).toBe(75); // min(70+10, 间隔建议 75, max 3600)
  });

  it("封顶：间隔已 3600 → 跳过该条；延迟已 3600 → 两条全无", () => {
    // 间隔到顶，延迟仍默认 20 → 只有延迟建议（30 ≤ 3600）
    const onlyDelay = buildSuggestions({
      last24h: 5,
      registry: PATCH_REGISTRY,
      applied: { "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 3600 }) },
    });
    expect(onlyDelay.map((s) => s.patchId)).toEqual(["wx-silent-first-delay"]);
    expect(onlyDelay[0]).toMatchObject({ current: 20, suggested: 30 });

    // 两者均到顶 → 无建议
    const none = buildSuggestions({
      last24h: 5,
      registry: PATCH_REGISTRY,
      applied: {
        "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 3600 }),
        "wx-silent-first-delay": APPLIED_ENTRY({ silentFirstDelaySec: 3600 }),
      },
    });
    expect(none).toEqual([]);
  });

  it("下限保护：current 45 → 建议至少 45+15；低于 min 的脏数据不低于 45（M3 硬边界）", () => {
    const normal = buildSuggestions({
      last24h: 2,
      registry: PATCH_REGISTRY,
      applied: { "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 45 }) },
    });
    expect(normal[0]).toMatchObject({ current: 45, suggested: 60 }); // 45+15

    // 脏数据 30（低于 schema min）：建议抬回下限 45，不更低
    const dirty = buildSuggestions({
      last24h: 2,
      registry: PATCH_REGISTRY,
      applied: { "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 30 }) },
    });
    expect(dirty[0]).toMatchObject({ current: 30, suggested: 45 });
  });

  it("applied 参数优先于登记默认值：current 120 → 建议 135（warn）", () => {
    const suggestions = buildSuggestions({
      last24h: 1,
      registry: PATCH_REGISTRY,
      applied: { "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 120 }) },
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ current: 120, suggested: 135, level: "warn" });
  });

  it("无纳管状态时使用源码 observed 参数：实际 30 → 建议 45（warn）", () => {
    const suggestions = buildSuggestions({
      last24h: 1,
      registry: PATCH_REGISTRY,
      applied: {},
      observed: { "wx-send-throttle": { minSendIntervalSec: 30 } },
    });
    expect(suggestions[0]).toMatchObject({ current: 30, suggested: 45, level: "warn" });
  });

  it("登记表缺 wx-send-throttle 时（异常入参）不产生建议", () => {
    expect(buildSuggestions({ last24h: 5, registry: [], applied: {} })).toEqual([]);
  });
});

/* ------------------------------ 服务层（真实 Core + fake patchManager） ------------------------------ */

/** 可配置 fake 补丁管理器：记录调用并可切换 apply/reapply/detect 返回。 */
interface FakeManagerH {
  manager: PatchManager;
  applyCalls: Array<{ patchId: string; params: Record<string, number>; rootPath?: string }>;
  reapplyCalls: Array<{ patchId: string; params: Record<string, number>; rootPath?: string }>;
  detectCalls: Array<{ patchId: string; rootPath?: string }>;
  applied: Record<string, AppliedEntry>;
  setApplyResult(result: Result<ApplyOutcome>): void;
  setDetectResult(result: Result<DriftReport>): void;
  setDetectResultFor(patchId: string, result: Result<DriftReport>): void;
}

function makeFakePatchManager(applied: Record<string, AppliedEntry> = {}): FakeManagerH {
  const applyCalls: FakeManagerH["applyCalls"] = [];
  const reapplyCalls: FakeManagerH["reapplyCalls"] = [];
  const detectCalls: FakeManagerH["detectCalls"] = [];
  let applyResult: Result<ApplyOutcome> = ok({
    status: "applied",
    targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
    params: { minSendIntervalSec: 60 },
  });
  let detectResult: Result<DriftReport> = ok({
    patchId: "wx-send-throttle",
    status: "ok",
    diffs: [],
    checkedAt: "2026-08-21T12:00:00.000Z",
  });
  const detectResults = new Map<string, Result<DriftReport>>();
  const manager: PatchManager = {
    listPatches: () => [...PATCH_REGISTRY],
    state: async () => applied,
    apply: async (patchId, params = {}, context = {}) => {
      applyCalls.push({ patchId, params, rootPath: context.rootPath });
      return applyResult;
    },
    reapply: async (patchId, params = {}, context = {}) => {
      reapplyCalls.push({ patchId, params, rootPath: context.rootPath });
      return applyResult;
    },
    detect: async (patchId, context = {}) => {
      detectCalls.push({ patchId, rootPath: context.rootPath });
      return detectResults.get(patchId) ?? detectResult;
    },
  };
  return {
    manager,
    applyCalls,
    reapplyCalls,
    detectCalls,
    applied,
    setApplyResult: (result) => {
      applyResult = result;
    },
    setDetectResult: (result) => {
      detectResult = result;
    },
    setDetectResultFor: (patchId, result) => {
      detectResults.set(patchId, result);
    },
  };
}

let tmp: string;
let core: Core;

/** 登记一个实例并推进到指定状态（Serving / Confirmed）。 */
function addInstance(instanceId: string, rootPath: string, serving: boolean): void {
  const created = core.instances.createInstance({
    instanceId,
    frameworkId: "hermes",
    runtime: "process",
    rootPath,
    version: "0.20.4",
    confidence: 0.9,
  });
  expect(created.ok).toBe(true);
  core.instances.beginDiscover(instanceId);
  expect(core.instances.confirmInstance(instanceId, "auto").ok).toBe(true);
  if (serving) {
    core.instances.beginNegotiate(instanceId);
    expect(core.instances.markServing(instanceId, 0).ok).toBe(true);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-gateway-"));
  core = createCore({ home: tmp });
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createGatewayService：stats / patches", () => {
  it("stats()：store 指纹/窗口 + patchManager.state() 汇成面板视图与建议", async () => {
    // 命中签名 ×3（count 3）+ 不命中 ×2
    for (let i = 0; i < 3; i += 1)
      core.store.upsertFingerprint("sig-rl", "iLink sendmessage ret=-<NUM>");
    for (let i = 0; i < 2; i += 1) core.store.upsertFingerprint("sig-mem", "MemoryError");
    // 窗口：命中签名 2h 前 count 4（计入）；30h 前 count 9（截止外）；不命中 1h 前（不计）
    core.store.insertFingerprintWindow({
      signature: "sig-rl",
      startedAt: new Date(NOW_MS - 2 * HOUR_MS).toISOString(),
      endedAt: new Date(NOW_MS - 2 * HOUR_MS).toISOString(),
      count: 4,
    });
    core.store.insertFingerprintWindow({
      signature: "sig-rl",
      startedAt: new Date(NOW_MS - 30 * HOUR_MS).toISOString(),
      endedAt: new Date(NOW_MS - 30 * HOUR_MS).toISOString(),
      count: 9,
    });
    core.store.insertFingerprintWindow({
      signature: "sig-mem",
      startedAt: new Date(NOW_MS - 1 * HOUR_MS).toISOString(),
      endedAt: new Date(NOW_MS - 1 * HOUR_MS).toISOString(),
      count: 5,
    });

    const h = makeFakePatchManager({
      "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 120 }),
    });
    const gateway = createGatewayService({ core, patchManager: h.manager, now: () => NOW_MS });
    const view = await gateway.stats();
    expect(view.overall).toBe("critical"); // last24h = 4 > 3
    expect(view.totalEvents).toBe(3);
    expect(view.last24h).toBe(4);
    expect(view.matched).toHaveLength(1);
    expect(view.matched[0]).toMatchObject({
      signature: "sig-rl",
      count: 3,
      template: "iLink sendmessage ret=-<NUM>",
    });
    // applied 参数优先：120 → 150（critical +30）；延迟默认 20 → 30（≤150）
    expect(view.suggestions).toHaveLength(2);
    expect(view.suggestions[0]).toMatchObject({ current: 120, suggested: 150, level: "critical" });
    expect(view.suggestions[1]).toMatchObject({ current: 20, suggested: 30, level: "critical" });
  });

  it("patches()：登记表逐条映射 + applied 状态（未应用为 null；requires 仅在前置存在时出现）", async () => {
    const h = makeFakePatchManager({
      "wx-send-throttle": APPLIED_ENTRY({ minSendIntervalSec: 60 }),
    });
    const gateway = createGatewayService({ core, patchManager: h.manager });
    const patches = await gateway.patches();
    expect(patches.map((p) => p.id)).toEqual([
      "wx-send-throttle",
      "wx-silent-first-delay",
      "wx-reply-shaping",
    ]);

    const throttle = patches[0]!;
    expect(throttle.title).toBe(PATCH_REGISTRY[0]!.title);
    expect(throttle.target).toBe("hermes-agent/gateway/platforms/weixin.py");
    expect(throttle.params).toEqual({
      minSendIntervalSec: { type: "number", default: 45, min: 45, max: 3600 },
    });
    expect(throttle.applied).toEqual({
      params: { minSendIntervalSec: 60 },
      appliedAt: "2026-08-20T00:00:00.000Z",
      targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
    });
    expect(throttle.observed).toBeNull();

    const silent = patches[1]!;
    expect(silent.applied).toBeNull();
    expect(silent.requires).toEqual(["wx-send-throttle"]); // 前置补丁透出
    const shaping = patches[2]!;
    expect(shaping.applied).toBeNull();
    expect("requires" in shaping).toBe(false); // 无前置 → 无 requires 字段
    expect(shaping.params["attachmentBudgetPerMsg"]).toMatchObject({
      default: 1,
      min: 1,
      max: 10,
      integer: true,
    });
  });

  it("patches()：无 state 时把真实源码命中映射为 observed，并保留实际参数", async () => {
    addInstance("hermes-main", "/home/jiach/.hermes", true);
    const h = makeFakePatchManager();
    const reports: Record<string, DriftReport> = {
      "wx-send-throttle": {
        patchId: "wx-send-throttle",
        status: "observed",
        params: { minSendIntervalSec: 30 },
        targetPath: "/home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py",
        diffs: [],
        checkedAt: "2026-08-21T12:00:00.000Z",
      },
      "wx-silent-first-delay": {
        patchId: "wx-silent-first-delay",
        status: "observed",
        params: { silentFirstDelaySec: 30 },
        targetPath: "/home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py",
        diffs: [],
        checkedAt: "2026-08-21T12:00:00.000Z",
      },
      "wx-reply-shaping": {
        patchId: "wx-reply-shaping",
        status: "observed",
        params: { attachmentBudgetPerMsg: 1, splitThresholdChars: 2000 },
        targetPath: "/home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py",
        diffs: [],
        checkedAt: "2026-08-21T12:00:00.000Z",
      },
    };
    for (const [patchId, report] of Object.entries(reports)) {
      h.setDetectResultFor(patchId, ok(report));
    }

    const gateway = createGatewayService({ core, patchManager: h.manager });
    const patches = await gateway.patches();
    expect(patches.map((patch) => patch.observed?.params)).toEqual([
      { minSendIntervalSec: 30 },
      { silentFirstDelaySec: 30 },
      { attachmentBudgetPerMsg: 1, splitThresholdChars: 2000 },
    ]);
    expect(patches.every((patch) => patch.applied === null)).toBe(true);
    expect(h.detectCalls).toEqual(
      PATCH_REGISTRY.map((patch) => ({ patchId: patch.id, rootPath: "/home/jiach/.hermes" })),
    );
  });
});

describe("createGatewayService：applyPatch / reapplyPatch / detectPatch", () => {
  it("ok 路径：显式 instanceId 精确解析 → rootPath 透传 → 结果映射 + 审计落库", async () => {
    addInstance("ins-a", "/hermes/a", true);
    addInstance("ins-b", "/hermes/b", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({ core, patchManager: h.manager });

    const outcome = await gateway.applyPatch({
      patchId: "wx-send-throttle",
      params: { minSendIntervalSec: 60 },
      instanceId: "ins-b",
    });
    expect(outcome).toEqual({
      status: "ok",
      result: "applied",
      targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
      params: { minSendIntervalSec: 60 },
    });
    expect(h.applyCalls).toEqual([
      { patchId: "wx-send-throttle", params: { minSendIntervalSec: 60 }, rootPath: "/hermes/b" },
    ]);

    const audits = core.audit.list({ action: PATCH_APPLY_ACTION });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: GATEWAY_ACTOR, target: "ins-b" });
    expect(audits[0]!.detail).toMatchObject({
      patchId: "wx-send-throttle",
      params: { minSendIntervalSec: 60 },
      outcome: { status: "ok", result: "applied" },
    });
  });

  it("缺省实例解析：取首个 rootPath 非空实例，优先 Serving（Confirmed 在前也不抢）", async () => {
    addInstance("ins-confirmed", "/hermes/confirmed", false); // Confirmed（非 Serving）
    addInstance("ins-serving", "/hermes/serving", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({ core, patchManager: h.manager });

    await gateway.applyPatch({ patchId: "wx-send-throttle" });
    expect(h.applyCalls[0]!.rootPath).toBe("/hermes/serving");

    await gateway.reapplyPatch({
      patchId: "wx-silent-first-delay",
      params: { silentFirstDelaySec: 30 },
    });
    expect(h.reapplyCalls[0]).toEqual({
      patchId: "wx-silent-first-delay",
      params: { silentFirstDelaySec: 30 },
      rootPath: "/hermes/serving",
    });
    expect(core.audit.list({ action: PATCH_REAPPLY_ACTION })).toHaveLength(1);
  });

  it("未知补丁 → unknown-patch（未触达管理器）；无实例 → no-instance", async () => {
    addInstance("ins-a", "/hermes/a", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({ core, patchManager: h.manager });

    await expect(gateway.applyPatch({ patchId: "no-such-patch" })).resolves.toEqual({
      status: "unknown-patch",
    });
    await expect(gateway.detectPatch({ patchId: "no-such-patch" })).resolves.toEqual({
      status: "unknown-patch",
    });
    expect(h.applyCalls).toHaveLength(0);
    expect(h.detectCalls).toHaveLength(0);

    // 无任何实例注册（新建 core）
    const emptyCore = createCore({ home: join(tmp, "empty-home") });
    try {
      const emptyGateway = createGatewayService({ core: emptyCore, patchManager: h.manager });
      await expect(emptyGateway.applyPatch({ patchId: "wx-send-throttle" })).resolves.toEqual({
        status: "no-instance",
      });
      await expect(emptyGateway.detectPatch({ patchId: "wx-send-throttle" })).resolves.toEqual({
        status: "no-instance",
      });
    } finally {
      emptyCore.close();
    }
  });

  it("E002 → invalid-params（userHint 优先）；E203 → patch-conflict", async () => {
    addInstance("ins-a", "/hermes/a", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({ core, patchManager: h.manager });

    h.setApplyResult(
      fail("E002", "param below floor", { userHint: "发送间隔下限 45 秒为 M3 硬边界" }),
    );
    await expect(
      gateway.applyPatch({ patchId: "wx-send-throttle", params: { minSendIntervalSec: 10 } }),
    ).resolves.toEqual({
      status: "invalid-params",
      error: "发送间隔下限 45 秒为 M3 硬边界",
    });

    h.setApplyResult(
      fail("E203", "anchor not found", { userHint: "锚点未找到，目标文件可能已升级" }),
    );
    await expect(gateway.reapplyPatch({ patchId: "wx-send-throttle" })).resolves.toEqual({
      status: "patch-conflict",
      error: "锚点未找到，目标文件可能已升级",
    });
    expect(core.audit.list({ action: PATCH_REAPPLY_ACTION })[0]!.detail).toMatchObject({
      outcome: { status: "patch-conflict" },
    });
  });

  it("面板写入口遇到 observed 手工实现 → 拒绝覆盖且不调用 apply", async () => {
    addInstance("ins-a", "/hermes/a", true);
    const h = makeFakePatchManager();
    h.setDetectResult(
      ok({
        patchId: "wx-send-throttle",
        status: "observed",
        params: { minSendIntervalSec: 30 },
        targetPath: "/hermes/a/hermes-agent/gateway/platforms/weixin.py",
        diffs: [],
        checkedAt: "2026-08-21T12:00:00.000Z",
      }),
    );
    const gateway = createGatewayService({ core, patchManager: h.manager });

    await expect(
      gateway.applyPatch({ patchId: "wx-send-throttle", params: { minSendIntervalSec: 45 } }),
    ).resolves.toEqual({
      status: "patch-conflict",
      error: "源码中已检测到同等手工实现；Butler 未纳管且不会覆盖，请保留只读观察",
    });
    expect(h.applyCalls).toHaveLength(0);
  });

  it("面板写入口在配置不变式失败时拒绝 apply/reapply", async () => {
    addInstance("ins-a", "/hermes/a", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({
      core,
      patchManager: h.manager,
      validateConfig: async () =>
        ok({
          passed: false,
          violations: [
            {
              invariant: "INV-weixin-open-policy",
              severity: "block",
              detail: "开放策略缺少白名单",
            },
          ],
        }),
    });

    await expect(
      gateway.applyPatch({ patchId: "wx-send-throttle", params: { minSendIntervalSec: 45 } }),
    ).resolves.toEqual({ status: "config-blocked", error: "开放策略缺少白名单" });
    await expect(
      gateway.reapplyPatch({ patchId: "wx-send-throttle", params: { minSendIntervalSec: 45 } }),
    ).resolves.toEqual({ status: "config-blocked", error: "开放策略缺少白名单" });
    expect(h.applyCalls).toHaveLength(0);
    expect(h.reapplyCalls).toHaveLength(0);
  });

  it("detectPatch：ok → { status, report }（rootPath 透传 + 审计 patch-detect）", async () => {
    addInstance("ins-a", "/hermes/a", true);
    const h = makeFakePatchManager();
    const gateway = createGatewayService({ core, patchManager: h.manager });

    const report: DriftReport = {
      patchId: "wx-send-throttle",
      status: "ok",
      params: { minSendIntervalSec: 60 },
      appliedAt: "2026-08-20T00:00:00.000Z",
      targetPath: "/hermes/a/hermes-agent/gateway/platforms/weixin.py",
      diffs: [],
      checkedAt: "2026-08-21T12:00:00.000Z",
    };
    h.setDetectResult(ok(report));
    await expect(gateway.detectPatch({ patchId: "wx-send-throttle" })).resolves.toEqual({
      status: "ok",
      report,
    });
    expect(h.detectCalls).toEqual([{ patchId: "wx-send-throttle", rootPath: "/hermes/a" }]);
    expect(core.audit.list({ action: PATCH_DETECT_ACTION })).toHaveLength(1);
  });
});

/* ------------------------------ 服务类型面（编译期契约） ------------------------------ */

it("GatewayPanelService 接口面：stats/patches/applyPatch/reapplyPatch/detectPatch", async () => {
  const h = makeFakePatchManager();
  const gateway: GatewayPanelService = createGatewayService({ core, patchManager: h.manager });
  expect(typeof gateway.stats).toBe("function");
  expect(typeof gateway.patches).toBe("function");
  expect(typeof gateway.applyPatch).toBe("function");
  expect(typeof gateway.reapplyPatch).toBe("function");
  expect(typeof gateway.detectPatch).toBe("function");
});
