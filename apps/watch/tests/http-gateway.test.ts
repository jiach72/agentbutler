/**
 * HTTP 控制通道网关端点测试（Task 15.1）：
 * - GET  /api/gateway/stats（200 { stats }，含尾斜杠归一）；
 * - GET  /api/gateway/patches（200 { patches }）；
 * - POST /api/gateway/patches/:id/apply 与 /reapply（200/400/404/409/503 +
 *   params/instanceId 透传 + :id URL 解码 + params 值非 number → 400）；
 * - POST /api/gateway/patches/:id/detect（200 { report } / 404 / 503）；
 * - 方法不符 405。
 *
 * 网关面板服务全 fake 注入（HTTP 层只做状态码映射），回环真实端口验证。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type {
  GatewayPanelService,
  PatchApplyOutcome,
  PatchDetectOutcome,
  PatchPanelView,
  RateLimitPanelView,
} from "../src/gateway-stats.js";
import type { DriftReport } from "@butler/adapter-hermes";

const STATS_VIEW: RateLimitPanelView = {
  overall: "warn",
  totalEvents: 12,
  last24h: 2,
  matched: [
    {
      signature: "abc123def4567890",
      template: "iLink sendmessage ret=-<NUM> rate limit",
      count: 12,
      firstSeen: "2026-08-20T00:00:00.000Z",
      lastSeen: "2026-08-21T10:00:00.000Z",
      status: "open",
    },
  ],
  suggestions: [
    {
      patchId: "wx-send-throttle",
      param: "minSendIntervalSec",
      current: 45,
      suggested: 60,
      level: "warn",
      reason: "近 24 小时限流事件 2 条，建议上调发送间隔",
    },
  ],
};

const PATCHES_VIEW: PatchPanelView[] = [
  {
    id: "wx-send-throttle",
    title: "微信发送间隔限流（Anti-断流）",
    description: "任意两条 iLink 出站消息之间至少间隔 minSendIntervalSec 秒",
    target: "hermes-agent/gateway/platforms/weixin.py",
    params: { minSendIntervalSec: { default: 45, min: 45, max: 3600 } },
    applied: null,
    observed: null,
  },
  {
    id: "wx-silent-first-delay",
    title: "静默期后首条消息预等待（连接冷却）",
    description: "重连/启动后首条消息先等 silentFirstDelaySec 秒再发",
    target: "hermes-agent/gateway/platforms/weixin.py",
    requires: ["wx-send-throttle"],
    params: { silentFirstDelaySec: { default: 20, min: 0, max: 3600 } },
    applied: {
      params: { silentFirstDelaySec: 30 },
      appliedAt: "2026-08-20T00:00:00.000Z",
      targetPath: "/h/weixin.py",
    },
    observed: null,
  },
];

const OK_APPLY: Extract<PatchApplyOutcome, { status: "ok" }> = {
  status: "ok",
  result: "applied",
  targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
  params: { minSendIntervalSec: 60 },
};

const DRIFT_REPORT: DriftReport = {
  patchId: "wx-send-throttle",
  status: "ok",
  params: { minSendIntervalSec: 60 },
  appliedAt: "2026-08-20T00:00:00.000Z",
  targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
  diffs: [],
  checkedAt: "2026-08-21T12:00:00.000Z",
};

interface GatewayState {
  statsView: RateLimitPanelView;
  patchesView: PatchPanelView[];
  applyOutcome: PatchApplyOutcome;
  reapplyOutcome: PatchApplyOutcome;
  detectOutcome: PatchDetectOutcome;
  applyCalls: Array<{ patchId: string; params?: Record<string, number>; instanceId?: string }>;
  reapplyCalls: Array<{ patchId: string; params?: Record<string, number>; instanceId?: string }>;
  detectCalls: Array<{ patchId: string; instanceId?: string }>;
}

function makeDeps(): { deps: WatchHttpDeps; state: GatewayState } {
  const state: GatewayState = {
    statsView: STATS_VIEW,
    patchesView: PATCHES_VIEW,
    applyOutcome: OK_APPLY,
    reapplyOutcome: { ...OK_APPLY, result: "already-applied" },
    detectOutcome: { status: "ok", report: DRIFT_REPORT },
    applyCalls: [],
    reapplyCalls: [],
    detectCalls: [],
  };
  const gateway: GatewayPanelService = {
    stats: async () => state.statsView,
    patches: async () => state.patchesView,
    applyPatch: async (input) => {
      state.applyCalls.push(input);
      return state.applyOutcome;
    },
    reapplyPatch: async (input) => {
      state.reapplyCalls.push(input);
      return state.reapplyOutcome;
    },
    detectPatch: async (input) => {
      state.detectCalls.push({ patchId: input.patchId, instanceId: input.instanceId });
      return state.detectOutcome;
    },
  };
  const deps: WatchHttpDeps = {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "no-servicing-instance" }),
    upgrade: {
      startUpgrade: () => ({ status: "missing-target-version" }),
      status: () => null,
      listVersions: async () => ({ reachable: false, versions: [] }),
      rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    },
    gateway,
  };
  return { deps, state };
}

describe("startWatchHttp 网关端点（fake 网关面板服务，回环真实端口）", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    http.close();
  });

  it("GET /api/gateway/stats → 200 { stats }（含尾斜杠归一）", async () => {
    const res = await fetch(`${base}/api/gateway/stats`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ stats: STATS_VIEW });

    // 尾斜杠归一
    const res2 = await fetch(`${base}/api/gateway/stats/`);
    expect(res2.status).toBe(200);
    await expect(res2.json()).resolves.toEqual({ stats: STATS_VIEW });
  });

  it("GET /api/gateway/patches → 200 { patches }（含尾斜杠归一）", async () => {
    const res = await fetch(`${base}/api/gateway/patches/`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ patches: PATCHES_VIEW });
  });

  it("恢复入口遇到未纳管手工补丁时返回可执行提示，不包装成 patch-apply-failed", async () => {
    fake.state.patchesView = [{
      ...PATCHES_VIEW[0],
      observed: {
        params: { minSendIntervalSec: 30 },
        checkedAt: "2026-08-28T00:00:00.000Z",
        targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
      },
    }, PATCHES_VIEW[1]!];
    const res = await fetch(`${base}/api/recovery/actions/apply-throttle-patch/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "patch-observed",
      nextAction: "open-gateway-patches",
      current: { minSendIntervalSec: 30 },
    });
    expect(fake.state.applyCalls).toHaveLength(0);
  });

  it("POST /api/gateway/patches/:id/apply → 200 { status, result, targetPath, params }（params/instanceId/:id 透传）", async () => {
    const res = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { minSendIntervalSec: 60 }, instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      result: "applied",
      targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
      params: { minSendIntervalSec: 60 },
    });
    expect(fake.state.applyCalls).toEqual([
      {
        patchId: "wx-send-throttle",
        params: { minSendIntervalSec: 60 },
        instanceId: "hermes-main",
      },
    ]);

    // 空 body → params/instanceId 缺省（undefined 透传）
    const res2 = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
    });
    expect(res2.status).toBe(200);
    expect(fake.state.applyCalls[1]).toEqual({
      patchId: "wx-send-throttle",
      params: undefined,
      instanceId: undefined,
    });
  });

  it(":id URL 解码（%2D → -）", async () => {
    const res = await fetch(`${base}/api/gateway/patches/wx%2Dsend%2Dthrottle/apply`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(fake.state.applyCalls[0]).toMatchObject({ patchId: "wx-send-throttle" });
  });

  it("POST /reapply → 200（result=already-applied 原样透出）", async () => {
    const res = await fetch(`${base}/api/gateway/patches/wx-silent-first-delay/reapply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { silentFirstDelaySec: 30 } }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      result: "already-applied",
      targetPath: "/hermes/hermes-agent/gateway/platforms/weixin.py",
      params: { minSendIntervalSec: 60 },
    });
    expect(fake.state.reapplyCalls).toEqual([
      {
        patchId: "wx-silent-first-delay",
        params: { silentFirstDelaySec: 30 },
        instanceId: undefined,
      },
    ]);
  });

  it("apply 分支：unknown-patch → 404；invalid-params → 400（detail=userHint）；patch-conflict → 409；no-instance → 503", async () => {
    fake.state.applyOutcome = { status: "unknown-patch" };
    const notFound = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
    });
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toEqual({ error: "unknown-patch" });

    fake.state.applyOutcome = { status: "invalid-params", error: "发送间隔下限 45 秒为 M3 硬边界" };
    const badParams = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
    });
    expect(badParams.status).toBe(400);
    await expect(badParams.json()).resolves.toEqual({
      error: "invalid-params",
      detail: "发送间隔下限 45 秒为 M3 硬边界",
    });

    fake.state.applyOutcome = { status: "patch-conflict", error: "锚点未找到，目标文件可能已升级" };
    const conflict = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "patch-conflict",
      detail: "锚点未找到，目标文件可能已升级",
    });

    fake.state.applyOutcome = { status: "no-instance" };
    const unavailable = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
      method: "POST",
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "no-instance" });
  });

  it("params 值非 number / params 非对象 → 400 invalid-params（不触达服务层）", async () => {
    for (const body of [
      '{"params":{"minSendIntervalSec":"60"}}',
      '{"params":{"minSendIntervalSec":true}}',
      '{"params":{"minSendIntervalSec":null}}',
      '{"params":["a"]}',
      '{"params":"x"}',
    ]) {
      const res = await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; detail?: string };
      expect(json.error).toBe("invalid-params");
      expect(typeof json.detail).toBe("string");
    }
    expect(fake.state.applyCalls).toHaveLength(0);
  });

  it("POST /api/gateway/patches/:id/detect → 200 { report }（instanceId 透传）", async () => {
    const res = await fetch(`${base}/api/gateway/patches/wx-send-throttle/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ report: DRIFT_REPORT });
    expect(fake.state.detectCalls).toEqual([
      { patchId: "wx-send-throttle", instanceId: "hermes-main" },
    ]);

    // 空 body → instanceId 缺省
    const res2 = await fetch(`${base}/api/gateway/patches/wx-send-throttle/detect`, {
      method: "POST",
    });
    expect(res2.status).toBe(200);
    expect(fake.state.detectCalls[1]).toEqual({
      patchId: "wx-send-throttle",
      instanceId: undefined,
    });
  });

  it("detect 分支：unknown-patch → 404；no-instance → 503", async () => {
    fake.state.detectOutcome = { status: "unknown-patch" };
    const notFound = await fetch(`${base}/api/gateway/patches/nope/detect`, { method: "POST" });
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toEqual({ error: "unknown-patch" });

    fake.state.detectOutcome = { status: "no-instance" };
    const unavailable = await fetch(`${base}/api/gateway/patches/wx-send-throttle/detect`, {
      method: "POST",
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "no-instance" });
  });

  it("方法不符 → 405（stats/patches/apply/reapply/detect 五端点）", async () => {
    expect((await fetch(`${base}/api/gateway/stats`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/gateway/patches`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/gateway/patches/wx-send-throttle/apply`)).status).toBe(405);
    expect((await fetch(`${base}/api/gateway/patches/wx-send-throttle/reapply`)).status).toBe(405);
    expect((await fetch(`${base}/api/gateway/patches/wx-send-throttle/detect`)).status).toBe(405);
  });

  it("未知路径 / 未知动作 → 404", async () => {
    expect((await fetch(`${base}/api/gateway/nope`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/gateway/patches/wx-send-throttle/remove`, { method: "POST" }))
        .status,
    ).toBe(404);
  });
});
