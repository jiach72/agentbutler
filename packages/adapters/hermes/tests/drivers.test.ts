import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_PREVIEW_LIMIT } from "@butler/contract";
import {
  createHermesMemoryDriver,
  createHermesPluginDriver,
  createHermesSkillDriver,
} from "../src/index.js";

let root: string;

function scope() {
  return {
    instance: { instanceId: "hermes-main", rootPath: root, runtime: "process" as const },
    rootPath: root,
  };
}

function writeSkill(relativeDir: string, body: string): void {
  const dir = join(root, "skills", relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
}

function createMemoryFixture(): void {
  const db = new DatabaseSync(join(root, "memory_store.db"));
  db.exec(`
    CREATE TABLE facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL UNIQUE,
      category TEXT DEFAULT 'general',
      tags TEXT DEFAULT '',
      trust_score REAL DEFAULT 0.5,
      retrieval_count INTEGER DEFAULT 0,
      helpful_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      hrr_vector BLOB
    );
    CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, tokenize='trigram');
  `);
  const insertFact = db.prepare(
    "INSERT INTO facts (content, category, tags, retrieval_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO facts_fts(rowid, content, tags) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let index = 0; index < 55; index += 1) {
    const content = `alpha memory ${index}`;
    const createdAt = index === 0 ? "2026-01-01 00:00:00" : "2026-08-20 10:00:00";
    const result = insertFact.run(
      content,
      "general",
      "channel:web",
      index === 0 ? 0 : 2,
      createdAt,
      createdAt,
    );
    insertFts.run(result.lastInsertRowid, content, "channel:web");
  }
  insertFact.run(
    "butler-probe:fixture",
    "butler-probe",
    "1787280429203",
    0,
    "2026-08-21 02:47:09",
    "2026-08-21 02:47:09",
  );
  db.exec("COMMIT");
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermes-drivers-"));
  mkdirSync(join(root, "skills"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hermes-skill read-only driver", () => {
  it("枚举并解析 SKILL.md 清单，识别内置来源、版本与停用标记", async () => {
    writeFileSync(join(root, "skills", ".bundled_manifest"), "arxiv:abcdef1234567890\n", "utf8");
    writeSkill(
      "research/arxiv",
      [
        "---",
        "name: arxiv",
        "description: Search research papers.",
        "category: research",
        "version: 2.1.0",
        "---",
        "",
        "# Arxiv",
      ].join("\n"),
    );
    writeSkill(
      "custom/reviewer",
      [
        "---",
        "name: reviewer",
        "description: Review local documents.",
        "category: custom",
        "source: self-evolved",
        "version: 0.3.0",
        "---",
        "",
        "# Reviewer",
      ].join("\n"),
    );
    writeFileSync(join(root, "skills", "custom", "reviewer", ".disabled"), "", "utf8");

    const driver = createHermesSkillDriver();
    const listed = await driver.enumerate(scope());

    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual([
      {
        ref: { name: "arxiv", version: "2.1.0", source: "builtin" },
        name: "arxiv",
        version: "2.1.0",
        source: "builtin",
        enabled: true,
        category: "research",
        description: "Search research papers.",
      },
      {
        ref: { name: "reviewer", version: "0.3.0", source: "self-evolved" },
        name: "reviewer",
        version: "0.3.0",
        source: "self-evolved",
        enabled: false,
        category: "custom",
        description: "Review local documents.",
      },
    ]);

    const parsedBuiltin = await driver.parse({ name: "arxiv" });
    expect(parsedBuiltin.data).toMatchObject({ version: "2.1.0", source: "builtin" });

    const parsed = await driver.parse({ name: "reviewer" });
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toMatchObject({
      name: "reviewer",
      version: "0.3.0",
      source: "self-evolved",
      description: "Review local documents.",
    });
    expect(parsed.data?.raw).toContain("# Reviewer");
  });

  it("缺少 category 时保留未分类事实，不按名称或目录猜测", async () => {
    writeSkill(
      "data-science",
      ["---", "name: data-science", "version: 1.0.0", "---", "", "# Data"].join("\n"),
    );
    writeSkill(
      "wechat-article-search",
      ["---", "name: wechat-article-search", "version: 1.0.0", "---", "", "# Wechat"].join("\n"),
    );
    writeSkill(
      "random-misc",
      ["---", "name: random-misc", "version: 1.0.0", "---", "", "# Misc"].join("\n"),
    );
    const driver = createHermesSkillDriver();
    const listed = await driver.enumerate(scope());
    expect(listed.ok).toBe(true);
    const byName = new Map((listed.data ?? []).map((item) => [item.name, item.category]));
    expect(byName.get("data-science")).toBeUndefined();
    expect(byName.get("wechat-article-search")).toBeUndefined();
    expect(byName.get("random-misc")).toBeUndefined();
  });

  it("写操作固定返回 E403，只读校验报告不修改文件", async () => {
    const driver = createHermesSkillDriver();
    const setEnabled = await driver.setEnabled({ name: "x" }, false);
    const rollback = await driver.rollbackVersion({ name: "x" }, "1.0.0");
    const validation = await driver.validate({
      ref: { name: "x" },
      name: "x",
      version: "未声明",
      source: "user",
    });

    expect(setEnabled.error?.code).toBe("E403");
    expect(rollback.error?.code).toBe("E403");
    expect(validation).toMatchObject({ ok: true, data: { valid: true, issues: [] } });
  });
});

describe("hermes-plugin read-only driver", () => {
  function writePlugin(relativeDir: string, files: Record<string, string>): void {
    const dir = join(root, "plugins", relativeDir);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, "utf8");
    }
  }

  it("枚举插件目录并解析元数据、分类与停用标记", async () => {
    writePlugin("platforms/telegram", {
      "plugin.yaml": [
        "name: telegram",
        "version: 3.1.0",
        "category: 平台通道",
        "description: Telegram 社区插件",
        "source: market",
      ].join("\n"),
    });
    writePlugin("a2a/server", {
      "manifest.json": JSON.stringify({
        name: "a2a-server",
        version: "0.4.0",
        category: "A2A 协议",
      }),
    });
    writePlugin("skills/reader", {
      "SKILL.md": "---\nname: reader\nversion: 1.0.0\n分类: 技能扩展\n---\n\n# Reader",
    });
    writePlugin("legacy/old-plugin", {
      "__init__.py": "PLUGIN_META = {\"name\": \"old-plugin\", \"version\": \"0.1.0\"}",
      ".disabled": "",
    });
    writePlugin("nested/deep/leaf", {
      "package.json": JSON.stringify({ name: "leaf", version: "2.0.0" }),
    });

    const driver = createHermesPluginDriver();
    const listed = await driver.enumerate(scope());

    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual([
      {
        ref: { name: "a2a-server", version: "0.4.0", source: "user" },
        name: "a2a-server",
        version: "0.4.0",
        source: "user",
        enabled: true,
        category: "A2A 协议",
      },
      {
        ref: { name: "leaf", version: "2.0.0", source: "user" },
        name: "leaf",
        version: "2.0.0",
        source: "user",
        enabled: true,
        category: "nested",
      },
      {
        ref: { name: "old-plugin", version: "0.1.0", source: "user" },
        name: "old-plugin",
        version: "0.1.0",
        source: "user",
        enabled: false,
        category: "legacy",
      },
      {
        ref: { name: "reader", version: "1.0.0", source: "user" },
        name: "reader",
        version: "1.0.0",
        source: "user",
        enabled: true,
        category: "技能扩展",
      },
      {
        ref: { name: "telegram", version: "3.1.0", source: "market" },
        name: "telegram",
        version: "3.1.0",
        source: "market",
        enabled: true,
        category: "平台通道",
        description: "Telegram 社区插件",
      },
    ]);
  });

  it("插件目录不存在时返回 E402", async () => {
    const driver = createHermesPluginDriver();
    const listed = await driver.enumerate(scope());
    expect(listed.error?.code).toBe("E402");
  });
});

