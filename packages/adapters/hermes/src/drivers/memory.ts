import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fail,
  MEMORY_PREVIEW_LIMIT,
  ok,
  type ArchivePolicy,
  type ArchiveReport,
  type DriverScope,
  type IntegrityReport,
  type MemoryDriver,
  type MemoryEntry,
  type MemoryHealth,
  type MemoryQuery,
  type MemorySignal,
  type MemoryStats,
  type MemorySuggestion,
  type PurgePolicy,
  type PurgeReport,
  type RebuildIndexReport,
  type Result,
  type RestorePolicy,
  type RestoreReport,
} from "@butler/contract";

const MEMORY_DB_FILE = "memory_store.db";
const COLD_AFTER_MS = 90 * 24 * 60 * 60 * 1_000;
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PROBE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PREVIEW_LIMIT = 20;
const PROBE_CATEGORY = "butler-probe";
const ARCHIVE_TABLE = "butler_memory_archive";
/** 管家记忆探针健康统计表（memory-probe 每次运行记录写入/召回结果）。 */
const OPS_TABLE = "butler_memory_ops";
/** 探针健康统计窗口：只取最近 N 次，避免无限膨胀影响健康评分。 */
const OPS_WINDOW = 50;

interface StatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
}

interface ReadonlyDb {
  prepare(sql: string): StatementLike;
  close(): void;
}

interface WritableDb extends ReadonlyDb {
  exec(sql: string): void;
}

export type ReadonlySqliteOpener = (path: string) => ReadonlyDb;
export type WritableSqliteOpener = (path: string) => WritableDb;

export interface HermesMemoryDriverOptions {
  open?: ReadonlySqliteOpener;
  openWritable?: WritableSqliteOpener;
  now?: () => number;
}

function defaultReadonlyOpener(path: string): ReadonlyDb {
  return new DatabaseSync(path, { readOnly: true }) as unknown as ReadonlyDb;
}

function defaultWritableOpener(path: string): WritableDb {
  return new DatabaseSync(path, { timeout: 5_000 }) as unknown as WritableDb;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sqliteTimestamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function queryTime(value: string | undefined): { value?: string; error?: string } {
  if (value === undefined) return {};
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: value };
  return { value: sqliteTimestamp(parsed.getTime()) };
}

function tableNames(db: ReadonlyDb): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all()
      .map((row) => (isRecord(row) ? String(row["name"] ?? "") : "")),
  );
}

function ensureSchema(db: ReadonlyDb): string | null {
  const names = tableNames(db);
  const missing = ["facts", "facts_fts"].filter((name) => !names.has(name));
  return missing.length === 0 ? null : missing.join(", ");
}

