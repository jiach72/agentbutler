import { readFileSync } from "node:fs";
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

      // 安全收敛：禁止在 URL Query 中传递敏感口令
      const queryDenied = await app.inject({
        method: "GET",
        url: `/api/alerts?token=${TOKEN}`,
      });
      expect(queryDenied.statusCode).toBe(401);

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

  // 审计 F-06：未配置访问口令但配置了内部操作口令时，消息控制写路径强制鉴权。
  it("内部操作口令：未配置访问口令时保护 /api/messages/* 写路径", async () => {
    const app = createGatewayServer({
      startLoop: false,
      internalToken: "internal-secret",
      messageService: {
        wake: () => {},
      } as unknown as MessageGatewayController,
    });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/api/messages/reconnect",
        payload: {},
      });
      expect(denied.statusCode).toBe(401);

      const wrong = await app.inject({
        method: "POST",
        url: "/api/messages/reconnect",
        payload: {},
        headers: { "x-butler-internal-token": "wrong" },
      });
      expect(wrong.statusCode).toBe(401);

      const ok = await app.inject({
        method: "POST",
        url: "/api/messages/reconnect",
        payload: {},
        headers: { "x-butler-internal-token": "internal-secret" },
      });
      expect(ok.statusCode).not.toBe(401);

      // 读路径不受影响（保持原有内网语义）。
      const other = await app.inject({ method: "GET", url: "/api/alerts" });
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // 审计 K-4 回归：内部口令必须覆盖 /api/messages/* 之外的状态变更路由
  // （告警投递、SOUL.md 写入的 bots 管理），否则 Compose 内任意容器可横向驱动。
  it("内部操作口令：覆盖全部状态变更路由，豁免 /internal/hermes/* 与 telegram webhook", async () => {
    const app = createGatewayServer({
      startLoop: false,
      internalToken: "internal-secret",
      messageService: {
        wake: () => {},
      } as unknown as MessageGatewayController,
    });
    try {
      const alertsDenied = await app.inject({ method: "POST", url: "/api/alerts", payload: {} });
      expect(alertsDenied.statusCode).toBe(401);

      const botsDenied = await app.inject({ method: "POST", url: "/api/bots", payload: {} });
      expect(botsDenied.statusCode).toBe(401);

      const botsDeleteDenied = await app.inject({ method: "DELETE", url: "/api/bots/abc" });
      expect(botsDeleteDenied.statusCode).toBe(401);

      const alertsOk = await app.inject({
        method: "POST",
        url: "/api/alerts",
        payload: {},
        headers: { "x-butler-internal-token": "internal-secret" },
      });
      expect(alertsOk.statusCode).not.toBe(401);

      // 豁免：宿主 Hermes 的 wake 提示（无令牌能力，另有限速）
      const internalOk = await app.inject({
        method: "POST",
        url: "/internal/hermes/inbound",
        payload: {},
      });
      expect(internalOk.statusCode).not.toBe(401);

      // 豁免：telegram webhook 自带 secret 校验（未配置密钥时 fail-closed 503，但绝不该 401）
      const webhook = await app.inject({
        method: "POST",
        url: "/api/channels/telegram/webhook",
        payload: {},
      });
      expect(webhook.statusCode).not.toBe(401);
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

  // 审计 K-4 盲区收口：内部口令必须是「默认拒绝」——从源码枚举全部状态变更路由
  // 逐个断言，而不是只抽查已知前缀。今后新增写路由若忘记纳入鉴权，本测试会红。
  it("K-4 覆盖矩阵：源码枚举的全部状态变更路由无凭据必须 401（豁免清单除外）", async () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const routes = [...source.matchAll(/app\.(post|put|delete|patch)\(\s*"([^"]+)"/g)].map((m) => ({
      method: m[1]!.toUpperCase() as "POST" | "PUT" | "DELETE" | "PATCH",
      url: m[2]!,
    }));
    // 自证扫描有效性：路由数明显不足说明正则失配，矩阵静默变空比失败更危险
    expect(routes.length).toBeGreaterThanOrEqual(25);

    const app = createGatewayServer({ startLoop: false, internalToken: TOKEN });
    try {
      for (const { method, url } of routes) {
        const injectable = url.replace(/:[^/]+/g, "matrix-placeholder");
        const res = await app.inject({ method, url: injectable });
        if (url.startsWith("/internal/hermes/")) {
          // 宿主 Hermes 无令牌能力的 wake 通道：设计内放行，另有固定窗口限速兜底
          expect(res.statusCode, `${method} ${url}`).not.toBe(401);
        } else if (url.startsWith("/api/channels/telegram/webhook")) {
          // 专享 secret 校验（fail-closed）：测试环境未配密钥时必须 503 关闭
          expect(res.statusCode, `${method} ${url}`).toBe(503);
        } else {
          expect(res.statusCode, `${method} ${url} 无凭据写必须 401`).toBe(401);
        }
      }
    } finally {
      await app.close();
    }
  });
});
