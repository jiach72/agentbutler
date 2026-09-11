/**
 * 告警持久队列（Task 8，V1）：SQLite 小队列。
 *
 * 单表 alerts：入队即落盘（断电不丢），dedupeKey 未终结合并（缓释），
 * 指数退避重试（attempts ≥ 5 → failed，保留可见不静默丢弃）。
 *
 * 语义要点：
 * - 构造时把遗留 delivering 行回置 pending（进程重启不存在真正投递中的行，
 *   即"重启补发"）；
 * - claimNext 按 created_at 升序认领到期（next_attempt_at ≤ now）的 pending 行；
 * - 冷却窗（默认 2h，BUTLER_ALERT_COOLDOWN_MS 可配）：同 dedupeKey 上一条已
 *   投递/已失败未超窗时，同严重度或更轻的重复告警只在该行 merged_count+1，
 *   不再产生新行——高频探针类故障（如计费类每 5min 一报）不再刷屏；
 *   升级为更严重则照常新建行；
 * - resolveByDedupeKey：故障恢复后归档（未投递行置 resolved 不再投递，
 *   已投递行补已读）；
 * - 所有时间戳均为 ISO 字符串（字典序即时间序）。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type AlertSeverity = "info" | "warn" | "critical";
export type AlertStatus = "pending" | "delivering" | "delivered" | "failed" | "resolved";

/**
 * 交互式卡片按钮（M3.1）。callbackData 走支持内联按钮的通道（Telegram）；
 * url 为降级链接（微信类通道不支持内联按钮时跳 Web 确认页）。
 */
export interface AlertAction {
  label: string;
  callbackData?: string;
  url?: string;
}

/** 单条告警最多 3 个按钮（够用且避免通道侧排版过载）。 */
export const MAX_ALERT_ACTIONS = 3;

/** alerts 表行（camelCase 视图，不含任何凭据，可直接外发 API）。 */
export interface AlertRow {
  id: number;
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
  dedupeKey: string | null;
  status: AlertStatus;
  attempts: number;
  mergedCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  /** 最终投递通道：panel | telegram | smtp | null（未投递）。 */
  channel: string | null;
  /** 面板通知已读时间；null 表示仍未读。 */
  readAt: string | null;
  /** 交互式卡片按钮（无按钮为空数组）。 */
  actions: AlertAction[];
}

export interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
  dedupeKey?: string;
  actions?: AlertAction[];
}

/** 连续失败上限：达到即 failed（保留可见）。 */
export const MAX_ATTEMPTS = 5;

/** 同 dedupeKey 冷却窗默认 2h：比探针周期大两个量级，小于典型计费故障恢复周期。 */
export const DEFAULT_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** 冷却窗允许的配置区间：0（关闭）到 24h。 */
export const MAX_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 归一化冷却窗：非法/越界值回落默认或边界。 */
export function normalizeCooldownMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_ALERT_COOLDOWN_MS;
  return Math.min(Math.floor(value), MAX_ALERT_COOLDOWN_MS);
}

/** 指数退避：min(2^attempts × 60s, 30min)，attempts 为自增后的新值。 */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts * 60, 30 * 60);
}

const DDL = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  merged_count INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  channel TEXT,
  read_at TEXT,
  actions_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status_next ON alerts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_alerts_pending_priority ON alerts(status, severity, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key);
