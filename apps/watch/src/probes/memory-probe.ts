/**
 * 记忆写入召回探针（memory-probe，Task 6.1）。
 *
 * 真实库勘察结论（2026-08-20，只读打开 ~/.hermes/memory_store.db 查 sqlite_master）：
 * - 内容表 `facts(fact_id INTEGER PK AUTOINCREMENT, content TEXT NOT NULL UNIQUE,
 *   category TEXT DEFAULT 'general', tags TEXT DEFAULT '', trust_score REAL,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ...)`；
 * - FTS5 外容虚表 `facts_fts USING fts5(content, tags, content=facts,
 *   content_rowid=fact_id, tokenize='trigram')`（trigram 分词，短语查询需 >= 3 字符）；
 * - 触发器 `facts_ai` / `facts_au` / `facts_ad` 自动维护 FTS 索引——
 *   探针只需 INSERT/DELETE facts，FTS 随之同步（含删除同步）。
 *
 * 流程：24h 旧测试行清理 → 写入带标记测试记忆（butler-probe:<uuid>，category
 * 固定 "butler-probe"，tags 存写入时刻 epoch ms 供清理判定）→ FTS MATCH 召回
 * 校验 → pass。任一步失败 → fail（detail 含错误）。
 * schema 不匹配（内容表/FTS 表缺失）或库文件不存在 → skipped（降级明示，不误报故障）。
 * 全部 SQLite 操作经可注入 opener，测试用临时 fixture 库建真实 FTS5 表。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InspectionContext, InspectionStage } from "../pipeline.js";

/** 探针标记前缀：测试记忆 content 以此开头，绝不混入用户记忆。 */
export const MEMORY_PROBE_PREFIX = "butler-probe:";
/** 探针测试记忆的 category 值（清理时按此列识别）。 */
export const MEMORY_PROBE_CATEGORY = "butler-probe";
export const MEMORY_PROBE_CHECK_ID = "memory-probe";
/** 测试行保留窗口：超过 24h 的旧探针行每次运行前清理。 */
export const MEMORY_PROBE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 管家记忆探针健康统计表（memory 驱动 analyze 读取，计算写入失败率/召回命中率）。 */
export const MEMORY_OPS_TABLE = "butler_memory_ops";

/** node:sqlite 的最小面（测试可注入 fake；DatabaseSync 天然满足）。 */
export interface SqliteStatementLike {
  run(...args: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  all(...args: unknown[]): unknown[];
}

export interface SqliteDbLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

export type SqliteOpener = (path: string) => SqliteDbLike;

export type MemoryProbeStatus = "pass" | "warn" | "fail" | "skipped";

export interface MemoryProbeProviderOptions {
  now: () => number;
  removeOwn: boolean;
}

/**
 * 外部记忆系统适配点：provider 按 InspectionContext 自行选择用户/实例后端。
 * Butler 不假设外部后端的数据库 schema，也不直接写入用户记忆。
 */
export type MemoryProbeProvider = (
  ctx: InspectionContext,
  options: MemoryProbeProviderOptions,
) => MemoryProbeProviderResult | Promise<MemoryProbeProviderResult>;

export interface MemoryProbeProviderResult {
  status: MemoryProbeStatus;
  detail?: string;
}

/** 默认 opener：node:sqlite DatabaseSync 读写打开。 */
export function defaultSqliteOpener(): SqliteOpener {
  return (path) => new DatabaseSync(path) as unknown as SqliteDbLike;
}

export interface MemoryProbeDeps {
  /** SQLite 打开器（默认 node:sqlite 读写打开）。 */
  open?: SqliteOpener;
  /** 可选外部记忆系统 provider；收到 ctx 后可按实例/用户选择后端。 */
  provider?: MemoryProbeProvider;
  /** 可注入时钟（默认 Date.now）。 */
  now?: () => number;
  /** 召回通过后立即删除本次测试行（按需自检用；缺省保留供 24h 观察）。 */
  removeOwn?: boolean;
  /** 内容表名（默认真实 schema 的 "facts"）。 */
  contentTable?: string;
  /** FTS 虚表名（默认真实 schema 的 "facts_fts"）。 */
  ftsTable?: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 识别符防御性校验（表名默认常量，注入路径下拒绝非法字符）。 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`非法表名: ${name}`);
  }
  return name;
}

/**
 * 记录一次探针健康统计（kind: probe-write / probe-recall，ok: 1 成功 / 0 失败）。
 * 统计表由管家写入 Hermes 记忆库；任何失败都静默忽略，不影响探针结论。
 */
function recordProbeOp(
  db: SqliteDbLike,
  kind: "probe-write" | "probe-recall",
  ok: boolean,
  detail: string,
): void {
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${ident(MEMORY_OPS_TABLE)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    ).run();
    db.prepare(`INSERT INTO ${ident(MEMORY_OPS_TABLE)} (kind, ok, detail) VALUES (?, ?, ?)`).run(
      kind,
      ok ? 1 : 0,
      detail.slice(0, 500),
    );
  } catch {
    // 统计尽力而为：写失败不影响探针结论。
  }
}

