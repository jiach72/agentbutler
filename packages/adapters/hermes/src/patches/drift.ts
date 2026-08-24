/**
 * 补丁漂移检测（Task 12 / Part A；Task 13 升级第四步 / Task 15 参数面板复用）。
 *
 * detect(patchId)：当前目标文件内容 vs 期望补丁块（原文 .orig 备份 + 已存参数的
 * transformations 重建）逐变换比对。同一目标文件可叠加多条登记补丁，因此按
 * “补丁块是否完整在位”判定而非全文件相等：
 * - 全部变换的补丁块（replacement）都在位 → ok；
 * - 某补丁块缺失但官方锚原文回到原位（官方升级覆盖/用户手工还原）→ piece-missing；
 * - 锚与补丁块均不可寻（区域被重写/参数被外部改动）→ region-unrecognized；
 * - 备份本身缺失全部锚（损坏或被覆盖）→ backup-invalid；
 * - 无 Butler 状态但源码存在同等手工实现 → observed（只读，不写 state.json）；
 * - 目标文件缺失 → missing-target；备份缺失 → missing-backup；未应用 → not-applied。
 * 差异摘要含锚序号、锚预览与上下文数行，供升级冲突检测与面板展示。
 */
import { join } from "node:path";
import { ok, fail, type Result } from "@butler/contract";
import { findPatch, type PatchDefinition, type PatchParams } from "./registry.js";
import {
  buildPatchedContent,
  normalizeRel,
  type FileReader,
  type PatchCallContext,
  type PatchState,
} from "./applier.js";

/** 单条差异摘要。 */
export interface DriftDiff {
  /** 变换序号（-1 = 备份整体无效）。 */
  anchorIndex: number;
  /** 锚首行预览（截断）。 */
  anchorPreview: string;
  reason: "piece-missing" | "region-unrecognized" | "backup-invalid";
  /** 差异点上下文行（前后各 3 行）。 */
  context: string[];
}

export interface DriftReport {
  patchId: string;
  status: "ok" | "observed" | "drifted" | "not-applied" | "missing-target" | "missing-backup";
  /** 应用时使用的参数（已应用时存在）。 */
  params?: PatchParams;
  appliedAt?: string;
  targetPath?: string;
  diffs: DriftDiff[];
  checkedAt: string;
}

export interface DetectDeps {
  context: PatchCallContext;
  rootPath?: string;
  readFile: FileReader;
  patchesDir: string;
  now: () => number;
}

/** 锚首行预览（≤80 字符 + 行数标注）。 */
function previewOf(def: PatchDefinition, index: number): string {
  const anchor = def.transformations[index]?.anchorFind ?? "";
  const lines = anchor.split("\n");
  const firstLine = lines[0] ?? "";
  const trimmed = firstLine.trim();
  return `${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}（${lines.length} 行锚）`;
}

/** needle 在 content 中的行号上下文（±3 行）；needle 不可寻时回退其首行搜索。 */
function linesAround(content: string, needle: string, looseNeedle: string): string[] {
  const lines = content.split("\n");
  let hitLine = -1;
  const idx = content.indexOf(needle);
  if (idx >= 0) {
    hitLine = content.slice(0, idx).split("\n").length - 1;
  } else {
    const looseIdx = content.indexOf(looseNeedle);
    if (looseIdx >= 0) hitLine = content.slice(0, looseIdx).split("\n").length - 1;
  }
  if (hitLine < 0) return ["（未在当前文件中找到锚的首行）"];
  const from = Math.max(0, hitLine - 3);
  const to = Math.min(lines.length - 1, hitLine + 3);
  return lines.slice(from, to + 1).map((line, i) => `${from + i + 1}: ${line}`);
}

/** 漂移检测实现（由 createPatchManager().detect 调用）。 */
export async function detectPatch(patchId: string, deps: DetectDeps): Promise<Result<DriftReport>> {
  const def = findPatch(patchId);
  if (!def) {
    return fail("E002", `unknown patch id: ${patchId}`, {
      userHint: `未知补丁 ${patchId}（未登记于补丁登记表）`,
    });
  }
  const rootPath = deps.context.rootPath ?? deps.rootPath;
  if (!rootPath) {
    return fail("E002", "rootPath is required (option or call context)", {
      userHint: "缺少 hermes 实例根路径",
    });
  }
  const targetPath = join(rootPath, ...normalizeRel(def.target).split("/"));
  const checkedAt = new Date(deps.now()).toISOString();

  let state: PatchState;
  try {
    state = JSON.parse(await deps.readFile(join(deps.patchesDir, "state.json"))) as PatchState;
  } catch {
    state = { applied: {} };
  }
  const stored = state.applied?.[patchId];
  if (stored === undefined) {
    let content: string;
    try {
      content = await deps.readFile(targetPath);
    } catch {
      return ok({ patchId, status: "missing-target", targetPath, diffs: [], checkedAt });
    }
    const observedParams = def.observe?.(content) ?? null;
    return ok({
      patchId,
      status: observedParams === null ? "not-applied" : "observed",
      ...(observedParams === null ? {} : { params: observedParams }),
      targetPath,
      diffs: [],
      checkedAt,
    });
  }

  let content: string;
  try {
    content = await deps.readFile(targetPath);
  } catch {
    return ok({
      patchId,
      status: "missing-target",
      params: stored.params,
      appliedAt: stored.appliedAt,
      targetPath,
      diffs: [],
      checkedAt,
    });
  }

  let backup: string;
  try {
    backup = await deps.readFile(join(deps.patchesDir, `${patchId}.orig`));
  } catch {
    return ok({
      patchId,
      status: "missing-backup",
      params: stored.params,
      appliedAt: stored.appliedAt,
      targetPath,
      diffs: [],
      checkedAt,
    });
  }

  const base = {
    patchId,
    params: stored.params,
    appliedAt: stored.appliedAt,
    targetPath,
    checkedAt,
  };
  const expected = buildPatchedContent(def, backup, stored.params);
  if (!expected.ok) {
    // 备份本身不含全部锚 → 备份不是可用的官方原文（损坏或被覆盖）。
    return ok({
      ...base,
      status: "drifted",
      diffs: [
        {
          anchorIndex: -1,
          anchorPreview: "backup",
          reason: "backup-invalid",
          context: [expected.error?.message ?? ""],
        },
      ],
    });
  }

  const diffs: DriftDiff[] = [];
  for (let i = 0; i < def.transformations.length; i += 1) {
    const t = def.transformations[i]!;
    const replacement = t.replacement(stored.params);
    if (content.includes(replacement)) continue; // 该补丁块完整在位
    const firstAnchorLine = t.anchorFind.split("\n")[0] ?? "";
    diffs.push({
      anchorIndex: i,
      anchorPreview: previewOf(def, i),
      reason: content.includes(t.anchorFind) ? "piece-missing" : "region-unrecognized",
      context: linesAround(content, t.anchorFind, firstAnchorLine),
    });
  }
  if (diffs.length === 0) {
    return ok({ ...base, status: "ok", diffs: [] });
  }
  return ok({ ...base, status: "drifted", diffs });
}
