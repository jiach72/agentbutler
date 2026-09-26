/**
 * 外发通道（Task 8）：Telegram / SMTP / Null（面板）。
 *
 * 通道接口刻意最小化（isConfigured + send），凭据从 env 读取、缺失即不可用；
 * fetch / transporter 均可注入，测试不触网。
 * 逐级降级路由由 DeliveryLoop 负责，这里只提供单通道发送能力与可用性判断。
 */
import type { AlertAction, AlertSeverity } from "./queue.js";
import nodemailer from "nodemailer";

export interface OutboundMessage {
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
  /** 交互式卡片按钮（M3.1）；不支持内联按钮的通道降级为正文追加 url。 */
  actions?: AlertAction[];
}

export interface AlertChannel {
  /** 通道名（panel | telegram | smtp | 自定义）。 */
  readonly name: string;
  /** 凭据是否齐备（不齐备的通道不参与 critical 外发，体现为 degradedChannels）。 */
  isConfigured(): boolean;
  send(message: OutboundMessage): Promise<void>;
}

/**
 * 上游错误响应体的安全摘录：截断到 200 字符并剥离控制字符。
 * 该文本会被拼进 Error 并可能随告警正文转发到其他通道——上游内容不可信，
 * 收窄长度与控制字符，避免二次注入与无界膨胀。
 */
export function safeUpstreamExcerpt(text: string): string {
  // 逐字符剥离控制字符（不用正则：控制字符字面类会触发 no-control-regex 规则）
  const cleaned = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  })
    .join("")
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/** Telegram 官方限制：单条消息文本至多 4096 字符。 */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;
/** Telegram 官方限制：callback query 弹窗/Toast 提示至多 200 字符。 */
export const TELEGRAM_MAX_CALLBACK_QUERY_TEXT = 200;

