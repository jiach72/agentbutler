import { describe, expect, it } from "vitest";
import {
  availableOutbound,
  BarkChannel,
  buildEnvChannels,
  degradedChannelLabels,
  NullChannel,
  safeUpstreamExcerpt,
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

  it("失败路径：上游错误响应超长或含控制字符时被安全摘录截断", async () => {
    const rawError = "\x00\x1b[31m" + "A".repeat(250) + "\x7f";
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 502,
      text: async () => rawError,
    });
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });

    let sendErr: Error | null = null;
    try {
      await channel.send({ severity: "critical", title: "t", body: "b", source: "s" });
    } catch (err) {
      sendErr = err as Error;
    }
    expect(sendErr?.message).toContain("telegram sendMessage failed: HTTP 502 [31m" + "A".repeat(196) + "…");
    expect(sendErr?.message).not.toContain("\x00");
    expect(sendErr?.message).not.toContain("\x1b");

    let sendTextErr: Error | null = null;
    try {
      await channel.sendText("test-text");
    } catch (err) {
      sendTextErr = err as Error;
    }
    expect(sendTextErr?.message).toContain("telegram sendText failed: HTTP 502 [31m" + "A".repeat(196) + "…");
  });

  it("失败路径：Telegram 返回 HTTP 200 但 ok 为 false 时抛错", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":false,"description":"Forbidden: bot was blocked by the user"}',
    });
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("telegram sendMessage failed: Forbidden: bot was blocked by the user");

    await expect(channel.sendText("hello")).rejects.toThrow(
      "telegram sendText failed: Forbidden: bot was blocked by the user",
    );
    await expect(channel.answerCallbackQuery("cb-1", "msg")).rejects.toThrow(
      "telegram answerCallbackQuery failed: Forbidden: bot was blocked by the user",
    );
  });

  it("失败路径：Telegram 返回 HTTP 200 但为非 JSON 响应时抛错", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><body>502 Bad Gateway</body></html>",
    });
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("telegram sendMessage failed: invalid JSON response <html><body>502 Bad Gateway</body></html>");
  });

  it("文本超长截断：正文超过 4096 字符截断至 4096 字符；sendText 同样截断", async () => {
    let sentBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = init.body;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    const superLongBody = "X".repeat(5000);
    await channel.send({ severity: "critical", title: "超长告警", body: superLongBody, source: "watch" });
    const form = new URLSearchParams(sentBody);
    const text = form.get("text") ?? "";
    expect(text.length).toBe(4096);
    expect(text.endsWith("…")).toBe(true);

    await channel.sendText("Y".repeat(5000));
    const formText = new URLSearchParams(sentBody);
    const singleText = formText.get("text") ?? "";
    expect(singleText.length).toBe(4096);
    expect(singleText.endsWith("…")).toBe(true);
  });

  it("answerCallbackQuery 文本超长截断至 200 字符", async () => {
    let sentBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = init.body;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    await channel.answerCallbackQuery("cb-123", "Z".repeat(300));
    const form = new URLSearchParams(sentBody);
    const text = form.get("text") ?? "";
    expect(text.length).toBe(200);
    expect(text.endsWith("…")).toBe(true);
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

  it("邮件主题清理：消除换行符防范 CRLF 注入", async () => {
    let capturedSubject = "";
    const transporter: MailTransporter = {
      async sendMail(mail) {
        capturedSubject = mail.subject;
        return { accepted: true };
      },
    };
    const channel = new SmtpChannel({ env: SMTP_ENV, transporter });
    await channel.send({
      severity: "critical",
      title: "Line 1\r\nBcc: evil@example.com\nLine 2",
      body: "body",
      source: "watch",
    });
    expect(capturedSubject).toBe("[critical] Line 1 Bcc: evil@example.com Line 2");
    expect(capturedSubject).not.toContain("\r");
    expect(capturedSubject).not.toContain("\n");
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

  it("失败路径：HTTP 非 2xx 抛错且超长上游文本被截断", async () => {
    const rawError = "B".repeat(250);
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, text: async () => rawError });
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow(`bark push failed: HTTP 500 ${"B".repeat(200)}…`);
  });

  it("Bark 支持携带动作首个外部 URL", async () => {
    let sentBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = init.body;
      return { ok: true, status: 200, text: async () => '{"code":200}' };
    };
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });
    await channel.send({
      severity: "critical",
      title: "需审批",
      body: "请确认",
      source: "watch",
      actions: [{ label: "跳转确认", url: "https://butler.local/approvals/1" }],
    });
    const parsed = JSON.parse(sentBody) as Record<string, string>;
    expect(parsed["url"]).toBe("https://butler.local/approvals/1");
  });

  it("Bark 响应体 code 非 200 时抛错", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":400,"message":"device key not found"}',
    });
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("bark push failed: code 400 device key not found");
  });

  it("Bark 返回 HTTP 200 但为非 JSON 响应时抛错（防御假成功）", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><body>502 Bad Gateway</body></html>",
    });
    const channel = new BarkChannel({ env: BARK_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("bark push failed: invalid JSON response <html><body>502 Bad Gateway</body></html>");
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

  it("Server酱返回 HTTP 200 但 code 非 0 时抛错并包含错误信息", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":40001,"message":"[AUTH]sendkey 不存在"}',
    });
    const channel = new ServerChanChannel({ env: SC_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("serverchan push failed: code 40001 [AUTH]sendkey 不存在");
  });

  it("Server酱返回 HTTP 200 但为非 JSON 响应时抛错（防御假成功）", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><body>504 Gateway Timeout</body></html>",
    });
    const channel = new ServerChanChannel({ env: SC_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("serverchan push failed: invalid JSON response <html><body>504 Gateway Timeout</body></html>");
  });
});

describe("buildEnvChannels", () => {
  it("默认候选序列：Telegram → Bark → Server酱 → SMTP", () => {
    const channels = buildEnvChannels({});
    expect(channels.map((channel) => channel.name)).toEqual(["telegram", "bark", "serverchan", "smtp"]);
  });
});

describe("safeUpstreamExcerpt", () => {
  it("剥离 ASCII 控制字符与 ANSI 控制码字符", () => {
    const input = "\x00Hello\x1b[31m World\x7f\t\r\n";
    expect(safeUpstreamExcerpt(input)).toBe("Hello [31m World");
  });

  it("短文本保持原样", () => {
    expect(safeUpstreamExcerpt("Bad Gateway")).toBe("Bad Gateway");
  });

  it("超过 200 字符时截断并追加省略号", () => {
    const input = "X".repeat(250);
    const result = safeUpstreamExcerpt(input);
    expect(result).toHaveLength(201); // 200 + '…'
    expect(result).toBe("X".repeat(200) + "…");
  });

  it("全控制字符或空串返回空串", () => {
    expect(safeUpstreamExcerpt("")).toBe("");
    expect(safeUpstreamExcerpt("\x00\x01\x02\r\n\t ")).toBe("");
  });
});
