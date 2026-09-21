import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerRateLimiting, SlidingWindowRateLimiter } from "../src/rate-limiter.js";

describe("精准速率限制（SlidingWindowRateLimiter & registerRateLimiting）", () => {
  it("纯计算测试：高危端点 /api/upgrade/run 达到上限 5 次后触发限流", () => {
    const limiter = new SlidingWindowRateLimiter([
      { prefix: "/api/upgrade/run", max: 5, windowMs: 60_000 },
    ]);

    for (let i = 1; i <= 5; i++) {
      const res = limiter.check("127.0.0.1", "/api/upgrade/run");
      expect(res).not.toBeNull();
      expect(res?.limited).toBe(false);
      expect(res?.remaining).toBe(5 - i);
    }

    const limitedRes = limiter.check("127.0.0.1", "/api/upgrade/run");
    expect(limitedRes?.limited).toBe(true);
    expect(limitedRes?.remaining).toBe(0);
    expect(limitedRes?.retryAfterSeconds).toBeGreaterThan(0);

    limiter.destroy();
  });

  it("豁免测试：/api/health、/ws 与静态资源完全豁免限流", () => {
    const limiter = new SlidingWindowRateLimiter([
      { prefix: "/api/upgrade/run", max: 1, windowMs: 60_000 },
    ]);

    for (let i = 0; i < 100; i++) {
      expect(limiter.check("127.0.0.1", "/api/health")).toBeNull();
      expect(limiter.check("127.0.0.1", "/ws")).toBeNull();
      expect(limiter.check("127.0.0.1", "/index.html")).toBeNull();
      expect(limiter.check("127.0.0.1", "/assets/main.js")).toBeNull();
    }

    limiter.destroy();
  });

  it("集成测试：Fastify 实例注入限流插件，触发 429 与 Retry-After 响应头", async () => {
    const app = Fastify({ logger: false });
    const limiter = new SlidingWindowRateLimiter([
      { prefix: "/api/inspect/run", max: 2, windowMs: 60_000 },
    ]);
    registerRateLimiting(app, limiter);

    app.post("/api/inspect/run", async () => ({ ok: true }));

    // 前两次放行
    const res1 = await app.inject({ method: "POST", url: "/api/inspect/run" });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["x-ratelimit-remaining"]).toBe("1");

    const res2 = await app.inject({ method: "POST", url: "/api/inspect/run" });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

    // 第三次拦截 429
    const res3 = await app.inject({ method: "POST", url: "/api/inspect/run" });
    expect(res3.statusCode).toBe(429);
    expect(res3.headers["retry-after"]).toBeDefined();
    const body = res3.json();
    expect(body.error).toBe("too-many-requests");

    await app.close();
  });
});