`;

export class AlertQueue {
  readonly dbFile: string;
  private db: DatabaseSync;
  private closed = false;
  private readonly cooldownMs: number;

  constructor(dbFile: string, options: { cooldownMs?: number } = {}) {
    this.dbFile = dbFile;
    this.cooldownMs = normalizeCooldownMs(options.cooldownMs);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(DDL);
    // 兼容已存在的 gateway.db：DDL 不会为既有表补列，因此显式迁移一次。
    const columns = this.db.prepare("PRAGMA table_info(alerts)").all() as Record<string, unknown>[];
    if (!columns.some((column) => column["name"] === "read_at")) {
      this.db.exec("ALTER TABLE alerts ADD COLUMN read_at TEXT;");
    }
    // 兼容已存在的 gateway.db：交互式卡片按钮列（M3.1）。
    if (!columns.some((column) => column["name"] === "actions_json")) {
      this.db.exec("ALTER TABLE alerts ADD COLUMN actions_json TEXT;");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(read_at, severity);");
    // 重启补发：进程刚启动时不存在真正投递中的行，delivering 一律回置 pending。
    this.db
      .prepare("UPDATE alerts SET status = 'pending', updated_at = ? WHERE status = 'delivering'")
      .run(new Date().toISOString());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * 入队（持久化）。同 dedupeKey 且存在未终结（pending/delivering）行时不新增：
   * 已有行 merged_count+1、updated_at 刷新，返回已有行（消息合并缓释）。
   * 若同一 pending 指纹升级为更高严重度，则用最新摘要提升该行；已经
   * delivering 的行不改写，以免发送中的内容与持久化记录发生竞态。
   *
   * 冷却窗：同 dedupeKey 在上一条 delivered/failed 行的冷却窗内重复入队时，
   * 同严重度或更轻只合并计数（merged_count+1），不再打扰；只有升级为更严重
   * 才新建行。解决的是"投递完成后 dedupe 失效"导致的告警风暴。
   */
  enqueue(input: AlertInput): AlertRow {
    const now = new Date().toISOString();
    const dedupeKey = input.dedupeKey?.trim() || null;
    const actionsJson = serializeActions(input.actions);
    if (dedupeKey !== null) {
      const open = this.findOpenByDedupeKey(dedupeKey);
      if (open !== undefined) {
        if (open.status === "pending" && severityRank(input.severity) < severityRank(open.severity)) {
          // 未投递行升级：摘要与按钮一起替换（例如审批单从「可一键放行」升级为「需面板确认」）。
          this.db
            .prepare(
              `UPDATE alerts
               SET severity = ?, title = ?, body = ?, source = ?, actions_json = ?,
                   merged_count = merged_count + 1, updated_at = ?
               WHERE id = ?`,
            )
            .run(input.severity, input.title, input.body, input.source, actionsJson, now, open.id);
        } else {
          this.db
            .prepare("UPDATE alerts SET merged_count = merged_count + 1, updated_at = ? WHERE id = ?")
            .run(now, open.id);
        }
        const merged = this.get(open.id);
        if (merged !== undefined) return merged;
      }
      if (this.cooldownMs > 0) {
        const recent = this.findRecentlyTerminatedByDedupeKey(dedupeKey, now);
        if (recent !== undefined && severityRank(input.severity) >= severityRank(recent.severity)) {
          this.db
            .prepare("UPDATE alerts SET merged_count = merged_count + 1, updated_at = ? WHERE id = ?")
            .run(now, recent.id);
          const merged = this.get(recent.id);
          if (merged !== undefined) return merged;
        }
      }
    }
    const result = this.db
      .prepare(
        `INSERT INTO alerts (kind, severity, title, body, source, dedupe_key, status,
                             attempts, merged_count, next_attempt_at, created_at, updated_at, actions_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 1, NULL, ?, ?, ?)`,
      )
      .run(input.kind, input.severity, input.title, input.body, input.source, dedupeKey, now, now, actionsJson);
    const row = this.get(Number(result.lastInsertRowid));
    if (row === undefined) {
      throw new Error(`alert ${result.lastInsertRowid} disappeared right after insert`);
    }
    return row;
  }

  /** 认领下一条到期 pending（critical 优先，同级按 created_at FIFO），置为 delivering。 */
  claimNext(now: string = new Date().toISOString()): AlertRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM alerts
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                  created_at ASC, id ASC LIMIT 1`,
      )
      .get(now) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const id = Number(row["id"]);
    this.db
      .prepare("UPDATE alerts SET status = 'delivering', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  markDelivered(id: number, channel: string, now: string = new Date().toISOString()): AlertRow | undefined {
    this.db
      .prepare(
        `UPDATE alerts SET status = 'delivered', delivered_at = ?, updated_at = ?, channel = ?, last_error = NULL
         WHERE id = ?`,
      )
      .run(now, now, channel, id);
    return this.get(id);
  }

  /** 外发失败：attempts+1；未达上限回 pending 并按指数退避安排 next_attempt_at，达上限置 failed。 */
  markFailed(id: number, error: string, now: string = new Date().toISOString()): AlertRow | undefined {
    this.db
      .prepare("UPDATE alerts SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error, now, id);
    const row = this.get(id);
    if (row === undefined) return undefined;
    if (row.attempts >= MAX_ATTEMPTS) {
      this.db
        .prepare("UPDATE alerts SET status = 'failed', next_attempt_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
    } else {
      const next = new Date(new Date(now).getTime() + backoffSeconds(row.attempts) * 1000).toISOString();
      this.db
        .prepare("UPDATE alerts SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?")
        .run(next, now, id);
    }
    return this.get(id);
  }

  get(id: number): AlertRow | undefined {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapRow(row);
  }

  /** 最新在前（面板展示用），limit 上限由调用方约束。 */
  list(limit = 50): AlertRow[] {
    const rows = this.db
      .prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  counts(): { pending: number; delivering: number; delivered: number; failed: number; resolved: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM alerts GROUP BY status")
      .all() as Record<string, unknown>[];
    const counts = { pending: 0, delivering: 0, delivered: 0, failed: 0, resolved: 0 };
    for (const row of rows) {
      const status = String(row["status"]);
      if (
        status === "pending" ||
        status === "delivering" ||
        status === "delivered" ||
        status === "failed" ||
        status === "resolved"
      ) {
        counts[status] = Number(row["n"]);
      }
    }
    return counts;
  }

  /** 通知中心未读数：只统计 warn/critical，和面板展示范围保持一致。 */
  unreadCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE read_at IS NULL AND severity IN ('warn', 'critical')")
      .get() as Record<string, unknown> | undefined;
    return row === undefined ? 0 : Number(row["n"]);
  }

  /** 标记单条通知已读；重复调用保持首次阅读时间。 */
  markRead(id: number, now: string = new Date().toISOString()): AlertRow | undefined {
    this.db
      .prepare("UPDATE alerts SET read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.get(id);
  }

  /** 标记所有重要通知已读，返回本次实际变更条数。 */
  markAllRead(now: string = new Date().toISOString()): number {
    const result = this.db
      .prepare(
        "UPDATE alerts SET read_at = ?, updated_at = ? WHERE read_at IS NULL AND severity IN ('warn', 'critical')",
      )
      .run(now, now);
    return Number(result.changes);
  }

  /**
   * 故障恢复归档：按 dedupeKey 把该故障的告警移出活跃/未读视野。
   * 未投递行（pending/delivering）置 resolved（问题已恢复，不再投递也不计未读）；
   * 已投递/已失败行只补已读（保留投递历史可见）。
   */
  resolveByDedupeKey(
    dedupeKey: string,
    now: string = new Date().toISOString(),
  ): { resolved: number; readMarked: number } {
    const first = this.db
      .prepare(
        `UPDATE alerts SET status = 'resolved', read_at = COALESCE(read_at, ?), next_attempt_at = NULL, updated_at = ?
         WHERE dedupe_key = ? AND status IN ('pending', 'delivering')`,
      )
      .run(now, now, dedupeKey);
    const second = this.db
      .prepare(
        `UPDATE alerts SET read_at = COALESCE(read_at, ?), updated_at = ?
         WHERE dedupe_key = ? AND status IN ('delivered', 'failed') AND read_at IS NULL`,
      )
      .run(now, now, dedupeKey);
    return { resolved: Number(first.changes), readMarked: Number(second.changes) };
  }

  private findOpenByDedupeKey(dedupeKey: string): AlertRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM alerts WHERE dedupe_key = ? AND status IN ('pending', 'delivering')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapRow(row);
  }

  /** 冷却窗内最近一条已终结（delivered/failed）的同行告警：delivered 看 delivered_at，failed 看最后更新。 */
  private findRecentlyTerminatedByDedupeKey(dedupeKey: string, now: string): AlertRow | undefined {
    const cutoff = new Date(new Date(now).getTime() - this.cooldownMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT * FROM alerts WHERE dedupe_key = ? AND status IN ('delivered', 'failed')
         AND COALESCE(delivered_at, updated_at) >= ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(dedupeKey, cutoff) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapRow(row);
  }

  private mapRow(r: Record<string, unknown>): AlertRow {
    return {
      id: Number(r["id"]),
      kind: String(r["kind"]),
      severity: String(r["severity"]) as AlertSeverity,
      title: String(r["title"]),
      body: String(r["body"]),
      source: String(r["source"]),
      dedupeKey: (r["dedupe_key"] as string | null) ?? null,
      status: String(r["status"]) as AlertStatus,
      attempts: Number(r["attempts"]),
      mergedCount: Number(r["merged_count"]),
      nextAttemptAt: (r["next_attempt_at"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
      deliveredAt: (r["delivered_at"] as string | null) ?? null,
      lastError: (r["last_error"] as string | null) ?? null,
      channel: (r["channel"] as string | null) ?? null,
      readAt: (r["read_at"] as string | null) ?? null,
      actions: parseActions(r["actions_json"]),
    };
  }
}

/** 序列化按钮（空/非法一律存 NULL，读侧回落空数组）。 */
function serializeActions(actions: AlertAction[] | undefined): string | null {
  if (actions === undefined || actions.length === 0) return null;
  const cleaned = actions
    .filter((action) => typeof action.label === "string" && action.label.trim() !== "")
    .slice(0, MAX_ALERT_ACTIONS)
    .map((action) => {
      const item: AlertAction = { label: action.label.trim() };
      if (typeof action.callbackData === "string" && action.callbackData !== "") {
        item.callbackData = action.callbackData;
      }
      if (typeof action.url === "string" && action.url !== "") item.url = action.url;
      return item;
    })
    // 两者皆无的按钮点了没反应，直接丢弃而不是渲染一个死按钮。
    .filter((action) => action.callbackData !== undefined || action.url !== undefined);
  return cleaned.length === 0 ? null : JSON.stringify(cleaned);
}

function parseActions(raw: unknown): AlertAction[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => {
        const action: AlertAction = { label: String(item["label"] ?? "") };
        if (typeof item["callbackData"] === "string") action.callbackData = item["callbackData"];
        if (typeof item["url"] === "string") action.url = item["url"];
        return action;
      })
      .filter((action) => action.label !== "");
  } catch {
    return [];
  }
}

function severityRank(severity: AlertSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "warn") return 1;
  return 2;
}
