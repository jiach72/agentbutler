import { existsSync, lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { basename, join, relative } from "node:path";
import {
  MEMORY_PREVIEW_LIMIT,
  type ArchivePolicy,
  type ArchiveReport,
  type DriverScope,
  type MemoryDriver,
  type MemoryEntry,
  type MemoryHealth,
  type MemoryStats,
  type PluginDriver,
  type PluginMeta,
  type PurgePolicy,
  type PurgeReport,
  type RebuildIndexReport,
  type RestorePolicy,
  type RestoreReport,
  type SkillDriver,
  type SkillMeta,
} from "@butler/contract";
import type { Core, InstanceRecord } from "@butler/core";

const MEMORY_EXPORT_MAGIC = "ABMEM01";
const MEMORY_EXPORT_MIN_PASSPHRASE = 8;

function memoryExportStamp(now: () => number): string {
  const d = new Date(now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 读取记忆库并加密为 .abmem 导出文件（AES-256-GCM + scrypt 口令派生）。 */
function encryptMemoryDb(
  dbFile: string,
  passphrase: string,
  now: () => number,
): { filename: string; data: Uint8Array } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const plain = readFileSync(dbFile);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.concat([Buffer.from(MEMORY_EXPORT_MAGIC, "utf8"), salt, iv, tag]);
  const payload = Buffer.concat([header, encrypted]);
  return {
    filename: `butler-memory-export-${memoryExportStamp(now)}.abmem`,
    data: payload,
  };
}

const DIRECTORY_SCAN_LIMIT = 5_000;
const DIRECTORY_SCAN_DEPTH = 6;

export type InventoryMode = "driver" | "directory-fallback" | "unavailable";

export interface DirectoryInventory {
  roots: string[];
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface WriteActivityView {
  status: "active" | "stalled" | "empty" | "unknown";
  detail: string;
}

export interface SkillsMemoryView {
  instance: null | {
    instanceId: string;
    frameworkId: string;
    state: string;
    version: string | null;
  };
  skills: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: SkillMeta[];
    directory: DirectoryInventory;
    notice: string;
  };
  plugins: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: PluginMeta[];
    directory: DirectoryInventory;
    notice: string;
  };
  memory: {
    mode: InventoryMode;
    driverId: string | null;
    stats: MemoryStats | null;
    health: MemoryHealth | null;
    preview: MemoryEntry[];
    previewLimit: number;
    writeActivity: WriteActivityView;
    directory: DirectoryInventory;
    notice: string;
  };
}

export interface SkillsMemoryQuery {
  instanceId?: string;
  keyword?: string;
  limit?: number;
}

export interface SkillsMemoryService {
  status(query: SkillsMemoryQuery): Promise<SkillsMemoryView>;
  /** 记忆健康分析（观察面；status 内已含，独立端点供刷新用）。 */
  analyze(query: SkillsMemoryQuery): Promise<MemoryActionResult>;
  /** 冷存归档：dryRun 只统计不落盘。 */
  archiveCold(query: SkillsMemoryQuery, policy: ArchivePolicy): Promise<MemoryActionResult>;
  /** 恢复已归档记忆。 */
  restoreCold(query: SkillsMemoryQuery, policy: RestorePolicy): Promise<MemoryActionResult>;
  /** 物理删除：必须 confirmed=true。 */
  purge(query: SkillsMemoryQuery, policy: PurgePolicy): Promise<MemoryActionResult>;
  /** 重建 FTS 索引（探针失败后引导执行；写动作，执行前由调用方快照）。 */
  rebuildIndex(query: SkillsMemoryQuery): Promise<MemoryActionResult>;
  /** 全量记忆加密导出（AES-256-GCM，口令派生密钥；PRD M6）。 */
  exportEncrypted(query: SkillsMemoryQuery, passphrase: string): Promise<MemoryExportResult>;
}

export interface MemoryExportResult {
  ok: boolean;
  instanceId: string | null;
  filename?: string;
  data?: Uint8Array;
  sizeBytes?: number;
  code?: string;
  error?: string;
  userHint?: string;
}

export interface MemoryActionResult {
  ok: boolean;
  instanceId: string | null;
  code?: string;
  error?: string;
  userHint?: string;
  report?: MemoryHealth | ArchiveReport | RestoreReport | PurgeReport | RebuildIndexReport;
}

export interface SkillsMemoryServiceDeps {
  core: Core;
  skillDriver?: SkillDriver;
  pluginDriver?: PluginDriver;
  memoryDriver?: MemoryDriver;
  now?: () => number;
  stallThresholdMin?: number;
  /** 记忆写动作执行前快照（PRD M6：所有写动作默认执行前快照）；缺失或失败时写动作必须中止。 */
  snapshotBeforeWrite?: (label: string) => Promise<void>;
}

function emptyDirectory(): DirectoryInventory {
  return { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false };
}

function scanDirectoryTargets(rootPath: string, targets: string[]): DirectoryInventory {
  const summary = emptyDirectory();
  let visited = 0;
  const visit = (path: string, depth: number): void => {
    if (summary.truncated || depth > DIRECTORY_SCAN_DEPTH) return;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path, { bigint: false, throwIfNoEntry: true });
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    visited += 1;
    if (visited > DIRECTORY_SCAN_LIMIT) {
      summary.truncated = true;
      return;
    }
    if (stat.isFile()) {
      summary.fileCount += 1;
      summary.sizeBytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    summary.directoryCount += 1;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (summary.truncated) return;
      if (entry.isSymbolicLink()) continue;
      visit(join(path, entry.name), depth + 1);
    }
  };

  for (const target of targets) {
    if (!existsSync(target)) continue;
    summary.roots.push(relative(rootPath, target) || basename(target));
    visit(target, 0);
  }
  return summary;
}

