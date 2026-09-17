import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSafeDbSnapshot } from "../src/state-db-snapshot.js";

describe("withSafeDbSnapshot", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "butler-snap-test-"));
    dbPath = join(tmp, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);");
    db.exec("INSERT INTO items (name) VALUES ('alpha'), ('beta');");
    db.close();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("通过隔离快照读取数据并返回正确结果", () => {
    let openedPath = "";
    const results = withSafeDbSnapshot(dbPath, (db) => {
      // 检查当前打开的文件路径不是原始路径（已被隔离在临时目录）
      const row = db.prepare("PRAGMA database_list").get() as { file?: string };
      openedPath = row.file ?? "";
      const rows = db.prepare("SELECT name FROM items ORDER BY id").all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    });

    expect(results).toEqual(["alpha", "beta"]);
    expect(openedPath).not.toBe(dbPath);
    expect(openedPath).toContain("butler-state-snap-");
    expect(existsSync(openedPath)).toBe(false); // 回调退出后临时文件已清理
  });

  it("WAL 中的未 checkpoint 数据可通过快照读取", () => {
    // 写入新数据但显式保持在 WAL 中
    const writer = new DatabaseSync(dbPath);
    writer.exec("INSERT INTO items (name) VALUES ('gamma');");
    // 不调用 wal_checkpoint，直接保留 writer
    const results = withSafeDbSnapshot(dbPath, (db) => {
      const rows = db.prepare("SELECT name FROM items ORDER BY id").all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    });
    writer.close();

    expect(results).toContain("gamma");
  });

  it("当 enabled=false 时直接读取原始数据库路径", () => {
    let openedPath = "";
    const results = withSafeDbSnapshot(
      dbPath,
      (db) => {
        const row = db.prepare("PRAGMA database_list").get() as { file?: string };
        openedPath = row.file ?? "";
        return 42;
      },
      { enabled: false },
    );

    expect(results).toBe(42);
    expect(openedPath).toBe(dbPath);
  });

  it("数据库文件不存在时抛出明确异常", () => {
    const nonexistent = join(tmp, "nonexistent.db");
    expect(() => withSafeDbSnapshot(nonexistent, () => 1)).toThrow("Database file not found");
  });
});
