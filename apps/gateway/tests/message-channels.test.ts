import { describe, expect, it } from "vitest";

import type { ChannelControlPort, ChannelDirectoryView } from "@butler/contract";

import { createGatewayServer } from "../src/server.js";

class FakeChannelControl implements ChannelControlPort {
  async listChannels(): Promise<ChannelDirectoryView> {
    return {
      channels: [
        { id: "weixin", label: "微信", kind: "qr-login", enabled: true, credentialsConfigured: true, loginState: "logged_in", account: "wx_01" },
        { id: "feishu", label: "飞书", kind: "credential", enabled: false, credentialsConfigured: false, loginState: "unknown" },
      ],
    };
  }
  async channelSchema(channel: string) {
    return { channel, kind: "credential", label: channel, fields: [] };
  }
  savedConfigs: Record<string, Record<string, string>> = {};
  async updateChannelConfig(channel: string, values: Record<string, string>) {
    if (channel === "telegram") throw new Error("unsupported channel: telegram");
    this.savedConfigs[channel] = values;
    return { saved: true as const };
  }
  async enableChannel(channel: string) {
    this.enabledChannels?.push(channel);
    return { restarting: true };
  }
  async disableChannel() { return { restarting: false }; }
  enabledChannels?: string[] = [];
  loginSessions = new Set<string>();
  async weixinLoginStart() {
    const sessionId = "s1";
    this.loginSessions.add(sessionId);
    return { sessionId, qrValue: "tok", qrUrl: "https://qr/1", expiresAt: "2026-09-01T00:05:00.000Z" };
  }
  async weixinLoginStatus(sessionId: string) {
    return this.loginSessions.has(sessionId)
      ? { state: "scanned" as const }
      : { state: "failed" as const, reason: "session expired" };
  }
  async weixinLoginCancel(sessionId: string) {
    return { cancelled: this.loginSessions.delete(sessionId) };
  }
}

function buildApp() {
  return createGatewayServer({ startLoop: false, channelControl: new FakeChannelControl() });
}

describe("gateway channel routes", () => {
  it("GET /api/messages/channels 返回目录", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/messages/channels" });
      expect(res.statusCode).toBe(200);
      expect(res.json().channels).toHaveLength(2);
      expect(res.json().channels[0].account).toBe("wx_01");
    } finally {
      await app.close();
    }
  });

  it("未注入 channelControl 时返回 503", async () => {
    const app = createGatewayServer({ startLoop: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/messages/channels" });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("gateway weixin login routes", () => {
  it("start/status/cancel 链路", async () => {
    const app = buildApp();
    try {
      const start = await app.inject({ method: "POST", url: "/api/messages/channels/weixin/login/start" });
      expect(start.statusCode).toBe(200);
      const sessionId = start.json().sessionId as string;
      const status = await app.inject({ method: "GET", url: `/api/messages/channels/weixin/login/status?sessionId=${sessionId}` });
      expect(status.json().state).toBe("scanned");
      await app.inject({ method: "POST", url: "/api/messages/channels/weixin/login/cancel", payload: { sessionId } });
      const after = await app.inject({ method: "GET", url: `/api/messages/channels/weixin/login/status?sessionId=${sessionId}` });
      expect(after.json().state).toBe("failed");
    } finally {
      await app.close();
    }
  });

  it("status 缺 sessionId 返回 400", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/messages/channels/weixin/login/status" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("cancel 缺 sessionId 返回 400", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/channels/weixin/login/cancel", payload: {} });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("gateway channel lifecycle routes", () => {
  it("PUT config → enable 链路", async () => {
    const control = new FakeChannelControl();
    const app = createGatewayServer({ startLoop: false, channelControl: control });
    try {
      const put = await app.inject({
        method: "PUT",
        url: "/api/messages/channels/feishu/config",
        payload: { app_id: "cli_a", app_secret: "s3cret" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().app_secret).toBe("••••");
      expect(control.savedConfigs["feishu"]).toEqual({ app_id: "cli_a", app_secret: "s3cret" });
      const enable = await app.inject({ method: "POST", url: "/api/messages/channels/feishu/enable" });
      expect(enable.json()).toEqual({ restarting: true });
      expect(control.enabledChannels).toEqual(["feishu"]);
    } finally {
      await app.close();
    }
  });

  it("未知通道返回 400", async () => {
    const app = createGatewayServer({ startLoop: false, channelControl: new FakeChannelControl() });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/messages/channels/telegram/config", payload: { app_id: "x" } });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("disable 透传 restarting 标记", async () => {
    const control = new FakeChannelControl();
    const app = createGatewayServer({ startLoop: false, channelControl: control });
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/channels/feishu/disable" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ restarting: false });
    } finally {
      await app.close();
    }
  });

  it("config 值必须为字符串", async () => {
    const app = createGatewayServer({ startLoop: false, channelControl: new FakeChannelControl() });
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/messages/channels/feishu/config",
        payload: { app_id: 42 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
