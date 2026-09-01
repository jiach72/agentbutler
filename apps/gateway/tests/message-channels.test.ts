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
  async updateChannelConfig() { return { saved: true as const }; }
  async enableChannel() { return { restarting: true }; }
  async disableChannel() { return { restarting: true }; }
  async weixinLoginStart() { throw new Error("unused"); }
  async weixinLoginStatus() { throw new Error("unused"); }
  async weixinLoginCancel() { throw new Error("unused"); }
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
