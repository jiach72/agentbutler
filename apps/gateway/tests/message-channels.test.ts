import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ChannelControlPort, ChannelDirectoryView } from "@butler/contract";

import { createGatewayServer } from "../src/server.js";

const testHomes: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "butler-gateway-channels-"));
  testHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of testHomes.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
  }
});

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
  async channelLoginStart(channel: string) {
    const sessionId = `${channel}_s1`;
    this.loginSessions.add(sessionId);
    return { sessionId, qrUrl: `https://qr/${channel}/1`, expiresAt: "2026-09-01T00:05:00.000Z" };
  }
  async channelLoginStatus(channel: string, sessionId: string) {
    return this.loginSessions.has(sessionId)
      ? { state: "scanned" as const, qrUrl: `https://qr/${channel}/1` }
      : { state: "failed" as const, reason: "session expired" };
  }
  async channelLoginCancel(_channel: string, sessionId: string) {
    return { cancelled: this.loginSessions.delete(sessionId) };
  }
  async weixinLoginStart() {
    return this.channelLoginStart("weixin");
  }
  async weixinLoginStatus(sessionId: string) {
    return this.channelLoginStatus("weixin", sessionId);
  }
  async weixinLoginCancel(sessionId: string) {
    return this.channelLoginCancel("weixin", sessionId);
  }
}

function buildApp() {
  return createGatewayServer({ home: isolatedHome(), startLoop: false, channelControl: new FakeChannelControl() });
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
      await app.gateway.close();
    }
  });

  it("未注入 channelControl 时返回 503", async () => {
    const app = createGatewayServer({ home: isolatedHome(), startLoop: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/messages/channels" });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.gateway.close();
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
      await app.gateway.close();
    }
  });

  it("status 缺 sessionId 返回 400", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/messages/channels/weixin/login/status" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.gateway.close();
    }
  });

  it("cancel 缺 sessionId 返回 400", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/channels/weixin/login/cancel", payload: {} });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.gateway.close();
    }
  });

  it("通用通道扫码登录链路（feishu / qqbot）", async () => {
    const app = buildApp();
    try {
      const start = await app.inject({ method: "POST", url: "/api/messages/channels/feishu/login/start" });
      expect(start.statusCode).toBe(200);
      const { sessionId, qrUrl } = start.json();
      expect(sessionId).toBe("feishu_s1");
      expect(qrUrl).toContain("https://qr/feishu/1");

      const status = await app.inject({ method: "GET", url: `/api/messages/channels/feishu/login/status?sessionId=${sessionId}` });
      expect(status.statusCode).toBe(200);
      expect(status.json().state).toBe("scanned");

      const cancel = await app.inject({ method: "POST", url: "/api/messages/channels/feishu/login/cancel", payload: { sessionId } });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().cancelled).toBe(true);

      const after = await app.inject({ method: "GET", url: `/api/messages/channels/feishu/login/status?sessionId=${sessionId}` });
      expect(after.json().state).toBe("failed");
    } finally {
      await app.gateway.close();
    }
  });
});

describe("gateway channel lifecycle routes", () => {
  it("PUT config → enable 链路", async () => {
    const control = new FakeChannelControl();
    const app = createGatewayServer({ home: isolatedHome(), startLoop: false, channelControl: control });
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
      await app.gateway.close();
    }
  });

  it("未知通道返回 400", async () => {
    const app = createGatewayServer({ home: isolatedHome(), startLoop: false, channelControl: new FakeChannelControl() });
    try {
      const res = await app.inject({ method: "PUT", url: "/api/messages/channels/telegram/config", payload: { app_id: "x" } });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.gateway.close();
    }
  });

  it("disable 透传 restarting 标记", async () => {
    const control = new FakeChannelControl();
    const app = createGatewayServer({ home: isolatedHome(), startLoop: false, channelControl: control });
    try {
      const res = await app.inject({ method: "POST", url: "/api/messages/channels/feishu/disable" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ restarting: false });
    } finally {
      await app.gateway.close();
    }
  });

  it("config 值必须为字符串", async () => {
    const app = createGatewayServer({ home: isolatedHome(), startLoop: false, channelControl: new FakeChannelControl() });
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/messages/channels/feishu/config",
        payload: { app_id: 42 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.gateway.close();
    }
  });
});