export function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_MAX_TEXT_LENGTH - 1)}…`;
}

export function truncateCallbackQueryText(text: string): string {
  if (text.length <= TELEGRAM_MAX_CALLBACK_QUERY_TEXT) return text;
  return `${text.slice(0, TELEGRAM_MAX_CALLBACK_QUERY_TEXT - 1)}…`;
}

/** 面板通道：入队即可被 butler-web 渲染，发送本身是无副作用的隐含基线。 */
export class NullChannel implements AlertChannel {
  readonly name = "panel";
  isConfigured(): boolean {
    return true;
  }
  async send(): Promise<void> {
    /* 面板通道无需外发动作 */
  }
}

/* --------------------------------- telegram -------------------------------- */

/** 可注入的最小 fetch 形状（测试用假实现避免触网）。 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TelegramEnv {
  BUTLER_TELEGRAM_BOT_TOKEN?: string;
  BUTLER_TELEGRAM_CHAT_ID?: string;
}

export interface TelegramChannelOptions {
  env?: TelegramEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class TelegramChannel implements AlertChannel {
  readonly name = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: TelegramChannelOptions = {}) {
    const env = options.env ?? process.env;
    this.token = (env.BUTLER_TELEGRAM_BOT_TOKEN ?? "").trim();
    this.chatId = (env.BUTLER_TELEGRAM_CHAT_ID ?? "").trim();
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  isConfigured(): boolean {
    return this.token !== "" && this.chatId !== "";
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConfigured()) throw new Error("telegram: missing credentials");
    const rawText = formatText(message, false);
    const form = new URLSearchParams({ chat_id: this.chatId, text: truncateTelegramText(rawText) });
    // 内联键盘：只有具备 callback_data 的按钮才能就地回执；url 按钮为纯跳转。
    const keyboard = buildInlineKeyboard(message.actions);
    if (keyboard !== null) form.set("reply_markup", JSON.stringify(keyboard));
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `telegram sendMessage failed: HTTP ${res.status} ${safeUpstreamExcerpt(text)}`,
      );
    }
    let parsed: { ok?: unknown; description?: unknown };
    try {
      parsed = JSON.parse(text) as { ok?: unknown; description?: unknown };
    } catch {
      throw new Error(
        `telegram sendMessage failed: invalid JSON response ${safeUpstreamExcerpt(text)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`telegram sendMessage failed: invalid JSON response ${safeUpstreamExcerpt(text)}`);
    }
    if (parsed.ok === false) {
      const detail =
        typeof parsed.description === "string" ? parsed.description : text;
      throw new Error(`telegram sendMessage failed: ${safeUpstreamExcerpt(detail)}`);
    }
  }

  /** 向指定会话发纯文本（口令急停回执 / 指令确认）。chat_id 缺省用配置值。 */
  async sendText(text: string, chatId?: string): Promise<void> {
    if (!this.isConfigured()) throw new Error("telegram: missing credentials");
    const form = new URLSearchParams({ chat_id: chatId ?? this.chatId, text: truncateTelegramText(text) });
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const resText = await res.text();
    if (!res.ok) {
      throw new Error(
        `telegram sendText failed: HTTP ${res.status} ${safeUpstreamExcerpt(resText)}`,
      );
    }
    let parsed: { ok?: unknown; description?: unknown };
    try {
      parsed = JSON.parse(resText) as { ok?: unknown; description?: unknown };
    } catch {
      throw new Error(
        `telegram sendText failed: invalid JSON response ${safeUpstreamExcerpt(resText)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`telegram sendText failed: invalid JSON response ${safeUpstreamExcerpt(resText)}`);
    }
    if (parsed.ok === false) {
      const detail =
        typeof parsed.description === "string" ? parsed.description : resText;
      throw new Error(`telegram sendText failed: ${safeUpstreamExcerpt(detail)}`);
    }
  }

  /**
   * 回执内联按钮点击（M3.1）：不停用会一直转圈。失败只影响交互反馈，
   * 不影响已经落地的审批决定——调用方按「尽力而为」处理。
   */
  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    if (!this.isConfigured()) throw new Error("telegram: missing credentials");
    const form = new URLSearchParams({ callback_query_id: callbackQueryId, text: truncateCallbackQueryText(text) });
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const resText = await res.text();
    if (!res.ok) {
      throw new Error(
        `telegram answerCallbackQuery failed: HTTP ${res.status} ${safeUpstreamExcerpt(resText)}`,
      );
    }
    let parsed: { ok?: unknown; description?: unknown };
    try {
      parsed = JSON.parse(resText) as { ok?: unknown; description?: unknown };
    } catch {
      throw new Error(
        `telegram answerCallbackQuery failed: invalid JSON response ${safeUpstreamExcerpt(resText)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`telegram answerCallbackQuery failed: invalid JSON response ${safeUpstreamExcerpt(resText)}`);
    }
    if (parsed.ok === false) {
      const detail =
        typeof parsed.description === "string" ? parsed.description : resText;
      throw new Error(`telegram answerCallbackQuery failed: ${safeUpstreamExcerpt(detail)}`);
    }
  }
}

/* ----------------------------------- smtp ---------------------------------- */

/** 可注入的最小邮件 transporter 形状（测试用假实现避免触网）。 */
export interface MailTransporter {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpEnv {
  BUTLER_SMTP_HOST?: string;
  BUTLER_SMTP_PORT?: string;
  BUTLER_SMTP_USER?: string;
  BUTLER_SMTP_PASS?: string;
  BUTLER_SMTP_FROM?: string;
  BUTLER_SMTP_TO?: string;
}

export interface SmtpChannelOptions {
  env?: SmtpEnv;
  transporter?: MailTransporter;
}

export class SmtpChannel implements AlertChannel {
  readonly name = "smtp";
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly pass: string;
  private readonly from: string;
  private readonly to: string;
  private readonly transporter: MailTransporter | null;

  constructor(options: SmtpChannelOptions = {}) {
    const env = options.env ?? process.env;
    this.host = (env.BUTLER_SMTP_HOST ?? "").trim();
    this.port = Number((env.BUTLER_SMTP_PORT ?? "").trim());
    this.user = (env.BUTLER_SMTP_USER ?? "").trim();
    this.pass = env.BUTLER_SMTP_PASS ?? "";
    this.from = (env.BUTLER_SMTP_FROM ?? "").trim();
    this.to = (env.BUTLER_SMTP_TO ?? "").trim();
    if (options.transporter !== undefined) {
      this.transporter = options.transporter;
    } else if (this.isConfigured()) {
      const transport: { host: string; port: number; auth?: { user: string; pass: string } } = {
        host: this.host,
        port: this.port,
      };
      if (this.user !== "" && this.pass !== "") transport.auth = { user: this.user, pass: this.pass };
      this.transporter = nodemailer.createTransport(transport) as unknown as MailTransporter;
    } else {
      this.transporter = null;
    }
  }

