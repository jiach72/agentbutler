/**
 * 快照落盘与登记（长操作：同步收敛为终态 Job）。
 *
 * 目录布局：<snapshotsDir>/<instanceId>/<snapshotId>/{code,venv,data}/...
 * scope.include 名 → 目标路径的映射为可查表（SNAPSHOT_TARGETS），未知名 step skipped。
 * 完成后经 SqliteStore.insertSnapshot 登记；同实例保留 MAX_SNAPSHOTS_PER_INSTANCE 份，
 * 超出删除最旧磁盘目录并将登记置为 expired。
 */
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fail,
  ok,
  type InstanceRef,
  type Job,
  type JobStep,
  type Result,
  type SnapshotRef,
  type SnapshotScope,
} from "@butler/contract";
import type { SqliteStore } from "@butler/core";
import { findVenvPython } from "../detect.js";
import type { ExecutorOutcome } from "./executor.js";

/** 同实例快照保留份数。 */
export const MAX_SNAPSHOTS_PER_INSTANCE = 3;

/** 快照登记中随 scope 一并落库的定位信息。 */
export interface StoredSnapshotScope {
  include: string[];
  snapshotId: string;
}

type SnapshotTarget =
  | { kind: "dir" | "files"; paths: string[] }
  | { kind: "sqlite"; path: string };

/** include 名到 rootPath 下目标路径的查表。SQLite 只快照独立主库，不热拷贝 WAL/SHM。 */
const SNAPSHOT_TARGETS: Record<string, (rootPath: string) => SnapshotTarget> = {
  code: (rootPath) => ({ kind: "dir", paths: [join(rootPath, "hermes-agent")] }),
  venv: (rootPath) => {
    const rel = findVenvPython(rootPath);
    // venv 根目录 = venv Python 的上两级（<venv>/bin/python 或 <venv>/Scripts/python.exe）。
    return { kind: "dir", paths: rel ? [dirname(dirname(join(rootPath, rel)))] : [] };
  },
  data: (rootPath) => ({ kind: "sqlite", path: join(rootPath, "memory_store.db") }),
  // Task 16 进化前快照使用语义化范围；skills 为技能库目录，memory 为
  // 记忆 SQLite 主库及 WAL/SHM。保留 data 别名供升级流水线兼容。
  skills: (rootPath) => ({ kind: "dir", paths: [join(rootPath, "skills")] }),
  memory: (rootPath) => ({ kind: "sqlite", path: join(rootPath, "memory_store.db") }),
};

export interface SnapshotDeps {
  store: SqliteStore;
  snapshotsDir: string;
}

/** 目录段名净化：非法路径字符折叠为下划线（instanceId/snapshotId 均为 uuid 或 slug，通常原样）。 */
export function sanitizeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function snapshotDirOf(deps: SnapshotDeps, instanceId: string, snapshotId: string): string {
  return join(deps.snapshotsDir, sanitizeSegment(instanceId), sanitizeSegment(snapshotId));
}

