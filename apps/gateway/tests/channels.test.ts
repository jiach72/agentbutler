import { describe, expect, it } from "vitest";
import {
  availableOutbound,
  BarkChannel,
  buildEnvChannels,
  buildInlineKeyboard,
  degradedChannelLabels,
  NullChannel,
  safeUpstreamExcerpt,
  ServerChanChannel,
  SmtpChannel,
  TelegramChannel,
  truncateButtonLabel,
  truncateCallbackData,
  truncateServerChanTitle,
  truncateSmtpSubject,
  SERVERCHAN_MAX_TITLE_LENGTH,
  SMTP_MAX_SUBJECT_LENGTH,
  TELEGRAM_MAX_CALLBACK_DATA_BYTES,
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

  it("端口范围防御：非法或越界端口判定为不可用", () => {
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "0" } }).isConfigured()).toBe(false);
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "-1" } }).isConfigured()).toBe(false);
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "70000" } }).isConfigured()).toBe(false);
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "abc" } }).isConfigured()).toBe(false);
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "587" } }).isConfigured()).toBe(true);
    expect(new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "25" } }).isConfigured()).toBe(true);
  });

  it("TLS secure 判定：465 默认 SMTPS，587 默认 STARTTLS，支持环境变量与选项覆盖", () => {
    const s465 = new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "465" } });
    expect(s465.secure).toBe(true);

    const s587 = new SmtpChannel({ env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "587" } });
    expect(s587.secure).toBe(false);

    const sOverrideEnv = new SmtpChannel({
      env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "587", BUTLER_SMTP_SECURE: "true" },
    });
    expect(sOverrideEnv.secure).toBe(true);

    const sOverrideOpt = new SmtpChannel({
      env: { ...SMTP_ENV, BUTLER_SMTP_PORT: "465" },
      secure: false,
    });
    expect(sOverrideOpt.secure).toBe(false);
  });

  it("超时熔断：transporter 长时间挂起时按 timeoutMs 熔断抛错，防范死锁投递循环", async () => {
    const hangingTransporter: MailTransporter = {
      async sendMail() {
        return new Promise(() => {}); // 永不结束的挂起
      },
    };
    const channel = new SmtpChannel({
      env: SMTP_ENV,
      transporter: hangingTransporter,
      timeoutMs: 50,
    });

    await expect(
      channel.send({ severity: "critical", title: "紧急告警", body: "内容", source: "watch" }),
    ).rejects.toThrow("smtp sendMail timed out after 50ms");
  });

  it("发件人与收件人清理：消除 from/to 换行符防范 CRLF 注入", async () => {
    const channel = new SmtpChannel({
      env: {
        ...SMTP_ENV,
        BUTLER_SMTP_FROM: "butler@example.com\r\nBcc: evil@example.com",
        BUTLER_SMTP_TO: "ops@example.com\nCc: spy@example.com",
      },
    });
    expect(channel.from).toBe("butler@example.comBcc: evil@example.com");
    expect(channel.to).toBe("ops@example.comCc: spy@example.com");
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

  it("truncateServerChanTitle 保持 32 字符以内原样，超过 32 字符安全截断", () => {
    expect(SERVERCHAN_MAX_TITLE_LENGTH).toBe(32);
    expect(truncateServerChanTitle("短标题")).toBe("短标题");
    const exact32 = "12345678901234567890123456789012";
    expect(truncateServerChanTitle(exact32)).toBe(exact32);
    const long = "123456789012345678901234567890123456";
    const truncated = truncateServerChanTitle(long);
    expect(truncated).toHaveLength(32);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).toBe("1234567890123456789012345678901…");
  });

  it("Server酱外发时自动截断超长标题为 32 字符以内，防范通道丢弃或 40001 报错", async () => {
    const calls: Array<{ url: string; init: { body: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"code":0,"message":""}' };
    };
    const channel = new ServerChanChannel({ env: SC_ENV, fetchImpl });
    const superLongTitle = "【紧急警报】系统核心资源告警：WSL宿主机节点CPU使用率达到 99.8% 且内存耗尽";
    await channel.send({
      severity: "critical",
      title: superLongTitle,
      body: "请立即处置",
      source: "watchdog",
    });

    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]!.init.body);
    const sentTitle = form.get("title");
    expect(sentTitle).toBeDefined();
    expect(sentTitle!.length).toBeLessThanOrEqual(32);
    expect(sentTitle!.endsWith("…")).toBe(true);
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

  it("自动遮罩传入的敏感密钥凭据与 Telegram bot token 格式", () => {
    const raw = "Failed to connect to https://api.telegram.org/bot123456:ABC-DEF1234ghIkl/sendMessage with key secret-token-xyz";
    const masked = safeUpstreamExcerpt(raw, ["secret-token-xyz"]);
    expect(masked).not.toContain("123456:ABC-DEF1234ghIkl");
    expect(masked).not.toContain("secret-token-xyz");
    expect(masked).toContain("/bot[REDACTED]");
    expect(masked).toContain("[REDACTED]");
  });
});