function chooseInstance(core: Core, instanceId?: string): InstanceRecord | undefined {
  if (instanceId !== undefined && instanceId.trim() !== "") {
    return core.instances.getInstance(instanceId.trim());
  }
  const instances = core.instances.listInstances().filter((instance) => instance.rootPath !== "");
  return instances.find((instance) => instance.state === "Serving") ?? instances[0];
}

function writeActivity(
  stats: MemoryStats | null,
  now: () => number,
  thresholdMin: number,
): WriteActivityView {
  if (stats === null) return { status: "unknown", detail: "驱动未能解析最近写入时间" };
  if (stats.lastWriteAt === null) return { status: "empty", detail: "记忆库尚无用户记忆写入" };
  const last = Date.parse(stats.lastWriteAt);
  if (!Number.isFinite(last)) return { status: "unknown", detail: "最近写入时间格式无法识别" };
  const ageMin = Math.max(0, Math.floor((now() - last) / 60_000));
  return ageMin > thresholdMin
    ? { status: "stalled", detail: `距上次写入 ${ageMin} 分钟，超过 ${thresholdMin} 分钟阈值` }
    : { status: "active", detail: `最近 ${ageMin} 分钟内有写入` };
}

function unavailableView(): SkillsMemoryView {
  return {
    instance: null,
    skills: {
      mode: "unavailable",
      driverId: null,
      total: 0,
      items: [],
      directory: emptyDirectory(),
      notice: "未发现可读取的实例",
    },
    plugins: {
      mode: "unavailable",
      driverId: null,
      total: 0,
      items: [],
      directory: emptyDirectory(),
      notice: "未发现可读取的实例",
    },
    memory: {
      mode: "unavailable",
      driverId: null,
      stats: null,
      health: null,
      preview: [],
      previewLimit: MEMORY_PREVIEW_LIMIT,
      writeActivity: { status: "unknown", detail: "未发现可读取的实例" },
      directory: emptyDirectory(),
      notice: "未发现可读取的实例",
    },
  };
}

