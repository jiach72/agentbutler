/**
 * 外发通道（Task 8）：Telegram / SMTP / Null（面板）。
 *
 * 通道接口刻意最小化（isConfigured + send），凭据从 env 读取、缺失即不可用；
 * fetch / transporter 均可注入，测试不触网。
 * 逐级降级路由由 DeliveryLoop 负责，这里只提供单通道发送能力与可用性判断。
 */
import type { AlertSeverity } from "./queue.js";
import nodemailer from "nodemailer";

export interface OutboundMessage {
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
}

export interface AlertChannel {
  /** 通道名（panel | telegram | smtp | 自定义）。 */
  readonly name: string;
  /** 凭据是否齐备（不齐备的通道不参与 critical 外发，体现为 degradedChannels）。 */
  isConfigured(): boolean;
  send(message: OutboundMessage): Promise<void>;
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
    const form = new URLSearchParams({ chat_id: this.chatId, text: formatText(message) });
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${await res.text()}`);
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
    await this.transporter.sendMail({
      from: this.from,
      to: this.to,
      subject: `[${message.severity}] ${message.title}`,
      text: formatText(message),
    });
  }
}

/* --------------------------------- 辅助函数 -------------------------------- */

function formatText(message: OutboundMessage): string {
  return `[${message.severity}] ${message.title}\n${message.body}\n(来源: ${message.source})`;
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

/** 从 env 组装默认外发候选序列：Telegram → SMTP。 */
export function buildEnvChannels(env: TelegramEnv & SmtpEnv = process.env): AlertChannel[] {
  return [new TelegramChannel({ env }), new SmtpChannel({ env })];
}
