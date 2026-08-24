/**
 * 补丁应用器（Task 12 / Part A）。
 *
 * apply(patchId, params)：读目标文件 → 校验全部锚点可寻且唯一 → 首次应用前备份
 * 原文到 <patchesDir>/<patchId>.orig → 生成补丁内容写回；已应用且当前内容与
 * 期望一致 → 幂等返回 already-applied；不一致 → 拒绝写入（漂移，先 detect/reapply）。
 *
 * reapply(patchId, params, { targetContent? })：从 .orig 备份（或调用方覆盖的
 * 新官方原文）重建补丁——升级后官方文件更新场景由 Task 13 复用（传 targetContent
 * 同时把它落为新的 .orig 基线）；未应用时等价首次应用。
 *
 * 写入白名单：只写登记表 target 精确匹配的路径（isWhitelistedTarget，路径 POSIX
 * 归一化后比对），白名单外一律 E203 拒绝；参数越界 E002（minSendIntervalSec ≥ 45
 * 为 M3 硬边界）。
 *
 * 状态持久化：<patchesDir>/state.json（applied 补丁、参数、时间戳、目标路径）。
 * patchesDir 默认 <BUTLER_HOME>/patches；readFile/writeFile 可注入（测试）。
 */
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ok, fail, type FailResult, type OkResult, type Result } from "@butler/contract";
import { resolveButlerHome } from "@butler/core";
import {
  findPatch,
  isWhitelistedTarget,
  PATCH_REGISTRY,
  type PatchDefinition,
  type PatchParams,
} from "./registry.js";
import { detectPatch } from "./drift.js";
import type { DriftReport } from "./drift.js";

/** 可注入文件读（默认 node:fs/promises readFile utf8）。 */
export type FileReader = (path: string) => Promise<string>;
/** 可注入文件写（默认实现含父目录递归创建）。 */
export type FileWriter = (path: string, content: string) => Promise<void>;

export interface PatchManagerOptions {
  /** hermes 实例根路径（缺省时 apply/reapply/detect 需在 context 中传入）。 */
  rootPath?: string;
  /** 补丁工作目录（备份 + state.json）；默认 <BUTLER_HOME>/patches。 */
  patchesDir?: string;
  readFile?: FileReader;
  writeFile?: FileWriter;
  now?: () => number;
}

/** 单次调用的上下文（rootPath 覆盖 / 升级场景的新官方原文覆盖）。 */
export interface PatchCallContext {
  rootPath?: string;
  /** 覆盖读源（Task 13：升级后官方文件更新的新原文；同时成为 reapply 的新备份基线）。 */
  targetContent?: string;
}

export type ApplyOutcome =
  | { status: "applied"; targetPath: string; params: PatchParams }
  | { status: "already-applied"; targetPath: string; params: PatchParams };

/** state.json 中单条已应用补丁的记录（Task 15 参数面板经 state() 只读暴露）。 */
export interface AppliedEntry {
  params: PatchParams;
  appliedAt: string;
  targetPath: string;
}

/** prepare() 产物：登记定义 + 解析后的根路径/目标路径/参数。 */
interface PreparedPatch {
  def: PatchDefinition;
  rootPath: string;
  targetPath: string;
  params: PatchParams;
}

export interface PatchState {
  applied: Record<string, AppliedEntry>;
}

export interface PatchManager {
  apply(
    patchId: string,
    params?: PatchParams,
    context?: PatchCallContext,
  ): Promise<Result<ApplyOutcome>>;
  reapply(
    patchId: string,
    params?: PatchParams,
    context?: PatchCallContext,
  ): Promise<Result<ApplyOutcome>>;
  detect(patchId: string, context?: PatchCallContext): Promise<Result<DriftReport>>;
  /** 登记表元信息（Task 15 参数面板）。 */
  listPatches(): PatchDefinition[];
  /** 只读快照：state.json 的 applied 段（Task 15 参数面板 / 建议引擎）。 */
  state(): Promise<Record<string, AppliedEntry>>;
}

/** 发送间隔参数下限（M3 硬边界，低于即拒绝）。 */
export const MIN_SEND_INTERVAL_HARD_FLOOR_SEC = 45;

const defaultReadFile: FileReader = (path) => fsReadFile(path, "utf8");
const defaultWriteFile: FileWriter = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content, "utf8");
};

