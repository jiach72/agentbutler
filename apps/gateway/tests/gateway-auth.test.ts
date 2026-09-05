import { describe, expect, it } from "vitest";

import { createGatewayServer, type MessageGatewayController } from "../src/server.js";

const TOKEN = "gateway-auth-test-token";

/**
 * 口令与 wake 上限通过 options 显式注入，而不是改写 process.env：
 * vitest 的 worker 之间共享环境变量，env 注入会与并发运行的其他测试文件竞态。
 */
describe("gateway 访问口令与 wake 限速", () => {
  it("配置口令后：无 token 401，带 token 200，/healthz 豁免", async () => {
    const app = createGatewayServer({ startLoop: false, accessToken: TOKEN });
    try {
      const denied = await app.inject({ method: "GET", url: "/api/alerts" });
      expect(denied.statusCode).toBe(401);

      const wrong = await app.inject({
        method: "GET",
        url: "/api/alerts",
        headers: { "x-butler-token": "wrong-token" },
      });
      expect(wrong.statusCode).toBe(401);

      const ok = await app.inject({
        method: "GET",
        url: "/api/alerts",
        headers: { "x-butler-token": TOKEN },
      });
      expect(ok.statusCode).toBe(200);

      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("未配置口令时保持原有内网语义（不鉴权）", async () => {
    const app = createGatewayServer({ startLoop: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/alerts" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("/internal/hermes/* 不要求口令但按分钟窗口限速，超限 429", async () => {
    const wakeCalls: number[] = [];
    const app = createGatewayServer({
      startLoop: false,
      wakeRateLimit: 3,
      messageService: {
        wake: () => {
          wakeCalls.push(1);
        },
      } as unknown as MessageGatewayController,
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/internal/hermes/outbound",
          payload: { messageId: `m-${i}` },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
      expect(wakeCalls).toHaveLength(3);
    } finally {
      await app.close();
    }
  });
});
