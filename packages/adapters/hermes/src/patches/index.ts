/**
 * 补丁管理器（Task 12 / Part A）公开出口。
 *
 * createPatchManager 与 createHermesAdapter 并列的独立工厂：登记表（registry）
 * + 应用器（applier）+ 漂移检测（drift）。目标文件仅限登记表白名单
 * （hermes-agent/gateway/platforms/weixin.py），补丁工作目录默认 <BUTLER_HOME>/patches。
 */
export {
  PATCH_REGISTRY,
  findPatch,
  isWhitelistedTarget,
  type PatchDefinition,
  type PatchParamSchema,
  type PatchParams,
  type PatchTransformation,
} from "./registry.js";
export {
  MIN_SEND_INTERVAL_HARD_FLOOR_SEC,
  buildPatchedContent,
  createPatchManager,
  normalizeRel,
  resolvePatchParams,
  type AppliedEntry,
  type ApplyOutcome,
  type FileReader,
  type FileWriter,
  type PatchCallContext,
  type PatchManager,
  type PatchManagerOptions,
  type PatchState,
} from "./applier.js";
export type { DriftDiff, DriftReport } from "./drift.js";