/** 路径 POSIX 归一化（反斜杠 → 正斜杠，去重复分隔符）。 */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** 按登记 schema 解析参数：缺省补默认值，越界/非数值 → E002。 */
export function resolvePatchParams(
  def: PatchDefinition,
  params: PatchParams,
): OkResult<PatchParams> | FailResult<PatchParams> {
  const resolved: PatchParams = {};
  for (const [key, schema] of Object.entries(def.params)) {
    const raw = params[key] ?? schema.default;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return fail(
        "E002",
        `patch ${def.id} param ${key} must be a finite number (got ${String(raw)})`,
        {
          userHint: `参数 ${key} 必须是有限数值`,
        },
      );
    }
    if (schema.integer && !Number.isInteger(raw)) {
      return fail("E002", `patch ${def.id} param ${key} must be an integer (got ${raw})`, {
        userHint: `参数 ${key} 必须是整数`,
      });
    }
    if (schema.min !== undefined && raw < schema.min) {
      const hardFloor =
        key === "minSendIntervalSec" && schema.min === MIN_SEND_INTERVAL_HARD_FLOOR_SEC;
      return fail(
        "E002",
        `patch ${def.id} param ${key} = ${raw} below floor ${schema.min}${hardFloor ? " (M3 hard boundary)" : ""}`,
        {
          userHint: hardFloor
            ? `发送间隔下限 ${schema.min} 秒为 M3 硬边界，不能低于该值`
            : `参数 ${key} 不能低于 ${schema.min}`,
        },
      );
    }
    if (schema.max !== undefined && raw > schema.max) {
      return fail("E002", `patch ${def.id} param ${key} = ${raw} above ceiling ${schema.max}`, {
        userHint: `参数 ${key} 不能高于 ${schema.max}`,
      });
    }
    resolved[key] = raw;
  }
  return ok(resolved);
}

/**
 * 在基线内容上依序应用全部变换：每个锚点必须恰好出现一次
 * （缺失 → 漂移拒绝；重复 → 歧义拒绝），替换保序。
 */
export function buildPatchedContent(
  def: PatchDefinition,
  base: string,
  params: PatchParams,
): OkResult<string> | FailResult<string> {
  let content = base;
  for (let i = 0; i < def.transformations.length; i += 1) {
    const t = def.transformations[i]!;
    const first = content.indexOf(t.anchorFind);
    if (first < 0) {
      return fail(
        "E203",
        `patch ${def.id} transformation #${i} anchor not found in target (official code drifted?)`,
        { userHint: `第 ${i + 1} 处锚点未找到，目标文件可能已升级或被改动，拒绝写入` },
      );
    }
    if (content.indexOf(t.anchorFind, first + 1) >= 0) {
      return fail("E203", `patch ${def.id} transformation #${i} anchor matches twice (ambiguous)`, {
        userHint: `第 ${i + 1} 处锚点出现多次，无法唯一定位，拒绝写入`,
      });
    }
    content = content.replace(t.anchorFind, t.replacement(params));
  }
  return ok(content);
}

