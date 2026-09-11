/**
 * butler-gateway HTTP 服务（Task 8）：告警入队 API + 投递循环装配。
 *
 * 契约（被 butler-watch 与 butler-web 共用，必须严格一致）：
 * - POST /api/alerts  → 202 { id }（dedupeKey 命中未终结行时返回已有 id）
 * - GET  /api/alerts?limit=50 → { counts, unreadCount, degradedChannels, items }
 * - POST /api/alerts/:id/read → 单条标记已读
 * - POST /api/alerts/read-all → 标记全部重要通知已读
 * - GET  /healthz     → { ok: true, pending }
 *
 * 返回 Fastify 实例，并在其上挂载 app.gateway 句柄（queue/channels/loop/
 * degradedChannels/close），队列、通道、时钟、调度器均可注入便于测试。
 */
import path from "node:path";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CONTROL_API_SCHEMA_VERSION, CONTRACT_VERSION, isOutboxState } from "@butler/contract";
import type { ChannelControlPort, InboundHistoryView, OutboxMessageView, PolicySnapshot, Result } from "@butler/contract";
import { readHermesConfig } from "@butler/adapter-hermes";
import { ensureButlerHome } from "@butler/core";
import { buildEnvChannels, degradedChannelLabels, TelegramChannel, type AlertChannel } from "./channels.js";
import { DeliveryLoop, type Clock, type LoopScheduler } from "./loop.js";
import { validateMessagePolicy } from "./message/config.js";
import type { MessageGatewayStatus } from "./message/service.js";
import type { DndRuleInput, MessagePolicyStore, RelayControlView } from "./message/store.js";
import { MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS } from "./message/store.js";
import type { MessagePolicyConfig } from "./message/types.js";
import {
  AlertQueue,
  MAX_ALERT_ACTIONS,
  normalizeCooldownMs,
  type AlertAction,
  type AlertRow,
  type AlertSeverity,
} from "./queue.js";

const SEVERITIES: readonly AlertSeverity[] = ["info", "warn", "critical"];
const DEFAULT_PACE_SEC = 30;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const DND_SCOPES = new Set(["global", "channel", "session"]);
const DEFAULT_WEIXIN_MIN_INTERVAL_SEC = 45;

/** 会改变状态的请求方法；只有它们需要校验来源。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 来源是否指向本机；解析失败按不受信任处理。 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function isSameRequestOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") return false;
  try {
    return new URL(origin).host.toLowerCase() === new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return false;
  }
}

function hasAllowedOrigin(origin: string): boolean {
  return (process.env["BUTLER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .includes(origin);
}
export const GATEWAY_SERVICE_VERSION = `gateway@1.0.0-beta.33+${CONTRACT_VERSION}`;

export type MessageDeliveryMode = "native" | "observe" | "disabled";

/** 通知即操作（M3.1）：通道侧按钮回执 → Watch 审批决策的桥接端口。 */
export interface ApprovalCallbackInput {
  approvalId: string;
  decision: "approve" | "deny";
  /** 通道侧身份（Telegram 用户名或 id），用于审计「谁批的」。 */
  actor?: string;
  channel: string;
}

export interface ApprovalCallbackResult {
  ok: boolean;
  /** not-found | already-settled | requires-web-confirm | expired | upstream-error */
  reason?: string;
  /** 回执给用户看的一句话（Telegram toast）。 */
  message: string;
}

export type ApprovalDecider = (input: ApprovalCallbackInput) => Promise<ApprovalCallbackResult>;

/* ------------------- 通道口令急停（M1.3） ------------------- */

export type KillswitchCommand = "engage" | "release" | "status";

export interface KillswitchCommandInput {
  command: KillswitchCommand;
  /** 通道侧身份，用于审计「谁按的急停」。 */
  actor?: string;
  channel: string;
}

export interface KillswitchCommandResult {
  ok: boolean;
  /** already-engaged | not-engaged | upstream-error | unavailable */
  reason?: string;
  /** 回给用户看的一句话。 */
  message: string;
}

export type KillswitchCommander = (input: KillswitchCommandInput) => Promise<KillswitchCommandResult>;

/**
 * 口令急停指令解析。
 *
 * 安全设计（这是唯一能「停掉全部实例」的远程入口，必须保守）：
 * 1. 口令未配置或长度 < 6 → 功能整体关闭（返回 null），绝不退化成「任意文本都能急停」；
 * 2. 口令必须**完整出现**在文本中；
 * 3. 只认显式动词，不认模糊表述；解析不出动词则返回 null（当作普通消息忽略）。
 *
 * 实现注意：中文在 JS 正则里不算 `\w`，所以中文分支不能跟 `\b`（`恢复\b` 永不匹配）；
 * 词边界只加在拉丁分支上。
 */
const KILLSWITCH_RELEASE_RE = /恢复|解除|释放|\b(?:resume|release|unpause)\b/i;
const KILLSWITCH_ENGAGE_RE =
  /急停|停机|全部停止|停止所有|\b(?:emergency\s*stop|panic|killswitch|kill\s*switch|halt|stop\s*all)\b/i;
const KILLSWITCH_STATUS_RE = /状态|\b(?:status|state)\b/i;

export function parseKillswitchCommand(
  text: string,
  passphrase: string,
): { command: KillswitchCommand } | null {
  const secret = passphrase.trim();
  if (secret.length < 6) return null;
  const normalized = text.trim();
  if (normalized === "") return null;
  if (!normalized.includes(secret)) return null;
  // 去掉口令后的剩余部分即指令动词区。
  const rest = normalized.split(secret).join(" ").trim();
  if (rest === "") return null;

  // 恢复必须排在急停之前判断：「恢复运行」里不含「急停」，但避免将来词表扩展时误判。
  if (KILLSWITCH_RELEASE_RE.test(rest)) return { command: "release" };
  if (KILLSWITCH_ENGAGE_RE.test(rest)) return { command: "engage" };
  if (KILLSWITCH_STATUS_RE.test(rest)) return { command: "status" };
  return null;
}