describe("sqlite-fts5 read-only memory driver", () => {
  it("统计按月分布、90 天冷候选与最近写入，并排除 butler-probe", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const result = await driver.stats(scope());

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      totalEntries: 55,
      byMonth: [
        { month: "2026-01", count: 1 },
        { month: "2026-08", count: 54 },
      ],
      coldCandidates: 1,
      lastWriteAt: "2026-08-20T10:00:00.000Z",
      archivedEntries: 0,
      probeEntries: 1,
      recalledEntries: 54,
      cumulativeRecalls: 108,
      probeWriteAttempts: 0,
      probeWriteFailures: 0,
      probeRecallAttempts: 0,
      probeRecallHits: 0,
    });
  });

  it("FTS 检索硬钳制到 50 条，并拒绝无效时间过滤", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const preview = await driver.preview(scope(), { keyword: "alpha", limit: 999 });
    expect(preview.ok).toBe(true);
    expect(preview.data).toHaveLength(MEMORY_PREVIEW_LIMIT);
    expect(preview.data?.every((entry) => entry.content.includes("alpha"))).toBe(true);
    expect(preview.data?.[0]).toMatchObject({ channel: "web", cold: false });

    const invalid = await driver.preview(scope(), { since: "not-a-date" });
    expect(invalid.error?.code).toBe("E002");
  });

  it("健康分析给出评分、信号与归档建议", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const result = await driver.analyze(scope());

    expect(result.ok).toBe(true);
    expect(result.data?.score).toBeGreaterThanOrEqual(0);
    expect(result.data?.score).toBeLessThanOrEqual(100);
    expect(result.data?.signals.some((signal) => signal.id === "write-activity")).toBe(true);
    expect(result.data?.signals.some((signal) => signal.id === "write-reliability")).toBe(true);
    expect(result.data?.signals.some((signal) => signal.id === "recall-hit-rate")).toBe(true);
    expect(result.data?.signals.some((signal) => signal.id === "recall-coverage")).toBe(true);
    expect(
      result.data?.suggestions.some(
        (item) => item.action === "archive-cold" && item.kind === "archive",
      ),
    ).toBe(true);
  });

  it("健康评分统计管家探针历史：写入失败率与召回命中率进入信号并扣分", async () => {
    createMemoryFixture();
    const db = new DatabaseSync(join(root, "memory_store.db"));
    db.exec(`
      CREATE TABLE butler_memory_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO butler_memory_ops (kind, ok, detail) VALUES
        ('probe-write', 1, 'ok'),
        ('probe-write', 1, 'ok'),
        ('probe-write', 0, 'write boom'),
        ('probe-recall', 1, 'ok'),
        ('probe-recall', 1, 'ok'),
        ('probe-recall', 0, 'fts miss');
    `);
    db.close();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const result = await driver.analyze(scope());
    expect(result.ok).toBe(true);
    const stats = await driver.stats(scope());
    expect(stats.data).toMatchObject({
      probeWriteAttempts: 3,
      probeWriteFailures: 1,
      probeRecallAttempts: 3,
      probeRecallHits: 2,
    });
    const writeSignal = result.data?.signals.find((signal) => signal.id === "write-reliability");
    expect(writeSignal?.status).toBe("error");
    expect(writeSignal?.detail).toContain("失败 1 次");
    const recallSignal = result.data?.signals.find((signal) => signal.id === "recall-hit-rate");
    expect(recallSignal?.status).toBe("error");
    expect(recallSignal?.detail).toContain("命中 2 次");
    expect(result.data?.score).toBeLessThan(100);
  });

  it("冷存归档：dryRun 只统计，真实归档后进入归档表", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const dry = await driver.archiveCold(scope(), { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.data).toEqual({ archived: 1, freedBytes: 14, dryRun: true, errors: [] });

    const real = await driver.archiveCold(scope(), {});
    expect(real.ok).toBe(true);
    expect(real.data).toMatchObject({ archived: 1, dryRun: false, errors: [] });

    const stats = await driver.stats(scope());
    expect(stats.data?.archivedEntries).toBe(1);
    expect(stats.data?.coldCandidates).toBe(0);

    const again = await driver.archiveCold(scope(), { dryRun: true });
    expect(again.data?.archived).toBe(0);
  });

  it("恢复归档：30 天内可一键恢复", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });
    await driver.archiveCold(scope(), {});

    const restored = await driver.restoreCold(scope(), {});

    expect(restored.ok).toBe(true);
    expect(restored.data).toEqual({ restored: 1, errors: [] });
    const stats = await driver.stats(scope());
    expect(stats.data?.archivedEntries).toBe(0);
    expect(stats.data?.coldCandidates).toBe(1);
  });

  it("物理删除：未确认拒绝，确认后删除归档条目并同步 FTS", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });
    await driver.archiveCold(scope(), {});

    const rejected = await driver.purge(scope(), { confirmed: false });
    expect(rejected.error?.code).toBe("E002");

    const retained = await driver.purge(scope(), { confirmed: true, kind: "archived" });
    expect(retained.data?.purged).toBe(0);

    const purged = await driver.purge(scope(), {
      confirmed: true,
      kind: "archived",
      archivedBefore: "2026-08-21T13:00:00Z",
    });
    expect(purged.ok).toBe(true);
    expect(purged.data?.purged).toBe(1);

    const stats = await driver.stats(scope());
    expect(stats.data?.totalEntries).toBe(54);
    const integrity = await driver.verifyIntegrity(scope());
    expect(integrity.data?.healthy).toBe(true);
  });

  it("清理过期探针测试记忆", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-22T12:00:00Z") });

    const purged = await driver.purge(scope(), { confirmed: true, kind: "probes" });

    expect(purged.ok).toBe(true);
    expect(purged.data?.purged).toBe(1);
    const stats = await driver.stats(scope());
    expect(stats.data?.probeEntries).toBe(0);
  });

  it("重建 FTS 索引：删除索引行后 rebuild 恢复一致", async () => {
    createMemoryFixture();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T12:00:00Z") });

    const db = new DatabaseSync(join(root, "memory_store.db"));
    db.prepare("DELETE FROM facts_fts WHERE rowid = 1").run();
    db.close();

    const before = await driver.analyze(scope());
    expect(before.data?.signals.some((signal) => signal.id === "fts-index" && signal.status === "warn")).toBe(true);

    const rebuilt = await driver.rebuildIndex(scope());
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.data?.rebuilt).toBe(true);

    const after = await driver.analyze(scope());
    expect(after.data?.signals.some((signal) => signal.id === "fts-index" && signal.status === "ok")).toBe(true);
  });
});