/** 组装补丁管理器（与 createHermesAdapter 并列的独立工厂）。 */
export function createPatchManager(options: PatchManagerOptions = {}): PatchManager {
  const patchesDir = options.patchesDir ?? join(resolveButlerHome(), "patches");
  const readFile = options.readFile ?? defaultReadFile;
  const writeFile = options.writeFile ?? defaultWriteFile;
  const now = options.now ?? Date.now;

  const statePath = join(patchesDir, "state.json");
  const backupPathOf = (patchId: string): string => join(patchesDir, `${patchId}.orig`);
  const targetPathOf = (def: PatchDefinition, rootPath: string): string =>
    join(rootPath, ...normalizeRel(def.target).split("/"));

  async function readState(): Promise<PatchState> {
    try {
      const parsed = JSON.parse(await readFile(statePath)) as PatchState;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.applied === "object" &&
        parsed.applied !== null
      ) {
        return { applied: parsed.applied };
      }
    } catch {
      // 缺失/损坏 → 视为空状态（首次使用）。
    }
    return { applied: {} };
  }

  async function writeState(state: PatchState): Promise<void> {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** 公共前置：登记查找 + rootPath 解析 + 白名单校验 + 参数解析。 */
  function prepare(
    patchId: string,
    params: PatchParams,
    context: PatchCallContext,
  ): OkResult<PreparedPatch> | FailResult<PreparedPatch> {
    const def = findPatch(patchId);
    if (!def) {
      return fail("E002", `unknown patch id: ${patchId}`, {
        userHint: `未知补丁 ${patchId}（未登记于补丁登记表）`,
      });
    }
    const rootPath = context.rootPath ?? options.rootPath;
    if (!rootPath) {
      return fail("E002", "rootPath is required (option or call context)", {
        userHint: "缺少 hermes 实例根路径",
      });
    }
    const rel = normalizeRel(def.target);
    if (!isWhitelistedTarget(rel)) {
      return fail("E203", `target ${rel} is outside the patch write whitelist`, {
        userHint: `目标 ${rel} 不在补丁写入白名单内，已拒绝`,
      });
    }
    const resolvedParams = resolvePatchParams(def, params);
    if (!resolvedParams.ok) return resolvedParams;
    return ok({
      def,
      rootPath,
      targetPath: targetPathOf(def, rootPath),
      params: resolvedParams.data,
    });
  }

  async function apply(
    patchId: string,
    params: PatchParams = {},
    context: PatchCallContext = {},
  ): Promise<Result<ApplyOutcome>> {
    const prepared = prepare(patchId, params, context);
    if (!prepared.ok) return prepared;
    const { def, targetPath, params: resolved } = prepared.data;

    const state = await readState();
    let content: string;
    try {
      content = await readFile(targetPath);
    } catch {
      return fail("E203", `target file missing: ${targetPath}`, {
        userHint: `目标文件不存在：${targetPath}`,
      });
    }

    const stored = state.applied[patchId];
    if (stored !== undefined) {
      // 已应用：按已存参数逐变换检查补丁块是否完整在位（同一文件可叠加多条补丁，
      // 不做全文件相等比较）；全部在位 → 幂等；否则 → 拒绝写入（漂移）。
      const piecesIntact = def.transformations.every((t) =>
        content.includes(t.replacement(stored.params)),
      );
      if (piecesIntact) {
        return ok({ status: "already-applied", targetPath, params: stored.params });
      }
      return fail(
        "E203",
        `patch ${patchId} applied but its patched blocks are missing/altered (drift?)`,
        {
          userHint: "补丁已应用但补丁块缺失或被改动（可能漂移），请先 detect 检查或 reapply 重打",
        },
      );
    }

    for (const req of def.requires ?? []) {
      if (!state.applied[req]) {
        return fail("E203", `patch ${patchId} requires patch ${req} applied first`, {
          userHint: `需先应用前置补丁 ${req}`,
        });
      }
    }

    const patched = buildPatchedContent(def, content, resolved);
    if (!patched.ok) return patched; // 锚点漂移 → 不写入

    await writeFile(backupPathOf(patchId), content); // 首次应用前备份官方原文
    await writeFile(targetPath, patched.data);
    state.applied[patchId] = {
      params: resolved,
      appliedAt: new Date(now()).toISOString(),
      targetPath,
    };
    await writeState(state);
    return ok({ status: "applied", targetPath, params: resolved });
  }

  async function reapply(
    patchId: string,
    params: PatchParams = {},
    context: PatchCallContext = {},
  ): Promise<Result<ApplyOutcome>> {
    const prepared = prepare(patchId, params, context);
    if (!prepared.ok) return prepared;
    const { def, targetPath, params: resolved } = prepared.data;

    const state = await readState();
    if (state.applied[patchId] === undefined) {
      return apply(patchId, params, context); // 未应用 → 等价首次应用
    }
    for (const req of def.requires ?? []) {
      if (req !== patchId && !state.applied[req]) {
        return fail("E203", `patch ${patchId} requires patch ${req} applied first`, {
          userHint: `需先应用前置补丁 ${req}`,
        });
      }
    }

    let base: string;
    if (context.targetContent !== undefined) {
      base = context.targetContent; // 升级场景：新官方原文成为新基线
      await writeFile(backupPathOf(patchId), base);
    } else {
      try {
        base = await readFile(backupPathOf(patchId));
      } catch {
        return fail("E203", `patch ${patchId} backup .orig missing, cannot reapply`, {
          userHint: "原始备份缺失，无法重打（可传 targetContent 提供新原文）",
        });
      }
    }

    const patched = buildPatchedContent(def, base, resolved);
    if (!patched.ok) return patched;

    await writeFile(targetPath, patched.data);
    state.applied[patchId] = {
      params: resolved,
      appliedAt: new Date(now()).toISOString(),
      targetPath,
    };
    await writeState(state);
    return ok({ status: "applied", targetPath, params: resolved });
  }

  async function detect(
    patchId: string,
    context: PatchCallContext = {},
  ): Promise<Result<DriftReport>> {
    return detectPatch(patchId, {
      context,
      rootPath: options.rootPath,
      readFile,
      patchesDir,
      now,
    });
  }

  /** 只读快照：当前 state.json 的 applied 段（每次调用重读，无内存缓存）。 */
  async function state(): Promise<Record<string, AppliedEntry>> {
    return (await readState()).applied;
  }

  return { apply, reapply, detect, listPatches: () => [...PATCH_REGISTRY], state };
}