export function createMemoryProbeStage(deps: MemoryProbeDeps = {}): InspectionStage {
  const open = deps.open ?? defaultSqliteOpener();
  const now = deps.now ?? Date.now;
  const contentTable = deps.contentTable ?? "facts";
  const ftsTable = deps.ftsTable ?? "facts_fts";
  const removeOwn = deps.removeOwn === true;
  return {
    id: MEMORY_PROBE_CHECK_ID,
    label: "记忆写入召回",
    async run(ctx) {
      if (deps.provider !== undefined) {
        try {
          const provided = await deps.provider(ctx, { now, removeOwn });
          return {
            id: MEMORY_PROBE_CHECK_ID,
            status: provided.status,
            detail: provided.detail ?? `provider=${ctx.instanceId}`,
          };
        } catch (error) {
          return {
            id: MEMORY_PROBE_CHECK_ID,
            status: "fail",
            detail: `记忆 provider 异常: ${describe(error)}`,
          };
        }
      }
      if (process.env["BUTLER_HERMES_READ_ONLY"] === "true") {
        return {
          id: MEMORY_PROBE_CHECK_ID,
          status: "skipped",
          detail: "Hermes 数据目录以只读方式挂载，跳过写入型记忆探针",
        };
      }
      const dbPath = join(ctx.rootPath, "memory_store.db");
      if (!existsSync(dbPath)) {
        return { id: MEMORY_PROBE_CHECK_ID, status: "skipped", detail: "memory_store.db 不存在，记忆探针无对象" };
      }
      let db: SqliteDbLike;
      try {
        db = open(dbPath);
      } catch (error) {
        return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `DB 打不开: ${describe(error)}` };
      }
      try {
        // schema 勘察：内容表与 FTS 虚表必须同时存在（FTS 虚表在 sqlite_master 中 type 同为 'table'）。
        const rows = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name?: unknown }>;
        const names = new Set(rows.map((r) => String(r["name"] ?? "")));
        const tContent = ident(contentTable);
        const tFts = ident(ftsTable);
        if (!names.has(tContent) || !names.has(tFts)) {
          const missing = [tContent, tFts].filter((n) => !names.has(n)).join(", ");
          return {
            id: MEMORY_PROBE_CHECK_ID,
            status: "skipped",
            detail: `schema 不匹配（缺少表 ${missing}），记忆探针降级跳过（默认 schema: facts + facts_fts）`,
          };
        }

        // 24h 自动清理：删除标记 category 且 tags（epoch ms）早于阈值的旧测试行。
        // 真实库的 facts_ad 触发器会同步删除 FTS 索引行，不进用户统计。
        const cutoff = now() - MEMORY_PROBE_RETENTION_MS;
        let cleaned = 0;
        try {
          const del = db
            .prepare(`DELETE FROM ${tContent} WHERE category = ? AND CAST(tags AS INTEGER) < ?`)
            .run(MEMORY_PROBE_CATEGORY, cutoff);
          cleaned = Number(del.changes ?? 0);
        } catch (error) {
          return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `旧测试行清理失败: ${describe(error)}` };
        }

        // 写入带标记测试记忆：content 含唯一标记词；category/tags 供识别与清理。
        const marker = `${MEMORY_PROBE_PREFIX}${randomUUID()}`;
        const writtenAt = now();
        try {
          db.prepare(`INSERT INTO ${tContent} (content, category, tags) VALUES (?, ?, ?)`).run(
            `${marker} 写入召回测试 ts=${writtenAt}`,
            MEMORY_PROBE_CATEGORY,
            String(writtenAt),
          );
          recordProbeOp(db, "probe-write", true, `marker=${marker}`);
        } catch (error) {
          recordProbeOp(db, "probe-write", false, describe(error));
          return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `测试记忆写入失败: ${describe(error)}` };
        }

        // FTS MATCH 召回校验：trigram 短语查询必须能召回刚写入的标记词。
        let recalled = 0;
        try {
          const found = db.prepare(`SELECT rowid FROM ${tFts} WHERE ${tFts} MATCH ? LIMIT 1`).all(`"${marker}"`);
          recalled = found.length;
          recordProbeOp(db, "probe-recall", recalled > 0, `marker=${marker}`);
        } catch (error) {
          recordProbeOp(db, "probe-recall", false, describe(error));
          return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `FTS 召回查询失败: ${describe(error)}` };
        }
        if (recalled === 0) {
          recordProbeOp(db, "probe-recall", false, "FTS MATCH 未召回刚写入的标记");
          return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `FTS 未能召回刚写入的标记 ${marker}（索引同步失效）` };
        }
        let ownCleaned = 0;
        if (removeOwn) {
          try {
            const del = db
              .prepare(`DELETE FROM ${tContent} WHERE content = ?`)
              .run(`${marker} 写入召回测试 ts=${writtenAt}`);
            ownCleaned = Number(del.changes ?? 0);
          } catch (error) {
            return { id: MEMORY_PROBE_CHECK_ID, status: "fail", detail: `本次测试行清理失败: ${describe(error)}` };
          }
        }
        return {
          id: MEMORY_PROBE_CHECK_ID,
          status: "pass",
          detail:
            `写入并召回成功（${marker}），清理 ${cleaned} 条 >24h 旧测试行` +
            (ownCleaned > 0 ? "，本次测试行已清理" : ""),
        };
      } finally {
        try {
          db.close();
        } catch {
          // 关闭失败不影响结论。
        }
      }
    },
  };
}
