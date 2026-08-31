/**
 * 访问口令测试。
 *
 * 面板能重启 AI、改配置、读写记忆。一旦监听地址不是回环，就必须凭口令进入。
 * 这组用例守住：无口令时放行（本机场景）、有口令时拦住、健康检查与静态外壳不受影响。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer, isLoopback, type WebServerOptions } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const DEAD_GATEWAY = "http://127.0.0.1:1";
const unreachableFetch: typeof fetch = async () => {
  throw new Error("watch unreachable");
};

describe("butler-web 访问口令", () => {
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

  function build(home: string, extra: Partial<WebServerOptions> = {}): FastifyInstance {
    const app = createWebServer({
      home,
      gatewayUrl: DEAD_GATEWAY,
      uiDist,
      watchUrl: "http://127.0.0.1:7533",
      fetchImpl: unreachableFetch,
      ...extra,
    });
    apps.push(app);
    return app;
  }

  it("未配置口令时不拦截任何请求（保留纯本机使用场景）", async () => {
    const app = build(tmp, { accessToken: "" });
    const res = await app.inject({ method: "GET", url: "/api/instances" });
    expect(res.statusCode).not.toBe(401);
  });

  it("配置口令后，没有口令的接口请求 → 401", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "192.168.1.88:7531" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("配置口令后，从本机地址打开仍可免查口令进入", async () => {
    const app = build(tmp, { accessToken: "secret-token", publishHost: "0.0.0.0" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "127.0.0.1:7531", origin: "http://127.0.0.1:7531" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("没有本机来源标记时，不因伪造 localhost Host 而绕过口令", async () => {
    const app = build(tmp, { accessToken: "secret-token", publishHost: "0.0.0.0" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "127.0.0.1:7531" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("浏览器同源 Fetch Metadata 足够时可免查口令", async () => {
    const app = build(tmp, { accessToken: "secret-token", publishHost: "0.0.0.0" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "localhost:7531", "sec-fetch-site": "same-origin" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("本机地址被跨站来源调用时仍不能绕过口令", async () => {
    const app = build(tmp, { accessToken: "secret-token", publishHost: "0.0.0.0" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "127.0.0.1:7531", origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("用 x-butler-token 头带上正确口令 → 放行", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { "x-butler-token": "secret-token" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("用 Authorization: Bearer 带上正确口令 → 放行", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("口令错误 → 401", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { host: "192.168.1.88:7531", "x-butler-token": "wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("健康检查放行，容器 healthcheck 不受口令影响", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("静态外壳放行，否则用户连输入口令的页面都看不到", async () => {
    const app = build(tmp, { accessToken: "secret-token" });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).not.toBe(401);
  });

  it("局域网同源写请求放行，跨站 Origin 与 WebSocket 握手仍被拒绝", async () => {
    const app = build(tmp, { accessToken: "secret-token", publishHost: "192.168.1.88" });
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/inspect/run",
      headers: {
        host: "192.168.1.88:7531",
        origin: "http://192.168.1.88:7531",
        "x-butler-token": "secret-token",
      },
    });
    // Watch 在这个测试中不可达；关键是同源请求没有被 CSRF 钩子拒绝。
    expect(sameOrigin.statusCode).not.toBe(403);

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/inspect/run",
      headers: {
        host: "192.168.1.88:7531",
        origin: "https://evil.example.com",
        "x-butler-token": "secret-token",
      },
    });
    expect(crossSite.statusCode).toBe(403);

    const websocketCrossSite = await app.inject({
      method: "GET",
      url: "/ws?token=secret-token",
      headers: { host: "192.168.1.88:7531", origin: "https://evil.example.com" },
    });
    expect(websocketCrossSite.statusCode).toBe(403);
  });

  it("安全基线使用宿主发布地址，而不是容器内监听地址", async () => {
    const loopbackApp = build(tmp, { accessToken: "", publishHost: "127.0.0.1" });
    const loopback = await loopbackApp.inject({ method: "GET", url: "/api/security-baseline" });
    expect(loopback.statusCode).toBe(200);
    expect(loopback.json()).toMatchObject({ auth: false, loopback: true, publishHost: "127.0.0.1" });

    const tokenApp = build(tmp, { accessToken: "secret-token", publishHost: "192.168.1.88" });
    const withToken = await tokenApp.inject({
      method: "GET",
      url: "/api/security-baseline",
      headers: { "x-butler-token": "secret-token" },
    });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json()).toMatchObject({ auth: true, loopback: false, publishHost: "192.168.1.88" });
  });
});

describe("isLoopback 判定口径", () => {
  it("回环地址判定", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.53")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
  });

  it("非回环地址判定", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.10")).toBe(false);
    expect(isLoopback("172.29.27.63")).toBe(false);
  });

  it("支持带端口和 IPv4-mapped IPv6 的回环地址", () => {
    expect(isLoopback("127.0.0.1:7531")).toBe(true);
    expect(isLoopback("[::1]:7531")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });
});
