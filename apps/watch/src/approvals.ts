/**
 * 通知即操作（M3.1）：高危动作 → 推送带按钮的卡片 → 用户在地铁上点「批准一次 / 拒绝」。
 *
 * 三条不可妥协的行为：
 * 1. **超时默认拒绝**：TTL 到期未应答一律置 expired 并生成「已拦截」事件，绝不因沉默而放行；
 * 2. **升级防误触**：同一动作指纹在升级窗口内第 N 次请求 → 标记 escalateRequired，
 *    内联按钮不再放行，强制回 Web 端确认（防打扰也防误触）；
 * 3. **操作全留痕**：请求 / 批准 / 拒绝 / 超时四类动作全部入审计流与事件中心。
 *
 * 边界诚实：本服务只登记与流转「审批单」，不代替执行器执行动作；也不猜测动作是否真的
 * 被拦住——拦截结果由调用方在决策后落地，本服务不虚构成功。
 */
import { randomUUID } from "node:crypto";
import type { ActionApprovalRow, ActionEventRow, AuditLog, SqliteStore } from "@butler/core";
import type { AlertPoster, GatewayAlertBody } from "./alert-forward.js";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";
import type { TrustEventHub } from "./trust-events.js";

/** 默认应答时限：15 分钟（计划书 M3.1）。 */
export const APPROVAL_DEFAULT_TTL_MS = 15 * 60 * 1000;
/** 超时扫描间隔：15 秒（验收要求「超时默认拒绝 100% 生效」，扫描粒度决定落地延迟）。 */
export const APPROVAL_SWEEP_INTERVAL_MS = 15_000;
/** 高危动作侦测间隔：与审计采集（15s）同频。 */
export const APPROVAL_SCAN_INTERVAL_MS = 15_000;
/** 升级阈值：同一动作指纹 24h 内第 3 次请求。 */
export const APPROVAL_ESCALATION_THRESHOLD = 3;
export const APPROVAL_ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_RETENTION_MIN_DAYS = 7;
export const APPROVAL_RETENTION_MAX_DAYS = 90;
export const APPROVAL_RETENTION_DEFAULT_DAYS = 30;

export const APPROVAL_REQUESTED_ACTION = "approval-requested";
export const APPROVAL_APPROVED_ACTION = "approval-approved";
export const APPROVAL_DENIED_ACTION = "approval-denied";
export const APPROVAL_EXPIRED_ACTION = "approval-expired";

/** 事件中心事件类型（同一 kind 便于收敛到一处）。 */
export const APPROVAL_EVENT_KIND = "action-approval";
/** 超时拦截事件类型：与用户主动拒绝区分，便于周报统计。 */
export const APPROVAL_BLOCKED_EVENT_KIND = "action-blocked";

export type ApprovalDecision = "approve" | "deny";

export interface ActionApprovalItem {
  id: string;
  actionId: string;
  fingerprint: string;
  instance: string;
  sessionId: string | null;
  kind: string;
  title: string;
  detail: unknown;
  status: string;
  channel: string | null;
  attempts: number;
  escalateRequired: boolean;
  expiresAt: string;
  respondedAt: string | null;
  actor: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  /** 距离超时的剩余毫秒（已终结为 0）。UI 倒计时用。 */
  remainingMs: number;
  /** Web 端确认页地址（卡片降级链接与复制粘贴用）。 */
  confirmUrl: string;
}

export interface ApprovalRequestInput {
  /** 关联的动作事件 id；缺省由调用方给出稳定标识。 */
  actionId: string;
  kind: string;
  /** 面向人的短标题，调用方需自行脱敏。 */
  title: string;
  detail?: unknown;
  instance?: string;
  sessionId?: string | null;
  /** 动作指纹（kind|target）；缺省用 kind + actionId 兜底。 */
  fingerprint?: string;
}

export interface ApprovalDecisionOutcome {
  ok: boolean;
  /** not-found | already-settled | expired | requires-web-confirm */
  reason?: string;
  item?: ActionApprovalItem;
}

export interface ApprovalSummary {
  total: number;
  pending: number;
  escalated: number;
  expired: number;
  approved: number;
  denied: number;
  lastRequestAt: string | null;
}