/** 默认实现：把口令急停转发到 Watch 的 killswitch 端点。 */
export function createWatchKillswitchCommander(options: {
  watchUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): KillswitchCommander {
  const base = (
    options.watchUrl ??
    process.env["BUTLER_WATCH_URL"] ??
    process.env["BUTLER_WATCH_HTTP_URL"] ??
    "http://127.0.0.1:7533"
  ).replace(/\/+$/, "");
  const doFetch = options.fetchFn ?? ((url, init) => fetch(url, init));
  // 急停是「尽快停掉」的路径，超时给得比审批短。
  const timeoutMs = options.timeoutMs ?? 8000;

  return async (input) => {
    try {
      if (input.command === "status") {
        const response = await doFetch(`${base}/api/killswitch`, {
          method: "GET",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { ok: false, reason: "unavailable", message: "管家急停服务暂时不可用" };
        }
        const state = (await response.json()) as { engaged?: boolean; engagedAt?: string | null };
        return {
          ok: true,
          message: state.engaged === true
            ? `当前状态：已急停（${state.engagedAt ?? "时间未知"}）`
            : "当前状态：运行中，未急停",
        };
      }

      const endpoint = input.command === "engage" ? "engage" : "release";
      const response = await doFetch(`${base}/api/killswitch/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger: "channel-command",
          ...(input.actor === undefined || input.actor === "" ? {} : { actor: input.actor }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return {
          ok: true,
          message: input.command === "engage" ? "已急停：全部实例已停止并落盘留痕" : "已恢复运行",
        };
      }
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const error = typeof body["error"] === "string" ? body["error"] : "";
        if (error === "killswitch-already-engaged") {
          return { ok: false, reason: "already-engaged", message: "当前已经是急停状态，无需重复操作" };
        }
        if (error === "killswitch-not-engaged") {
          return { ok: false, reason: "not-engaged", message: "当前没有处于急停状态" };
        }
        return { ok: false, reason: "upstream-error", message: `操作被拒绝（HTTP ${response.status}）` };
      }
      return { ok: false, reason: "upstream-error", message: `操作失败（HTTP ${response.status}）` };
    } catch {
      return { ok: false, reason: "upstream-error", message: "管家暂时联系不上，急停指令未送达" };
    }
  };
}

/** 默认实现：转发到 Watch 的决策端点（HTTP 401/404/409/410 原样映射为 reason）。 */
export function createWatchApprovalDecider(options: {
  watchUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): ApprovalDecider {
  // 变量名与 butler-web 的 BUTLER_WATCH_URL 保持一致（compose 内为 http://butler-watch:7533）。
  const base = (
    options.watchUrl ??
    process.env["BUTLER_WATCH_URL"] ??
    process.env["BUTLER_WATCH_HTTP_URL"] ??
    "http://127.0.0.1:7533"
  ).replace(/\/+$/, "");
  const doFetch = options.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 5000;
  return async (input) => {
    try {
      const response = await doFetch(
        `${base}/api/approvals/${encodeURIComponent(input.approvalId)}/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: input.decision,
            channel: input.channel,
            // 通道侧来源，不允许对已升级单放行（服务端只认 panel/web）。
            source: "channel",
            ...(input.actor === undefined || input.actor === "" ? {} : { actor: input.actor }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.ok) {
        return {
          ok: true,
          message: input.decision === "approve" ? "已批准本次操作" : "已拒绝本次操作",
        };
      }
      const reason = mapDecideFailureReason(response.status);
      return { ok: false, reason, message: describeDecideFailure(reason) };
    } catch {
      return { ok: false, reason: "upstream-error", message: "管家暂时联系不上，请稍后在面板处理" };
    }
  };
}

function mapDecideFailureReason(status: number): string {
  if (status === 404) return "not-found";
  if (status === 409) return "already-settled";
  if (status === 410) return "expired";
  if (status === 503) return "upstream-unavailable";
  return "upstream-error";
}

function describeDecideFailure(reason: string): string {
  switch (reason) {
    case "not-found":
      return "该操作已不存在";
    case "already-settled":
      return "该操作已被处理，或已升级为需在面板确认";
    case "expired":
      return "已超时，按默认拒绝拦截";
    case "upstream-unavailable":
      return "管家审批服务未启用";
    default:
      return "处理失败，请在面板重试";
  }
}

export interface MessageGatewayController {
  status(): Promise<MessageGatewayStatus>;
  updatePolicy(config: MessagePolicyConfig): Promise<PolicySnapshot>;
  wake(): void;
  setRelayEnabled(enabled: boolean): Promise<RelayControlView>;
}

export interface GatewayServerOptions {
  /** Butler 主目录（默认 env BUTLER_HOME 或 ~/.agent-butler）。 */
  home?: string;
  /** 直接指定队列 db 文件（测试注入，优先于 home）。 */
  dbFile?: string;
  /** 注入队列（测试；注入时不由本服务负责关闭）。 */
  queue?: AlertQueue;
  /** 注入外发候选通道（默认从 env 组装 Telegram → SMTP）。 */
  channels?: AlertChannel[];
  /** 配速间隔秒（默认 env BUTLER_GATEWAY_PACE_SEC 或 30）。 */
  paceSec?: number;
  /** 同 dedupeKey 告警冷却窗毫秒（默认 env BUTLER_ALERT_COOLDOWN_MS 或 2h；测试显式注入用）。 */
  alertCooldownMs?: number;
  clock?: Clock;
  scheduler?: LoopScheduler;
  /** 是否自动启动投递循环（默认 true，测试可关）。 */
  startLoop?: boolean;
  /** 注入 Hermes 消息网关服务；真实环境装配属于 runtime integration。 */
  messageService?: MessageGatewayController;
  /** 注入 Butler 消息投影库；WSL Outbox 仍是权威来源。 */
  messageStore?: MessagePolicyStore;
  /** M5 入站消息优化对照历史（由 Hermes 消息运行时提供）。 */
  inboundHistory?: (limit?: number) => Promise<Result<InboundHistoryView>>;
  /** 死信重投（dead_letter → policy_pending；由 Hermes 消息运行时注入）。 */
  redeliver?: (messageId: string) => Promise<Result<OutboxMessageView>>;
  /** 立即发送（held_dnd/held_pacing/ready → ready + availableAt=now；由 Hermes 消息运行时注入）。 */
  expedite?: (messageId: string) => Promise<Result<OutboxMessageView>>;
  /** Bridge 通道控制面端口（目录/启停/微信扫码；仅 Hermes 消息运行时注入）。 */
  channelControl?: ChannelControlPort;
  /** Hermes native is authoritative by default; the Butler runtime is observe-only when enabled. */
  messageMode?: MessageDeliveryMode;
  nativeMinIntervalSec?: number;
  /** 访问口令（测试显式注入用；生产缺省读 env BUTLER_ACCESS_TOKEN，避免测试间共享 env 竞态）。 */
  accessToken?: string;
  /** /internal/hermes/* 每分钟 wake 上限（测试显式注入用；生产缺省读 env，默认 120）。 */
  wakeRateLimit?: number;
  /** 通知即操作（M3.1）：通道按钮回执 → Watch 决策的桥接（缺省按 env 组装 HTTP 客户端）。 */
  approvalDecider?: ApprovalDecider;
  /** Telegram webhook 校验密钥（缺省读 BUTLER_TELEGRAM_WEBHOOK_SECRET；未配置则不校验）。 */
  telegramWebhookSecret?: string;
  /** M1.3 通道口令急停：指令 → Watch killswitch 的桥接（缺省按 env 组装 HTTP 客户端）。 */
  killswitchCommander?: KillswitchCommander;
  /** M1.3 急停口令（缺省读 BUTLER_KILLSWITCH_PASSPHRASE；未配置则通道急停整体关闭）。 */
  killswitchPassphrase?: string;
}

export interface GatewayHandle {
  queue: AlertQueue;
  channels: AlertChannel[];
  loop: DeliveryLoop;
  /** 未配置外发通道标签，如 "telegram:missing-credentials"。 */
  degradedChannels(): string[];
  /** 优雅退出：停循环 → 关库（自有队列时）→ 关服务。 */
  close(): Promise<void>;
}

export type GatewayApp = FastifyInstance & { gateway: GatewayHandle };

export function createGatewayServer(options: GatewayServerOptions = {}): GatewayApp {
  let queue = options.queue;
  let ownsQueue = false;
  if (queue === undefined) {
    const paths = ensureButlerHome(options.home);
    queue = new AlertQueue(options.dbFile ?? path.join(paths.dataDir, "gateway.db"), {
      cooldownMs: options.alertCooldownMs ?? alertCooldownMsFromEnv(),
    });
    ownsQueue = true;
  }

  const channels = options.channels ?? buildEnvChannels();
  const loop = new DeliveryLoop({
    queue,
    outbound: channels,
    paceSec: options.paceSec ?? paceSecFromEnv(),
    clock: options.clock,
    scheduler: options.scheduler,
  });

  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES }) as unknown as GatewayApp;

  /**
   * 访问口令（配置了 BUTLER_ACCESS_TOKEN 时启用）：网关能读全部消息正文、改策略与 DND，
   * 内网不等于可信。/healthz 与 /internal/hermes/* 豁免（后者仅触发 wake 且单独限速）。
   */
  const accessToken = (options.accessToken ?? process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();
  if (accessToken !== "") {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/healthz" || request.url.startsWith("/internal/hermes/")) return;
      const auth = request.headers["authorization"];
      const match = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
      const header = request.headers["x-butler-token"];
      const queryToken = new URL(request.url, "http://127.0.0.1").searchParams.get("token");
      const received = (match?.[1] ?? (typeof header === "string" ? header : "") ?? "").trim() || (queryToken ?? "").trim();
      const expected = Buffer.from(accessToken, "utf8");
      const receivedBytes = Buffer.from(received, "utf8");
      if (
        expected.length !== receivedBytes.length ||
        !timingSafeEqual(expected, receivedBytes)
      ) {
        reply.code(401);
        return reply.send({ error: "unauthorized", reason: "需要访问口令" });
      }
    });
  }

  /** /internal/hermes/* 固定窗口限速：这些端点只触发 wake，但也不能被本机进程无限打。 */
  const wakeRateLimit =
    options.wakeRateLimit ?? (Number(process.env["BUTLER_GATEWAY_WAKE_RATE_LIMIT"] ?? 120) || 120);
  let wakeWindowStart = 0;
  let wakeCount = 0;
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/internal/hermes/")) return;
    const nowMs = Date.now();
    if (nowMs - wakeWindowStart >= 60_000) {
      wakeWindowStart = nowMs;
      wakeCount = 0;
    }
    wakeCount += 1;
    if (wakeCount > wakeRateLimit) {
      reply.code(429);
      return reply.send({ error: "wake-rate-limited", reason: "内部提示触发过于频繁，本轮已忽略" });
    }
  });

  /**
   * 来源校验（CSRF 防线）。网关能改免打扰规则、改发送策略、标记已读。
   * 与 watch 同理：服务端代理（web → gateway）不带 Origin，一律放行；
   * 同源的局域网面板请求也允许通过；不同 Origin 才可能是别人页面里发来的。
   */
  app.addHook("onRequest", async (request, reply) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;
    const origin = request.headers["origin"];
    if (typeof origin !== "string" || origin.trim() === "") return;
    if (isLoopbackOrigin(origin) || isSameRequestOrigin(origin, request.headers.host) || hasAllowedOrigin(origin)) return;
    reply.code(403);
    return reply.send({ error: "origin-not-allowed" });
  });

  const queueRef = queue;
  app.gateway = {
    queue,
    channels,
    loop,
    degradedChannels: () => degradedChannelLabels(channels),
    close: async () => {
      await loop.stop();
      if (ownsQueue) queueRef.close();
      await app.close();
    },
  };

  app.post("/api/alerts", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const kind = readString(body["kind"]);
    const title = readString(body["title"]);
    const bodyText = readString(body["body"]);
    const source = readString(body["source"]);
    const severity = readString(body["severity"]);
    const dedupeKeyRaw = body["dedupeKey"];
    const ts = body["ts"];

    if (kind === null || title === null || bodyText === null || source === null) {
      return await reply.code(400).send({ error: "kind/title/body/source 均为必填字符串" });
    }
    if (!SEVERITIES.includes(severity as AlertSeverity)) {
      return await reply
        .code(400)
        .send({ error: `severity 必须是 ${SEVERITIES.join(" | ")} 之一` });
    }
    if (
      (dedupeKeyRaw !== undefined && typeof dedupeKeyRaw !== "string") ||
      (ts !== undefined && typeof ts !== "string")
    ) {
      return await reply.code(400).send({ error: "dedupeKey/ts 若提供必须是字符串" });
    }
    const dedupeKey = typeof dedupeKeyRaw === "string" ? dedupeKeyRaw.trim() : "";

    // 交互式卡片按钮（可选）：≤3 项，label 必填，url / callbackData 至少一个。
    const actionsRaw = body["actions"];
    let actions: AlertAction[] | undefined;
    if (actionsRaw !== undefined) {
      if (!Array.isArray(actionsRaw)) {
        return await reply.code(400).send({ error: "actions 必须是数组" });
      }
      if (actionsRaw.length > MAX_ALERT_ACTIONS) {
        return await reply.code(400).send({ error: `actions 最多 ${MAX_ALERT_ACTIONS} 个` });
      }
      const parsed: AlertAction[] = [];
      for (const item of actionsRaw) {
        if (typeof item !== "object" || item === null) {
          return await reply.code(400).send({ error: "actions 每项必须是对象" });
        }
        const record = item as Record<string, unknown>;
        const label = readString(record["label"])?.trim() ?? "";
        const url = typeof record["url"] === "string" ? record["url"].trim() : "";
        const callbackData = typeof record["callbackData"] === "string" ? record["callbackData"].trim() : "";
        if (label === "") {
          return await reply.code(400).send({ error: "actions[].label 必填" });
        }
        if (url === "" && callbackData === "") {
          return await reply.code(400).send({ error: "actions[] 必须提供 url 或 callbackData" });
        }
        parsed.push({
          label,
          ...(callbackData === "" ? {} : { callbackData }),
          ...(url === "" ? {} : { url }),
        });
      }
      if (parsed.length > 0) actions = parsed;
    }

    // ts 为上报侧时间戳，仅接受不持久化：投递排序一律以队列侧 created_at 为准。
    const row = queueRef.enqueue({
      kind,
      severity: severity as AlertSeverity,
      title,
      body: bodyText,
      source,
      dedupeKey: dedupeKey || undefined,
      ...(actions === undefined ? {} : { actions }),
    });
    return await reply.code(202).send({ id: row.id });
  });

  app.get("/api/alerts", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const limit = parseLimit(query["limit"]);
    return {
      counts: queueRef.counts(),
      unreadCount: queueRef.unreadCount(),
      degradedChannels: degradedChannelLabels(channels),
      items: queueRef.list(limit).map(toApiItem),
    };
  });

  app.post("/api/alerts/read-all", async () => {
    return { marked: queueRef.markAllRead() };
  });

  // 故障恢复归档（探针恢复时由 watch 调用）：未投递行置 resolved，已投递行补已读。
  app.post("/api/alerts/resolve", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const dedupeKey = typeof body["dedupeKey"] === "string" ? body["dedupeKey"].trim() : "";
    if (dedupeKey === "") {
      return await reply.code(400).send({ error: "dedupeKey 为必填字符串" });
    }
    return queueRef.resolveByDedupeKey(dedupeKey);
  });

  app.post("/api/alerts/:id/read", async (request, reply) => {
    const rawId = (request.params as Record<string, unknown>)["id"];
    const id = typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "invalid-alert-id" });
    }
    const row = queueRef.markRead(id);
    if (row === undefined) return reply.code(404).send({ error: "alert-not-found" });
    return { item: toApiItem(row) };
  });

  /**
   * Telegram 内联按钮回执（M3.1）。Telegram 侧按钮 callback_data 形如
   * `apr:<approvalId>:approve|deny`；本端点把它桥接为 Watch 的审批决策。
   *
   * 安全：这是唯一面向公网的写入口，因此
   * 1) 校验 X-Telegram-Bot-Api-Secret-Token（配置了密钥才启用校验）；
   * 2) 只认 callback_query.data 前缀 apr:，其余一律忽略；
   * 3) 「批准已升级单」会被 Watch 侧拒绝——通道侧不具备放行升级单的权限。
   * 无论结果如何都返回 200，避免 Telegram 反复重投同一更新。
   */
  app.post("/api/channels/telegram/webhook", async (request, reply) => {
    const secret = (options.telegramWebhookSecret ?? process.env["BUTLER_TELEGRAM_WEBHOOK_SECRET"] ?? "").trim();
    if (secret !== "") {
      const provided = String(request.headers["x-telegram-bot-api-secret-token"] ?? "");
      if (!timingSafeEqualString(provided, secret)) {
        return await reply.code(401).send({ error: "invalid-webhook-secret" });
      }
    }
    const body = (request.body ?? {}) as Record<string, unknown>;

    // ① 内联按钮回执（配对口令审批单）。
    const callback = body["callback_query"];
    if (typeof callback === "object" && callback !== null) {
      const record = callback as Record<string, unknown>;
      const data = typeof record["data"] === "string" ? record["data"] : "";
      const parsed = parseApprovalCallback(data);
      const callbackId = typeof record["id"] === "string" ? record["id"] : "";
      if (parsed === null) {
        if (callbackId !== "") await answerCallback(channels, callbackId, "该按钮已失效", app);
        return await reply.code(200).send({ ok: true, ignored: "unrecognized-callback-data" });
      }
      const actor = describeTelegramActor(record["from"]);
      const decider = options.approvalDecider ?? createWatchApprovalDecider();
      const result = await decider({
        approvalId: parsed.approvalId,
        decision: parsed.decision,
        channel: "telegram",
        ...(actor === null ? {} : { actor }),
      });
      if (callbackId !== "") await answerCallback(channels, callbackId, result.message, app);
      return await reply.code(200).send({ ok: result.ok, reason: result.reason ?? null });
    }

    // ② 口令急停指令（M1.3）：在通道里直接发「<口令> 急停 / 恢复 / 状态」。
    //    口令未配置时本通道整体关闭，解析必然返回 null → 当普通消息忽略。
    const message = body["message"];
    if (typeof message === "object" && message !== null) {
      const record = message as Record<string, unknown>;
      const text = typeof record["text"] === "string" ? record["text"] : "";
      const passphrase = (options.killswitchPassphrase ?? process.env["BUTLER_KILLSWITCH_PASSPHRASE"] ?? "").trim();
      const parsed = parseKillswitchCommand(text, passphrase);
      if (parsed === null) return await reply.code(200).send({ ok: true, ignored: "not-a-command" });

      // 若配置了会话白名单，只接受来自该会话的指令（防口令泄露后被旁路使用）。
      const allowedChat = (process.env["BUTLER_TELEGRAM_CHAT_ID"] ?? "").trim();
      const chatId = describeTelegramChatId(record["chat"]);
      if (allowedChat !== "" && chatId !== allowedChat) {
        return await reply.code(200).send({ ok: false, reason: "chat-not-allowed" });
      }

      const actor = describeTelegramActor(record["from"]);
      const commander = options.killswitchCommander ?? createWatchKillswitchCommander();
      const result = await commander({
        command: parsed.command,
        channel: "telegram",
        ...(actor === null ? {} : { actor }),
      });
      // 回执：把结果发回同一会话，让用户知道指令到底生效没有。
      await sendTelegramText(channels, result.message, chatId, app);
      return await reply.code(200).send({ ok: result.ok, reason: result.reason ?? null, command: parsed.command });
    }

    return await reply.code(200).send({ ok: true, ignored: "unsupported-update" });
  });

  app.get("/healthz", async () => {
    const mode = resolveMessageMode(options);
    const message =
      options.messageService !== undefined && options.messageStore !== undefined
        ? await options.messageService.status().then((status) => ({
            mode,
            connected: status.bridgeConnected,
            running: status.running,
            nativeMinIntervalSec: resolveNativeMinInterval(options),
            lastCycleAt: status.lastCycleAt,
            lastError: status.lastError === null ? null : "Hermes Bridge unavailable",
          }))
        : {
            mode,
            connected: mode === "native",
            running: false,
            nativeMinIntervalSec: resolveNativeMinInterval(options),
            lastCycleAt: null,
            lastError: null,
          };
    return {
      ok: true,
      service: "gateway",
      serviceVersion: GATEWAY_SERVICE_VERSION,
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      pending: queueRef.counts().pending,
      ...(message === undefined ? {} : { message }),
    };
  });

  // 把求助提示词转发给本机 Hermes 智能体（走其 api_server 的 OpenAI 兼容聊天接口）。
  // 面板→web→gateway→host:port；key 只在本链路内部使用，绝不回显。
  app.post("/api/agent-message", async (request, reply) => {
    const body = asRecord(request.body);
    const text = body === null ? null : readString(body["text"]);
    if (text === null) {
      return reply.code(400).send({ error: "text must be a non-empty string" });
    }
    if (text.length > 8_000) {
      return reply.code(400).send({ error: "text is too long (max 8000 chars)" });
    }
    const hermesRoot =
      process.env["BUTLER_HERMES_ROOT"]?.trim() || path.join(os.homedir(), ".hermes");
    const config = await readHermesConfig(hermesRoot);
    const api = config?.apiServer;
    if (api === undefined || api.port === null || api.key === null) {
      return reply
        .code(503)
        .send({ error: "agent-api-unavailable", detail: "未找到智能体接口（api_server）配置" });
    }
    // bind 地址（0.0.0.0）不能直接访问；容器内优先走 host.docker.internal。
    const hosts = [...new Set([api.host, "127.0.0.1", "host.docker.internal"])].filter(
      (host) => host !== null && host !== "" && host !== "0.0.0.0",
    );
    let lastError = "unknown";
    for (const host of hosts) {
      let response: Response;
      try {
        response = await fetch(`http://${host}:${api.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${api.key}`,
            "content-type": "application/json",
            "x-hermes-session-id": "butler-troubleshoot",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: text }],
            stream: false,
          }),
          signal: AbortSignal.timeout(170_000),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        return reply.code(502).send({
          error: "agent-auth-failed",
          detail: "智能体接口鉴权失败，请检查 api_server 的 key 配置",
        });
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const payload = (await response.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;
      const replyText =
        typeof payload?.choices?.[0]?.message?.content === "string"
          ? payload.choices[0].message.content
          : "";
      return reply.code(200).send({ ok: true, reply: replyText });
    }
    return reply.code(502).send({
      error: "agent-unreachable",
      detail: `无法连接智能体接口：${lastError}`,
    });
  });

  registerMessageRoutes(
    app,
    options.messageService,
    options.messageStore,
    options.inboundHistory,
    options.messageMode,
    options.nativeMinIntervalSec,
    options.channelControl,
    options.redeliver,
    options.expedite,
  );

  if (options.startLoop !== false) loop.start();
  return app;
}