  /** HOST/PORT/FROM/TO 均存在才可用（USER/PASS 可选，仅用于认证）。 */
  isConfigured(): boolean {
    return (
      this.host !== "" && Number.isFinite(this.port) && this.port > 0 && this.from !== "" && this.to !== ""
    );
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConfigured() || this.transporter === null) throw new Error("smtp: missing credentials");
    // 清理邮件主题中的 CRLF 换行符，防范邮件头注入
    const sanitizedTitle = message.title.replace(/[\r\n]+/g, " ").trim();
    // HTML 正文让降级链接可点（审批卡片在邮件里的落地路径）；text 保底纯文本客户端。
    await this.transporter.sendMail({
      from: this.from,
      to: this.to,
      subject: `[${message.severity}] ${sanitizedTitle}`,
      text: formatText(message),
      html: formatHtml(message),
    } as never);
  }
}

/* ----------------------------------- bark ----------------------------------- */

export interface BarkEnv {
  BUTLER_BARK_DEVICE_KEY?: string;
  BUTLER_BARK_SERVER?: string;
}

export interface BarkChannelOptions {
  env?: BarkEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Bark（iOS 推送）：自托管服务也走同一 JSON 协议，server 可覆盖默认官方端点。 */
export class BarkChannel implements AlertChannel {
  readonly name = "bark";
  private readonly deviceKey: string;
  private readonly server: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: BarkChannelOptions = {}) {
    const env = options.env ?? process.env;
    this.deviceKey = (env.BUTLER_BARK_DEVICE_KEY ?? "").trim();
    this.server = (env.BUTLER_BARK_SERVER ?? "").trim().replace(/\/+$/, "") || "https://api.day.app";
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  isConfigured(): boolean {
    return this.deviceKey !== "";
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConfigured()) throw new Error("bark: missing credentials");
    const payload: Record<string, string> = {
      title: message.title,
      body: formatText(message),
      group: "butler",
    };
    const firstUrl = message.actions?.find((action) => isExternallyOpenableUrl(action.url))?.url;
    if (firstUrl !== undefined) {
      payload["url"] = firstUrl;
    }
    const res = await this.fetchImpl(`${this.server}/${encodeURIComponent(this.deviceKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `bark push failed: HTTP ${res.status} ${safeUpstreamExcerpt(text)}`,
      );
    }
    let parsed: { code?: unknown; message?: unknown };
    try {
      parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    } catch {
      throw new Error(
        `bark push failed: invalid JSON response ${safeUpstreamExcerpt(text)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`bark push failed: invalid JSON response ${safeUpstreamExcerpt(text)}`);
    }
    const codeNum = parsed.code !== undefined ? Number(parsed.code) : undefined;
    if (codeNum !== undefined && (!Number.isFinite(codeNum) || codeNum !== 200)) {
      const codeStr = `code ${String(parsed.code)} `;
      const errorDetail = parsed.message ? String(parsed.message) : text;
      throw new Error(
        `bark push failed: ${codeStr}${safeUpstreamExcerpt(errorDetail)}`.trim(),
      );
    }
  }
}

/* -------------------------------- serverchan -------------------------------- */

export interface ServerChanEnv {
  BUTLER_SERVERCHAN_SENDKEY?: string;
}