export interface ApprovalScanView {
  enabled: boolean;
  scannedActions: number;
  created: number;
  lastScanAt: string | null;
  /** 侦测水位（已处理到的 action_events.id）。 */
  watermark: number;
  ttlMs: number;
  escalationThreshold: number;
  retentionDays: number;
}

export interface ApprovalService {
  /** 登记一张审批单并推送卡片；同一动作幂等（返回既有单）。 */
  request(input: ApprovalRequestInput): ActionApprovalItem;
  /** 应答（批准 / 拒绝）。仅 pending 可流转；已升级的单拒绝内联应答。 */
  decide(
    id: string,
    input: { decision: ApprovalDecision; actor?: string; channel?: string; reason?: string; allowEscalatedInline?: boolean },
  ): ApprovalDecisionOutcome;
  list(filter?: { status?: string; escalateOnly?: boolean; limit?: number; offset?: number }): {
    items: ActionApprovalItem[];
    summary: ApprovalSummary;
  };
  get(id: string): ActionApprovalItem | null;
  /** 超时结算：到期 pending → expired（默认拒绝）+ 事件 + 审计。返回结算条数。 */
  sweep(): number;
  /** 高危动作增量侦测：新出现的高危 action_events 自动开单。返回新建条数。 */
  scanHighRisk(): number;
  scanView(): ApprovalScanView;
  prune(): number;
  start(): void;
  stop(): void;
}

export interface ApprovalServiceOptions {
  store: SqliteStore;
  trustEvents: TrustEventHub;
  audit?: AuditLog;
  /** 卡片推送器（缺省不推送，仅登记；测试可注入假实现）。 */
  poster?: AlertPoster;
  /** Web 确认页基址（如 https://butler.example.com）；缺省仅给相对路径。 */
  publicBaseUrl?: string;
  ttlMs?: number;
  sweepIntervalMs?: number;
  scanIntervalMs?: number;
  escalationThreshold?: number;
  escalationWindowMs?: number;
  retentionDays?: number;
  /** 是否自动侦测高危动作（关掉则仅响应显式 request 调用）。 */
  autoDetect?: boolean;
  now?: () => number;
  driver?: TimerDriver;
  /** 注入 id 生成（测试确定性）。 */
  idFactory?: () => string;
}

/**
 * 动作指纹：同一类动作打同一目标 → 同一指纹（升级计数的口径）。
 *
 * 取不到目标时回落 "unknown"：同类且都没给目标的高危动作会被归为同一指纹，
 * 从而在第 3 次请求时进入「需面板确认」——这正是防打扰的意图
 * （宁可多要一次确认，也不让同一种危险动作被反复一键放行）。
 */
export function actionFingerprint(kind: string, target: string): string {
  const normalized = target.trim();
  return `${kind}|${(normalized === "" ? "unknown" : normalized).slice(0, 200)}`;
}

