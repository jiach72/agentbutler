/**
 * butler-web 消息网关聚合与补丁代理测试（Task 15.2）：
 * - GET /api/gateway 并发聚合 watch 限流统计、补丁清单与 gateway 告警队列；
 * - watch / gateway 任一不可达时仅对应分区降级，不拖垮整页；
 * - apply / reapply / detect 三动作的路径、请求体、状态码与响应体原样透传。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer, type WebServerOptions } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";
const GATEWAY_URL = "http://127.0.0.1:7532";

const STATS = {
  overall: "critical",
  totalEvents: 67,
  last24h: 6,
  matched: [
    {
      signature: "sig-rate",
      template: "iLink send failed: ret=-<NUM> rate limit",
      count: 61,
      firstSeen: "2026-08-20T00:00:00.000Z",
      lastSeen: "2026-08-21T01:00:00.000Z",
      status: "open",
    },
  ],
  suggestions: [
    {
      patchId: "wx-send-throttle",
      param: "minSendIntervalSec",
      current: 45,
      suggested: 75,
      level: "critical",
      reason: "近 24 小时限流事件 6 条，建议上调发送间隔",
    },
  ],
};

const PATCHES = [
  {
    id: "wx-send-throttle",
    title: "微信发送间隔限流（Anti-断流）",
    description: "任意两条 iLink 出站消息之间至少间隔指定秒数。",
    target: "hermes-agent/gateway/platforms/weixin.py",
    params: { minSendIntervalSec: { default: 45, min: 45, max: 3600 } },
    applied: {
      params: { minSendIntervalSec: 60 },
      appliedAt: "2026-08-20T12:00:00.000Z",
      targetPath: "/home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py",
    },
    observed: null,
  },
];

const ALERTS = {
  counts: { pending: 2, delivering: 1, delivered: 8, failed: 1 },
  degradedChannels: ["smtp:missing-credentials"],
  items: [
    {
      id: 9,
      kind: "fingerprint",
      severity: "critical",
      title: "iLink 限流升级",
      body: "近 24 小时限流 6 次",
      source: "butler-watch",
      status: "pending",
      attempts: 0,
      mergedCount: 1,
      createdAt: "2026-08-21T01:00:00.000Z",
      updatedAt: "2026-08-21T01:00:00.000Z",
      deliveredAt: null,
      lastError: null,
      channel: null,
    },
  ],
};

const MESSAGE_COUNTS = {
  captured: 0,
  policy_pending: 0,
  held_dnd: 1,
  held_pacing: 0,
  ready: 0,
  delivering: 0,
  retry_wait: 0,
  delivered: 3,
  delivery_unknown: 0,
  absorbed: 0,
  policy_error: 0,
  dead_letter: 1,
  cancelled: 0,
};

const MESSAGE_STATUS = {
  bridge: {
    connected: true,
    running: true,
    inFlight: false,
    attached: true,
    outboxWritable: true,
    protocolVersion: 1,
    bridgeVersion: "bridge-v1",
    instanceId: "hermes-main",
    policyVersion: "message-policy-v1",
    policyHash: "policy-hash",
    remotePolicyVersion: "message-policy-v1",
    channels: { weixin: "ok", a2a: "ok" },
    coverage: { runtime: "ok", apiJson: "ok", apiSse: "ok" },
    startedAt: "2026-08-22T08:00:00.000Z",
    lastCycleAt: "2026-08-22T10:00:00.000Z",
    lastError: null,
  },
  counts: MESSAGE_COUNTS,
};

const MESSAGE_ITEM = {
  messageId: "m-live",
  instanceId: "hermes-main",
  adapterId: "hermes",
  channel: "weixin",
  accountId: null,
  chatId: "chat-1",
  threadId: null,
  sessionId: "session-1",
  runId: "run-1",
  inboundMessageId: "in-1",
  messageKind: "final",
  transport: "queued-push",
  priority: "normal",
  content: "AB_JSON_OK",
  contentSha256: "message-hash",
  replyTo: null,
  metadata: {},
  capturedAt: "2026-08-22T09:59:50.000Z",
  sequence: 7,
  state: "delivered",
  availableAt: null,
  attemptCount: 1,
  providerMessageId: "provider-1",
  deliveredAt: "2026-08-22T10:00:00.000Z",
  lastError: null,
  transformTrace: ["policy:allow", "delivery:accepted"],
  decisionId: "decision-1",
  lastPolicyError: null,
  updatedAt: "2026-08-22T10:00:00.000Z",
};

const MESSAGE_DEAD_LETTER = {
  ...MESSAGE_ITEM,
  messageId: "m-dead-letter",
  sequence: 6,
  runId: null,
  inboundMessageId: null,
  state: "dead_letter",
  providerMessageId: null,
  deliveredAt: null,
  lastError: "external delivery not authorized",
};

const MESSAGE_TASK = {
  runId: "run-1",
  sessionId: "session-1",
  state: "done",
  lastEventSequence: 2,
  updatedAt: "2026-08-22T10:00:00.000Z",
  events: [
    {
      runId: "run-1",
      sequence: 1,
      sessionId: "session-1",
      kind: "started",
      summary: "started",
      occurredAt: "2026-08-22T09:59:00.000Z",
    },
    {
      runId: "run-1",
      sequence: 2,
      sessionId: "session-1",
      kind: "done",
      summary: "finished",
      occurredAt: "2026-08-22T10:00:00.000Z",
    },
  ],
};

interface FakeRoute {
  status: number;
  body: unknown;
}

function makeFetch(routes: Record<string, FakeRoute | "throw">): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string; body: string }>;
} {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = String(init?.body ?? "");
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (route === "throw") throw new Error(`unreachable: ${url}`);
    if (route === undefined) {
      return new Response(JSON.stringify({ error: `no-route: ${method} ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake, calls };
}

describe("butler-web 消息网关聚合与补丁代理（Task 15.2，fastify inject）", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(fetchImpl: typeof fetch, extra: Partial<WebServerOptions> = {}): FastifyInstance {
    const app = createWebServer({
      home: tmp,
      uiDist,
      watchUrl: WATCH_URL,
      gatewayUrl: GATEWAY_URL,
      fetchImpl,
      ...extra,
    });
    apps.push(app);
    return app;
  }

  it("GET /api/gateway：三路数据聚合并补充 alerts.reachable=true", async () => {
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/gateway/stats`]: { status: 200, body: { stats: STATS } },
      [`GET ${WATCH_URL}/api/gateway/patches`]: { status: 200, body: { patches: PATCHES } },
      [`GET ${GATEWAY_URL}/api/alerts`]: { status: 200, body: ALERTS },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/gateway" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      watchReachable: true,
      rateLimit: STATS,
      patches: PATCHES,
      alerts: { reachable: true, ...ALERTS },
    });
    expect(transport.calls.map((call) => call.url).sort()).toEqual(
      [
        `${WATCH_URL}/api/gateway/stats`,
        `${WATCH_URL}/api/gateway/patches`,
        `${GATEWAY_URL}/api/alerts`,
      ].sort(),
    );
  });

  it("watch 不可达：rateLimit/patches 降级，告警队列仍可展示", async () => {
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/gateway/stats`]: "throw",
      [`GET ${WATCH_URL}/api/gateway/patches`]: "throw",
      [`GET ${GATEWAY_URL}/api/alerts`]: { status: 200, body: ALERTS },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/gateway" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      watchReachable: false,
      rateLimit: null,
      patches: [],
      alerts: { reachable: true, ...ALERTS },
    });
  });

  it("gateway 不可达：告警分区返回固定降级载荷，watch 数据不受影响", async () => {
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/gateway/stats`]: { status: 200, body: { stats: STATS } },
      [`GET ${WATCH_URL}/api/gateway/patches`]: { status: 200, body: { patches: PATCHES } },
      [`GET ${GATEWAY_URL}/api/alerts`]: "throw",
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/gateway" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      watchReachable: true,
      rateLimit: STATS,
      patches: PATCHES,
      alerts: {
        reachable: false,
        counts: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
        degradedChannels: ["gateway:unreachable"],
        items: [],
      },
    });
  });

  it("GET /api/messages/overview：并发代理并校验 Bridge 状态与 Outbox 消息", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/status`]: { status: 200, body: MESSAGE_STATUS },
      [`GET ${GATEWAY_URL}/api/messages?limit=60`]: {
        status: 200,
        body: { counts: MESSAGE_COUNTS, items: [MESSAGE_ITEM, MESSAGE_DEAD_LETTER] },
      },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/overview?limit=60" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reachable: true,
      status: MESSAGE_STATUS,
      messages: { counts: MESSAGE_COUNTS, items: [MESSAGE_ITEM, MESSAGE_DEAD_LETTER] },
      degraded: [],
    });
    expect(transport.calls.map((call) => call.url).sort()).toEqual(
      [`${GATEWAY_URL}/api/messages/status`, `${GATEWAY_URL}/api/messages?limit=60`].sort(),
    );
  });

  it("消息上游畸形或不可达时返回分区降级载荷，不把异常结构传给 UI", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/status`]: {
        status: 200,
        body: { bridge: { connected: "yes" }, counts: MESSAGE_COUNTS },
      },
      [`GET ${GATEWAY_URL}/api/messages?limit=12`]: {
        status: 200,
        body: { counts: MESSAGE_COUNTS, items: [{ messageId: "unsafe-partial" }] },
      },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/overview?limit=12" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reachable: true,
      status: null,
      messages: {
        counts: { ...MESSAGE_COUNTS, held_dnd: 0, delivered: 0, dead_letter: 0 },
        items: [],
      },
      degraded: ["messages:status-unavailable", "messages:outbox-unavailable"],
    });
  });

  it("GET /api/messages/tasks/:runId：只透传结构完整的任务时间线", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/tasks/run-1`]: { status: 200, body: MESSAGE_TASK },
      [`GET ${GATEWAY_URL}/api/messages/tasks/missing`]: {
        status: 404,
        body: { error: "task not found" },
      },
    });
    const app = build(transport.fetch);

    const ok = await app.inject({ method: "GET", url: "/api/messages/tasks/run-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(MESSAGE_TASK);

    const missing = await app.inject({ method: "GET", url: "/api/messages/tasks/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "task-not-found" });
  });

  it("上游返回畸形结构：聚合端点过滤异常值而不把崩溃风险传给 UI", async () => {
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/gateway/stats`]: {
        status: 200,
        body: { stats: { overall: "warn", matched: "not-an-array" } },
      },
      [`GET ${WATCH_URL}/api/gateway/patches`]: {
        status: 200,
        body: { patches: [{ id: "broken-without-schema" }] },
      },
      [`GET ${GATEWAY_URL}/api/alerts`]: {
        status: 200,
        body: { counts: "broken", degradedChannels: [], items: "broken" },
      },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/gateway" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      watchReachable: true,
      rateLimit: null,
      patches: [],
      alerts: {
        reachable: false,
        counts: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
        degradedChannels: ["gateway:unreachable"],
        items: [],
      },
    });
  });

  it("apply / reapply / detect：请求体与 watch 响应状态原样透传", async () => {
    const transport = makeFetch({
      [`POST ${WATCH_URL}/api/gateway/patches/wx-send-throttle/apply`]: {
        status: 200,
        body: { status: "ok", result: "applied", params: { minSendIntervalSec: 75 } },
      },
      [`POST ${WATCH_URL}/api/gateway/patches/wx-send-throttle/reapply`]: {
        status: 409,
        body: { error: "patch-conflict", detail: "锚点已漂移" },
      },
      [`POST ${WATCH_URL}/api/gateway/patches/wx-send-throttle/detect`]: {
        status: 200,
        body: { report: { patchId: "wx-send-throttle", status: "drifted", diffs: [] } },
      },
    });
    const app = build(transport.fetch);

    const apply = await app.inject({
      method: "POST",
      url: "/api/gateway/patches/wx-send-throttle/apply",
      payload: { params: { minSendIntervalSec: 75 }, instanceId: "hermes-main" },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toMatchObject({ status: "ok", result: "applied" });

    const reapply = await app.inject({
      method: "POST",
      url: "/api/gateway/patches/wx-send-throttle/reapply",
      payload: { params: { minSendIntervalSec: 75 } },
    });
    expect(reapply.statusCode).toBe(409);
    expect(reapply.json()).toEqual({ error: "patch-conflict", detail: "锚点已漂移" });

    const detect = await app.inject({
      method: "POST",
      url: "/api/gateway/patches/wx-send-throttle/detect",
      payload: { instanceId: "hermes-main" },
    });
    expect(detect.statusCode).toBe(200);
    expect(detect.json()).toMatchObject({ report: { status: "drifted" } });

    expect(JSON.parse(transport.calls[0]!.body)).toEqual({
      params: { minSendIntervalSec: 75 },
      instanceId: "hermes-main",
    });
    expect(transport.calls[1]!.method).toBe("POST");
    expect(transport.calls[2]!.url).toBe(
      `${WATCH_URL}/api/gateway/patches/wx-send-throttle/detect`,
    );
  });

  it("GET /api/messages/optimization-history：代理并校验对照历史结构", async () => {
    const history = {
      reachable: true,
      items: [
        {
          inboundMessageId: "in-opt-1",
          inbound: {
            inboundMessageId: "in-opt-1",
            instanceId: "hermes-main",
            adapterId: "weixin",
            channel: "weixin",
            chatId: "chat-1",
            content: "帮我把那个论文技能弄好点",
            receivedAt: "2026-08-23T08:00:00.000Z",
          },
          decision: {
            inboundMessageId: "in-opt-1",
            action: "forward",
            optimizedText: "改进论文技能",
            transformTrace: ["optimize:strip-filler"],
            mode: "rule",
            changes: ["去掉开头的客套话"],
          },
          decidedAt: "2026-08-23T08:00:01.000Z",
        },
      ],
    };
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/optimization-history?limit=50`]: {
        status: 200,
        body: history,
      },
    });
    const app = build(transport.fetch);

    const res = await app.inject({
      method: "GET",
      url: "/api/messages/optimization-history?limit=50",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(history);
  });

  it("优化历史网关不可达时返回降级空载荷", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/optimization-history?limit=50`]: "throw",
    });
    const app = build(transport.fetch);

    const res = await app.inject({
      method: "GET",
      url: "/api/messages/optimization-history",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reachable: false, items: [] });
  });

  it("watch 不可达时补丁动作返回 502", async () => {
    const transport = makeFetch({
      [`POST ${WATCH_URL}/api/gateway/patches/wx-send-throttle/apply`]: "throw",
    });
    const app = build(transport.fetch);

    const res = await app.inject({
      method: "POST",
      url: "/api/gateway/patches/wx-send-throttle/apply",
      payload: { params: { minSendIntervalSec: 60 } },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "watch-unreachable" });
  });
});