describe("Telegram 内联键盘限制与智能降级", () => {
  it("callbackData <= 64 字节时正常生成 callback_data 按钮", () => {
    const actions = [{ label: "通过", callbackData: "apr:123:approve" }];
    const markup = buildInlineKeyboard(actions);
    expect(markup?.inline_keyboard[0]?.[0]).toEqual({ text: "通过", callback_data: "apr:123:approve" });
  });

  it("callbackData > 64 字节但带有效 URL 时智能降级为 url 按钮，保障交互可达", () => {
    const longData = "apr:" + "a".repeat(70) + ":approve"; // 78 字节
    const actions = [{ label: "确认审批", callbackData: longData, url: "https://butler.local/approvals/123" }];
    const markup = buildInlineKeyboard(actions);
    expect(markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "确认审批",
      url: "https://butler.local/approvals/123",
    });
    expect(markup?.inline_keyboard[0]?.[0]).not.toHaveProperty("callback_data");
  });

  it("callbackData > 64 字节且无 URL 时防御性截断至 64 字节以内，避免 Telegram 报 BUTTON_DATA_INVALID", () => {
    const longData = "apr:" + "b".repeat(80);
    const markup = buildInlineKeyboard([{ label: "操作", callbackData: longData }]);
    const btn = markup?.inline_keyboard[0]?.[0];
    expect(btn?.callback_data).toBeDefined();
    expect(Buffer.byteLength(btn!.callback_data!, "utf8")).toBeLessThanOrEqual(TELEGRAM_MAX_CALLBACK_DATA_BYTES);
    expect(btn!.callback_data).toBe(truncateCallbackData(longData));
  });

  it("多字节 UTF-8 字符截断时不产生半个字符乱码", () => {
    const chineseData = "测试中文审批单数据超长字符串测试中文审批单数据超长字符串"; // 每个中文 3 字节，共 84 字节
    const truncated = truncateCallbackData(chineseData, 64);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(64);
    // 能够正常重新编码且不含乱码替换字符
    expect(Buffer.from(truncated, "utf8").toString("utf8")).toBe(truncated);
  });

  it("按钮文本超过 64 字符时防御性截断", () => {
    const longLabel = "超长按钮文本".repeat(20);
    expect(truncateButtonLabel(longLabel).length).toBe(64);
    expect(truncateButtonLabel(longLabel).endsWith("…")).toBe(true);
  });

  it("按钮文本为空或纯空白字符时自动过滤，防止 Telegram API 报错 400 BUTTON_TEXT_INVALID", () => {
    const markup = buildInlineKeyboard([
      { label: "   ", callbackData: "apr:123:approve" },
      { label: "", url: "https://butler.local/approvals/1" },
      { label: "有效操作", callbackData: "apr:456:deny" },
    ]);
    expect(markup?.inline_keyboard).toHaveLength(1);
    expect(markup?.inline_keyboard[0]?.[0]).toEqual({ text: "有效操作", callback_data: "apr:456:deny" });
  });
});

