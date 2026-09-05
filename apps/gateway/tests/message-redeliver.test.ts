import { describe, expect, it } from "vitest";

import { fail, ok, type OutboxMessageView, type Result } from "@butler/contract";

import { createGatewayServer } from "../src/server.js";

function requeuedView(): OutboxMessageView {
  return {
    messageId: "m-dead-1",
    instanceId: "hermes-main",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "chat-1",
    sessionId: "session-1",
    messageKind: "final",
    transport: "queued-push",
    priority: "normal",
    content: "晨报正文",
    contentSha256: "a".repeat(64),
    metadata: {},
    capturedAt: "2026-09-05T00:00:00.000Z",
    sequence: 99,
    state: "policy_pending",
    availableAt: null,
    attemptCount: 0,
    providerMessageId: null,
    deliveredAt: null,
    lastError: null,
    transformTrace: [],
  };
}

describe("gateway 死信重投路由", () => {
  it("未注入 redeliver 能力时返回 503", async () => {
    const app = createGatewayServer({ startLoop: false });
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/m-dead-1/redeliver" });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("重投成功返回投影并提示下一步", async () => {
    const requested: string[] = [];
    const app = createGatewayServer({
      startLoop: false,
      redeliver: async (messageId): Promise<Result<OutboxMessageView>> => {
        requested.push(messageId);
        return ok(requeuedView());
      },
    });
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/m-dead-1/redeliver" });
      expect(res.statusCode).toBe(200);
      expect(res.json().message.state).toBe("policy_pending");
      expect(res.json().nextStep).toContain("重新排队");
      expect(requested).toEqual(["m-dead-1"]);
    } finally {
      await app.close();
    }
  });

  it("Bridge 拒绝（非 dead_letter 等）时透传为 502 与原因", async () => {
    const app = createGatewayServer({
      startLoop: false,
      redeliver: async (): Promise<Result<OutboxMessageView>> =>
        fail("E002", "Hermes Bridge 409 conflict: message is not in dead_letter state"),
    });
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/m-live-1/redeliver" });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("redeliver-failed");
      expect(res.json().detail).toContain("not in dead_letter");
    } finally {
      await app.close();
    }
  });
});
