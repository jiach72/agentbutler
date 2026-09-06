/**
 * M7 备份服务（Task 18.2）：每日全量 + 每小时记忆增量 + 升级/进化前事件触发。
 *
 * - 全量/事件备份：Hermes 核心数据文件（memory/state/response/kanban/projects/
 *   verification/lcm/cron）与 config.yaml，以及 Butler 自身数据（butler.db、
 *   gateway.db）；不备份 .env 等密钥明文文件。
 * - 记忆增量备份：只备份 Hermes memory_store.db。
 * - 数据库文件用 node:sqlite VACUUM INTO 做一致性快照（失败回退文件复制）；
 *   普通文件直接复制，保留 0600 权限位。
 * - 每次备份写 backups 登记表 + 审计；自动轮转（full 保留 14 份、memory 24 份、
 *   event 10 份）。
 * - 还原：先做当前态事件备份，再按 manifest 回写 Hermes 侧文件（Butler 自身
 *   数据库运行中不回写，避免覆盖打开中的句柄），全部动作落审计。
 */
import fs from "node:fs";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BackupRow, Core } from "@butler/core";

export type BackupKind = "full" | "memory" | "event";

export const BACKUP_RETENTION_LIMITS = { full: 14, memory: 24, event: 10 } as const;
export type BackupRetentionLimits = typeof BACKUP_RETENTION_LIMITS;

export interface BackupEntry {
  /** 源文件绝对路径。 */
  from: string;
  /** 备份目录内相对路径（含根前缀，如 hermes/memory_store.db）。 */
  rel: string;
}

export interface BackupServiceOptions {
  core: Core;
  /** Hermes 主目录（~/.hermes）。 */
  hermesRoot: string;
  /** 可注入时钟（毫秒时间戳；缺省 Date.now）。 */
  now?: () => number;
  /** 自动备份定时器（测试注入 fake timer；缺省真实 setInterval）。 */
  driver?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  /** 自动备份是否随服务启动（缺省 true）。 */
  autoStart?: boolean;
  /** 覆盖备份目录（缺省 core.paths.home/backups）。 */
  backupsDir?: string;
}

export interface BackupService {
  list(kind?: BackupKind): BackupRow[];
  run(kind: BackupKind, label?: string): Promise<BackupRow>;
  restore(
    id: number,
    confirmed: boolean,
  ): Promise<
    | { ok: true; backupId: number; preRestoreBackupId: number; restored: number; skipped: number }
    | { ok: false; error: string }
  >;
  /** 在临时目录验证备份可读取；绝不回写 Hermes 或 Butler 的真实数据。 */
  verify(
    id?: number,
  ): Promise<
    | { ok: true; backupId: number; checkedFiles: number; checkedDatabases: number; checkedAt: string }
    | { ok: false; backupId: number | null; error: string; checkedFiles: number; checkedDatabases: number }
  >;
  status(): {
    enabled: boolean;
    lastFullAt: string | null;
    lastMemoryAt: string | null;
    lastFullVerification: {
      backupId: number;
      at: string;
      status: "verified" | "verification-failed" | "not-verified";
    } | null;
    hourlyTickMs: number;
    retention: BackupRetentionLimits;
  };
  start(): void;
  stop(): void;
}

/** 每种备份的保留份数（轮转上限）。 */
const ROTATION_LIMITS: Record<BackupKind, number> = BACKUP_RETENTION_LIMITS;

/** Hermes 根目录下的核心数据文件（含 cron 目录内 *.db）。 */
const HERMES_DB_FILES = [
  "memory_store.db",
  "state.db",
  "response_store.db",
  "kanban.db",
  "projects.db",
  "verification_evidence.db",
  "lcm.db",
];

