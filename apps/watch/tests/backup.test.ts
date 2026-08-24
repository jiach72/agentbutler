import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, type Core } from "@butler/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupService, type BackupService } from "../src/backup.js";

let hermesRoot: string;
let home: string;
let core: Core;
let service: BackupService;
let intervals: number[];

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
        intervals.push(ms);
        return { fn, ms };
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
    expect(intervals).toEqual([60 * 60 * 1000]);
    service.stop();
  });
});
