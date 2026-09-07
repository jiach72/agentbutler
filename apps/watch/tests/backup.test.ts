import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCore, type Core } from "@butler/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupService, type BackupService } from "../src/backup.js";

let hermesRoot: string;
let home: string;
let core: Core;
let service: BackupService;
let intervals: Array<{ fn: () => void; ms: number }>;

beforeEach(() => {
  hermesRoot = mkdtempSync(join(tmpdir(), "butler-backup-hermes-"));
  home = mkdtempSync(join(tmpdir(), "butler-backup-home-"));
  core = createCore({ home });
  writeFileSync(join(hermesRoot, "memory_store.db"), "old-memory-content", "utf8");
  writeFileSync(join(hermesRoot, "config.yaml"), "throttle: 60", "utf8");
  intervals = [];
  service = createBackupService({
    core,
    hermesRoot,
    now: () => Date.parse("2026-08-23T04:00:00Z"),
    driver: {
      setInterval: (fn, ms) => {
        const handle = { fn, ms };
        intervals.push(handle);
        return handle;
      },
      clearInterval: () => undefined,
    },
  });
});

afterEach(() => {
  core.close();
  rmSync(hermesRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("M7 备份服务", () => {
  it("记忆增量备份：登记 + 落盘 + 审计", async () => {
    const row = await service.run("memory", "测试记忆备份");

    expect(row.kind).toBe("memory");
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(row.path, "hermes", "memory_store.db"))).toBe(true);
    const audit = core.store.listAudit({ action: "backup-memory" });
    expect(audit.length).toBe(1);
    expect(audit[0]!.actor).toBe("backup");
    expect(core.store.listBackups("memory")[0]!.id).toBe(row.id);
  });

  it("全量备份包含 Hermes 数据与 Butler 自身数据，且不包含密钥明文", async () => {
    writeFileSync(join(hermesRoot, ".env"), "OPENAI_API_KEY=sk-test", "utf8");
    const row = await service.run("full", "测试全量备份");

    expect(existsSync(join(row.path, "hermes", "memory_store.db"))).toBe(true);
    expect(existsSync(join(row.path, "hermes", "config.yaml"))).toBe(true);
    expect(existsSync(join(row.path, "hermes", ".env"))).toBe(false);
    expect(existsSync(join(row.path, "butler-data", "butler.db"))).toBe(true);
  });

  it("还原前必须先确认；确认后先做当前态备份再还原记忆", async () => {
    const row = await service.run("memory", "待还原备份");
    writeFileSync(join(hermesRoot, "memory_store.db"), "changed-content", "utf8");

    const refused = await service.restore(row.id, false);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe("confirmation-required");

    const done = await service.restore(row.id, true);
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.restored).toBe(1);
      expect(done.preRestoreBackupId).toBeGreaterThan(0);
    }
    expect(readFileSync(join(hermesRoot, "memory_store.db"), "utf8")).toBe("old-memory-content");
    const events = core.store.listBackups("event");
    expect(events.some((b) => b.label?.includes("还原前自动备份"))).toBe(true);
  });

  it("自动调度：注册 1 小时周期；stop 后不再触发", () => {
    service.start();
    expect(intervals.map((item) => item.ms)).toEqual([60 * 60 * 1000]);
    service.stop();
  });

  it("自动调度使用注入时钟判断是否需要增量备份", async () => {
    const run = await service.run("memory", "刚刚完成");
    expect(run.status).toBe("ok");
    service.start();
    // 注入时钟与备份时间相同，周期回调不应因真实系统时钟而重复创建记忆备份。
    const interval = intervals.at(-1);
    expect(interval?.ms).toBe(60 * 60 * 1000);
    await interval?.fn();
    // 周期回调是 void tick()（不回传 promise）；文件操作已下沉 worker。
    // 本 tick 判定记忆备份仍新鲜后会在后台补做全量备份并立即验证，这里
    // 轮询等待其收敛（验证状态落库即代表全部文件写入完成），避免 afterEach
    // 清理目录时备份仍在写入。
    for (let i = 0; i < 300; i += 1) {
      const full = core.store.listBackups("full")[0];
      if (full !== undefined && (full.status === "verified" || full.status === "verification-failed")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(core.store.listBackups("memory")).toHaveLength(1);
    service.stop();
  }, 15_000);

  it("状态明确返回日常备份的分类型保留上限", () => {
    expect(service.status().retention).toEqual({ full: 14, memory: 24, event: 10 });
    expect(service.status().lastFullVerification).toBeNull();
  });

  it("在临时目录验证最近备份，不覆盖当前 Hermes 数据", async () => {
    const row = await service.run("memory", "待验证备份");
    writeFileSync(join(hermesRoot, "memory_store.db"), "current-data-must-remain", "utf8");

    const result = await service.verify(row.id);

    expect(result).toMatchObject({ ok: false, backupId: row.id, error: "backup-verification-failed" });
    expect(readFileSync(join(hermesRoot, "memory_store.db"), "utf8")).toBe("current-data-must-remain");
    expect(core.store.getBackup(row.id)?.status).toBe("verification-failed");
    expect(core.store.listAudit({ action: "backup-verify-failed" })).toHaveLength(1);
  });

  it("可验证真实 SQLite 备份，并记录已验证状态", async () => {
    const memoryPath = join(hermesRoot, "memory_store.db");
    rmSync(memoryPath, { force: true });
    const database = new DatabaseSync(memoryPath);
    database.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT); INSERT INTO memories (content) VALUES ('backup');");
    database.close();
    const row = await service.run("memory", "SQLite 备份");

    const result = await service.verify(row.id);

    expect(result).toMatchObject({ ok: true, backupId: row.id, checkedFiles: 1, checkedDatabases: 1 });
    expect(core.store.getBackup(row.id)?.status).toBe("verified");
    expect(core.store.listAudit({ action: "backup-verify" })).toHaveLength(1);
  });

  describe("外部记忆后端（hindsight/mem0）的记忆增量备份", () => {
    function externalService(): BackupService {
      return createBackupService({
        core,
        hermesRoot,
        now: () => Date.parse("2026-08-23T04:00:00Z"),
        driver: {
          setInterval: (fn, ms) => {
            const handle = { fn, ms };
            intervals.push(handle);
            return handle;
          },
          clearInterval: () => undefined,
        },
      });
    }

    function migrateToHindsight(): void {
      rmSync(join(hermesRoot, "memory_store.db"), { force: true });
      mkdirSync(join(hermesRoot, "hindsight"), { recursive: true });
      writeFileSync(join(hermesRoot, "hindsight", "config.json"), "{}", "utf8");
    }

    it("hindsight 接管且本地无库：run 明确报错并记审计，不产生备份登记", async () => {
      migrateToHindsight();
      const external = externalService();

      await expect(external.run("memory", "测试")).rejects.toThrow(/hindsight/);
      expect(core.store.listBackups("memory")).toHaveLength(0);
      expect(core.store.listAudit({ action: "memory-backup-skipped" })).toHaveLength(1);
      external.stop();
    });

    it("每小时 tick 静默跳过：不抛错、审计只在原因变化时记一条", async () => {
      migrateToHindsight();
      const external = externalService();
      external.start();
      const interval = intervals.at(-1);
      await interval?.fn();
      await interval?.fn();
      // 周期回调是 void tick()；轮询等待审计落库（与既有调度用例同一手法）。
      for (let i = 0; i < 100; i += 1) {
        if (core.store.listAudit({ action: "memory-backup-skipped" }).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // 两个 tick 同一原因：只记一条 skip 审计（逐小时跳过不刷屏）。
      expect(core.store.listAudit({ action: "memory-backup-skipped" })).toHaveLength(1);
      // tick 还会补做当日全量备份；等它收敛（落库+验证完成）再结束，避免
      // afterEach 清理目录时 worker 仍在写入（Windows 上表现为 EPERM）。
      for (let i = 0; i < 300; i += 1) {
        const full = core.store.listBackups("full")[0];
        if (full !== undefined && (full.status === "verified" || full.status === "verification-failed")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      external.stop();
    });
  });
});
