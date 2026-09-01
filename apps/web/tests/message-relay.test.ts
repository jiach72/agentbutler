/**
 * butler-web 消息接管切换代理与 relay 状态透传测试（Task 7）：
 * - POST /api/messages/relay 原样透传 gateway 响应与状态码；
 * - GET /api/messages/status 响应顶层透传 relay 块（parseMessageStatus 保留）；
 * - /api/messages/overview 复用 parseMessageStatus 而自动携带 relay。
 *
 * 装配沿用 gateway.test.ts 的既有模式：注入 fake fetch 的被测 fastify 实例 + inject。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FastifyInstance } from "fastify";
import { createWebServer, type WebServerOptions } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";
const GATEWAY_URL = "http://127.0.0.1:7532";

const RELAY = { enabled: false, pending: true, updatedAt: "2026-09-01T00:00:00.000Z" };

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
    channels: { weixin: "ok" },
    coverage: { runtime: "ok", apiJson: "ok", apiSse: "ok" },
    startedAt: "2026-08-22T08:00:00.000Z",
    lastCycleAt: "2026-08-22T10:00:00.000Z",
    lastError: null,
  },
  counts: MESSAGE_COUNTS,
  relay: RELAY,
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

describe("butler-web 消息接管代理与 relay 透传（Task 7，fastify inject）", () => {
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

  it("透传 POST /api/messages/relay：响应体与状态码原样返回", async () => {
    const transport = makeFetch({
      [`POST ${GATEWAY_URL}/api/messages/relay`]: { status: 200, body: RELAY },
    });
    const app = build(transport.fetch);

    const res = await app.inject({
      method: "POST",
      url: "/api/messages/relay",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RELAY);
    expect(transport.calls).toEqual([
      {
        url: `${GATEWAY_URL}/api/messages/relay`,
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      },
    ]);

    // 上游错误状态码同样原样透传（web 不吞状态码）。
    const failureTransport = makeFetch({
      [`POST ${GATEWAY_URL}/api/messages/relay`]: {
        status: 503,
        body: { error: "E303" },
      },
    });
    const failureApp = build(failureTransport.fetch);
    const failure = await failureApp.inject({
      method: "POST",
      url: "/api/messages/relay",
      payload: { enabled: true },
    });
    expect(failure.statusCode).toBe(503);
    expect(failure.json()).toEqual({ error: "E303" });
  });

  it("status 透传 relay 块", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/status`]: { status: 200, body: MESSAGE_STATUS },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; status: { relay?: unknown } | null };
    expect(body.reachable).toBe(true);
    expect(body.status?.relay).toEqual(RELAY);
  });

  it("overview 复用 parseMessageStatus 而自动携带 relay 块", async () => {
    const transport = makeFetch({
      [`GET ${GATEWAY_URL}/api/messages/status`]: { status: 200, body: MESSAGE_STATUS },
      [`GET ${GATEWAY_URL}/api/messages?limit=60`]: {
        status: 200,
        body: { counts: MESSAGE_COUNTS, items: [] },
      },
    });
    const app = build(transport.fetch);

    const res = await app.inject({ method: "GET", url: "/api/messages/overview?limit=60" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; status: { relay?: unknown } | null };
    expect(body.reachable).toBe(true);
    expect(body.status?.relay).toEqual(RELAY);
  });
});
