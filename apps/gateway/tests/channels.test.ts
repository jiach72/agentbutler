import { describe, expect, it } from "vitest";
import {
  availableOutbound,
  BarkChannel,
  buildEnvChannels,
  degradedChannelLabels,
  NullChannel,
  ServerChanChannel,
  SmtpChannel,
  TelegramChannel,
  type FetchLike,
  type MailTransporter,
} from "../src/channels";

const TELEGRAM_ENV = {
  BUTLER_TELEGRAM_BOT_TOKEN: "bot-token-1",
  BUTLER_TELEGRAM_CHAT_ID: "123456",
};

describe("TelegramChannel", () => {
  it("凭据缺失时不可用，齐备时可用", () => {
    expect(new TelegramChannel({ env: {} }).isConfigured()).toBe(false);
    expect(new TelegramChannel({ env: { BUTLER_TELEGRAM_BOT_TOKEN: "t" } }).isConfigured()).toBe(false);
    expect(new TelegramChannel({ env: TELEGRAM_ENV }).isConfigured()).toBe(true);
    // env 默认读 process.env（测试环境无凭据）
    expect(new TelegramChannel().isConfigured()).toBe(false);
  });

  it("发送：POST sendMessage，form 含 chat_id 与格式化 text", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });

    await channel.send({ severity: "critical", title: "实例卡死", body: "无响应", source: "watch" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botbot-token-1/sendMessage");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(calls[0]!.init.body);
    expect(form.get("chat_id")).toBe("123456");
    expect(form.get("text")).toContain("[critical] 实例卡死");
    expect(form.get("text")).toContain("无响应");
    expect(form.get("text")).toContain("watch");
  });

  it("失败路径：HTTP 非 2xx 抛错并带状态码；未配置直接抛错", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"ok":false}',
    });
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("HTTP 401");

    const unconfigured = new TelegramChannel({ env: {}, fetchImpl });
    await expect(
      unconfigured.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("missing credentials");
  });
});

describe("SmtpChannel", () => {
  const SMTP_ENV = {
    BUTLER_SMTP_HOST: "smtp.example.com",
    BUTLER_SMTP_PORT: "465",
    BUTLER_SMTP_USER: "butler",
    BUTLER_SMTP_PASS: "secret",
    BUTLER_SMTP_FROM: "butler@example.com",
    BUTLER_SMTP_TO: "owner@example.com",
  };

  it("HOST/PORT/FROM/TO 均存在才可用", () => {
    expect(new SmtpChannel({ env: {} }).isConfigured()).toBe(false);
    const missingPort = { ...SMTP_ENV } as Partial<typeof SMTP_ENV>;
    delete missingPort.BUTLER_SMTP_PORT;
    expect(new SmtpChannel({ env: missingPort }).isConfigured()).toBe(false);
    expect(new SmtpChannel({ env: SMTP_ENV }).isConfigured()).toBe(true);
  });

  it("发送：transporter 收到 from/to/subject/text", async () => {
    const mails: Array<{ from: string; to: string; subject: string; text: string }> = [];
    const transporter: MailTransporter = {
      async sendMail(mail) {
        mails.push(mail);
        return { accepted: true };
      },
    };
    const channel = new SmtpChannel({ env: SMTP_ENV, transporter });

    await channel.send({ severity: "critical", title: "实例卡死", body: "无响应", source: "watch" });

    expect(mails).toHaveLength(1);
    expect(mails[0]!.from).toBe("butler@example.com");
    expect(mails[0]!.to).toBe("owner@example.com");
    expect(mails[0]!.subject).toBe("[critical] 实例卡死");
    expect(mails[0]!.text).toContain("无响应");
  });

  it("失败路径：transporter 抛错透传；未配置直接抛错", async () => {
    const transporter: MailTransporter = {
      async sendMail() {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const channel = new SmtpChannel({ env: SMTP_ENV, transporter });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("ECONNREFUSED");

    const unconfigured = new SmtpChannel({
      env: {},
      transporter: { async sendMail() {} },
    });
    await expect(
      unconfigured.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("missing credentials");
  });
});

describe("NullChannel 与通道辅助函数", () => {
  it("NullChannel 恒可用且发送无副作用", async () => {
    const panel = new NullChannel();
    expect(panel.name).toBe("panel");
    expect(panel.isConfigured()).toBe(true);
    await expect(panel.send({ severity: "info", title: "t", body: "b", source: "s" })).resolves.toBeUndefined();
  });

  it("availableOutbound / degradedChannelLabels：按配置状态分流", () => {
    const channels = buildEnvChannels({ ...TELEGRAM_ENV }); // 只配了 telegram
    expect(availableOutbound(channels).map((c) => c.name)).toEqual(["telegram"]);
    expect(degradedChannelLabels(channels)).toEqual([
      "bark:missing-credentials",
      "serverchan:missing-credentials",
      "smtp:missing-credentials",
    ]);

    expect(degradedChannelLabels(buildEnvChannels({}))).toEqual([
      "telegram:missing-credentials",
      "bark:missing-credentials",
      "serverchan:missing-credentials",
      "smtp:missing-credentials",
    ]);
  });
});

describe("BarkChannel", () => {
  const BARK_ENV = { BUTLER_BARK_DEVICE_KEY: "device-key-1" };

  it("凭据缺失时不可用，齐备时可用；server 可覆盖官方端点", () => {
    expect(new BarkChannel({ env: {} }).isConfigured()).toBe(false);
    expect(new BarkChannel({ env: BARK_ENV }).isConfigured()).toBe(true);
  });

  it("发送：POST JSON 到 {server}/{deviceKey}，带 group=butler", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"code":200}' };
    };
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });

    await channel.send({ severity: "critical", title: "消息链路离线", body: "Bridge 不可达", source: "gateway" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.day.app/device-key-1");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["content-type"]).toContain("application/json");
    const payload = JSON.parse(calls[0]!.init.body) as Record<string, string>;
    expect(payload["title"]).toBe("消息链路离线");
    expect(payload["body"]).toContain("Bridge 不可达");
    expect(payload["group"]).toBe("butler");
  });

  it("失败路径：HTTP 非 2xx 抛错", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 400, text: async () => "bad" });
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("HTTP 400");
  });
});

describe("ServerChanChannel", () => {
  const SC_ENV = { BUTLER_SERVERCHAN_SENDKEY: "SCT-key-1" };

  it("凭据缺失时不可用，齐备时可用", () => {
    expect(new ServerChanChannel({ env: {} }).isConfigured()).toBe(false);
    expect(new ServerChanChannel({ env: SC_ENV }).isConfigured()).toBe(true);
  });

  it("发送：POST form 到 sctapi .send，title 与 desp 对应", async () => {
    const calls: Array<{ url: string; init: { method: string; body: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init: init as { method: string; body: string } });
      return { ok: true, status: 200, text: async () => '{"code":0}' };
    };
    const channel = new ServerChanChannel({ env: SC_ENV, fetchImpl });

    await channel.send({ severity: "critical", title: "升级已回滚", body: "健康验收未通过", source: "updater" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://sctapi.ftqq.com/SCT-key-1.send");
    const form = new URLSearchParams(calls[0]!.init.body);
    expect(form.get("title")).toBe("升级已回滚");
    expect(form.get("desp")).toContain("健康验收未通过");
  });
});

describe("buildEnvChannels", () => {
  it("默认候选序列：Telegram → Bark → Server酱 → SMTP", () => {
    const channels = buildEnvChannels({});
    expect(channels.map((channel) => channel.name)).toEqual(["telegram", "bark", "serverchan", "smtp"]);
  });
});
