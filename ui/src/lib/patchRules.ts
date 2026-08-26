/**
 * 网关补丁参数规则：草稿数值解析与跨补丁不变式校验的唯一出口。
 *
 * 规则来源：原 Gateway 页 parsePatchParams 的交叉校验不变式——
 * 「静默后首条延迟不能超过发送间隔」，即
 * wx-silent-first-delay.silentFirstDelaySec ≤ wx-send-throttle.minSendIntervalSec；
 * 违反时服务端会拒绝应用，这里在前置完成同样的校验以给出即时反馈。
 */

/** 补丁参数输入形态：params 值允许数字或未解析的草稿字符串。 */
export interface GatewayPatchRuleInput {
  id: string;
  params?: Record<string, unknown>;
}

/** 参数约束 schema（与 /api/gateway 返回的 params 单项一致）。 */
export interface PatchParamRuleSchema {
  default: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

const THROTTLE_PATCH_ID = "wx-send-throttle";
const SILENT_PATCH_ID = "wx-silent-first-delay";
const THROTTLE_PARAM = "minSendIntervalSec";
const SILENT_PARAM = "silentFirstDelaySec";

/** 数值解析：数字直通；字符串去空白后转数字；空串或非法值返回 undefined（视为沿用已生效值/默认值）。 */
export function parsePatchNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPatchParam(
  patch: GatewayPatchRuleInput | undefined,
  param: string,
): number | undefined {
  const raw = patch?.params?.[param];
  return raw === undefined ? undefined : parsePatchNumber(raw);
}

/** 单参数 schema 校验：整数 / 下界 / 上界；通过返回 null。 */
export function validatePatchParamAgainstSchema(
  param: string,
  value: number,
  schema: PatchParamRuleSchema,
  t: (key: string) => string,
): string | null {
  const label = t(param);
  if (schema.integer === true && !Number.isInteger(value)) return `${label}必须是整数`;
  if (schema.min !== undefined && value < schema.min) return `${label}不能低于 ${schema.min}`;
  if (schema.max !== undefined && value > schema.max) return `${label}不能高于 ${schema.max}`;
  return null;
}

/**
 * 批量校验全部补丁参数，返回 patchId → 错误文案（空对象表示全部通过）。
 * 交叉不变式违反时会同时登记在两个相关补丁上，任一侧的应用动作都应被拦截。
 * t 用于把参数名翻译成展示标签，缺省原样返回键名。
 */
export function validateGatewayPatches(
  patches: Array<GatewayPatchRuleInput>,
  t?: (key: string) => string,
): Record<string, string> {
  const label = t ?? ((key: string): string => key);
  const errors: Record<string, string> = {};
  for (const patch of patches) {
    for (const [name, value] of Object.entries(patch.params ?? {})) {
      if (parsePatchNumber(value) !== undefined) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      errors[patch.id] = `${label(name)}必须是数字`;
      break;
    }
  }
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  const interval = readPatchParam(byId.get(THROTTLE_PATCH_ID), THROTTLE_PARAM);
  const firstDelay = readPatchParam(byId.get(SILENT_PATCH_ID), SILENT_PARAM);
  if (interval !== undefined && firstDelay !== undefined && firstDelay > interval) {
    const text = `静默后首条延迟 ${firstDelay}s 不能超过发送间隔 ${interval}s`;
    errors[THROTTLE_PATCH_ID] ??= text;
    errors[SILENT_PATCH_ID] = text;
  }
  return errors;
}
