/**
 * memory-probe 测试：fixture 建真实 FTS5 表（node:sqlite 支持），
 * 覆盖写入召回全流程 / 24h 清理 / FTS 查询失败 / schema 缺失 / 库打不开 / 库缺失。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryProbeStage,
  MEMORY_PROBE_CATEGORY,
  MEMORY_PROBE_PREFIX,
  type SqliteDbLike,
} from "../src/probes/memory-probe.js";
import type { InspectionContext } from "../src/pipeline.js";

let tmp: string;
/** 固定基准时刻（注入时钟）。 */
const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-memprobe-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxOf(root = tmp): InspectionContext {
  return { instanceId: "hermes-main", frameworkId: "hermes", rootPath: root, runtime: "process", shared: {} };
}

/** 建真实 FTS5 fixture 库：镜像真实库 facts + facts_fts（外容 + trigram）+ 同步触发器。 */
function createFactsDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL UNIQUE,
      category TEXT DEFAULT 'general',
      tags TEXT DEFAULT '',
      trust_score REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id, tokenize='trigram');
    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, tags) VALUES (new.fact_id, new.content, new.tags);
    END;
    CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES ('delete', old.fact_id, old.content, old.tags);
    END;
  `);
  db.close();
}

/** 探针运行后连接已关闭，直接打开校验内容（tmp 库无锁竞争）。 */
function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

describe("memory-probe（记忆写入召回）", () => {
  it("真实 FTS5 fixture：写入 → 召回全流程 pass，测试行带探针标记", async () => {
    createFactsDb(join(tmp, "memory_store.db"));
    const stage = createMemoryProbeStage({ now: () => NOW });
    const result = await stage.run(ctxOf());

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("写入并召回成功");
    expect(result.detail).toContain(MEMORY_PROBE_PREFIX);

    const db = openDb(join(tmp, "memory_store.db"));
    const rows = db.prepare("SELECT content, category FROM facts ORDER BY fact_id").all() as Array<{
      content: string;
      category: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe(MEMORY_PROBE_CATEGORY);
    expect(rows[0]!.content.startsWith(MEMORY_PROBE_PREFIX)).toBe(true);
    const ops = db
      .prepare("SELECT kind, ok FROM butler_memory_ops ORDER BY id")
      .all() as Array<{ kind: string; ok: number }>;
    expect(ops).toEqual([
      { kind: "probe-write", ok: 1 },
      { kind: "probe-recall", ok: 1 },
    ]);
    db.close();
  });

  it("removeOwn=true：召回通过后立即删除本次测试行（FTS 同步），用户行保留", async () => {
    const dbPath = join(tmp, "memory_store.db");
    createFactsDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO facts (content, category, tags) VALUES (?, ?, ?)").run(
      "用户记忆：保留",
      "general",
      "",
    );
    db.close();

    const result = await createMemoryProbeStage({ now: () => NOW, removeOwn: true }).run(ctxOf());
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("本次测试行已清理");

    const reader = openDb(dbPath);
    const rows = reader.prepare("SELECT content, category FROM facts ORDER BY fact_id").all() as Array<{
      content: string;
      category: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: "用户记忆：保留", category: "general" });
    const probeRow = reader.prepare("SELECT COUNT(*) AS c FROM facts WHERE category = ?").get(MEMORY_PROBE_CATEGORY) as {
      c: number;
    };
    expect(probeRow.c).toBe(0);
    reader.close();
  });

  it("24h 清理：旧探针行被删（含 FTS 索引），用户记忆与新鲜探针行保留", async () => {
    const dbPath = join(tmp, "memory_store.db");
    createFactsDb(dbPath);
    const db = new DatabaseSync(dbPath);
    const OLD = NOW - 25 * 60 * 60 * 1000; // 25h 前 > 24h 保留窗口
    db.prepare("INSERT INTO facts (content, category, tags) VALUES (?, ?, ?)").run(
      "butler-probe:old-uuid 旧测试行",
      MEMORY_PROBE_CATEGORY,
      String(OLD),
    );
    db.prepare("INSERT INTO facts (content, category, tags) VALUES (?, ?, ?)").run(
      "用户记忆：今天天气不错",
      "general",
      "",
    );
    db.close();

    const result = await createMemoryProbeStage({ now: () => NOW }).run(ctxOf());
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("清理 1 条");

    const reader = openDb(dbPath);
    const rows = reader.prepare("SELECT content, category FROM facts ORDER BY fact_id").all() as Array<{
      content: string;
      category: string;
    }>;
    // 旧探针行已删；用户行保留；本次探针新写入一行。
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ content: "用户记忆：今天天气不错", category: "general" });
    expect(rows[1]!.category).toBe(MEMORY_PROBE_CATEGORY);
    // FTS 索引同步删除：旧标记词召回 0 行。
    const oldHits = reader
      .prepare('SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? LIMIT 1')
      .all('"butler-probe:old-uuid"');
    expect(oldHits).toHaveLength(0);
    reader.close();
  });

  it("FTS 召回查询失败 → fail（detail 含错误）", async () => {
    writeFileSync(join(tmp, "memory_store.db"), "");
    const fakeDb: SqliteDbLike = {
      prepare(sql: string) {
        if (sql.includes("sqlite_master")) {
          return { all: () => [{ name: "facts" }, { name: "facts_fts" }], run: () => ({ changes: 0 }) };
        }
        if (sql.includes("DELETE") || sql.includes("INSERT")) {
          return { run: () => ({ changes: 0 }), all: () => [] };
        }
        throw new Error("fts match boom");
      },
      close: () => {},
    };
    const result = await createMemoryProbeStage({ open: () => fakeDb, now: () => NOW }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("FTS 召回查询失败");
    expect(result.detail).toContain("fts match boom");
  });

  it("schema 缺失（无 FTS 虚表）→ skipped 降级明示", async () => {
    const dbPath = join(tmp, "memory_store.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE facts (fact_id INTEGER PRIMARY KEY, content TEXT)");
    db.close();

    const result = await createMemoryProbeStage({ now: () => NOW }).run(ctxOf());
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("schema 不匹配");
    expect(result.detail).toContain("facts_fts");
  });

  it("库打不开（锁死/只读）→ fail", async () => {
    writeFileSync(join(tmp, "memory_store.db"), "");
    const result = await createMemoryProbeStage({
      open: () => {
        throw new Error("SQLITE_CANTOPEN: unable to open database file");
      },
      now: () => NOW,
    }).run(ctxOf());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("DB 打不开");
    expect(result.detail).toContain("SQLITE_CANTOPEN");
  });

  it("memory_store.db 不存在 → skipped 无对象", async () => {
    const result = await createMemoryProbeStage({ now: () => NOW }).run(ctxOf());
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("不存在");
  });
});