/** 动作类型 → 人话标题（不猜细节，只描述类型与目标）。 */
export function describeAction(kind: string, target: string): string {
  const short = target.length <= 80 ? target : `${target.slice(0, 80)}…`;
  switch (kind) {
    case "file-delete":
      return `智能体请求删除文件：${short}`;
    case "file-write":
      return `智能体请求写入文件：${short}`;
    case "shell-exec":
      return `智能体请求执行命令：${short}`;
    case "message-send":
      return `智能体请求对外发送消息（${short}）`;
    case "api-call":
      return `智能体请求调用外部接口：${short}`;
    case "web-fetch":
      return `智能体请求抓取外部页面：${short}`;
    default:
      return `智能体请求执行高危动作：${short}`;
  }
}

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const driver = options.driver ?? defaultTimerDriver;
  const idFactory = options.idFactory ?? (() => randomUUID());
  const ttlMs = Math.max(30_000, Math.floor(options.ttlMs ?? APPROVAL_DEFAULT_TTL_MS));
  const escalationThreshold = Math.max(2, Math.floor(options.escalationThreshold ?? APPROVAL_ESCALATION_THRESHOLD));
  const escalationWindowMs = Math.max(
    60_000,
    Math.floor(options.escalationWindowMs ?? APPROVAL_ESCALATION_WINDOW_MS),
  );
  const retentionDays = Math.max(
    APPROVAL_RETENTION_MIN_DAYS,
    Math.min(
      APPROVAL_RETENTION_MAX_DAYS,
      Math.floor(options.retentionDays ?? APPROVAL_RETENTION_DEFAULT_DAYS),
    ),
  );
  const baseUrl = (options.publicBaseUrl ?? "").replace(/\/+$/, "");
  const autoDetect = options.autoDetect !== false;

  let sweepTimer: unknown = null;
  let scanTimer: unknown = null;
  let running = false;
  let watermark = 0;
  let lastScanAt: string | null = null;
  let lastScanned = 0;
  let lastCreated = 0;

  const confirmUrlOf = (id: string): string =>
    baseUrl === "" ? `/approvals/${id}` : `${baseUrl}/approvals/${id}`;

  function toItem(row: ActionApprovalRow): ActionApprovalItem {
    const active = row.status === "pending";
    const remaining = active ? Math.max(0, Date.parse(row.expiresAt) - now()) : 0;
    return {
      id: row.id,
      actionId: row.actionId,
      fingerprint: row.fingerprint,
      instance: row.instance,
      sessionId: row.sessionId,
      kind: row.kind,
      title: row.title,
      detail: safeParse(row.detailJson),
      status: row.status,
      channel: row.channel,
      attempts: row.attempts,
      escalateRequired: row.escalateRequired,
      expiresAt: row.expiresAt,
      respondedAt: row.respondedAt,
      actor: row.actor,
      reason: row.reason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      remainingMs: Number.isFinite(remaining) ? remaining : 0,
      confirmUrl: confirmUrlOf(row.id),
    };
  }

  function summary(): ApprovalSummary {
    const counts = store.countActionApprovals();
    const rows = store.listActionApprovals({ limit: 1 });
    return {
      total: counts.total,
      pending: counts.pending,
      escalated: counts.escalated,
      expired: counts.expired,
      approved: counts.approved,
      denied: counts.denied,
      lastRequestAt: rows[0]?.createdAt ?? null,
    };
  }

  /** 卡片正文：说清「要做什么、多久不管就按拒绝处理」，不放对话内容。 */
  function buildCard(item: ActionApprovalItem): GatewayAlertBody {
    const minutes = Math.max(1, Math.round(ttlMs / 60_000));
    const escalateNote = item.escalateRequired
      ? `同一动作今日已被请求 ${item.attempts} 次，已升级为「需在面板确认」，请打开面板核对后再放行。`
      : `批准后该动作才会执行；${minutes} 分钟内未应答将按「拒绝」拦截。`;
    const link = `${item.confirmUrl}`;
    return {
      kind: "action-approval",
      severity: "critical",
      title: item.title,
      body: `${escalateNote}\n动作类型：${item.kind}\n目标：${describeTarget(item)}\n处理入口：${link}`,
      source: "butler-watch",
      dedupeKey: `approval:${item.id}`,
      actions: item.escalateRequired
        ? [{ label: "前往面板确认", url: link }]
        : [
            { label: "批准一次", callbackData: `apr:${item.id}:approve` },
            { label: "拒绝", callbackData: `apr:${item.id}:deny` },
            { label: "查看详情", url: link },
          ],
    };
  }

  function describeTarget(item: ActionApprovalItem): string {
    const detail = item.detail;
    if (typeof detail === "object" && detail !== null) {
      const record = detail as Record<string, unknown>;
      const target = record["target"] ?? record["path"] ?? record["command"];
      if (typeof target === "string" && target !== "") return target.slice(0, 200);
    }
    return item.fingerprint.split("|")[1] ?? "（未提供）";
  }

  function safeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function request(input: ApprovalRequestInput): ActionApprovalItem {
    // 幂等：同一动作事件只开一张单。已有单直接返回，不重复计数/推送/留痕。
    const existing = store.getActionApprovalByActionId(input.actionId);
    if (existing !== undefined) return toItem(existing);

    const fingerprint = input.fingerprint ?? actionFingerprint(input.kind, extractTarget(input));
    const since = new Date(now() - escalationWindowMs).toISOString();
    // 计数在插入前进行：priorCount 不含本次，故本次序号为 priorCount + 1。
    const priorCount = store.countApprovalRequestsByAction(fingerprint, since);
    const attempts = priorCount + 1;
    const escalateRequired = attempts >= escalationThreshold;
    const row = store.insertActionApproval({
      id: idFactory(),
      actionId: input.actionId,
      fingerprint,
      ...(input.instance !== undefined ? { instance: input.instance } : {}),
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      title: input.title,
      detail: {
        ...(typeof input.detail === "object" && input.detail !== null ? (input.detail as object) : {}),
        target: extractTarget(input),
      },
      attempts,
      escalateRequired,
      expiresAt: new Date(now() + ttlMs).toISOString(),
      at: iso(),
    });
    const item = toItem(row);

    options.audit?.append({
      actor: "action-approval",
      action: APPROVAL_REQUESTED_ACTION,
      target: item.id,
      detail: { actionId: item.actionId, kind: item.kind, attempts: item.attempts, escalateRequired },
    });
    options.trustEvents.record({
      kind: APPROVAL_EVENT_KIND,
      severity: escalateRequired ? "warn" : "info",
      title: escalateRequired
        ? `高危动作需面板确认（今日第 ${item.attempts} 次）：${item.title}`
        : `等待你确认的高危动作：${item.title}`,
      evidence: [{ approvalId: item.id, actionId: item.actionId, kind: item.kind, expiresAt: item.expiresAt }],
      relatedIds: [item.id],
      dedupeKey: `approval:${item.id}`,
    });
    if (options.poster !== undefined) void options.poster.post(buildCard(item));
    return item;
  }

  function extractTarget(input: ApprovalRequestInput): string {
    if (typeof input.detail === "object" && input.detail !== null) {
      const record = input.detail as Record<string, unknown>;
      const value = record["target"] ?? record["path"] ?? record["command"];
      if (typeof value === "string") return value.slice(0, 200);
    }
    return input.actionId;
  }

  function settle(
    item: ActionApprovalItem,
    status: "approved" | "denied" | "expired",
    actor: string,
    channel: string,
    reason: string,
  ): ApprovalDecisionOutcome {
    const updated = store.decideActionApproval(item.id, {
      status,
      actor,
      channel,
      reason,
      at: iso(),
    });
    if (updated === undefined) {
      const current = store.getActionApproval(item.id);
      return current === undefined
        ? { ok: false, reason: "not-found" }
        : { ok: false, reason: "already-settled", item: toItem(current) };
    }
    const settled = toItem(updated);
    options.audit?.append({
      actor: "action-approval",
      action:
        status === "approved"
          ? APPROVAL_APPROVED_ACTION
          : status === "denied"
            ? APPROVAL_DENIED_ACTION
            : APPROVAL_EXPIRED_ACTION,
      target: settled.id,
      detail: { actionId: settled.actionId, channel, reason, actor },
    });
    options.trustEvents.record({
      kind: status === "approved" ? APPROVAL_EVENT_KIND : APPROVAL_BLOCKED_EVENT_KIND,
      severity: status === "approved" ? "info" : "warn",
      title:
        status === "approved"
          ? `你已批准高危动作：${settled.title}`
          : status === "denied"
            ? `已拒绝高危动作：${settled.title}`
            : `超时未应答，已按默认拒绝拦截：${settled.title}`,
      evidence: [
        {
          approvalId: settled.id,
          actionId: settled.actionId,
          status,
          channel,
          actor,
          reason,
          respondedAt: settled.respondedAt,
        },
      ],
      relatedIds: [settled.id],
      dedupeKey: `approval:${settled.id}:${status}`,
    });
    // 归档原告警：卡片不再停留在通知中心（终态已在事件中心可见）。
    void options.poster?.resolve(`approval:${settled.id}`);
    return { ok: true, item: settled };
  }

  function decide(
    id: string,
    input: {
      decision: ApprovalDecision;
      actor?: string;
      channel?: string;
      reason?: string;
      allowEscalatedInline?: boolean;
    },
  ): ApprovalDecisionOutcome {
    const row = store.getActionApproval(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    const item = toItem(row);
    if (row.status !== "pending") return { ok: false, reason: "already-settled", item };
    // 升级单不允许在通知里一键放行（防误触）；拒绝仍然允许——拦比放安全。
    if (item.escalateRequired && input.decision === "approve" && input.allowEscalatedInline !== true) {
      return { ok: false, reason: "requires-web-confirm", item };
    }
    if (Date.parse(row.expiresAt) <= now()) {
      // 恰好踩在超时点：按默认拒绝结算，不给「迟到的批准」开口子。
      const expired = settle(item, "expired", "system:timeout", input.channel ?? "panel", "超时未应答，按默认拒绝拦截");
      return { ok: false, reason: "expired", item: expired.item };
    }
    const status = input.decision === "approve" ? "approved" : "denied";
    return settle(
      item,
      status,
      input.actor ?? "panel-user",
      input.channel ?? "panel",
      input.reason ?? (status === "approved" ? "用户在通知中批准一次" : "用户在通知中拒绝"),
    );
  }

  function sweep(): number {
    const expired = store.expireActionApprovals(iso());
    for (const row of expired) {
      const item = toItem(row);
      options.audit?.append({
        actor: "action-approval",
        action: APPROVAL_EXPIRED_ACTION,
        target: item.id,
        detail: { actionId: item.actionId, reason: "超时未应答，按默认拒绝拦截", ttlMs },
      });
      options.trustEvents.record({
        kind: APPROVAL_BLOCKED_EVENT_KIND,
        severity: "warn",
        title: `超时未应答，已按默认拒绝拦截：${item.title}`,
        evidence: [{ approvalId: item.id, actionId: item.actionId, expiresAt: item.expiresAt, channel: null }],
        relatedIds: [item.id],
        dedupeKey: `approval:${item.id}:expired`,
      });
      void options.poster?.resolve(`approval:${item.id}`);
    }
    return expired.length;
  }

  /**
   * 高危动作增量侦测。只处理 id > watermark 的行（不全量重扫），
   * 同一动作已有审批单时 store 层幂等去重，不会重复开单。
   */
  function scanHighRisk(): number {
    if (!autoDetect) return 0;
    const rows: ActionEventRow[] = store.listActionEventsAfterId(watermark, { severity: "high", limit: 100 });
    lastScanAt = iso();
    lastScanned = rows.length;
    if (rows.length === 0) return 0;
    let created = 0;
    for (const row of rows) {
      watermark = Math.max(watermark, row.id);
      const fingerprint = actionFingerprint(row.kind, row.target);
      const before = store.getActionApprovalByActionId(String(row.id));
      request({
        actionId: String(row.id),
        kind: row.kind,
        title: describeAction(row.kind, row.target),
        detail: { target: row.target, detail: safeParse(row.detailJson) },
        ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
        fingerprint,
      });
      if (before === undefined) created += 1;
    }
    lastCreated = created;
    return created;
  }

  return {
    request,
    decide,
    list(filter = {}) {
      const rows = store.listActionApprovals({
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.escalateOnly === true ? { escalateOnly: true } : {}),
        ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
        ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
      });
      return { items: rows.map(toItem), summary: summary() };
    },
    get(id) {
      const row = store.getActionApproval(id);
      return row === undefined ? null : toItem(row);
    },
    sweep,
    scanHighRisk,
    scanView() {
      return {
        enabled: autoDetect,
        scannedActions: lastScanned,
        created: lastCreated,
        lastScanAt,
        watermark,
        ttlMs,
        escalationThreshold,
        retentionDays,
      };
    },
    prune() {
      const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString();
      return store.pruneActionApprovals(cutoff);
    },
    start() {
      if (running) return;
      running = true;
      const sweepInterval = Math.max(1_000, Math.floor(options.sweepIntervalMs ?? APPROVAL_SWEEP_INTERVAL_MS));
      const scanInterval = Math.max(1_000, Math.floor(options.scanIntervalMs ?? APPROVAL_SCAN_INTERVAL_MS));
      void Promise.resolve().then(() => {
        try {
          sweep();
          scanHighRisk();
        } catch {
          /* 首轮失败不阻断启动 */
        }
      });
      sweepTimer = driver.setInterval(() => {
        try {
          sweep();
        } catch {
          /* 单轮异常不终止循环 */
        }
      }, sweepInterval);
      if (autoDetect) {
        scanTimer = driver.setInterval(() => {
          try {
            scanHighRisk();
          } catch {
            /* 单轮异常不终止循环 */
          }
        }, scanInterval);
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (sweepTimer !== null) driver.clearInterval(sweepTimer);
      if (scanTimer !== null) driver.clearInterval(scanTimer);
      sweepTimer = null;
      scanTimer = null;
    },
  };
}
