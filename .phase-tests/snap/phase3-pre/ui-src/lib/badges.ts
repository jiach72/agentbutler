/**
 * 语义状态色调：全站徽标的唯一映射表。
 * 页面只负责把领域状态翻译成语义 tone，视觉呈现统一交给 <StatusBadge>。
 *
 * v2.0 迁移对照（v1.2 → v2.0，规范 03 §3.2 只认右列 6 种）：
 *
 * | v1.2 tone | v2.0 tone | 理由 |
 * |---|---|---|
 * | ok / warn / error | 同名保留 | — |
 * | muted（中性） | `unknown`（还不知道）/ `offline`（确定连不上、未接入） | 规范 §1.4 要求这两态文案分开，不许都用"未知"糊过去 |
 * | muted +「当前版本」 | `brand` | §3.2 把「推荐 / 当前版本 / 已备份」划给 brand |
 * | info（蓝） | `brand` | 蓝是交互色（§1.1），不进徽标语义；「推荐」正是 brand 的规范用例 |
 * | pulse（紫） | `unknown` | 紫色不在品牌色板内；语气是「进行中」，结果尚未可知 |
 */
import type { SemanticTone } from "../components/StatusBadge.js";

/** 旧 CSS 契约类 → 语义 tone，供迁移期对照。 */
export type LegacyBadgeClass =
  | "badge-healthy"
  | "badge-degraded"
  | "badge-down"
  | "badge-muted"
  | "badge-pulse";

export const toneOfLegacyClass: Record<LegacyBadgeClass, SemanticTone> = {
  "badge-healthy": "ok",
  "badge-degraded": "warn",
  "badge-down": "error",
  "badge-muted": "unknown",
  "badge-pulse": "unknown",
};

/**
 * 文案 → 中性态的二选一判定。
 *
 * 规范 02 §1.4 明确要求区分：
 *   · offline 是"确定连不上 / 未启动 / 未接入"
 *   · unknown 是"还没读到数据"
 * 两者同色，只能靠文案区分，所以这里用关键词做判定，避免全都退化成"未知"。
 */
const OFFLINE_HINTS = ["未接入", "未配置", "未启动", "已停止", "停止", "连不上", "离线", "不可达"];

export function neutralToneFor(label: string): SemanticTone {
  return OFFLINE_HINTS.some((hint) => label.includes(hint)) ? "offline" : "unknown";
}