describe("外发通道网络异常捕获与凭据脱敏防线", () => {
  it("TelegramChannel 网络异常抛出时剥离 token", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.telegram.org/botbot-token-1/sendMessage");
    };
    const channel = new TelegramChannel({ env: TELEGRAM_ENV, fetchImpl });
    await expect(
      channel.send({ severity: "critical", title: "t", body: "b", source: "s" }),
    ).rejects.toThrow("telegram sendMessage failed:");

    let caughtErr: Error | null = null;
    try {
      await channel.send({ severity: "critical", title: "t", body: "b", source: "s" });
    } catch (e) {
      caughtErr = e as Error;
    }
    expect(caughtErr?.message).not.toContain("bot-token-1");
    expect(caughtErr?.message).toContain("[REDACTED]");
  });

  it("BarkChannel 网络异常抛出时剥离 deviceKey", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED https://api.day.app/device-key-secret-12345");
    };
    const channel = new BarkChannel({ env: { BUTLER_BARK_DEVICE_KEY: "device-key-secret-12345" }, fetchImpl });
    let caughtErr: Error | null = null;
    try {
      await channel.send({ severity: "critical", title: "t", body: "b", source: "s" });
    } catch (e) {
      caughtErr = e as Error;
    }
    expect(caughtErr?.message).not.toContain("device-key-secret-12345");
    expect(caughtErr?.message).toContain("[REDACTED]");
  });

  it("ServerChanChannel 网络异常抛出时剥离 sendKey", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT https://sctapi.ftqq.com/SCT123456SecretKey.send");
    };
    const channel = new ServerChanChannel({ env: { BUTLER_SERVERCHAN_SENDKEY: "SCT123456SecretKey" }, fetchImpl });
    let caughtErr: Error | null = null;
    try {
      await channel.send({ severity: "critical", title: "t", body: "b", source: "s" });
    } catch (e) {
      caughtErr = e as Error;
    }
    expect(caughtErr?.message).not.toContain("SCT123456SecretKey");
    expect(caughtErr?.message).toContain("[REDACTED]");
  });

  it("SmtpChannel 发送异常时自动剥离 pass 与 user 敏感凭据，防范密码外泄至 last_error", async () => {
    const transporter: MailTransporter = {
      async sendMail() {
        throw new Error(
          "535 5.7.8 Authentication credentials invalid for user: my_smtp_user, pass: super_secret_password_9988",
        );
      },
    };
    const channel = new SmtpChannel({
      env: {
        BUTLER_SMTP_HOST: "smtp.example.com",
        BUTLER_SMTP_PORT: "465",
        BUTLER_SMTP_USER: "my_smtp_user",
        BUTLER_SMTP_PASS: "super_secret_password_9988",
        BUTLER_SMTP_FROM: "from@example.com",
        BUTLER_SMTP_TO: "to@example.com",
      },
      transporter,
    });

    let caughtErr: Error | null = null;
    try {
      await channel.send({ severity: "critical", title: "告警", body: "正文", source: "watch" });
    } catch (e) {
      caughtErr = e as Error;
    }
    expect(caughtErr?.message).toBeDefined();
    expect(caughtErr?.message).not.toContain("super_secret_password_9988");
    expect(caughtErr?.message).not.toContain("my_smtp_user");
    expect(caughtErr?.message).toContain("[REDACTED]");
  });

  it("safeUpstreamExcerpt 自动遮罩 URL 中内嵌的账号密码凭据", () => {
    const raw = "connect failed to smtps://ops_bot:super_secret_token_123@smtp.feishu.cn:465/mail";
    const masked = safeUpstreamExcerpt(raw);
    expect(masked).not.toContain("ops_bot");
    expect(masked).not.toContain("super_secret_token_123");
    expect(masked).toBe("connect failed to smtps://[REDACTED]:[REDACTED]@smtp.feishu.cn:465/mail");
  });
});

