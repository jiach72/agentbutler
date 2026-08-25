import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHermesMemoryDriver, createHermesSkillDriver } from "@butler/adapter-hermes";
import { createCore, type Core } from "@butler/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillsMemoryService } from "../src/skills.js";

let root: string;
let home: string;
let core: Core;

function registerServingInstance(): void {
  core.instances.createInstance({
    instanceId: "hermes-main",
    frameworkId: "hermes",
    rootPath: root,
    runtime: "process",
    confidence: 0.95,
  });
  core.instances.beginDiscover("hermes-main");
  core.instances.confirmInstance("hermes-main", "auto");
  core.instances.beginNegotiate("hermes-main");
  core.instances.markServing("hermes-main", 2, {
    effectiveLevel: 2,
    capabilities: {
      probe: "ok",
      control: "ok",
      messaging: "not-implemented",
      "skill-driver": "ok",
      "memory-driver": "ok",
      "config-driver": "ok",
    },
    anomalies: [],
  });
}

function createMemoryDb(valid = true): void {
  const db = new DatabaseSync(join(root, "memory_store.db"));
  if (valid) {
    db.exec(`
      CREATE TABLE facts (
        fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL UNIQUE,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '',
        retrieval_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, tokenize='trigram');
      INSERT INTO facts (content, tags, retrieval_count, created_at, updated_at)
      VALUES ('agent butler memory', 'channel:web', 1, '2026-08-21 06:00:00', '2026-08-21 06:00:00');
      INSERT INTO facts_fts(rowid, content, tags) VALUES (1, 'agent butler memory', 'channel:web');
    `);
  } else {
    db.exec("CREATE TABLE unsupported_payload (id INTEGER PRIMARY KEY, value TEXT)");
  }
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-skills-root-"));
  home = mkdtempSync(join(tmpdir(), "butler-skills-home-"));
  core = createCore({ home });
  registerServingInstance();
});