/** 还原时允许回写 Hermes 侧的文件（密钥明文文件一律不在备份/还原范围）。 */
const RESTORE_ALLOWED = new Set([
  ...HERMES_DB_FILES,
  "config.yaml",
  "config.yaml.bak",
]);

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** 备份目录名：本地时间 yyyyMMdd-HHmmss。 */
function stamp(now: () => number): string {
  const d = new Date(now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function isAllowedRoot(from: string, roots: string[]): boolean {
  const resolved = resolve(from);
  return roots.some((root) => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
}

function isWithin(parent: string, candidate: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(resolvedParent + sep);
}

/** 单文件一致性备份：db → VACUUM INTO；其他 → 复制；保留 0600。 */
function backupFile(from: string, to: string): number {
  mkdirSync(dirname(to), { recursive: true });
  const base = basename(from);
  if (base.endsWith(".db")) {
    try {
      const q = String.fromCharCode(39);
      if (existsSync(to)) rmSync(to, { force: true });
      const db = new DatabaseSync(from, { readOnly: true });
      try {
        db.exec("VACUUM INTO " + q + to + q);
      } finally {
        db.close();
      }
      const st = statSync(to);
      return st.size;
    } catch {
      // VACUUM 失败（加密库/权限等）→ 回退普通复制，尽力而为
    }
  }
  cpSync(from, to, { force: true, errorOnExist: false });
  const st = statSync(from);
  if (process.platform !== "win32") {
    try {
      const mode = st.mode & 0o777;
      fs.chmodSync(to, mode);
    } catch {
      // 权限位设置失败不阻断备份
    }
  }
  return st.size;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort()
    .reverse();
}

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { core } = options;
  const now = options.now ?? Date.now;
  const hermesRoot = resolve(options.hermesRoot);
  const backupsDir = resolve(options.backupsDir ?? join(core.paths.home, "backups"));
  const butlerDataDir = resolve(core.paths.dataDir);
  const driver =
    options.driver ??
    {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  const hourlyTickMs = 60 * 60 * 1000;
  let handle: unknown;

  function collectScope(kind: BackupKind): BackupEntry[] {
    const entries: BackupEntry[] = [];
    const addFile = (from: string, prefix: string): void => {
      const resolved = resolve(from);
      if (!existsSync(resolved)) return;
      entries.push({ from: resolved, rel: join(prefix, relative(hermesRoot, resolved)) });
    };

    if (kind === "memory") {
      addFile(join(hermesRoot, "memory_store.db"), "hermes");
      return entries;
    }

    for (const name of HERMES_DB_FILES) {
      addFile(join(hermesRoot, name), "hermes");
    }
    const cronDir = join(hermesRoot, "cron");
    if (existsSync(cronDir)) {
      for (const entry of fs.readdirSync(cronDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".db")) {
          addFile(join(cronDir, entry.name), "hermes");
        }
      }
    }
    addFile(join(hermesRoot, "config.yaml"), "hermes");

    // Butler 自身数据（不备份 -wal/-shm，VACUUM 已收敛）。
    if (existsSync(butlerDataDir)) {
      for (const name of fs.readdirSync(butlerDataDir)) {
        if (name.endsWith(".db")) {
          const from = join(butlerDataDir, name);
          if (!existsSync(from)) continue;
          entries.push({
            from: resolve(from),
            rel: join("butler-data", name),
          });
        }
      }
    }
    return entries;
  }

  function rotate(kind: BackupKind): void {
    const dir = join(backupsDir, kind);
    const dirs = listDirs(dir);
    const limit = ROTATION_LIMITS[kind] ?? 10;
    const keep = new Set(dirs.slice(0, limit));
    for (const oldDir of dirs) {
      if (keep.has(oldDir)) continue;
      if (!oldDir.startsWith(backupsDir + sep)) continue;
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {
        // 轮转失败不阻断后续备份
      }
      for (const row of core.store.listBackups(kind)) {
        if (resolve(row.path) === oldDir) {
          core.store.updateBackupStatus(row.id, "expired");
        }
      }
    }
  }

  async function run(kind: BackupKind, label?: string): Promise<BackupRow> {
    const entries = collectScope(kind);
    if (entries.length === 0) {
      throw new Error("没有找到可备份的文件（Hermes 数据目录为空？）");
    }
    const destDir = join(backupsDir, kind, stamp(now));
    mkdirSync(destDir, { recursive: true });
    let totalBytes = 0;
    const manifest: Array<{ from: string; rel: string; size: number }> = [];
    for (const entry of entries) {
      const target = join(destDir, entry.rel);
      const size = backupFile(entry.from, target);
      totalBytes += size;
      manifest.push({ from: entry.from, rel: entry.rel, size });
    }
    writeFileSync(
      join(destDir, "manifest.json"),
      JSON.stringify({ kind, label: label ?? undefined, createdAt: isoNow(now), files: manifest }, null, 2),
      { mode: 0o600 },
    );
    const row = core.store.insertBackup({
      kind,
      label: label ?? undefined,
      target: kind === "memory" ? "hermes-memory" : kind === "full" ? "butler-full" : "butler-event",
      path: destDir,
      sizeBytes: totalBytes,
    });
    core.audit.append({
      actor: "backup",
      action: `backup-${kind}`,
      target: destDir,
      detail: { label: label ?? null, sizeBytes: totalBytes, files: manifest.length, backupId: row.id },
    });
    core.bus.emit("backup-completed", { id: row.id, kind, path: destDir, sizeBytes: totalBytes });
    rotate(kind);
    return row;
  }

  async function restore(
    id: number,
    confirmed: boolean,
  ): Promise<
    | { ok: true; backupId: number; preRestoreBackupId: number; restored: number; skipped: number }
    | { ok: false; error: string }
  > {
    if (confirmed !== true) {
      return { ok: false, error: "confirmation-required" };
    }
    const row = core.store.getBackup(id);
    if (row === undefined || !existsSync(row.path)) {
      return { ok: false, error: "backup-not-found" };
    }
    let manifest: { files: Array<{ from: string; rel: string; size: number }> };
    try {
      manifest = JSON.parse(readFileSync(join(row.path, "manifest.json"), "utf8")) as {
        files: Array<{ from: string; rel: string; size: number }>;
      };
    } catch {
      return { ok: false, error: "backup-manifest-corrupt" };
    }
    if (!Array.isArray(manifest.files)) {
      return { ok: false, error: "backup-manifest-corrupt" };
    }
    // 还原前先做当前态事件备份（PRD M7：还原任何快照前先做当前态快照）。
    const pre = await run("event", `还原前自动备份（backup #${id}）`);
    let restored = 0;
    let skipped = 0;
    for (const entry of manifest.files) {
      const base = basename(entry.from);
      const fromResolved = resolve(entry.from);
      const withinHermes = isAllowedRoot(fromResolved, [hermesRoot]);
      const withinButlerData = isAllowedRoot(fromResolved, [butlerDataDir]);
      if (!withinHermes && !withinButlerData) {
        skipped += 1;
        continue;
      }
      // Butler 自身数据库运行中不可回写（打开的句柄会写回旧 inode）。
      if (!withinHermes || !RESTORE_ALLOWED.has(base)) {
        skipped += 1;
        continue;
      }
      const source = join(row.path, entry.rel);
      if (!existsSync(source)) {
        skipped += 1;
        continue;
      }
      mkdirSync(dirname(fromResolved), { recursive: true });
      cpSync(source, fromResolved, { force: true, errorOnExist: false });
      restored += 1;
    }
    core.audit.append({
      actor: "backup",
      action: "backup-restore",
      target: row.path,
      detail: { backupId: id, preRestoreBackupId: pre.id, restored, skipped },
    });
    core.store.updateBackupStatus(id, "restored");
    return { ok: true, backupId: id, preRestoreBackupId: pre.id, restored, skipped };
  }

  async function verify(
    requestedId?: number,
  ): Promise<
    | { ok: true; backupId: number; checkedFiles: number; checkedDatabases: number; checkedAt: string }
    | { ok: false; backupId: number | null; error: string; checkedFiles: number; checkedDatabases: number }
  > {
    const row = requestedId === undefined
      ? core.store.listBackups().find((item) => item.status !== "expired")
      : core.store.getBackup(requestedId);
    if (row === undefined || !existsSync(row.path) || !isWithin(backupsDir, row.path)) {
      return { ok: false, backupId: row?.id ?? null, error: "backup-not-found", checkedFiles: 0, checkedDatabases: 0 };
    }

    let manifest: { files: Array<{ rel: string; size: number }> };
    try {
      manifest = JSON.parse(readFileSync(join(row.path, "manifest.json"), "utf8")) as {
        files: Array<{ rel: string; size: number }>;
      };
    } catch {
      core.store.updateBackupStatus(row.id, "verification-failed");
      core.audit.append({ actor: "backup", action: "backup-verify-failed", target: row.path, detail: { backupId: row.id, error: "backup-manifest-corrupt" } });
      return { ok: false, backupId: row.id, error: "backup-manifest-corrupt", checkedFiles: 0, checkedDatabases: 0 };
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      core.store.updateBackupStatus(row.id, "verification-failed");
      core.audit.append({ actor: "backup", action: "backup-verify-failed", target: row.path, detail: { backupId: row.id, error: "backup-manifest-corrupt" } });
      return { ok: false, backupId: row.id, error: "backup-manifest-corrupt", checkedFiles: 0, checkedDatabases: 0 };
    }

    const stagingDir = fs.mkdtempSync(join(tmpdir(), "butler-backup-verify-"));
    let checkedFiles = 0;
    let checkedDatabases = 0;
    try {
      for (const entry of manifest.files) {
        if (
          typeof entry.rel !== "string" ||
          entry.rel.trim() === "" ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        ) {
          throw new Error("backup-manifest-corrupt");
        }
        const source = resolve(row.path, entry.rel);
        if (!isWithin(row.path, source) || !existsSync(source)) throw new Error("backup-file-missing");
        const sourceStat = lstatSync(source);
        if (!sourceStat.isFile() || sourceStat.size !== entry.size) throw new Error("backup-file-invalid");

        const staged = resolve(stagingDir, entry.rel);
        if (!isWithin(stagingDir, staged)) throw new Error("backup-manifest-corrupt");
        mkdirSync(dirname(staged), { recursive: true });
        cpSync(source, staged, { force: true, errorOnExist: false });
        if (statSync(staged).size !== entry.size) throw new Error("backup-file-invalid");
        checkedFiles += 1;

        if (staged.endsWith(".db")) {
          const db = new DatabaseSync(staged, { readOnly: true });
          try {
            const result = db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
            if (result === undefined || Object.values(result)[0] !== "ok") throw new Error("backup-database-invalid");
          } finally {
            db.close();
          }
          checkedDatabases += 1;
        }
      }
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith("backup-")
        ? error.message
        : "backup-verification-failed";
      core.store.updateBackupStatus(row.id, "verification-failed");
      core.audit.append({
        actor: "backup",
        action: "backup-verify-failed",
        target: row.path,
        detail: { backupId: row.id, error: code, checkedFiles, checkedDatabases },
      });
      return { ok: false, backupId: row.id, error: code, checkedFiles, checkedDatabases };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }

    const checkedAt = isoNow(now);
    core.store.updateBackupStatus(row.id, "verified");
    core.audit.append({
      actor: "backup",
      action: "backup-verify",
      target: row.path,
      detail: { backupId: row.id, checkedFiles, checkedDatabases, checkedAt },
    });
    return { ok: true, backupId: row.id, checkedFiles, checkedDatabases, checkedAt };
  }

  function status() {
    const full = core.store.listBackups("full").find((item) => item.status !== "expired");
    const memory = core.store.listBackups("memory").find((item) => item.status !== "expired");
    return {
      enabled: true,
      lastFullAt: full?.createdAt ?? null,
      lastMemoryAt: memory?.createdAt ?? null,
      lastFullVerification: full === undefined
        ? null
        : {
            backupId: full.id,
            at: full.createdAt,
            status:
              full.status === "verified"
                ? "verified" as const
                : full.status === "verification-failed"
                  ? "verification-failed" as const
                  : "not-verified" as const,
          },
      hourlyTickMs,
      retention: { ...BACKUP_RETENTION_LIMITS },
    };
  }

  async function tick(): Promise<void> {
    try {
      const memory = core.store.listBackups("memory").find((item) => item.status !== "expired");
      if (memory === undefined || now() - Date.parse(memory.createdAt) > 55 * 60 * 1000) {
        await run("memory", "每小时记忆增量备份");
      }
      const full = core.store.listBackups("full").find((item) => item.status !== "expired");
      const today = isoNow(now).slice(0, 10);
      if (full === undefined || full.createdAt.slice(0, 10) !== today) {
        const created = await run("full", "每日全量备份");
        // 每日新建的全量备份立刻在临时目录验读；失败只影响该备份状态，绝不回写运行数据。
        await verify(created.id);
      }
    } catch (error) {
      console.warn("[butler-watch] 自动备份执行异常（下个周期重试）:", error);
    }
  }

  function start(): void {
    if (handle !== undefined) return;
    handle = driver.setInterval(() => void tick(), hourlyTickMs);
  }

  function stop(): void {
    if (handle !== undefined) {
      driver.clearInterval(handle);
      handle = undefined;
    }
  }

  return { list: (kind?: BackupKind) => core.store.listBackups(kind), run, restore, verify, status, start, stop };
}