describe("Smtp 主题截断与邮件格式化防线", () => {
  it("truncateSmtpSubject 保持 120 字符以内原样，超过 120 字符安全截断", () => {
    expect(SMTP_MAX_SUBJECT_LENGTH).toBe(120);
    expect(truncateSmtpSubject("短主题")).toBe("短主题");
    const exact120 = "A".repeat(120);
    expect(truncateSmtpSubject(exact120)).toBe(exact120);
    const long = "A".repeat(150);
    const truncated = truncateSmtpSubject(long);
    expect(truncated).toHaveLength(120);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("SmtpChannel 发送时自动截断超长主题为 120 字符以内，防范邮件网关 554/501 报错", async () => {
    let capturedSubject = "";
    const transporter: MailTransporter = {
      async sendMail(mail) {
        capturedSubject = mail.subject;
        return { accepted: true };
      },
    };
    const channel = new SmtpChannel({
      env: {
        BUTLER_SMTP_HOST: "smtp.example.com",
        BUTLER_SMTP_PORT: "465",
        BUTLER_SMTP_FROM: "from@example.com",
        BUTLER_SMTP_TO: "to@example.com",
      },
      transporter,
    });
    const superLongTitle = "【紧急警报】系统核心资源告警：" + "关键指标超限故障详情".repeat(20);
    await channel.send({
      severity: "critical",
      title: superLongTitle,
      body: "请立即处置",
      source: "watchdog",
    });
    expect(capturedSubject.startsWith("[critical] ")).toBe(true);
    const titlePart = capturedSubject.replace("[critical] ", "");
    expect(titlePart.length).toBeLessThanOrEqual(120);
    expect(titlePart.endsWith("…")).toBe(true);
  });

  it("formatHtml 与 formatText 自动过滤空标签或纯空白标签动作，防范不可点击死链接", async () => {
    let sentMail: { text: string; html?: string } | undefined;
    const transporter: MailTransporter = {
      async sendMail(mail) {
        sentMail = mail;
        return { accepted: true };
      },
    };
    const channel = new SmtpChannel({
      env: {
        BUTLER_SMTP_HOST: "smtp.example.com",
        BUTLER_SMTP_PORT: "465",
        BUTLER_SMTP_FROM: "from@example.com",
        BUTLER_SMTP_TO: "to@example.com",
      },
      transporter,
    });

    await channel.send({
      severity: "critical",
      title: "审批卡片",
      body: "请确认",
      source: "watch",
      actions: [
        { label: "   ", url: "https://butler.local/empty-1" },
        { label: "", url: "https://butler.local/empty-2" },
        { label: "有效审批", url: "https://butler.local/approvals/1" },
      ],
    });

    expect(sentMail).toBeDefined();
    // 纯文本正文中不含空标签行
    expect(sentMail!.text).not.toContain("https://butler.local/empty-1");
    expect(sentMail!.text).not.toContain("https://butler.local/empty-2");
    expect(sentMail!.text).toContain("· 有效审批：https://butler.local/approvals/1");
    // HTML 正文中不含空 <a> 标签
    expect(sentMail!.html).not.toContain("https://butler.local/empty-1");
    expect(sentMail!.html).not.toContain("https://butler.local/empty-2");
    expect(sentMail!.html).toContain('<a href="https://butler.local/approvals/1">有效审批</a>');
  });
});

describe("BarkChannel 告警级别 payload 增强", () => {
  it("critical 告警注入 level: critical 触发 iOS 关键警报", async () => {
    let sentPayload: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      sentPayload = JSON.parse(init.body) as Record<string, string>;
      return { ok: true, status: 200, text: async () => '{"code":200}' };
    };
    const channel = new BarkChannel({
      env: { BUTLER_BARK_DEVICE_KEY: "device-key" },
      fetchImpl,
    });

    await channel.send({
      severity: "critical",
      title: "严重宕机",
      body: "节点失联",
      source: "watchdog",
    });

    expect(sentPayload["level"]).toBe("critical");
  });

  it("warn 告警注入 level: timeSensitive 触发时效性通知", async () => {
    let sentPayload: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      sentPayload = JSON.parse(init.body) as Record<string, string>;
      return { ok: true, status: 200, text: async () => '{"code":200}' };
    };
    const channel = new BarkChannel({
      env: { BUTLER_BARK_DEVICE_KEY: "device-key" },
      fetchImpl,
    });

    await channel.send({
      severity: "warn",
      title: "磁盘快满",
      body: "已达 85%",
      source: "watchdog",
    });

    expect(sentPayload["level"]).toBe("timeSensitive");
  });
});

