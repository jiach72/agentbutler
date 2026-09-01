/**
 * butler-web 通道目录代理与登录态透传测试（Task 12）：
 * - GET /api/messages/channels 透传 gateway 通道目录（不可达时 502）；
 * - GET /api/messages/status 的 bridge.channelDetails 保留 loginState/account
 *   登录态字段（gateway 侧并入 health.channelStatus 后由 parseMessageStatus 透传）。
 *
 * 装配沿用 message-relay.test.ts 的既有模式：注入 fake fetch 的被测 fastify 实例 + inject。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FastifyInstance } from "fastify";
import { createWebServer, type WebServerOptions } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";
const GATEWAY_URL = "http://127.0.0.1:7532";

const DIRECTORY = {
  channels: [
    {
      id: "weixin",
      label: "微信",
      kind: "qr-login",
      enabled: true,
      credentialsConfigured: true,
      loginState: "logged_in",
      account: "wx_01",
    },
    {
      id: "feishu",
      label: "飞书",
      kind: "credential",
      enabled: false,
      credentialsConfigured: false,
      loginState: "unknown",
    },
  ],
};

const MESSAGE_COUNTS = {
  captured: 0,
  policy_pending: 0,
  held_dnd: 0,
  held_pacing: 0,
  ready: 0,
  delivering: 0,
  retry_wait: 0,
  delivered: 0,
  delivery_unknown: 0,
  absorbed: 0,
  policy_error: 0,
  dead_letter: 0,
  cancelled: 0,
};

// gateway /api/messages/status 的 channelDetails 构造（并入 health.channelStatus 后）：
// 基础健康字段 + 可选运行态（enabled/credentialsConfigured/loginState/account）。
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
    channels: { weixin: "ok", feishu: "unavailable" },
    channelDetails: {
      weixin: {
        status: "ok",
        unavailableReason: null,
        unavailableFix: null,
        retryable: true,
        enabled: true,
        credentialsConfigured: true,
        loginState: "logged_in",
        account: "wx_01",
      },
      feishu: {
        status: "unavailable",
        unavailableReason: "通道未连接，可能缺少凭据或桥接未启动",
        unavailableFix: "补充通道凭据后重新连接",
        retryable: false,
      },
    },
    coverage: { runtime: "ok", apiJson: "ok", apiSse: "ok" },
    startedAt: "2026-08-22T08:00:00.000Z",
    lastCycleAt: "2026-08-22T10:00:00.000Z",
    lastError: null,
  },
  counts: MESSAGE_COUNTS,
  relay: { enabled: true, pending: false, updatedAt: null },
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

describe("butler-web 通道目录代理与登录态透传（Task 12，fastify inject）", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

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

  it("透传通道目录", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/channels`]: { status: 200, body: DIRECTORY },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/channels" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { channels: Array<{ id: string }> };
    expect(body.channels[0]?.id).toBe("weixin");
    expect(body.channels).toEqual(DIRECTORY.channels);
    expect(transport.calls).toEqual([
      { url: `${GATEWAY_URL}/api/messages/channels`, method: "GET", body: "" },
    ]);

    // gateway 不可达 / 非 2xx：web 返回 502 降级载荷。
    const failureTransport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/channels`]: "throw",
    });
    const failureApp = build(failureTransport.fetch);
    const failure = await failureApp.inject({ method: "GET", url: "/api/messages/channels" });
    expect(failure.statusCode).toBe(502);
    expect(failure.json()).toEqual({ error: "gateway-unreachable" });

    const notOkTransport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/channels`]: { status: 503, body: { error: "E302" } },
    });
    const notOkApp = build(notOkTransport.fetch);
    const notOk = await notOkApp.inject({ method: "GET", url: "/api/messages/channels" });
    expect(notOk.statusCode).toBe(502);
    expect(notOk.json()).toEqual({ error: "gateway-unreachable" });
  });

  it("channelDetails 携带登录态字段", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/status`]: { status: 200, body: MESSAGE_STATUS },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reachable: boolean;
      status: {
        bridge: {
          channelDetails?: Record<string, Record<string, unknown>>;
        } | null;
      } | null;
    };
    expect(body.reachable).toBe(true);
    const details = body.status?.bridge?.channelDetails ?? {};
    // 微信：登录态字段被透传（enabled/credentialsConfigured 走 /api/messages/channels 目录，不在 status 视图层重复透出）。
    expect(details.weixin).toEqual({
      status: "ok",
      unavailableReason: null,
      unavailableFix: null,
      retryable: true,
      loginState: "logged_in",
      account: "wx_01",
    });
    // 飞书：无运行态时不得出现 loginState/account 键。
    expect(details.feishu).toEqual({
      status: "unavailable",
      unavailableReason: "通道未连接，可能缺少凭据或桥接未启动",
      unavailableFix: "补充通道凭据后重新连接",
      retryable: false,
    });
    expect(Object.keys(details.feishu ?? {})).not.toContain("loginState");
    expect(Object.keys(details.feishu ?? {})).not.toContain("account");
  });
});
