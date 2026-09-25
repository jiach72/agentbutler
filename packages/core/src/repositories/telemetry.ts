import { BaseRepository, fromJson, nowIso } from "./base.js";

export type EventSeverity = "info" | "warn" | "error";

export interface StoredEvent {
  id: number;
  ts: string;
  type: string;
  severity: EventSeverity;
  source: string;
  payload: unknown;
}

export interface EventInput {
  type: string;
  severity?: EventSeverity;
  source?: string;
  payload?: unknown;
}

export interface FingerprintRow {
  id: number;
  signature: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: string;
  lastSample: string | null;
  /** 错误指纹归属实例（影响组件）；旧数据/未知来源为空串。 */
  instance: string;
}

/** fingerprint_windows 表行：单个签名的锚定式突发窗口（升级趋势判定与面板展示）。 */
export interface FingerprintWindowRow {
  id: number;
  signature: string;
  startedAt: string;
  endedAt: string | null;
  count: number;
}

export interface FingerprintWindowInput {
  signature: string;
  startedAt: string;
  endedAt?: string | null;
  count: number;
}

export class TelemetryRepository extends BaseRepository {
  /* --------------------------------- events --------------------------------- */

  insertEvent(input: EventInput): StoredEvent {
    const ts = nowIso();
    const severity = input.severity ?? "info";
    const source = input.source ?? "";
    const payloadJson = JSON.stringify(input.payload ?? null);
    const result = this.prepare(
      "INSERT INTO events (ts, type, severity, source, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(ts, input.type, severity, source, payloadJson);
    return {
      id: Number(result.lastInsertRowid),
      ts,
      type: input.type,
      severity,
      source,
      payload: input.payload ?? null,
    };
  }

  listEvents(filter: { type?: string; limit?: number; afterId?: number } = {}): StoredEvent[] {
    const limit = filter.limit ?? 100;
    const afterId = filter.afterId;
    if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) {
      throw new Error("events afterId must be a non-negative integer");
    }
    const rows = this.prepare(
      "SELECT * FROM events WHERE type = COALESCE(?, type) AND id > COALESCE(?, 0) ORDER BY id DESC LIMIT ?",
    ).all(filter.type ?? null, afterId ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      type: String(r["type"]),
      severity: String(r["severity"]) as EventSeverity,
      source: String(r["source"]),
      payload: fromJson<unknown>(r["payload_json"] as string | null, null),
    }));
  }

  /** Removes events older than the cutoff（ISO 时间戳）；供保留期清理低频调用。 */
  pruneEvents(cutoff: string): number {
    if (typeof cutoff !== "string" || Number.isNaN(Date.parse(cutoff))) {
      throw new Error("events cutoff must be a valid timestamp");
    }
    const result = this.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  /**
   * Aggregates inspection-completed events in SQLite. The caller supplies the
   * UTC lower bound for the local-calendar window; JSON1 computes per-check
   * duration averages before averaging across inspections.
   */
  dailyInspectionMetrics(since: string): Array<{
    date: string;
    count: number;
    avgDurationMs: number | null;
    errorCount: number;
  }> {
    if (typeof since !== "string" || Number.isNaN(Date.parse(since))) {
      throw new Error("inspection metrics since must be a valid timestamp");
    }
    const rows = this.prepare(
      `WITH inspection_rows AS (
         SELECT
           date(e.ts, 'localtime') AS day,
           CASE
             WHEN typeof(json_extract(e.payload_json, '$.overall')) = 'text'
              AND json_extract(e.payload_json, '$.overall') NOT IN ('ok', 'healthy')
             THEN 1 ELSE 0
           END AS is_error,
           (
             SELECT AVG(
               CASE
                 WHEN typeof(json_extract(check_item.value, '$.durationMs')) IN ('integer', 'real')
                 THEN CAST(json_extract(check_item.value, '$.durationMs') AS REAL)
                 ELSE NULL
               END
             )
             FROM json_each(e.payload_json, '$.checks') AS check_item
           ) AS duration_ms
         FROM events AS e
         WHERE e.type = 'inspection-completed' AND e.ts >= ?
       )
       SELECT
         day,
         COUNT(*) AS count,
         ROUND(AVG(duration_ms)) AS avg_duration_ms,
         SUM(is_error) AS error_count
       FROM inspection_rows
       GROUP BY day
       ORDER BY day ASC`,
    ).all(since) as Record<string, unknown>[];
    return rows.map((row) => ({
      date: String(row["day"]),
      count: Number(row["count"]),
      avgDurationMs: row["avg_duration_ms"] === null ? null : Number(row["avg_duration_ms"]),
      errorCount: Number(row["error_count"]),
    }));
  }

  /* ------------------------------ fingerprints ------------------------------ */

  upsertFingerprint(signature: string, sample?: string, instanceId?: string): FingerprintRow {
    const ts = nowIso();
    this.prepare(
      `INSERT INTO fingerprints (signature, first_seen, last_seen, count, status, last_sample, instance)
       VALUES (?, ?, ?, 1, 'open', ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         last_seen = excluded.last_seen,
         count = fingerprints.count + 1,
         last_sample = COALESCE(excluded.last_sample, fingerprints.last_sample),
         instance = CASE WHEN excluded.instance <> '' THEN excluded.instance ELSE fingerprints.instance END`,
    ).run(signature, ts, ts, sample ?? null, instanceId ?? "");
    const row = this.prepare("SELECT * FROM fingerprints WHERE signature = ?").get(signature) as Record<
      string,
      unknown
    >;
    return this.mapFingerprint(row);
  }

  listFingerprints(limit = 100, since?: string): FingerprintRow[] {
    const rows = this.prepare(
      "SELECT * FROM fingerprints WHERE (? IS NULL OR last_seen >= ?) ORDER BY last_seen DESC, id DESC LIMIT ?",
    ).all(since ?? null, since ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapFingerprint(r));
  }

  findFingerprint(signature: string): FingerprintRow | undefined {
    const row = this.prepare("SELECT * FROM fingerprints WHERE signature = ?").get(signature) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapFingerprint(row);
  }

  updateFingerprintStatus(signature: string, status: string): boolean {
    const result = this.prepare("UPDATE fingerprints SET status = ? WHERE signature = ?").run(status, signature);
    return result.changes > 0;
  }

  private mapFingerprint(r: Record<string, unknown>): FingerprintRow {
    return {
      id: Number(r["id"]),
      signature: String(r["signature"]),
      firstSeen: String(r["first_seen"]),
      lastSeen: String(r["last_seen"]),
      count: Number(r["count"]),
      status: String(r["status"]),
      lastSample: (r["last_sample"] as string | null) ?? null,
      instance: String(r["instance"] ?? ""),
    };
  }

  /* ----------------------------- tail_positions ----------------------------- */

  /** 读取日志源的已提交字节位点；从未读过返回 undefined。 */
  getTailPosition(sourceId: string): number | undefined {
    const row = this.prepare("SELECT byte_offset FROM tail_positions WHERE source_id = ?").get(sourceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : Number(row["byte_offset"]);
  }

  /** 提交日志源位点（仅在调用方成功处理完一批行后由 LogTailer 调用）。 */
  setTailPosition(sourceId: string, byteOffset: number): void {
    this.prepare(
      `INSERT INTO tail_positions (source_id, byte_offset, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         updated_at = excluded.updated_at`,
    ).run(sourceId, byteOffset, nowIso());
  }

  /* --------------------------- fingerprint_windows -------------------------- */

  insertFingerprintWindow(input: FingerprintWindowInput): FingerprintWindowRow {
    const result = this.prepare(
      "INSERT INTO fingerprint_windows (signature, started_at, ended_at, count) VALUES (?, ?, ?, ?)",
    ).run(input.signature, input.startedAt, input.endedAt ?? null, input.count);
    return {
      id: Number(result.lastInsertRowid),
      signature: input.signature,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      count: input.count,
    };
  }

  listFingerprintWindows(filter: { signature?: string; limit?: number } = {}): FingerprintWindowRow[] {
    const limit = filter.limit ?? 100;
    const rows = this.prepare(
      "SELECT * FROM fingerprint_windows WHERE signature = COALESCE(?, signature) ORDER BY id DESC LIMIT ?",
    ).all(filter.signature ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      signature: String(r["signature"]),
      startedAt: String(r["started_at"]),
      endedAt: (r["ended_at"] as string | null) ?? null,
      count: Number(r["count"]),
    }));
  }
}
