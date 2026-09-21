import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fail, ok, type OutboxChangeBatch, type OutboxMessageView, type Result } from "@butler/contract";

import { MessagePolicyStore } from "../src/message/store.js";
import { createGatewayServer } from "../src/server.js";
import { makeTempDir, rmTempDir } from "./helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = makeTempDir();
});

afterEach(() => {
  rmTempDir(tmp);
});

function mockUnknownView(messageId = "m-unknown-1"): OutboxMessageView {
  return {
    messageId,
    instanceId: "hermes-main",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "chat-1",
    sessionId: "session-1",
    messageKind: "final",
    transport: "queued-push",
    priority: "normal",
    content: "重要通知正文",
    contentSha256: "b".repeat(64),
    metadata: {},
    capturedAt: "2026-09-05T00:00:00.000Z",
    sequence: 10,
    state: "delivery_unknown",
    availableAt: null,
    attemptCount: 1,
    providerMessageId: null,
    deliveredAt: null,
    lastError: "timeout waiting for ack",
    transformTrace: [],
  };
}

describe("gateway 结果未知结案路由 (/api/messages/:messageId/resolve)", () => {
  it("未注入 resolveMessage 且无 store 时返回 503", async () => {
    const app = createGatewayServer({ home: tmp, startLoop: false });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/messages/m-unknown-1/resolve",
        payload: { outcome: "delivered" },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.gateway.close();
    }
  });

  it("参数校验：非法 outcome 返回 400", async () => {
    const app = createGatewayServer({ home: tmp, startLoop: false });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/messages/m-unknown-1/resolve",
        payload: { outcome: "invalid_state" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("outcome must be 'delivered' or 'cancelled'");
    } finally {
      await app.gateway.close();
    }
  });

  it("通过 store 本地结案为 delivered 与 cancelled", async () => {
    const store = new MessagePolicyStore(`${tmp}/messages.sqlite`);
    const batch: OutboxChangeBatch = {
      afterSequence: 0,
      nextSequence: 2,
      items: [mockUnknownView("m-unknown-1"), mockUnknownView("m-unknown-2")],
      taskEvents: [],
      inbound: [],
    };
    store.ingestBatch(batch);
    expect(store.counts().delivery_unknown).toBe(2);

    let woke = false;
    const fakeService = {
      status: async () => ({ bridgeConnected: true, running: true, lastCycleAt: null, lastError: null }),
      updatePolicy: async () => ({ version: "v1", sha256: "s", payload: {} }),
      wake: () => {
        woke = true;
      },
      setRelayEnabled: async () => ({ enabled: true, pending: false, updatedAt: null }),
    };

    const app = createGatewayServer({
      home: tmp,
      startLoop: false,
      messageStore: store,
      messageService: fakeService,
    });

    try {
      // 1. 结案为 delivered
      const res1 = await app.inject({
        method: "POST",
        url: "/api/messages/m-unknown-1/resolve",
        payload: { outcome: "delivered", reason: "operator confirmed delivery" },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().message.state).toBe("delivered");
      expect(res1.json().message.deliveredAt).not.toBeNull();
      expect(res1.json().nextStep).toContain("已结案为核实送达");
      expect(store.counts().delivery_unknown).toBe(1);
      expect(woke).toBe(true);

      // 2. 结案为 cancelled
      const res2 = await app.inject({
        method: "POST",
        url: "/api/messages/m-unknown-2/resolve",
        payload: { outcome: "cancelled", reason: "operator dropped message" },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().message.state).toBe("cancelled");
      expect(res2.json().message.lastError).toBe("operator dropped message");
      expect(res2.json().nextStep).toContain("已结案为作废取消");
      expect(store.counts().delivery_unknown).toBe(0);

      // 3. 重复结案非 delivery_unknown 返回 404
      const res3 = await app.inject({
        method: "POST",
        url: "/api/messages/m-unknown-1/resolve",
        payload: { outcome: "delivered" },
      });
      expect(res3.statusCode).toBe(404);
    } finally {
      await app.gateway.close();
      store.close();
    }
  });

  it("注入 resolveMessage 时调用并透传结果", async () => {
    const called: Array<{ id: string; outcome: string; reason?: string }> = [];
    const app = createGatewayServer({
      home: tmp,
      startLoop: false,
      resolveMessage: async (messageId, outcome, reason): Promise<Result<OutboxMessageView>> => {
        called.push({ id: messageId, outcome, reason });
        const view = mockUnknownView(messageId);
        view.state = outcome;
        return ok(view);
      },
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/messages/m-ext-1/resolve",
        payload: { outcome: "delivered", reason: "client acknowledged" },
      });
      expect(res.statusCode).toBe(200);
      expect(called).toEqual([
        { id: "m-ext-1", outcome: "delivered", reason: "client acknowledged" },
      ]);
      expect(res.json().message.state).toBe("delivered");
    } finally {
      await app.gateway.close();
    }
  });

  it("Bridge 显式失败且本地未处理时返回 502", async () => {
    const app = createGatewayServer({
      home: tmp,
      startLoop: false,
      resolveMessage: async (): Promise<Result<OutboxMessageView>> =>
        fail("E002", "Bridge 400: invalid state"),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/messages/m-fail-1/resolve",
        payload: { outcome: "delivered" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("resolve-failed");
    } finally {
      await app.gateway.close();
    }
  });

  it("Bridge 失败但本地 store 存在时降级结案并标记 degraded: true", async () => {
    const store = new MessagePolicyStore(`${tmp}/degraded.sqlite`);
    store.ingestBatch({
      afterSequence: 0,
      nextSequence: 1,
      items: [mockUnknownView("m-deg-1")],
      taskEvents: [],
      inbound: [],
    });
    const app = createGatewayServer({
      home: tmp,
      startLoop: false,
      messageStore: store,
      resolveMessage: async () => fail("E002", "Bridge 404: not found"),
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/messages/m-deg-1/resolve",
        payload: { outcome: "delivered", reason: "manual confirm" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.message.state).toBe("delivered");
      expect(body.degraded).toBe(true);
      expect(body.degradedReason).toContain("宿主 Bridge 未实现 resolve 端点或未找到消息，仅更新网关本地投影");
    } finally {
      await app.gateway.close();
      store.close();
    }
  });
});