function openDb(
  scope: DriverScope,
  open: ReadonlySqliteOpener,
): { db?: ReadonlyDb; error?: string; path: string } {
  const path = join(scope.rootPath, MEMORY_DB_FILE);
  if (!existsSync(path)) return { path, error: "memory_store.db 不存在" };
  try {
    return { path, db: open(path) };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

function openWritableDb(
  scope: DriverScope,
  openWritable: WritableSqliteOpener,
): { db?: WritableDb; error?: string; path: string } {
  const path = join(scope.rootPath, MEMORY_DB_FILE);
  if (!existsSync(path)) return { path, error: "memory_store.db 不存在" };
  try {
    return { path, db: openWritable(path) };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

function ensureArchiveTable(db: WritableDb): string | null {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${ARCHIVE_TABLE} (
        fact_id INTEGER PRIMARY KEY,
        archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reason TEXT DEFAULT 'cold',
        archived_by TEXT DEFAULT 'butler'
      )`,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function tagValue(tags: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[,;\\s])${key}:([^,;\\s]+)`).exec(tags);
  return match?.[1];
}

function ftsPhrase(keyword: string): string {
  return `"${keyword.replace(/"/g, '""')}"`;
}

function clampLimit(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_PREVIEW_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MEMORY_PREVIEW_LIMIT, Math.floor(value));
}

function toMemoryEntry(row: Record<string, unknown>, cutoffMs: number): MemoryEntry {
  const content = String(row["content"] ?? "");
  const tags = String(row["tags"] ?? "");
  const writtenAt = normalizeTimestamp(row["created_at"]) ?? String(row["created_at"] ?? "");
  const createdMs = Date.parse(writtenAt);
  const retrievalCount = numberValue(row["retrieval_count"]);
  const channel = tagValue(tags, "channel");
  const sessionId = tagValue(tags, "session");
  return {
    entryId: String(row["fact_id"] ?? ""),
    writtenAt,
    content,
    sizeBytes: Buffer.byteLength(content),
    cold: Number.isFinite(createdMs) && createdMs < cutoffMs && retrievalCount === 0,
    ...(channel === undefined ? {} : { channel }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function placeholderList(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function olderThanMs(
  policy: { olderThan?: string; keepMonths?: number },
  nowMs: number,
  fallbackMs: number,
): { value: number } | { error: string } {
  if (policy.olderThan !== undefined) {
    const parsed = Date.parse(policy.olderThan);
    if (!Number.isFinite(parsed)) return { error: policy.olderThan };
    return { value: parsed };
  }
  if (policy.keepMonths !== undefined) {
    if (!Number.isFinite(policy.keepMonths) || policy.keepMonths <= 0) {
      return { error: String(policy.keepMonths) };
    }
    return { value: nowMs - policy.keepMonths * 30 * 24 * 60 * 60 * 1_000 };
  }
  return { value: nowMs - fallbackMs };
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

interface ProbeStats {
  writeAttempts: number;
  writeFailures: number;
  recallAttempts: number;
  recallHits: number;
}

/** 读取管家记忆探针统计（最近 OPS_WINDOW 次；表不存在视为无记录）。 */
function collectProbeStats(db: ReadonlyDb): ProbeStats {
  if (!tableNames(db).has(OPS_TABLE)) {
    return { writeAttempts: 0, writeFailures: 0, recallAttempts: 0, recallHits: 0 };
  }
  const writeRows = db
    .prepare(`SELECT ok FROM ${OPS_TABLE} WHERE kind = ? ORDER BY id DESC LIMIT ?`)
    .all("probe-write", OPS_WINDOW);
  const recallRows = db
    .prepare(`SELECT ok FROM ${OPS_TABLE} WHERE kind = ? ORDER BY id DESC LIMIT ?`)
    .all("probe-recall", OPS_WINDOW);
  const toOk = (row: unknown): number => (isRecord(row) ? numberValue(row["ok"]) : 0);
  const write = writeRows.map(toOk);
  const recall = recallRows.map(toOk);
  return {
    writeAttempts: write.length,
    writeFailures: write.filter((value) => value === 0).length,
    recallAttempts: recall.length,
    recallHits: recall.filter((value) => value === 1).length,
  };
}

function collectStats(db: ReadonlyDb, nowMs: number): { stats: MemoryStats } | { error: string } {
  const missing = ensureSchema(db);
  if (missing !== null) return { error: `Hermes memory schema missing: ${missing}` };
  const totalRow = db
    .prepare("SELECT COUNT(*) AS count FROM facts WHERE COALESCE(category, '') <> ?")
    .get(PROBE_CATEGORY);
  const months = db
    .prepare(
      "SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM facts WHERE COALESCE(category, '') <> ? GROUP BY month ORDER BY month",
    )
    .all(PROBE_CATEGORY);
  const cutoff = sqliteTimestamp(nowMs - COLD_AFTER_MS);
  const hasArchiveTable = tableNames(db).has(ARCHIVE_TABLE);
  const coldRow = hasArchiveTable
    ? db
        .prepare(
          "SELECT COUNT(*) AS count FROM facts f WHERE COALESCE(f.category, '') <> ? AND f.created_at < ? AND COALESCE(f.retrieval_count, 0) = 0 AND NOT EXISTS (SELECT 1 FROM butler_memory_archive a WHERE a.fact_id = f.fact_id)",
        )
        .get(PROBE_CATEGORY, cutoff)
    : db
        .prepare(
          "SELECT COUNT(*) AS count FROM facts WHERE COALESCE(category, '') <> ? AND created_at < ? AND COALESCE(retrieval_count, 0) = 0",
        )
        .get(PROBE_CATEGORY, cutoff);
  const latestRow = db
    .prepare("SELECT MAX(created_at) AS last_write_at FROM facts WHERE COALESCE(category, '') <> ?")
    .get(PROBE_CATEGORY);
  const probeRow = db
    .prepare("SELECT COUNT(*) AS count FROM facts WHERE category = ?")
    .get(PROBE_CATEGORY);
  const recalledRow = db
    .prepare(
      "SELECT COUNT(*) AS count FROM facts WHERE COALESCE(category, '') <> ? AND COALESCE(retrieval_count, 0) > 0",
    )
    .get(PROBE_CATEGORY);
  const recallsRow = db
    .prepare(
      "SELECT COALESCE(SUM(retrieval_count), 0) AS sum FROM facts WHERE COALESCE(category, '') <> ?",
    )
    .get(PROBE_CATEGORY);
  const probeStats = collectProbeStats(db);
  let archivedEntries = 0;
  if (hasArchiveTable) {
    const archivedRow = db.prepare(`SELECT COUNT(*) AS count FROM ${ARCHIVE_TABLE}`).get();
    archivedEntries = isRecord(archivedRow) ? numberValue(archivedRow["count"]) : 0;
  }
  return {
    stats: {
      totalEntries: isRecord(totalRow) ? numberValue(totalRow["count"]) : 0,
      byMonth: months.filter(isRecord).map((row) => ({
        month: String(row["month"] ?? "unknown"),
        count: numberValue(row["count"]),
      })),
      coldCandidates: isRecord(coldRow) ? numberValue(coldRow["count"]) : 0,
      lastWriteAt: isRecord(latestRow) ? normalizeTimestamp(latestRow["last_write_at"]) : null,
      archivedEntries,
      probeEntries: isRecord(probeRow) ? numberValue(probeRow["count"]) : 0,
      recalledEntries: isRecord(recalledRow) ? numberValue(recalledRow["count"]) : 0,
      cumulativeRecalls: isRecord(recallsRow) ? numberValue(recallsRow["sum"]) : 0,
      probeWriteAttempts: probeStats.writeAttempts,
      probeWriteFailures: probeStats.writeFailures,
      probeRecallAttempts: probeStats.recallAttempts,
      probeRecallHits: probeStats.recallHits,
    },
  };
}

export function createHermesMemoryDriver(options: HermesMemoryDriverOptions = {}): MemoryDriver {
  const open = options.open ?? defaultReadonlyOpener;
  const openWritable = options.openWritable ?? defaultWritableOpener;
  const now = options.now ?? Date.now;

  return {
    id: "sqlite-fts5",
    async stats(scope: DriverScope) {
      const startedAt = Date.now();
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不是受支持的 SQLite+FTS5 格式，将降级为目录统计",
        });
      }
      const db = opened.db;
      try {
        const collected = collectStats(db, now());
        if ("error" in collected) {
          return fail("E402", collected.error, {
            startedAt,
            userHint: "记忆库不是受支持的 SQLite+FTS5 格式，将降级为目录统计",
          });
        }
        return ok(collected.stats, startedAt);
      } catch (error) {
        return fail("E402", "failed to read Hermes memory statistics", {
          startedAt,
          cause: error,
          userHint: "SQLite 记忆库读取失败，将降级为目录统计",
        });
      } finally {
        db.close();
      }
    },

    async preview(scope: DriverScope, query: MemoryQuery) {
      const startedAt = Date.now();
      const limit = clampLimit(query.limit);
      if (limit === null) {
        return fail("E002", "memory preview limit must be a positive finite number", {
          startedAt,
          userHint: `检索预览条数必须为正数，且最多 ${MEMORY_PREVIEW_LIMIT} 条`,
        });
      }
      const since = queryTime(query.since);
      const until = queryTime(query.until);
      if (since.error !== undefined || until.error !== undefined) {
        return fail("E002", `invalid memory preview time: ${since.error ?? until.error}`, {
          startedAt,
          userHint: "记忆检索时间必须是有效的 ISO-8601 时间",
        });
      }
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不是受支持的 SQLite+FTS5 格式，暂不支持检索预览",
        });
      }
      const db = opened.db;
      try {
        const missing = ensureSchema(db);
        if (missing !== null) {
          return fail("E402", `Hermes memory schema missing: ${missing}`, {
            startedAt,
            userHint: `记忆库缺少 ${missing}，暂不支持检索预览`,
          });
        }
        const conditions = ["COALESCE(f.category, '') <> ?"];
        const params: unknown[] = [PROBE_CATEGORY];
        let from = "facts f";
        const keyword = query.keyword?.trim() ?? "";
        if (keyword !== "") {
          if (Array.from(keyword).length >= 3) {
            from = "facts f JOIN facts_fts ON facts_fts.rowid = f.fact_id";
            conditions.push("facts_fts MATCH ?");
            params.push(ftsPhrase(keyword));
          } else {
            conditions.push("f.content LIKE ? ESCAPE '\\'");
            params.push(`%${keyword.replace(/[\\%_]/g, "\\$&")}%`);
          }
        }
        if (query.channel !== undefined && query.channel.trim() !== "") {
          conditions.push("f.tags LIKE ?");
          params.push(`%channel:${query.channel.trim()}%`);
        }
        if (since.value !== undefined) {
          conditions.push("f.created_at >= ?");
          params.push(since.value);
        }
        if (until.value !== undefined) {
          conditions.push("f.created_at <= ?");
          params.push(until.value);
        }
        params.push(limit);
        const rows = db
          .prepare(
            `SELECT f.fact_id, f.content, f.tags, f.retrieval_count, f.created_at FROM ${from} WHERE ${conditions.join(" AND ")} ORDER BY f.created_at DESC, f.fact_id DESC LIMIT ?`,
          )
          .all(...params)
          .filter(isRecord);
        const cutoffMs = now() - COLD_AFTER_MS;
        return ok(
          rows.map((row) => toMemoryEntry(row, cutoffMs)),
          startedAt,
        );
      } catch (error) {
        return fail("E402", "failed to preview Hermes memory", {
          startedAt,
          cause: error,
          userHint: "记忆检索失败；该实例的此格式暂不支持解析",
        });
      } finally {
        db.close();
      }
    },

    async verifyIntegrity(scope: DriverScope) {
      const startedAt = Date.now();
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不可读，无法校验完整性",
        });
      }
      const db = opened.db;
      try {
        const missing = ensureSchema(db);
        const quick = db.prepare("PRAGMA quick_check").all().filter(isRecord);
        const problems: IntegrityReport["problems"] = [];
        if (missing !== null) problems.push({ kind: "schema-missing", detail: `缺少 ${missing}` });
        for (const row of quick) {
          const detail = String(Object.values(row)[0] ?? "");
          if (detail !== "ok") problems.push({ kind: "sqlite-quick-check", detail });
        }
        const total = db.prepare("SELECT COUNT(*) AS count FROM facts").get();
        return ok(
          {
            healthy: problems.length === 0,
            checkedAt: new Date(now()).toISOString(),
            totalChecked: isRecord(total) ? numberValue(total["count"]) : 0,
            problems,
          },
          startedAt,
        );
      } catch (error) {
        return fail("E402", "failed to verify Hermes memory integrity", {
          startedAt,
          cause: error,
          userHint: "记忆库完整性校验失败",
        });
      } finally {
        db.close();
      }
    },

    async analyze(scope: DriverScope) {
      const startedAt = Date.now();
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不可读，无法给出健康评分",
        });
      }
      const db = opened.db;
      try {
        const collected = collectStats(db, now());
        if ("error" in collected) {
          return fail("E402", collected.error, {
            startedAt,
            userHint: "记忆库不是受支持的 SQLite+FTS5 格式，暂不支持健康分析",
          });
        }
        const stats = collected.stats;
        const nowMs = now();
        const signals: MemorySignal[] = [];
        const suggestions: MemorySuggestion[] = [];
        let score = 100;

        const quick = db.prepare("PRAGMA quick_check").all().filter(isRecord);
        const integrityProblems: string[] = [];
        for (const row of quick) {
          const detail = String(Object.values(row)[0] ?? "");
          if (detail !== "ok") integrityProblems.push(detail);
        }
        if (integrityProblems.length > 0) {
          signals.push({
            id: "integrity",
            label: "数据库完整性",
            status: "error",
            detail: `SQLite quick_check 发现 ${integrityProblems.length} 处问题`,
          });
          score -= 30;
        } else {
          signals.push({
            id: "integrity",
            label: "数据库完整性",
            status: "ok",
            detail: "SQLite quick_check 通过",
          });
        }

        const factsTotal = stats.totalEntries + stats.probeEntries;
        const ftsRow = db.prepare("SELECT COUNT(*) AS count FROM facts_fts").get();
        const ftsCount = isRecord(ftsRow) ? numberValue(ftsRow["count"]) : 0;
        if (ftsCount !== factsTotal) {
          signals.push({
            id: "fts-index",
            label: "全文索引",
            status: "warn",
            detail: `记忆表 ${factsTotal} 条，FTS 索引 ${ftsCount} 条，存在差异`,
          });
          suggestions.push({
            id: "rebuild-index",
            kind: "rebuild-index",
            title: "重建全文索引",
            detail: "全文索引与记忆表数量不一致，检索可能漏结果，建议重建索引。",
          });
          score -= 20;
        } else {
          signals.push({
            id: "fts-index",
            label: "全文索引",
            status: "ok",
            detail: `FTS 索引 ${ftsCount} 条，与记忆表一致`,
          });
        }

        let writeStalled = false;
        if (stats.lastWriteAt === null) {
          signals.push({
            id: "write-activity",
            label: "写入活动",
            status: "unknown",
            detail: "记忆库尚无用户记忆写入",
          });
        } else {
          const ageMs = nowMs - Date.parse(stats.lastWriteAt);
          if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1_000) {
            writeStalled = true;
            signals.push({
              id: "write-activity",
              label: "写入活动",
              status: "warn",
              detail: `距上次写入 ${formatAge(ageMs)}，可能有停写风险`,
            });
          } else if (Number.isFinite(ageMs)) {
            signals.push({
              id: "write-activity",
              label: "写入活动",
              status: "ok",
              detail: `最近写入在 ${formatAge(ageMs)} 前`,
            });
          } else {
            signals.push({
              id: "write-activity",
              label: "写入活动",
              status: "unknown",
              detail: "最近写入时间格式无法识别",
            });
          }
        }
        if (writeStalled) score -= 15;

        // PRD M6：健康评分含写入失败率与召回命中率（管家探针最近 50 次实测）。
        const probeStats = collectProbeStats(db);
        if (probeStats.writeAttempts === 0) {
          signals.push({
            id: "write-reliability",
            label: "写入失败率",
            status: "unknown",
            detail: "管家探针尚未积累写入记录，暂无法评估写入失败率",
          });
        } else {
          const writeFailRate = probeStats.writeFailures / probeStats.writeAttempts;
          if (probeStats.writeFailures === 0) {
            signals.push({
              id: "write-reliability",
              label: "写入失败率",
              status: "ok",
              detail: `最近 ${probeStats.writeAttempts} 次记忆写入探针全部成功`,
            });
          } else {
            const failPercent = Math.round(writeFailRate * 100);
            signals.push({
              id: "write-reliability",
              label: "写入失败率",
              status: writeFailRate > 0.1 ? "error" : "warn",
              detail: `最近 ${probeStats.writeAttempts} 次记忆写入探针失败 ${probeStats.writeFailures} 次（${failPercent}%）`,
            });
            score -= writeFailRate > 0.1 ? 20 : 8;
          }
        }
        if (probeStats.recallAttempts === 0) {
          signals.push({
            id: "recall-hit-rate",
            label: "召回命中率",
            status: "unknown",
            detail: "管家探针尚未积累召回记录，暂无法评估召回命中率",
          });
        } else {
          const recallHitRate = probeStats.recallHits / probeStats.recallAttempts;
          if (probeStats.recallHits === probeStats.recallAttempts) {
            signals.push({
              id: "recall-hit-rate",
              label: "召回命中率",
              status: "ok",
              detail: `最近 ${probeStats.recallAttempts} 次召回探针全部命中`,
            });
          } else {
            const hitPercent = Math.round(recallHitRate * 100);
            signals.push({
              id: "recall-hit-rate",
              label: "召回命中率",
              status: recallHitRate < 0.9 ? "error" : "warn",
              detail: `最近 ${probeStats.recallAttempts} 次召回探针命中 ${probeStats.recallHits} 次（${hitPercent}%）`,
            });
            score -= recallHitRate < 0.9 ? 20 : 8;
          }
        }
        if (stats.totalEntries > 0) {
          signals.push({
            id: "recall-coverage",
            label: "召回覆盖",
            status: stats.recalledEntries > 0 ? "ok" : "warn",
            detail: `${stats.recalledEntries}/${stats.totalEntries} 条记忆被召回过，累计召回 ${stats.cumulativeRecalls} 次`,
          });
        }

        if (stats.totalEntries > 0 && (ftsCount !== factsTotal || writeStalled)) {
          suggestions.push({
            id: "embedding-vendor",
            kind: "notice",
            title: "切换嵌入供应商建议",
            detail: "当前检索依赖本地全文索引；若召回仍不准，可切换到嵌入检索（如 bge / deepseek-embedding）并重建向量索引。",
          });
        }

        const coldRatio = stats.totalEntries > 0 ? stats.coldCandidates / stats.totalEntries : 0;
        if (stats.coldCandidates > 0) {
          signals.push({
            id: "cold",
            label: "冷记忆",
            status: coldRatio > 0.2 ? "warn" : "ok",
            detail: `${stats.coldCandidates} 条 90 天未召回，占 ${Math.round(coldRatio * 100)}%`,
          });
          suggestions.push({
            id: "archive-cold",
            kind: "archive",
            title: "归档冷记忆",
            detail: `${stats.coldCandidates} 条超过 90 天未召回且无任务关联；归档可逆，30 天内可一键恢复。`,
            action: "archive-cold",
          });
          if (coldRatio > 0.2) score -= 10;
        } else {
          signals.push({
            id: "cold",
            label: "冷记忆",
            status: "ok",
            detail: "没有 90 天未召回的冷记忆",
          });
        }

        const staleProbeRow = db
          .prepare("SELECT COUNT(*) AS count FROM facts WHERE category = ? AND created_at < ?")
          .get(PROBE_CATEGORY, sqliteTimestamp(nowMs - PROBE_RETENTION_MS));
        const staleProbes = isRecord(staleProbeRow) ? numberValue(staleProbeRow["count"]) : 0;
        if (staleProbes > 0) {
          signals.push({
            id: "probe-hygiene",
            label: "测试记忆",
            status: "warn",
            detail: `${staleProbes} 条探针测试记忆超过 24 小时未清理`,
          });
          suggestions.push({
            id: "purge-probes",
            kind: "purge-probes",
            title: "清理过期测试记忆",
            detail: `删除 ${staleProbes} 条超过 24 小时的探针测试记忆，不影响用户记忆。`,
            action: "purge-probes",
          });
          score -= 5;
        } else {
          signals.push({
            id: "probe-hygiene",
            label: "测试记忆",
            status: "ok",
            detail: "无过期探针测试记忆",
          });
        }

        if (stats.archivedEntries > 0) {
          const oldArchiveRow = db
            .prepare(`SELECT COUNT(*) AS count FROM ${ARCHIVE_TABLE} WHERE archived_at < ?`)
            .get(sqliteTimestamp(nowMs - ARCHIVE_RETENTION_MS));
          const oldArchived = isRecord(oldArchiveRow) ? numberValue(oldArchiveRow["count"]) : 0;
          if (oldArchived > 0) {
            suggestions.push({
              id: "purge-archived",
              kind: "restore",
              title: "清理超期归档",
              detail: `${oldArchived} 条归档超过 30 天保留期，确认后可以物理删除释放空间。`,
              action: "purge-archived",
            });
            score -= 5;
          }
          suggestions.push({
            id: "restore-archived",
            kind: "restore",
            title: "恢复已归档记忆",
            detail: `${stats.archivedEntries} 条已归档记忆在 30 天保留期内，可一键恢复。`,
            action: "restore-archived",
          });
        }

        return ok(
          {
            score: Math.max(0, Math.min(100, score)),
            checkedAt: new Date(nowMs).toISOString(),
            signals,
            suggestions,
          } satisfies MemoryHealth,
          startedAt,
        );
      } catch (error) {
        return fail("E402", "failed to analyze Hermes memory", {
          startedAt,
          cause: error,
          userHint: "记忆健康分析失败",
        });
      } finally {
        db.close();
      }
    },

    async archiveCold(scope: DriverScope, policy: ArchivePolicy): Promise<Result<ArchiveReport>> {
      const startedAt = Date.now();
      const cutoffResult = olderThanMs(policy, now(), COLD_AFTER_MS);
      if ("error" in cutoffResult) {
        return fail("E002", `invalid archive cutoff time: ${cutoffResult.error}`, {
          startedAt,
          userHint: "归档时间必须是有效的 ISO-8601 时间，或正数月数",
        });
      }
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不可读，无法计算冷记忆清单",
        });
      }
      const db = opened.db;
      let candidates: { factId: number; content: string }[] = [];
      try {
        const missing = ensureSchema(db);
        if (missing !== null) {
          return fail("E402", `Hermes memory schema missing: ${missing}`, {
            startedAt,
            userHint: `记忆库缺少 ${missing}，暂不支持归档`,
          });
        }
        const conditions = [
          "COALESCE(f.category, '') <> ?",
          "COALESCE(f.retrieval_count, 0) = 0",
          "f.created_at < ?",
        ];
        const params: unknown[] = [PROBE_CATEGORY, sqliteTimestamp(cutoffResult.value)];
        if (tableNames(db).has(ARCHIVE_TABLE)) {
          conditions.push(
            "NOT EXISTS (SELECT 1 FROM butler_memory_archive a WHERE a.fact_id = f.fact_id)",
          );
        }
        if (policy.entryIds !== undefined) {
          const ids = policy.entryIds.map(Number).filter(Number.isInteger);
          if (ids.length === 0) {
            return fail("E002", "entryIds must be a non-empty list of fact ids", {
              startedAt,
              userHint: "请选择要归档的记忆条目",
            });
          }
          conditions.push(`f.fact_id IN (${placeholderList(ids.length)})`);
          params.push(...ids);
        }
        const rows = db
          .prepare(
            `SELECT f.fact_id AS fact_id, f.content AS content FROM facts f WHERE ${conditions.join(" AND ")}`,
          )
          .all(...params)
          .filter(isRecord);
        candidates = rows.map((row) => ({
          factId: numberValue(row["fact_id"]),
          content: String(row["content"] ?? ""),
        }));
      } finally {
        db.close();
      }
      const freedBytes = candidates.reduce(
        (sum, item) => sum + Buffer.byteLength(item.content),
        0,
      );
      if (policy.dryRun === true) {
        return ok(
          { archived: candidates.length, freedBytes, dryRun: true, errors: [] },
          startedAt,
        );
      }

      const writable = openWritableDb(scope, openWritable);
      if (writable.db === undefined) {
        return fail(
          "E403",
          `cannot open Hermes memory database for writing: ${writable.error ?? writable.path}`,
          {
            startedAt,
            userHint: "记忆库当前不可写（可能被 Hermes 占用），请稍后重试",
          },
        );
      }
      const wdb = writable.db;
      const errors: string[] = [];
      let archived = 0;
      try {
        const tableError = ensureArchiveTable(wdb);
        if (tableError !== null) {
          return fail("E403", `cannot create archive table: ${tableError}`, {
            startedAt,
            userHint: "记忆库不可写，无法创建归档表",
          });
        }
        const insert = wdb.prepare(
          `INSERT OR IGNORE INTO ${ARCHIVE_TABLE} (fact_id, archived_at, reason, archived_by) VALUES (?, ?, 'cold', 'butler')`,
        );
        wdb.exec("BEGIN");
        for (const candidate of candidates) {
          try {
            const result = insert.run(candidate.factId, sqliteTimestamp(now()));
            if (Number(result.changes ?? 0) > 0) archived += 1;
          } catch (error) {
            errors.push(
              `fact_id=${candidate.factId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        wdb.exec("COMMIT");
      } catch (error) {
        try {
          wdb.exec("ROLLBACK");
        } catch {
          // 忽略回滚失败
        }
        return fail("E403", "failed to archive cold memory", {
          startedAt,
          cause: error,
          userHint: "归档失败；请确认记忆库可写（Hermes 占用时稍后重试）",
        });
      } finally {
        wdb.close();
      }
      return ok({ archived, freedBytes, dryRun: false, errors }, startedAt);
    },

    async restoreCold(scope: DriverScope, policy: RestorePolicy): Promise<Result<RestoreReport>> {
      const startedAt = Date.now();
      const writable = openWritableDb(scope, openWritable);
      if (writable.db === undefined) {
        return fail(
          "E403",
          `cannot open Hermes memory database for writing: ${writable.error ?? writable.path}`,
          {
            startedAt,
            userHint: "记忆库当前不可写（可能被 Hermes 占用），请稍后重试",
          },
        );
      }
      const wdb = writable.db;
      try {
        const tableError = ensureArchiveTable(wdb);
        if (tableError !== null) {
          return fail("E403", `cannot open archive table: ${tableError}`, {
            startedAt,
            userHint: "记忆库不可写，无法恢复归档记忆",
          });
        }
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (policy.entryIds !== undefined) {
          const ids = policy.entryIds.map(Number).filter(Number.isInteger);
          if (ids.length === 0) {
            return fail("E002", "entryIds must be a non-empty list of fact ids", {
              startedAt,
              userHint: "请选择要恢复的记忆条目",
            });
          }
          conditions.push(`fact_id IN (${placeholderList(ids.length)})`);
          params.push(...ids);
        }
        if (policy.olderThan !== undefined) {
          const parsed = Date.parse(policy.olderThan);
          if (!Number.isFinite(parsed)) {
            return fail("E002", `invalid restore cutoff time: ${policy.olderThan}`, {
              startedAt,
              userHint: "恢复时间必须是有效的 ISO-8601 时间",
            });
          }
          conditions.push("archived_at < ?");
          params.push(sqliteTimestamp(parsed));
        }
        const sql = `DELETE FROM ${ARCHIVE_TABLE}${
          conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
        }`;
        const result = wdb.prepare(sql).run(...params);
        return ok({ restored: Number(result.changes ?? 0), errors: [] }, startedAt);
      } catch (error) {
        return fail("E403", "failed to restore archived memory", {
          startedAt,
          cause: error,
          userHint: "恢复失败；请稍后重试",
        });
      } finally {
        wdb.close();
      }
    },

    async purge(scope: DriverScope, policy: PurgePolicy): Promise<Result<PurgeReport>> {
      const startedAt = Date.now();
      if (policy.confirmed !== true) {
        return fail("E002", "purge requires confirmed: true", {
          startedAt,
          userHint: "物理删除记忆不可撤销，需要先确认影响范围",
        });
      }
      const kind = policy.kind ?? "archived";
      const writable = openWritableDb(scope, openWritable);
      if (writable.db === undefined) {
        return fail(
          "E403",
          `cannot open Hermes memory database for writing: ${writable.error ?? writable.path}`,
          {
            startedAt,
            userHint: "记忆库当前不可写（可能被 Hermes 占用），请稍后重试",
          },
        );
      }
      const wdb = writable.db;
      try {
        const missing = ensureSchema(wdb);
        if (missing !== null) {
          return fail("E402", `Hermes memory schema missing: ${missing}`, {
            startedAt,
            userHint: `记忆库缺少 ${missing}，暂不支持清理`,
          });
        }
        const conditions: string[] = [];
        const params: unknown[] = [];
        let from = "facts f";
        if (kind === "archived") {
          const tableError = ensureArchiveTable(wdb);
          if (tableError !== null) {
            return fail("E403", `cannot open archive table: ${tableError}`, {
              startedAt,
              userHint: "记忆库不可写，无法清理归档记忆",
            });
          }
          conditions.push("a.fact_id = f.fact_id");
          from = `facts f JOIN ${ARCHIVE_TABLE} a ON a.fact_id = f.fact_id`;
          if (policy.entryIds !== undefined) {
            const ids = policy.entryIds.map(Number).filter(Number.isInteger);
            if (ids.length === 0) {
              return fail("E002", "entryIds must be a non-empty list of fact ids", {
                startedAt,
                userHint: "请选择要清理的记忆条目",
              });
            }
            conditions.push(`f.fact_id IN (${placeholderList(ids.length)})`);
            params.push(...ids);
          } else {
            const cutoff =
              policy.archivedBefore !== undefined
                ? Date.parse(policy.archivedBefore)
                : now() - ARCHIVE_RETENTION_MS;
            if (!Number.isFinite(cutoff)) {
              return fail("E002", `invalid archivedBefore time: ${policy.archivedBefore}`, {
                startedAt,
                userHint: "归档清理时间必须是有效的 ISO-8601 时间",
              });
            }
            conditions.push("a.archived_at < ?");
            params.push(sqliteTimestamp(cutoff));
          }
        } else {
          conditions.push("f.category = ?");
          params.push(PROBE_CATEGORY);
          if (policy.entryIds !== undefined) {
            const ids = policy.entryIds.map(Number).filter(Number.isInteger);
            if (ids.length === 0) {
              return fail("E002", "entryIds must be a non-empty list of fact ids", {
                startedAt,
                userHint: "请选择要清理的测试记忆",
              });
            }
            conditions.push(`f.fact_id IN (${placeholderList(ids.length)})`);
            params.push(...ids);
          } else {
            conditions.push("f.created_at < ?");
            params.push(sqliteTimestamp(now() - PROBE_RETENTION_MS));
          }
        }
        const rows = wdb
          .prepare(
            `SELECT f.fact_id AS fact_id, f.content AS content, f.tags AS tags FROM ${from} WHERE ${conditions.join(" AND ")}`,
          )
          .all(...params)
          .filter(isRecord);
        const targets = rows.map((row) => ({
          factId: numberValue(row["fact_id"]),
          content: String(row["content"] ?? ""),
          tags: String(row["tags"] ?? ""),
        }));
        const errors: string[] = [];
        let purged = 0;
        let freedBytes = 0;
        const deleteFts = wdb.prepare(
          "DELETE FROM facts_fts WHERE rowid = ?",
        );
        const deleteFact = wdb.prepare("DELETE FROM facts WHERE fact_id = ?");
        const deleteArchive =
          kind === "archived"
            ? wdb.prepare(`DELETE FROM ${ARCHIVE_TABLE} WHERE fact_id = ?`)
            : undefined;
        wdb.exec("BEGIN");
        for (const target of targets) {
          try {
            deleteFts.run(target.factId);
            deleteFact.run(target.factId);
            if (kind === "archived") deleteArchive!.run(target.factId);
            purged += 1;
            freedBytes += Buffer.byteLength(target.content);
          } catch (error) {
            errors.push(
              `fact_id=${target.factId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        wdb.exec("COMMIT");
        return ok({ purged, freedBytes, errors }, startedAt);
      } catch (error) {
        try {
          wdb.exec("ROLLBACK");
        } catch {
          // 忽略回滚失败
        }
        return fail("E403", "failed to purge memory", {
          startedAt,
          cause: error,
          userHint: "清理失败；请确认记忆库可写（Hermes 占用时稍后重试）",
        });
      } finally {
        wdb.close();
      }
    },

    async rebuildIndex(scope: DriverScope): Promise<Result<RebuildIndexReport>> {
      const startedAt = Date.now();
      const opened = openDb(scope, open);
      if (opened.db === undefined) {
        return fail("E402", `cannot open Hermes memory database: ${opened.error ?? opened.path}`, {
          startedAt,
          userHint: "记忆库不可读，无法重建全文索引",
        });
      }
      const db = opened.db;
      try {
        const missing = ensureSchema(db);
        if (missing !== null) {
          return fail("E402", `Hermes memory schema missing: ${missing}`, {
            startedAt,
            userHint: `记忆库缺少 ${missing}，暂不支持重建索引`,
          });
        }
        const beforeRow = db.prepare("SELECT COUNT(*) AS count FROM facts_fts").get();
        const rowsBefore = isRecord(beforeRow) ? numberValue(beforeRow["count"]) : 0;
        const writable = openWritableDb(scope, openWritable);
        if (writable.db === undefined) {
          return fail(
            "E403",
            `cannot open Hermes memory database for writing: ${writable.error ?? writable.path}`,
            {
              startedAt,
              userHint: "记忆库当前不可写（可能被 Hermes 占用），请稍后重试",
            },
          );
        }
        const wdb = writable.db;
        const errors: string[] = [];
        let rowsAfter = rowsBefore;
        try {
          wdb.exec("DELETE FROM facts_fts");
          wdb.exec(
            "INSERT INTO facts_fts(rowid, content, tags) SELECT fact_id, content, COALESCE(tags, '') FROM facts",
          );
          const afterRow = wdb.prepare("SELECT COUNT(*) AS count FROM facts_fts").get();
          rowsAfter = isRecord(afterRow) ? numberValue(afterRow["count"]) : rowsBefore;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          return fail("E403", "failed to rebuild Hermes memory FTS index", {
            startedAt,
            cause: error,
            userHint: "索引重建失败；请确认记忆库可写（Hermes 占用时稍后重试）",
          });
        } finally {
          wdb.close();
        }
        return ok(
          { rebuilt: true, rowsBefore, rowsAfter, errors },
          startedAt,
        );
      } catch (error) {
        return fail("E402", "failed to rebuild Hermes memory FTS index", {
          startedAt,
          cause: error,
          userHint: "索引重建失败；请稍后重试或查看管家日志",
        });
      } finally {
        db.close();
      }
    },
  };
}