function registerMessageRoutes(
  app: FastifyInstance,
  messageService: MessageGatewayController | undefined,
  messageStore: MessagePolicyStore | undefined,
  inboundHistory?: (limit?: number) => Promise<Result<InboundHistoryView>>,
  messageMode?: MessageDeliveryMode,
  nativeMinIntervalSec?: number,
  channelControl?: ChannelControlPort,
  redeliver?: (messageId: string) => Promise<Result<OutboxMessageView>>,
  expedite?: (messageId: string) => Promise<Result<OutboxMessageView>>,
): void {
  const hints = new BoundedHintDeduper(10_000);

  app.get("/api/messages/status", async (_request, reply) => {
    const mode = resolveMessageMode({ messageMode, messageService, messageStore });
    const emptyCounts = {
      captured: 0,
      policy_pending: 0,
      held_dnd: 0,
      held_pacing: 0,
      ready: 0,
      delivering: 0,
      retry_wait: 0,
      delivered: 0,
      delivery_unknown: 0,
      absorbed: 0,
      policy_error: 0,
      dead_letter: 0,
      cancelled: 0,
    } as const;
    if (messageService === undefined || messageStore === undefined) {
      return {
        mode,
        nativeMinIntervalSec: resolveNativeMinInterval({ nativeMinIntervalSec }),
        hermesGateway: { authoritative: mode === "native", connected: mode === "native", running: false },
        relay: { enabled: true, pending: false, updatedAt: null },
        bridge: { connected: false, running: false, inFlight: false, attached: false, outboxWritable: false, channels: {}, channelDetails: {}, lastError: null },
        counts: emptyCounts,
        absorbedProgress: 0,
        pendingFinalResults: 0,
        recent: { rateLimited: 0, connectionFailures: 0, deliveryUnknown: 0 },
      };
    }
    try {
      const status = await messageService.status();
      const health = status.bridgeHealth;
      const summary = messageStore.messageStatusSummary();
      const runtimeStatus = health?.channelStatus ?? {};
      const channelDetails = Object.fromEntries(
        Object.entries(health?.channels ?? {}).map(([channel, channelStatusFlag]) => {
          const runtime = runtimeStatus[channel];
          return [channel, {
            status: channelStatusFlag,
            unavailableReason: channelStatusFlag === "ok" ? null : channelStatusFlag === "degraded" ? "通道已连接，但部分能力暂不可用" : "通道未连接，可能缺少凭据或桥接未启动",
            unavailableFix: channelStatusFlag === "ok" ? null : channelStatusFlag === "degraded" ? "检查桥接状态并重新连接" : "补充通道凭据后重新连接",
            retryable: channelStatusFlag !== "unavailable" || status.bridgeConnected,
            ...(runtime === undefined ? {} : {
              enabled: runtime.enabled,
              credentialsConfigured: runtime.credentialsConfigured,
              loginState: runtime.loginState,
              ...(runtime.account === undefined ? {} : { account: runtime.account }),
            }),
          }];
        }),
      );
      return {
        mode,
        nativeMinIntervalSec: resolveNativeMinInterval({ nativeMinIntervalSec }),
        hermesGateway: { authoritative: mode === "native", connected: mode === "native" || status.bridgeConnected, running: status.running },
        relay: messageStore.getRelayControl(),
        bridge: {
          connected: status.bridgeConnected,
          running: status.running,
          inFlight: status.inFlight,
          attached: health?.attached ?? false,
          outboxWritable: health?.outboxWritable ?? false,
          protocolVersion: health?.protocolVersion ?? null,
          bridgeVersion: health?.bridgeVersion ?? null,
          instanceId: health?.instanceId ?? null,
          policyVersion: status.policyVersion,
          policyHash: status.policyHash,
          remotePolicyVersion: health?.policyVersion ?? null,
          channels: health?.channels ?? {},
          channelDetails,
          coverage: health?.coverage ?? {},
          ...(health?.runs === undefined ? {} : { runs: health.runs }),
          startedAt: health?.startedAt ?? null,
          lastCycleAt: status.lastCycleAt,
          lastError: status.lastError === null ? null : "Hermes Bridge unavailable",
        },
        counts: messageStore.counts(),
        absorbedProgress: summary.absorbedProgress,
        pendingFinalResults: summary.pendingFinalResults,
        recent: {
          rateLimited: summary.rateLimited,
          connectionFailures: summary.connectionFailures,
          deliveryUnknown: summary.deliveryUnknown,
          lastRateLimitedAt: summary.lastRateLimitedAt,
          lastConnectionFailureAt: summary.lastConnectionFailureAt,
        },
      };
    } catch {
      return bridgeUnavailable(reply, "E302");
    }
  });

  app.post("/api/messages/reconnect", async (_request, reply) => {
    if (messageService === undefined) return bridgeUnavailable(reply, "E302");
    try {
      messageService.wake();
      return { accepted: true, nextStep: "已请求重新连接，稍后刷新查看通道状态。" };
    } catch {
      return bridgeUnavailable(reply, "E302");
    }
  });

  /** 一键接管切换：开=Butler 策略接管，关=原通道直发（持久意图由服务落盘）。 */
  app.post("/api/messages/relay", async (request, reply) => {
    if (messageService === undefined) return bridgeUnavailable(reply, "E302");
    const body = asRecord(request.body);
    if (body === null || typeof body["enabled"] !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    try {
      return await messageService.setRelayEnabled(body["enabled"]);
    } catch {
      return bridgeUnavailable(reply, "E303");
    }
  });

  /** 死信重投：把 dead_letter 消息放回策略管线（dead_letter → policy_pending，新变更序列）。 */
  app.post("/api/messages/:messageId/redeliver", async (request, reply) => {
    if (redeliver === undefined) return bridgeUnavailable(reply, "E302");
    const messageId = readString((request.params as Record<string, unknown>)["messageId"]);
    if (messageId === null)
      return reply.code(400).send({ error: "messageId must be a non-empty string" });
    const result = await redeliver(messageId);
    if (!result.ok || result.data === undefined) {
      return reply.code(502).send({
        error: "redeliver-failed",
        detail: result.ok ? undefined : result.error?.userHint ?? result.error?.message,
      });
    }
    // 立即触发一轮 reconcile，避免重投消息等待下一个轮询周期。
    messageService?.wake();
    return {
      message: result.data,
      nextStep: "已重新排队进入策略管线，稍后可在消息明细中查看投递结果。",
    };
  });

  /** 立即发送：等待中的消息跳过剩余的节奏/免打扰等待，按当前队列顺序尽快投递。 */
  app.post("/api/messages/:messageId/expedite", async (request, reply) => {
    if (expedite === undefined) return bridgeUnavailable(reply, "E302");
    const messageId = readString((request.params as Record<string, unknown>)["messageId"]);
    if (messageId === null)
      return reply.code(400).send({ error: "messageId must be a non-empty string" });
    const result = await expedite(messageId);
    if (!result.ok || result.data === undefined) {
      return reply.code(502).send({
        error: "expedite-failed",
        detail: result.ok ? undefined : result.error?.userHint ?? result.error?.message,
      });
    }
    // 立即触发一轮 reconcile，让放行的消息不用等下一个轮询周期。
    messageService?.wake();
    return {
      message: result.data,
      nextStep: "已跳过剩余等待，将按当前队列顺序尽快投递。",
    };
  });

  /** Bridge 通道控制面代理：未注入端口或 Bridge 不可达时统一 503。 */
  const channelUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({ error: "channel-control-unavailable" });

  app.get("/api/messages/channels", async (_request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    try {
      return await channelControl.listChannels();
    } catch {
      return channelUnavailable(reply);
    }
  });

  /** 微信扫码登录：start 建会话，status 轮询（sessionId 必填），cancel 主动取消。 */
  app.post("/api/messages/channels/weixin/login/start", async (_request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    try {
      return await channelControl.weixinLoginStart();
    } catch {
      return channelUnavailable(reply);
    }
  });

  app.get("/api/messages/channels/weixin/login/status", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const sessionId = query["sessionId"];
    if (sessionId === undefined || sessionId.trim() === "") {
      return reply.code(400).send({ error: "sessionId is required" });
    }
    try {
      return await channelControl.weixinLoginStatus(sessionId);
    } catch {
      return channelUnavailable(reply);
    }
  });

  app.post("/api/messages/channels/weixin/login/cancel", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const body = asRecord(request.body);
    const sessionId = body === null ? null : readString(body["sessionId"]);
    if (sessionId === null) return reply.code(400).send({ error: "sessionId is required" });
    try {
      return await channelControl.weixinLoginCancel(sessionId);
    } catch {
      return channelUnavailable(reply);
    }
  });

  /** 通道启停与首次接入：schema 驱动 UI 配置表单；secret 字段响应体掩码回显。 */
  app.get("/api/messages/channels/:channel/schema", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const channel = readString((request.params as Record<string, unknown>)["channel"]);
    if (channel === null) return reply.code(400).send({ error: "channel is required" });
    try {
      return await channelControl.channelSchema(channel);
    } catch {
      return channelUnavailable(reply);
    }
  });

  app.put("/api/messages/channels/:channel/config", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const channel = readString((request.params as Record<string, unknown>)["channel"]);
    const body = asRecord(request.body);
    if (channel === null || body === null) return reply.code(400).send({ error: "channel and body are required" });
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") return reply.code(400).send({ error: `${key} must be a string` });
      if (value.trim() !== "") values[key] = value;
    }
    try {
      const result = await channelControl.updateChannelConfig(channel, values);
      return reply.code(200).send({ ...result, ...maskConfigValues(channel, values) });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/messages/channels/:channel/enable", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const channel = readString((request.params as Record<string, unknown>)["channel"]);
    if (channel === null) return reply.code(400).send({ error: "channel is required" });
    try {
      return await channelControl.enableChannel(channel);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/messages/channels/:channel/disable", async (request, reply) => {
    if (channelControl === undefined) return channelUnavailable(reply);
    const channel = readString((request.params as Record<string, unknown>)["channel"]);
    if (channel === null) return reply.code(400).send({ error: "channel is required" });
    try {
      return await channelControl.disableChannel(channel);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/messages/tasks/:runId", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const runId = readString((request.params as Record<string, unknown>)["runId"]);
    if (runId === null) return reply.code(400).send({ error: "runId must be a non-empty string" });
    const task = messageStore.taskView(runId);
    return task === undefined ? reply.code(404).send({ error: "task not found" }) : task;
  });

  app.get("/api/messages/dnd", async (_request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    return { items: messageStore.listDndRules() };
  });

  app.put("/api/messages/dnd/:scope/:scopeKey", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    try {
      const params = request.params as Record<string, unknown>;
      const scope = readString(params["scope"]);
      const rawScopeKey = readString(params["scopeKey"]);
      if (scope === null || !DND_SCOPES.has(scope) || rawScopeKey === null) {
        return reply.code(400).send({ error: "invalid DND scope or scopeKey" });
      }
      if (scope === "global" && rawScopeKey !== "global" && rawScopeKey !== "_") {
        return reply.code(400).send({ error: "global DND scopeKey must be global or _" });
      }
      const body = parseDndBody(request.body);
      const scopeKey = scope === "global" ? null : rawScopeKey;
      const rule: DndRuleInput = {
        ruleId: `dnd:${scope}:${scopeKey ?? "global"}`,
        scope,
        scopeKey,
        ...body,
        source: "api",
      };
      return messageStore.upsertDndRule(rule);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete("/api/messages/dnd/:ruleId", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const ruleId = readString((request.params as Record<string, unknown>)["ruleId"]);
    if (ruleId === null)
      return reply.code(400).send({ error: "ruleId must be a non-empty string" });
    if (!messageStore.deleteDndRule(ruleId))
      return reply.code(404).send({ error: "DND rule not found" });
    return reply.code(204).send();
  });

  app.get("/api/messages/policy", async (_request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const policy = messageStore.loadPolicy();
    return policy === undefined
      ? reply.code(404).send({ error: "message policy not installed" })
      : policy;
  });

  app.put("/api/messages/policy", async (request, reply) => {
    if (messageService === undefined) return bridgeUnavailable(reply, "E302");
    let config: MessagePolicyConfig;
    try {
      config = parsePolicyBody(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
    try {
      const snapshot = await messageService.updatePolicy(config);
      return { version: snapshot.version, sha256: snapshot.sha256 };
    } catch {
      return bridgeUnavailable(reply, "E303");
    }
  });

  app.get("/api/messages/:messageId", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const messageId = readString((request.params as Record<string, unknown>)["messageId"]);
    if (messageId === null)
      return reply.code(400).send({ error: "messageId must be a non-empty string" });
    const message = messageStore.messageView(messageId);
    return message === undefined ? reply.code(404).send({ error: "message not found" }) : message;
  });

  app.get("/api/messages/optimization-history", async (request, reply) => {
    if (inboundHistory === undefined) return bridgeUnavailable(reply, "E302");
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const limit = parseLimit(query["limit"]);
    const result = await inboundHistory(limit);
    if (!result.ok || result.data === undefined) {
      return reply.code(503).send({ error: "optimization-history-unavailable" });
    }
    return { reachable: true, items: result.data.items };
  });

  app.get("/api/messages", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const limit = parseLimit(query["limit"]);
    const rawState = query["state"];
    if (rawState !== undefined && !isOutboxState(rawState)) {
      return reply.code(400).send({ error: "invalid message state" });
    }
    return { counts: messageStore.counts(), items: messageStore.listMessages(limit, rawState) };
  });

  /** 送达结果按日历史：days 缺省 7，上限为独立历史表的 365 天保留期。 */
  app.get("/api/messages/delivery-history", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const parsed = Number(query["days"] ?? "7");
    const days = Number.isFinite(parsed) ? Math.floor(parsed) : 7;
    if (days < 1 || days > MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS) {
      return reply.code(400).send({
        error: `invalid days; expected an integer from 1 through ${MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS}`,
      });
    }
    return {
      days,
      retentionDays: MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS,
      items: messageStore.dailyOutcomeHistory(days),
    };
  });

  /** 按通道聚合的送达指标：结构化计数，替代对错误文案的正则猜测。 */
  app.get("/api/messages/metrics", async (request, reply) => {
    if (messageStore === undefined) return bridgeUnavailable(reply, "E302");
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const parsed = Number(query["days"] ?? "30");
    const days = Number.isFinite(parsed) ? Math.floor(parsed) : 30;
    if (days < 1 || days > MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS) {
      return reply.code(400).send({
        error: `invalid days; expected an integer from 1 through ${MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS}`,
      });
    }
    return {
      days,
      retentionDays: MESSAGE_OUTCOME_HISTORY_RETENTION_DAYS,
      ...messageStore.channelMetrics(days),
    };
  });

  const acceptHint = async (
    kind: string,
    id: string | null,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (messageService === undefined) return bridgeUnavailable(reply, "E302");
    if (id === null) return reply.code(400).send({ error: "invalid Hermes hint identifier" });
    const deduped = hints.seen(`${kind}:${id}`);
    if (!deduped) {
      try {
        messageService.wake();
      } catch {
        return bridgeUnavailable(reply, "E302");
      }
    }
    return { accepted: true, deduped };
  };

  app.post("/internal/hermes/outbound", async (request, reply) => {
    const body = asRecord(request.body);
    return acceptHint("outbound", readString(body?.["messageId"]), reply);
  });

  app.post("/internal/hermes/task-event", async (request, reply) => {
    const body = asRecord(request.body);
    const runId = readString(body?.["runId"]);
    const sequence = body?.["sequence"];
    const id =
      runId !== null && Number.isInteger(sequence) && Number(sequence) >= 0
        ? `${runId}:${String(sequence)}`
        : null;
    return acceptHint("task-event", id, reply);
  });

  app.post("/internal/hermes/inbound", async (request, reply) => {
    const body = asRecord(request.body);
    return acceptHint("inbound", readString(body?.["inboundMessageId"]), reply);
  });
}

