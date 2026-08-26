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
 * - 所有时间戳均为 ISO 字符串（字典序即时间序）。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type AlertSeverity = "info" | "warn" | "critical";
export type AlertStatus = "pending" | "delivering" | "delivered" | "failed";

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
}

export interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
  dedupeKey?: string;
}

/** 连续失败上限：达到即 failed（保留可见）。 */
export const MAX_ATTEMPTS = 5;

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
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status_next ON alerts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key);
`;

export class AlertQueue {
  readonly dbFile: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(DDL);
    // 兼容已存在的 gateway.db：DDL 不会为既有表补列，因此显式迁移一次。
    const columns = this.db.prepare("PRAGMA table_info(alerts)").all() as Record<string, unknown>[];
    if (!columns.some((column) => column["name"] === "read_at")) {
      this.db.exec("ALTER TABLE alerts ADD COLUMN read_at TEXT;");
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
   */
  enqueue(input: AlertInput): AlertRow {
    const now = new Date().toISOString();
    const dedupeKey = input.dedupeKey?.trim() || null;
    if (dedupeKey !== null) {
      const open = this.findOpenByDedupeKey(dedupeKey);
      if (open !== undefined) {
        this.db
          .prepare("UPDATE alerts SET merged_count = merged_count + 1, updated_at = ? WHERE id = ?")
          .run(now, open.id);
        const merged = this.get(open.id);
        if (merged !== undefined) return merged;
      }
    }
    const result = this.db
      .prepare(
        `INSERT INTO alerts (kind, severity, title, body, source, dedupe_key, status,
                             attempts, merged_count, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 1, NULL, ?, ?)`,
      )
      .run(input.kind, input.severity, input.title, input.body, input.source, dedupeKey, now, now);
    const row = this.get(Number(result.lastInsertRowid));
    if (row === undefined) {
      throw new Error(`alert ${result.lastInsertRowid} disappeared right after insert`);
    }
    return row;
  }

  /** 认领下一条到期 pending（created_at 升序，id 平局决胜），置为 delivering。 */
  claimNext(now: string = new Date().toISOString()): AlertRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM alerts
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, id ASC LIMIT 1`,
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

  counts(): { pending: number; delivering: number; delivered: number; failed: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM alerts GROUP BY status")
      .all() as Record<string, unknown>[];
    const counts = { pending: 0, delivering: 0, delivered: 0, failed: 0 };
    for (const row of rows) {
      const status = String(row["status"]);
      if (status === "pending" || status === "delivering" || status === "delivered" || status === "failed") {
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

  private findOpenByDedupeKey(dedupeKey: string): AlertRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM alerts WHERE dedupe_key = ? AND status IN ('pending', 'delivering')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(dedupeKey) as Record<string, unknown> | undefined;
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
    };
  }
}
