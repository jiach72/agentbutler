/**
 * GitHub 访问令牌（设置页）代理测试：GET 状态查询与 POST 写入/清除透传 watch，
 * watch 不可达时按读取 503 { configured:false } / 写入 502 { watch-unreachable } 降级。
 * 令牌值只透传不落日志，任何降级/透传响应都不回显原始值。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

function makeFetch(
  respond: (path: string, init: RequestInit | undefined) => { body: unknown; status?: number } | null,
): { fetch: typeof fetch; calls: Array<{ path: string; init: RequestInit | undefined }> } {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const fake: typeof fetch = async (input, init) => {
    const path = String(input).replace(WATCH_URL, "");
    calls.push({ path, init });
    const res = respond(path, init);
    if (res === null) throw new Error("watch offline");
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake, calls };
}

describe("butler-web GitHub 访问令牌代理", () => {
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

  function build(fetchImpl: typeof fetch): FastifyInstance {
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("GET 状态与 POST 写入/清除透传 watch 响应，请求体原样转发", async () => {
    const transport = makeFetch((path, init) => {
      if (path === "/api/github-token" && (init?.method ?? "GET") === "GET") {
        return { body: { configured: true } };
      }
      if (path === "/api/github-token" && init?.method === "POST") {
        const body = String(init.body ?? "");
        if (body.includes('"clear":true')) return { body: { configured: false } };
        return { body: { configured: true } };
      }
      return null;
    });
    const app = build(transport.fetch);

    const status = await app.inject({ method: "GET", url: "/api/github-token" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ configured: true });

    const save = await app.inject({
      method: "POST",
      url: "/api/github-token",
      payload: { token: "ghp_proxy_token_value" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ configured: true });

    const clear = await app.inject({
      method: "POST",
      url: "/api/github-token",
      payload: { clear: true },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({ configured: false });

    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/github-token",
      "/api/github-token",
      "/api/github-token",
    ]);
    expect(String(transport.calls[1]?.init?.body)).toContain("ghp_proxy_token_value");
    expect(String(transport.calls[2]?.init?.body)).toContain('"clear":true');
  });

  it("watch 不可达：GET 降级 503 { configured:false }，POST 降级 502 watch-unreachable", async () => {
    const offline: typeof fetch = async () => {
      throw new Error("watch offline");
    };
    const app = build(offline);

    const status = await app.inject({ method: "GET", url: "/api/github-token" });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toMatchObject({ configured: false, reason: "watch-unreachable" });

    const save = await app.inject({
      method: "POST",
      url: "/api/github-token",
      payload: { token: "ghp_proxy_token_value" },
    });
    expect(save.statusCode).toBe(502);
    expect(save.json()).toMatchObject({ error: "watch-unreachable" });
    expect(JSON.stringify(save.json())).not.toContain("ghp_proxy_token_value");
  });
});