function resolveMessageMode(options: Pick<GatewayServerOptions, "messageMode" | "messageService" | "messageStore">): MessageDeliveryMode {
  return options.messageMode ?? (options.messageService !== undefined && options.messageStore !== undefined ? "observe" : "disabled");
}

function resolveNativeMinInterval(options: Pick<GatewayServerOptions, "nativeMinIntervalSec">): number {
  const configured = options.nativeMinIntervalSec;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_WEIXIN_MIN_INTERVAL_SEC;
}

class BoundedHintDeduper {
  private readonly keys = new Set<string>();

  constructor(private readonly limit: number) {}

  seen(key: string): boolean {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    if (this.keys.size > this.limit) {
      const oldest = this.keys.values().next().value as string | undefined;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return false;
  }
}

function parseDndBody(
  value: unknown,
): Omit<DndRuleInput, "ruleId" | "scope" | "scopeKey" | "source"> {
  const body = requireRecord(value, "DND body");
  assertExactKeys(
    body,
    ["timeZone", "startMinute", "endMinute", "pausedUntil", "enabled"],
    "DND body",
  );
  const timeZone = readString(body["timeZone"]);
  if (timeZone === null) throw new Error("timeZone must be a non-empty string");
  if (typeof body["enabled"] !== "boolean") throw new Error("enabled must be a boolean");
  return {
    timeZone,
    startMinute: optionalNumberOrNull(body["startMinute"]),
    endMinute: optionalNumberOrNull(body["endMinute"]),
    pausedUntil: optionalStringOrNull(body["pausedUntil"]),
    enabled: body["enabled"],
  };
}

function parsePolicyBody(value: unknown): MessagePolicyConfig {
  const root = requireRecord(value, "policy");
  assertExactKeys(
    root,
    ["version", "inlineResponse", "relayMode", "digest", "delivery", "channels"],
    "policy",
  );
  if (readString(root["version"]) === null)
    throw new Error("policy.version must be a non-empty string");
  const digest = requireRecord(root["digest"], "policy.digest");
  const delivery = requireRecord(root["delivery"], "policy.delivery");
  const channels = requireRecord(root["channels"], "policy.channels");
  assertExactKeys(
    digest,
    ["windowSec", "maxItems", "maxChars", "finalAbsorbsPendingProgress"],
    "policy.digest",
  );
  assertExactKeys(delivery, ["maxAttempts", "retryBaseSec", "retryMaxSec"], "policy.delivery");
  if (typeof digest["finalAbsorbsPendingProgress"] !== "boolean") {
    throw new Error("policy.digest.finalAbsorbsPendingProgress must be a boolean");
  }
  const channelKeys = [
    "minRatePerMin",
    "initialRatePerMin",
    "maxRatePerMin",
    "additiveStep",
    "multiplicativeFactor",
    "successWindow",
    "nativeMinIntervalSec",
    "prewarmTtlSec",
  ];
  for (const [channel, rawPolicy] of Object.entries(channels)) {
    assertExactKeys(
      requireRecord(rawPolicy, `policy.channels.${channel}`),
      channelKeys,
      `policy.channels.${channel}`,
    );
  }
  if (root["relayMode"] !== undefined && root["relayMode"] !== "takeover" && root["relayMode"] !== "passthrough") {
    throw new Error('policy.relayMode must be "takeover" or "passthrough"');
  }
  const config = root as unknown as MessagePolicyConfig;
  validateMessagePolicy(config);
  return config;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0)
    throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === null) throw new Error(`${field} must be an object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new Error("DND minute values must be numbers or null");
  return value;
}

function optionalStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("pausedUntil must be a string or null");
  return value;
}

function bridgeUnavailable(reply: FastifyReply, code: "E302" | "E303"): FastifyReply {
  return reply.code(503).send({ code, error: "Hermes Bridge unavailable" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** secret 字段名单与 contract ChannelFieldSchema / Bridge CHANNEL_SCHEMAS 一致（按通道硬编码镜像；掩码仅用于响应体回显）。 */
const CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = {
  qqbot: ["client_secret"],
  yuanbao: ["app_secret"],
  feishu: ["app_secret", "verification_token"],
  dingtalk: ["client_secret"],
  wecom: ["secret"],
};

function maskConfigValues(channel: string, values: Record<string, string>): Record<string, string> {
  const secrets = CHANNEL_SECRET_FIELDS[channel] ?? [];
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, secrets.includes(name) ? "••••" : value]),
  );
}

function paceSecFromEnv(): number {
  const raw = process.env["BUTLER_GATEWAY_PACE_SEC"];
  const parsed = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_PACE_SEC;
}

/** 同 dedupeKey 告警冷却窗（默认 2h；env BUTLER_ALERT_COOLDOWN_MS，0 关闭）。 */
function alertCooldownMsFromEnv(): number {
  const raw = process.env["BUTLER_ALERT_COOLDOWN_MS"];
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw.trim());
  return normalizeCooldownMs(Number.isFinite(parsed) ? parsed : undefined);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

/** 行内不含任何凭据，剔除 next_attempt_at 等内部调度字段后原样外发。 */
/** Telegram callback_data 解析：只认 `apr:<id>:<approve|deny>`。 */
export function parseApprovalCallback(
  data: string,
): { approvalId: string; decision: "approve" | "deny" } | null {
  const match = /^apr:([^:]+):(approve|deny)$/.exec(data);
  if (match === null) return null;
  return { approvalId: match[1]!, decision: match[2] as "approve" | "deny" };
}

/** 会话标识（数字或字符串）；取不到返回空串（不编造）。 */
function describeTelegramChatId(chat: unknown): string {
  if (typeof chat !== "object" || chat === null) return "";
  const id = (chat as Record<string, unknown>)["id"];
  return typeof id === "number" || typeof id === "string" ? String(id) : "";
}

/** 向会话回发一条纯文本（口令急停回执）；失败不影响已生效的指令。 */
async function sendTelegramText(
  channels: AlertChannel[],
  text: string,
  chatId: string,
  app: FastifyInstance,
): Promise<void> {
  const telegram = channels.find((channel) => channel.name === "telegram");
  if (telegram === undefined || !(telegram instanceof TelegramChannel)) return;
  try {
    await telegram.sendText(text, chatId === "" ? undefined : chatId);
  } catch (error) {
    app.log.warn({ err: error }, "telegram sendText failed");
  }
}

/** 通道侧身份：优先用户名，其次数字 id；都没有则 null（不编造）。 */
function describeTelegramActor(from: unknown): string | null {
  if (typeof from !== "object" || from === null) return null;
  const record = from as Record<string, unknown>;
  const username = typeof record["username"] === "string" ? record["username"].trim() : "";
  if (username !== "") return `telegram:${username}`;
  const id = record["id"];
  if (typeof id === "number" || typeof id === "string") return `telegram:${String(id)}`;
  return null;
}

/** 常量时间比较（长度不同直接判否；密钥不进日志）。 */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 回执 Telegram 按钮点击（尽力而为：失败不影响已落地的审批决定）。 */
async function answerCallback(
  channels: AlertChannel[],
  callbackQueryId: string,
  text: string,
  app: FastifyInstance,
): Promise<void> {
  const telegram = channels.find((channel) => channel.name === "telegram");
  if (telegram === undefined || !(telegram instanceof TelegramChannel)) return;
  try {
    await telegram.answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    app.log.warn({ err: error }, "telegram answerCallbackQuery failed");
  }
}

function toApiItem(row: AlertRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    source: row.source,
    dedupeKey: row.dedupeKey,
    status: row.status,
    attempts: row.attempts,
    mergedCount: row.mergedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveredAt: row.deliveredAt,
    lastError: row.lastError,
    channel: row.channel,
    readAt: row.readAt,
    actions: row.actions,
  };
}