afterEach(() => {
  core.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("技能与记忆只读聚合服务", () => {
  it("经驱动返回技能清单、记忆统计、停写状态与最多 50 条预览", async () => {
    const skillDir = join(root, "skills", "agent-butler");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: agent-butler\ndescription: Manage local agents.\nversion: 1.0.0\n---\n",
      "utf8",
    );
    createMemoryDb();
    const service = createSkillsMemoryService({
      core,
      skillDriver: createHermesSkillDriver(),
      memoryDriver: createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T06:10:00Z") }),
      now: () => Date.parse("2026-08-21T06:10:00Z"),
      stallThresholdMin: 30,
    });

    const view = await service.status({ keyword: "agent", limit: 80 });

    expect(view.instance).toMatchObject({ instanceId: "hermes-main", state: "Serving" });
    expect(view.skills).toMatchObject({ mode: "driver", driverId: "hermes-skill", total: 1 });
    expect(view.skills.items[0]).toMatchObject({ name: "agent-butler", version: "1.0.0" });
    expect(view.memory).toMatchObject({
      mode: "driver",
      driverId: "sqlite-fts5",
      stats: { totalEntries: 1 },
      writeActivity: { status: "active" },
    });
    expect(view.memory.preview).toHaveLength(1);
    expect(view.memory.previewLimit).toBe(50);
    expect(view.skills.items[0]).toMatchObject({
      riskStatus: "unscanned",
      riskDetail: "尚未执行风险扫描",
    });
  });

  it("风险状态显式区分未扫描与解析失败资产", async () => {
    const baseDriver = createHermesSkillDriver();
    const service = createSkillsMemoryService({
      core,
      skillDriver: {
        ...baseDriver,
        enumerate: async () => ({
          ok: true as const,
          data: [
            {
              ref: { name: "broken-skill", version: "解析失败", source: "user" as const },
              name: "broken-skill",
              version: "解析失败",
              source: "user" as const,
              enabled: true,
            },
          ],
          durationMs: 0,
        }),
      },
    });

    const view = await service.status({});

    expect(view.skills.items[0]).toMatchObject({
      riskStatus: "blocked",
      riskDetail: "清单解析失败，暂不允许把它当作可信资产",
    });
  });

  it("驱动覆盖不到时降级为有界目录统计并明确只读/不可解析", async () => {
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "skills.json"), "[]", "utf8");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "legacy.mem"), "legacy", "utf8");
    createMemoryDb(false);
    const service = createSkillsMemoryService({
      core,
      skillDriver: createHermesSkillDriver(),
      memoryDriver: createHermesMemoryDriver(),
    });

    const view = await service.status({});

    expect(view.skills.mode).toBe("directory-fallback");
    expect(view.skills.directory).toMatchObject({ fileCount: 1, truncated: false });
    expect(view.skills.notice).toContain("暂不支持解析");
    expect(view.skills.notice).toContain("不支持写入");
    expect(view.memory.mode).toBe("directory-fallback");
    expect(view.memory.directory.fileCount).toBeGreaterThanOrEqual(2);
    expect(view.memory.notice).toContain("目录统计");
    expect(view.memory.preview).toEqual([]);
  });

  it("无实例时返回可渲染的 unavailable 载荷", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "butler-skills-empty-"));
    const isolatedCore = createCore({ home: isolatedHome });
    try {
      const view = await createSkillsMemoryService({
        core: isolatedCore,
        skillDriver: createHermesSkillDriver(),
        memoryDriver: createHermesMemoryDriver(),
      }).status({});
      expect(view).toMatchObject({
        instance: null,
        skills: { mode: "unavailable", total: 0 },
        memory: { mode: "unavailable", stats: null, preview: [] },
      });
    } finally {
      isolatedCore.close();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
  it("exportEncrypted 加密导出记忆库；口令过短或库缺失时给出可读错误", async () => {
    createMemoryDb();
    const service = createSkillsMemoryService({
      core,
      skillDriver: createHermesSkillDriver(),
      memoryDriver: createHermesMemoryDriver(),
    });

    const tooShort = await service.exportEncrypted({}, "short");
    expect(tooShort).toMatchObject({
      ok: false,
      instanceId: "hermes-main",
      code: "passphrase-too-short",
    });

    const exported = await service.exportEncrypted({}, "secret-pass-123");
    expect(exported.ok).toBe(true);
    if (!exported.ok || exported.data === undefined) return;
    expect(exported.filename).toMatch(/\.abmem$/);
    const header = Buffer.from(exported.data.buffer, exported.data.byteOffset, 7).toString("utf8");
    expect(header).toBe("ABMEM01");
    expect(exported.sizeBytes).toBe(exported.data.byteLength);
  });

  it("exportEncrypted 记忆库文件缺失时返回 memory-store-not-found", async () => {
    const service = createSkillsMemoryService({
      core,
      skillDriver: createHermesSkillDriver(),
      memoryDriver: createHermesMemoryDriver(),
    });
    const result = await service.exportEncrypted({}, "secret-pass-123");
    expect(result).toMatchObject({
      ok: false,
      instanceId: "hermes-main",
      code: "memory-store-not-found",
    });
  });

  it("记忆写动作默认执行前快照；dryRun 与只读操作不触发", async () => {
    createMemoryDb();
    const snapshots: string[] = [];
    const service = createSkillsMemoryService({
      core,
      memoryDriver: createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T06:10:00Z") }),
      now: () => Date.parse("2026-08-21T06:10:00Z"),
      stallThresholdMin: 30,
      snapshotBeforeWrite: async (label: string) => {
        snapshots.push(label);
      },
    });

    await service.archiveCold({}, { dryRun: true });
    expect(snapshots).toEqual([]);

    await service.archiveCold({}, {});
    expect(snapshots).toEqual(["记忆归档前自动备份"]);

    await service.purge({}, { confirmed: true, kind: "probes" });
    expect(snapshots).toEqual(["记忆归档前自动备份", "记忆清理前自动备份"]);

    await service.rebuildIndex({});
    expect(snapshots[2]).toBe("索引重建前自动备份");

    await service.restoreCold({}, {});
    expect(snapshots[3]).toBe("记忆恢复前自动备份");
  });

  it("写前快照失败时 fail-closed，记忆驱动不会被调用", async () => {
    createMemoryDb();
    const driver = createHermesMemoryDriver({ now: () => Date.parse("2026-08-21T06:10:00Z") });
    let purgeCalls = 0;
    const service = createSkillsMemoryService({
      core,
      memoryDriver: {
        ...driver,
        purge: async (scope, policy) => {
          purgeCalls += 1;
          return driver.purge(scope, policy);
        },
      },
      snapshotBeforeWrite: async () => {
        throw new Error("disk full");
      },
    });

    const result = await service.purge({}, { confirmed: true, kind: "probes" });
    expect(result).toMatchObject({
      ok: false,
      code: "snapshot-failed",
      error: "disk full",
    });
    expect(purgeCalls).toBe(0);
  });

});