export interface ServerChanChannelOptions {
  env?: ServerChanEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Server酱（微信服务号推送）：title 为摘要，desp 为正文（Markdown）。 */
export class ServerChanChannel implements AlertChannel {
  readonly name = "serverchan";
  private readonly sendKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ServerChanChannelOptions = {}) {
    const env = options.env ?? process.env;
    this.sendKey = (env.BUTLER_SERVERCHAN_SENDKEY ?? "").trim();
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  isConfigured(): boolean {
    return this.sendKey !== "";
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConfigured()) throw new Error("serverchan: missing credentials");
    const form = new URLSearchParams({ title: message.title, desp: formatText(message) });
    const res = await this.fetchImpl(`https://sctapi.ftqq.com/${encodeURIComponent(this.sendKey)}.send`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `serverchan push failed: HTTP ${res.status} ${safeUpstreamExcerpt(text)}`,
      );
    }
    let parsed: { code?: unknown; message?: unknown; info?: unknown };
    try {
      parsed = JSON.parse(text) as { code?: unknown; message?: unknown; info?: unknown };
    } catch {
      throw new Error(
        `serverchan push failed: invalid JSON response ${safeUpstreamExcerpt(text)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`serverchan push failed: invalid JSON response ${safeUpstreamExcerpt(text)}`);
    }
    const codeNum = parsed.code !== undefined ? Number(parsed.code) : undefined;
    if (codeNum !== undefined && (!Number.isFinite(codeNum) || codeNum !== 0)) {
      const codeStr = `code ${String(parsed.code)} `;
      const errorDetail =
        parsed && typeof parsed === "object"
          ? String(parsed.message ?? parsed.info ?? text)
          : text;
      throw new Error(
        `serverchan push failed: ${codeStr}${safeUpstreamExcerpt(errorDetail)}`.trim(),
      );
    }
  }
}

/* --------------------------------- 辅助函数 -------------------------------- */

/**
 * 渲染正文。通道不支持内联按钮时（includeActionLinks=true），把带 url 的按钮
 * 追加为正文链接——这是「微信不支持内联按钮则降级为链接到 Web 确认页」的落点；
 * 只有 callbackData 的按钮无链接可降级，故不计入（避免出现点了没反应的死按钮）。
 */
/** HTML 版正文：动作链接渲染为 <a>（转义防注入）。仅 SMTP 使用。 */
function formatHtml(message: OutboundMessage): string {
  const esc = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const base = `<p><strong>[${esc(message.severity)}] ${esc(message.title)}</strong></p>` +
    `<p style="white-space:pre-wrap">${esc(message.body)}</p>` +
    `<p style="color:#888">来源: ${esc(message.source)}</p>`;
  const links = (message.actions ?? [])
    .filter((action) => isExternallyOpenableUrl(action.url))
    .map((action) => `<a href="${esc(action.url!)}">${esc(action.label)}</a>`);
  return links.length === 0 ? base : `${base}<hr/><p>${links.join(" &nbsp;|&nbsp; ")}</p>`;
}

/** 外发 URL 必须带 scheme（同 queue.ts 规则；相对路径不进任何通道正文）。 */
function isExternallyOpenableUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function formatText(message: OutboundMessage, includeActionLinks = true): string {
  const base = `[${message.severity}] ${message.title}\n${message.body}\n(来源: ${message.source})`;
  if (!includeActionLinks) return base;
  const links = (message.actions ?? [])
    .filter((action) => isExternallyOpenableUrl(action.url))
    .map((action) => `· ${action.label}：${action.url}`);
  return links.length === 0 ? base : `${base}\n\n${links.join("\n")}`;
}

/** Telegram 内联键盘：每行一个按钮（手机上不挤压；≤3 个按钮最多 3 行）。 */
function buildInlineKeyboard(actions: AlertAction[] | undefined): { inline_keyboard: Array<Array<Record<string, string>>> } | null {
  if (actions === undefined || actions.length === 0) return null;
  const rows: Array<Array<Record<string, string>>> = [];
  for (const action of actions) {
    if (typeof action.callbackData === "string" && action.callbackData !== "") {
      rows.push([{ text: action.label, callback_data: action.callbackData }]);
    } else if (isExternallyOpenableUrl(action.url)) {
      rows.push([{ text: action.label, url: action.url }]);
    }
  }
  return rows.length === 0 ? null : { inline_keyboard: rows };
}

/** 按给定顺序返回凭据齐备的外发通道（降级路由的候选序列）。 */
export function availableOutbound(channels: AlertChannel[]): AlertChannel[] {
  return channels.filter((channel) => channel.isConfigured());
}

/** 未配置通道的降级标签，如 "telegram:missing-credentials"（面板可见凭据缺失事实）。 */
export function degradedChannelLabels(channels: AlertChannel[]): string[] {
  return channels
    .filter((channel) => !channel.isConfigured())
    .map((channel) => `${channel.name}:missing-credentials`);
}

/** 从 env 组装默认外发候选序列：Telegram → Bark → Server酱 → SMTP。 */
export function buildEnvChannels(
  env: TelegramEnv & SmtpEnv & BarkEnv & ServerChanEnv = process.env,
): AlertChannel[] {
  return [
    new TelegramChannel({ env }),
    new BarkChannel({ env }),
    new ServerChanChannel({ env }),
    new SmtpChannel({ env }),
  ];
}