export function createSkillsMemoryService(deps: SkillsMemoryServiceDeps): SkillsMemoryService {
  const now = deps.now ?? Date.now;
  const stallThresholdMin = Math.max(1, deps.stallThresholdMin ?? 30);

  const resolveScope = (
    query: SkillsMemoryQuery,
  ): { scope: DriverScope; instance: InstanceRecord } | { error: string } => {
    const instance = chooseInstance(deps.core, query.instanceId);
    if (instance === undefined) return { error: "未发现可读取的实例" };
    return {
      instance,
      scope: {
        instance: {
          instanceId: instance.instanceId,
          rootPath: instance.rootPath,
          runtime: instance.runtime,
        },
        rootPath: instance.rootPath,
      },
    };
  };

  async function runSnapshotBeforeWrite(label: string): Promise<MemoryActionResult | null> {
    if (deps.snapshotBeforeWrite === undefined) {
      return {
        ok: false,
        instanceId: null,
        code: "snapshot-failed",
        error: "snapshot-before-write-unavailable",
        userHint: "写入前备份能力不可用，已取消本次操作",
      };
    }
    try {
      await deps.snapshotBeforeWrite(label);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.core.audit.append({
        actor: "memory",
        action: "snapshot-before-write-failed",
        target: label,
        detail: { error: message },
      });
      return {
        ok: false,
        instanceId: null,
        code: "snapshot-failed",
        error: message,
        userHint: "写入前备份失败，已取消本次操作",
      };
    }
  }

  async function runMemoryAction(
    query: SkillsMemoryQuery,
    method: "archiveCold" | "restoreCold" | "purge",
    policy: ArchivePolicy | RestorePolicy | PurgePolicy,
  ): Promise<MemoryActionResult> {
    const resolved = resolveScope(query);
    if ("error" in resolved) {
      return { ok: false, instanceId: null, error: resolved.error, userHint: resolved.error };
    }
    if (deps.memoryDriver === undefined) {
      return {
        ok: false,
        instanceId: resolved.instance.instanceId,
        error: "memory-driver-unavailable",
        userHint: "该实例的此格式暂不支持记忆写操作",
      };
    }
    const fn = deps.memoryDriver[method] as (
      scope: DriverScope,
      policy: ArchivePolicy | RestorePolicy | PurgePolicy,
    ) => Promise<import("@butler/contract").Result<
      ArchiveReport | RestoreReport | PurgeReport
    >>;
    const result = await deps.core.invoke(() => fn(resolved.scope, policy), {
      method,
      instance: resolved.instance.instanceId,
      auditEntry: { actor: "memory", detail: { policy } },
    });
    if (result.ok && result.data !== undefined) {
      return { ok: true, instanceId: resolved.instance.instanceId, report: result.data as never };
    }
    return {
      ok: false,
      instanceId: resolved.instance.instanceId,
      code: result.error?.code,
      error: result.error?.message,
      userHint: result.error?.userHint,
    };
  }

  return {
    async status(query: SkillsMemoryQuery): Promise<SkillsMemoryView> {
      const instance = chooseInstance(deps.core, query.instanceId);
      if (instance === undefined) return unavailableView();
      const scope: DriverScope = {
        instance: {
          instanceId: instance.instanceId,
          rootPath: instance.rootPath,
          runtime: instance.runtime,
        },
        rootPath: instance.rootPath,
      };
      const skillsDirectory = scanDirectoryTargets(instance.rootPath, [
        join(instance.rootPath, "skills"),
      ]);
      const memoryDirectory = scanDirectoryTargets(instance.rootPath, [
        join(instance.rootPath, "memory_store.db"),
        join(instance.rootPath, "memory"),
        join(instance.rootPath, "memories"),
        join(instance.rootPath, "hindsight"),
      ]);
      const pluginsDirectory = scanDirectoryTargets(instance.rootPath, [
        join(instance.rootPath, "plugins"),
      ]);

      const skillPromise =
        deps.skillDriver === undefined
          ? Promise.resolve(null)
          : deps.core.invoke(() => deps.skillDriver!.enumerate(scope), {
              method: "enumerate",
              instance: instance.instanceId,
            });
      const pluginPromise =
        deps.pluginDriver === undefined
          ? Promise.resolve(null)
          : deps.core.invoke(() => deps.pluginDriver!.enumerate(scope), {
              method: "enumerate",
              instance: instance.instanceId,
            });
      const statsPromise =
        deps.memoryDriver === undefined
          ? Promise.resolve(null)
          : deps.core.invoke(() => deps.memoryDriver!.stats(scope), {
              method: "stats",
              instance: instance.instanceId,
            });
      const previewPromise =
        deps.memoryDriver === undefined
          ? Promise.resolve(null)
          : deps.core.invoke(
              () =>
                deps.memoryDriver!.preview(scope, {
                  ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
                  limit: Math.min(MEMORY_PREVIEW_LIMIT, query.limit ?? 20),
                }),
              { method: "preview", instance: instance.instanceId },
            );
      const healthPromise =
        deps.memoryDriver === undefined
          ? Promise.resolve(null)
          : deps.core.invoke(() => deps.memoryDriver!.analyze(scope), {
              method: "analyze",
              instance: instance.instanceId,
            });
      const [skillResult, pluginResult, statsResult, previewResult, healthResult] = await Promise.all([
        skillPromise,
        pluginPromise,
        statsPromise,
        previewPromise,
        healthPromise,
      ]);

      const skillItems =
        skillResult?.ok === true && skillResult.data !== undefined ? skillResult.data : [];
      const skillDriverCovered =
        skillResult?.ok === true && (skillItems.length > 0 || skillsDirectory.fileCount === 0);
      const pluginItems =
        pluginResult?.ok === true && pluginResult.data !== undefined ? pluginResult.data : [];
      const pluginDriverCovered =
        pluginResult?.ok === true && (pluginItems.length > 0 || pluginsDirectory.fileCount === 0);
      const memoryStats =
        statsResult?.ok === true && statsResult.data !== undefined ? statsResult.data : null;
      const memoryPreview =
        previewResult?.ok === true && previewResult.data !== undefined ? previewResult.data : [];
      const memoryHealth =
        healthResult?.ok === true && healthResult.data !== undefined ? healthResult.data : null;

      const skillsMode: InventoryMode =
        deps.skillDriver === undefined
          ? skillsDirectory.fileCount > 0
            ? "directory-fallback"
            : "unavailable"
          : skillDriverCovered
            ? "driver"
            : "directory-fallback";
      const pluginsMode: InventoryMode =
        deps.pluginDriver === undefined
          ? pluginsDirectory.fileCount > 0
            ? "directory-fallback"
            : "unavailable"
          : pluginDriverCovered
            ? "driver"
            : "directory-fallback";
      const memoryMode: InventoryMode =
        deps.memoryDriver === undefined
          ? memoryDirectory.fileCount > 0
            ? "directory-fallback"
            : "unavailable"
          : memoryStats !== null
            ? "driver"
            : "directory-fallback";

      return {
        instance: {
          instanceId: instance.instanceId,
          frameworkId: instance.frameworkId,
          state: instance.state,
          version: instance.version,
        },
        skills: {
          mode: skillsMode,
          driverId: deps.skillDriver?.id ?? null,
          total: skillItems.length,
          items: skillItems,
          directory: skillsDirectory,
          notice:
            skillsMode === "driver"
              ? "经 hermes-skill 驱动只读解析；V1 不支持启停、导入或回退"
              : "该实例的此格式暂不支持解析；V1 不支持写入，已降级为目录统计",
        },
        plugins: {
          mode: pluginsMode,
          driverId: deps.pluginDriver?.id ?? null,
          total: pluginItems.length,
          items: pluginItems,
          directory: pluginsDirectory,
          notice:
            pluginsMode === "driver"
              ? "经 hermes-plugin 驱动只读解析；V1 不支持安装、启停或删除"
              : "该实例的此格式暂不支持解析；V1 不支持写入，已降级为目录统计",
        },
        memory: {
          mode: memoryMode,
          driverId: deps.memoryDriver?.id ?? null,
          stats: memoryStats,
          health: memoryHealth,
          preview: memoryPreview,
          previewLimit: MEMORY_PREVIEW_LIMIT,
          writeActivity: writeActivity(memoryStats, now, stallThresholdMin),
          directory: memoryDirectory,
          notice:
            memoryMode === "driver"
              ? previewResult?.ok === true
                ? "经 sqlite-fts5 驱动只读统计与检索；预览硬上限 50 条"
                : "统计可读，但该实例的检索格式暂不支持解析；V1 不支持写入"
              : "该实例的此格式暂不支持解析；V1 不支持写入，已降级为目录统计",
        },
      };
    },

    async analyze(query: SkillsMemoryQuery): Promise<MemoryActionResult> {
      const resolved = resolveScope(query);
      if ("error" in resolved) {
        return { ok: false, instanceId: null, error: resolved.error, userHint: resolved.error };
      }
      if (deps.memoryDriver === undefined) {
        return {
          ok: false,
          instanceId: resolved.instance.instanceId,
          error: "memory-driver-unavailable",
          userHint: "该实例的此格式暂不支持记忆健康分析",
        };
      }
      const result = await deps.core.invoke(
        () => deps.memoryDriver!.analyze(resolved.scope),
        { method: "analyze", instance: resolved.instance.instanceId },
      );
      if (result.ok && result.data !== undefined) {
        return { ok: true, instanceId: resolved.instance.instanceId, report: result.data };
      }
      return {
        ok: false,
        instanceId: resolved.instance.instanceId,
        code: result.error?.code,
        error: result.error?.message,
        userHint: result.error?.userHint,
      };
    },

    async archiveCold(
      query: SkillsMemoryQuery,
      policy: ArchivePolicy,
    ): Promise<MemoryActionResult> {
      if (policy.dryRun !== true) {
        const snapshotFailure = await runSnapshotBeforeWrite("记忆归档前自动备份");
        if (snapshotFailure !== null) return snapshotFailure;
      }
      return runMemoryAction(query, "archiveCold", policy);
    },

    async restoreCold(
      query: SkillsMemoryQuery,
      policy: RestorePolicy,
    ): Promise<MemoryActionResult> {
      const snapshotFailure = await runSnapshotBeforeWrite("记忆恢复前自动备份");
      if (snapshotFailure !== null) return snapshotFailure;
      return runMemoryAction(query, "restoreCold", policy);
    },

    async purge(query: SkillsMemoryQuery, policy: PurgePolicy): Promise<MemoryActionResult> {
      const snapshotFailure = await runSnapshotBeforeWrite("记忆清理前自动备份");
      if (snapshotFailure !== null) return snapshotFailure;
      return runMemoryAction(query, "purge", policy);
    },

    async rebuildIndex(query: SkillsMemoryQuery): Promise<MemoryActionResult> {
      const snapshotFailure = await runSnapshotBeforeWrite("索引重建前自动备份");
      if (snapshotFailure !== null) return snapshotFailure;
      const resolved = resolveScope(query);
      if ("error" in resolved) {
        return { ok: false, instanceId: null, error: resolved.error, userHint: resolved.error };
      }
      if (deps.memoryDriver === undefined) {
        return {
          ok: false,
          instanceId: resolved.instance.instanceId,
          error: "memory-driver-unavailable",
          userHint: "该实例的此格式暂不支持重建索引",
        };
      }
      const result = await deps.core.invoke(
        () => deps.memoryDriver!.rebuildIndex(resolved.scope),
        { method: "rebuildIndex", instance: resolved.instance.instanceId },
      );
      if (result.ok && result.data !== undefined) {
        return { ok: true, instanceId: resolved.instance.instanceId, report: result.data };
      }
      return {
        ok: false,
        instanceId: resolved.instance.instanceId,
        code: result.error?.code,
        error: result.error?.message,
        userHint: result.error?.userHint,
      };
    },
    async exportEncrypted(query: SkillsMemoryQuery, passphrase: string): Promise<MemoryExportResult> {
      const resolved = resolveScope(query);
      if ("error" in resolved) {
        return { ok: false, instanceId: null, error: resolved.error, userHint: resolved.error };
      }
      if (passphrase.length < MEMORY_EXPORT_MIN_PASSPHRASE) {
        return {
          ok: false,
          instanceId: resolved.instance.instanceId,
          code: "passphrase-too-short",
          error: "passphrase-too-short",
          userHint: "口令至少 8 位，导出的加密文件才安全",
        };
      }
      const dbFile = join(resolved.instance.rootPath, "memory_store.db");
      if (!existsSync(dbFile)) {
        return {
          ok: false,
          instanceId: resolved.instance.instanceId,
          code: "memory-store-not-found",
          error: "memory-store-not-found",
          userHint: "未找到记忆库文件，无法导出",
        };
      }
      try {
        const exported = encryptMemoryDb(dbFile, passphrase, now);
        return {
          ok: true,
          instanceId: resolved.instance.instanceId,
          filename: exported.filename,
          data: exported.data,
          sizeBytes: exported.data.byteLength,
        };
      } catch (cause) {
        return {
          ok: false,
          instanceId: resolved.instance.instanceId,
          code: "memory-export-failed",
          error: "memory-export-failed",
          userHint: "导出失败：" + (cause instanceof Error ? cause.message : String(cause)),
        };
      }
    },

  };
}