/** 解析 include 名对应的目标（含未知/缺失判定），供快照与回滚共用。 */
export function resolveSnapshotTarget(rootPath: string, name: string): SnapshotTarget | null {
  return SNAPSHOT_TARGETS[name]?.(rootPath) ?? null;
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 生成不依赖源 WAL/SHM 的一致 SQLite 副本，并验证产物可读且完整。 */
function snapshotSqlite(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  const sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    sourceDb.exec(`VACUUM INTO ${quoteSqliteString(target)}`);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    sourceDb.close();
  }

  const snapshotDb = new DatabaseSync(target, { readOnly: true, timeout: 5_000 });
  let integrityError: unknown = null;
  try {
    const row = snapshotDb.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    const result = row ? Object.values(row)[0] : undefined;
    if (result !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${String(result ?? "no result")}`);
    }
  } catch (error) {
    integrityError = error;
  } finally {
    snapshotDb.close();
  }
  if (integrityError !== null) {
    rmSync(target, { force: true });
    throw integrityError;
  }
}

function targetPaths(target: SnapshotTarget): string[] {
  return target.kind === "sqlite" ? [target.path] : target.paths;
}

export async function takeSnapshot(
  deps: SnapshotDeps,
  instance: InstanceRef,
  scope: SnapshotScope,
  rootPath: string,
): Promise<Result<Job>> {
  const startedAt = Date.now();
  const jobId = randomUUID();
  const snapshotId = randomUUID();
  const snapDir = snapshotDirOf(deps, instance.instanceId, snapshotId);
  const steps: JobStep[] = [];

  try {
    mkdirSync(snapDir, { recursive: true });
  } catch (e) {
    return fail("E203", `cannot create snapshot dir: ${snapDir}`, {
      userHint: "无法创建快照目录",
      cause: e,
      startedAt,
    });
  }

  for (const name of scope.include) {
    const stepId = `copy-${name}`;
    const label = `复制 ${name}`;
    const target = resolveSnapshotTarget(rootPath, name);
    if (!target) {
      steps.push({ id: stepId, label, status: "skipped", detail: `未知快照目标: ${name}` });
      continue;
    }
    const existing = targetPaths(target).filter((p) => existsSync(p));
    if (existing.length === 0) {
      steps.push({ id: stepId, label, status: "skipped", detail: `目标不存在，跳过: ${targetPaths(target).join(", ")}` });
      continue;
    }
    try {
      if (target.kind === "dir") {
        cpSync(existing[0]!, join(snapDir, name), { recursive: true });
      } else if (target.kind === "sqlite") {
        snapshotSqlite(target.path, join(snapDir, name, basename(target.path)));
      } else {
        mkdirSync(join(snapDir, name), { recursive: true });
        for (const p of existing) {
          cpSync(p, join(snapDir, name, basename(p)));
        }
      }
      steps.push({
        id: stepId,
        label,
        status: "passed",
        detail:
          target.kind === "sqlite"
            ? `${basename(target.path)} (integrity_check=ok)`
            : existing.map((p) => basename(p)).join(", "),
      });
    } catch (e) {
      steps.push({ id: stepId, label, status: "failed", detail: String(e) });
    }
  }

  const registerStep: JobStep = { id: "register", label: "登记快照", status: "running" };
  if (steps.some((step) => step.status === "failed")) {
    rmSync(snapDir, { recursive: true, force: true });
    steps.push({ ...registerStep, status: "skipped", detail: "快照内容生成或校验失败，未登记" });
    return ok({ jobId, kind: "snapshot", steps }, startedAt);
  }
  try {
    const storedScope: StoredSnapshotScope = { include: scope.include, snapshotId };
    deps.store.insertSnapshot({
      instance: instance.instanceId,
      scope: storedScope,
      label: scope.label,
    });
    enforceRetention(deps, instance.instanceId);
    steps.push({ ...registerStep, status: "passed", detail: `snapshotId=${snapshotId}` });
  } catch (e) {
    rmSync(snapDir, { recursive: true, force: true });
    steps.push({ ...registerStep, status: "failed", detail: String(e) });
  }

  return ok({ jobId, kind: "snapshot", steps }, startedAt);
}

/** 同实例超出保留份数时淘汰最旧（磁盘目录删除 + 登记置 expired）。 */
function enforceRetention(deps: SnapshotDeps, instance: string): void {
  const rows = deps.store.listSnapshots(instance); // id 降序（新→旧）
  const active = rows.filter((r) => r.status !== "expired");
  for (const row of active.slice(MAX_SNAPSHOTS_PER_INSTANCE)) {
    deps.store.updateSnapshotStatus(row.id, "expired");
    const snapshotId = (row.scope as StoredSnapshotScope | null)?.snapshotId;
    if (snapshotId) {
      rmSync(snapshotDirOf(deps, instance, snapshotId), { recursive: true, force: true });
    }
  }
}

/* --------------------------------- rollback -------------------------------- */

/** 回滚所需的实例控制动作（由调用方按 runtime 形态适配双执行器）。 */
export interface RollbackExecutors {
  isAlive(): Promise<boolean>;
  stop(): Promise<ExecutorOutcome>;
  start(): Promise<ExecutorOutcome>;
}

/**
 * 回滚到指定快照：记录运行状态 → （运行中则先停）当前态备份到快照目录旁 .pre-rollback
 * → 按 scope 逐项覆盖恢复 → （原运行中则重启）。同步收敛为终态 Job。
 */
export async function rollbackSnapshot(
  deps: SnapshotDeps,
  instance: InstanceRef,
  ref: SnapshotRef,
  rootPath: string,
  executors: RollbackExecutors,
): Promise<Result<Job>> {
  const startedAt = Date.now();
  const rows = deps.store.listSnapshots(instance.instanceId);
  const row = rows.find(
    (r) => r.status === "ok" && (r.scope as StoredSnapshotScope | null)?.snapshotId === ref.snapshotId,
  );
  if (!row) {
    return fail("E204", `snapshot ${ref.snapshotId} not found or expired for ${instance.instanceId}`, {
      userHint: "目标快照不存在或已被淘汰",
      startedAt,
    });
  }
  const snapScope = row.scope as StoredSnapshotScope;
  const snapDir = snapshotDirOf(deps, instance.instanceId, snapScope.snapshotId);
  if (!existsSync(snapDir)) {
    return fail("E204", `snapshot dir missing: ${snapDir}`, {
      userHint: "快照目录缺失，无法回滚",
      startedAt,
    });
  }

  const steps: JobStep[] = [
    { id: "locate", label: "定位快照", status: "passed", detail: `snapshotId=${snapScope.snapshotId}` },
  ];

  const wasRunning = await executors.isAlive();
  steps.push({
    id: "check-state",
    label: "记录运行状态",
    status: "passed",
    detail: wasRunning ? "运行中，回滚前需停止" : "已停止",
  });

  let stopSucceeded = true;
  if (wasRunning) {
    const stopOut = await executors.stop();
    steps.push(
      stopOut.ok
        ? { id: "stop", label: "停止实例", status: "passed" }
        : { id: "stop", label: "停止实例", status: "failed", detail: stopOut.message },
    );
    stopSucceeded = stopOut.ok;
  }

  // 当前态临时备份：快照目录旁 <snapshotId>.pre-rollback
  const backupDir = join(dirname(snapDir), `${basename(snapDir)}.pre-rollback`);
  try {
    rmSync(backupDir, { recursive: true, force: true });
    let backedUp = 0;
    for (const name of snapScope.include) {
      const target = resolveSnapshotTarget(rootPath, name);
      if (!target) continue;
      const existing = targetPaths(target).filter((p) => existsSync(p));
      if (existing.length === 0) continue;
      if (target.kind === "dir") {
        cpSync(existing[0]!, join(backupDir, name), { recursive: true });
        backedUp += 1;
      } else if (target.kind === "sqlite") {
        snapshotSqlite(target.path, join(backupDir, name, basename(target.path)));
        backedUp += 1;
      } else {
        mkdirSync(join(backupDir, name), { recursive: true });
        for (const p of existing) {
          cpSync(p, join(backupDir, name, basename(p)));
        }
        backedUp += 1;
      }
    }
    steps.push({ id: "backup", label: "备份当前态", status: "passed", detail: `${backedUp} 项 → ${basename(backupDir)}` });
  } catch (e) {
    steps.push({ id: "backup", label: "备份当前态", status: "failed", detail: String(e) });
  }

  const mayRestore = !wasRunning || stopSucceeded;
  for (const name of snapScope.include) {
    const stepId = `restore-${name}`;
    const label = `恢复 ${name}`;
    const target = resolveSnapshotTarget(rootPath, name);
    const srcItem = join(snapDir, name);
    if (!target) {
      steps.push({ id: stepId, label, status: "skipped", detail: `未知快照目标: ${name}` });
      continue;
    }
    if (!mayRestore) {
      steps.push({ id: stepId, label, status: "skipped", detail: "停止失败，跳过恢复" });
      continue;
    }
    if (!existsSync(srcItem)) {
      steps.push({ id: stepId, label, status: "skipped", detail: "快照内无该项内容" });
      continue;
    }
    try {
      if (target.kind === "dir") {
        rmSync(target.paths[0]!, { recursive: true, force: true });
        cpSync(srcItem, target.paths[0]!, { recursive: true });
      } else if (target.kind === "sqlite") {
        rmSync(`${target.path}-wal`, { force: true });
        rmSync(`${target.path}-shm`, { force: true });
        cpSync(join(srcItem, basename(target.path)), target.path, { force: true });
      } else {
        for (const file of readdirSync(srcItem)) {
          cpSync(join(srcItem, file), join(rootPath, file));
        }
      }
      steps.push({ id: stepId, label, status: "passed" });
    } catch (e) {
      steps.push({ id: stepId, label, status: "failed", detail: String(e) });
    }
  }

  if (wasRunning) {
    if (stopSucceeded) {
      const startOut = await executors.start();
      steps.push(
        startOut.ok
          ? { id: "start", label: "重启实例", status: "passed" }
          : { id: "start", label: "重启实例", status: "failed", detail: startOut.message },
      );
    } else {
      steps.push({ id: "start", label: "重启实例", status: "skipped", detail: "停止失败，跳过重启" });
    }
  }

  return ok({ jobId: randomUUID(), kind: "rollback", steps }, startedAt);
}
