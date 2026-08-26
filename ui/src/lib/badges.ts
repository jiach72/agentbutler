/**
 * 语义状态色调：全站徽标的唯一映射表。
 * 页面只负责把领域状态翻译成语义 tone，视觉呈现统一交给 <StatusBadge>。
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
  "badge-muted": "muted",
  "badge-pulse": "pulse",
};

export const TONE_TAG_COLOR: Record<SemanticTone, string> = {
  ok: "green",
  info: "blue",
  warn: "gold",
  error: "red",
  muted: "default",
  pulse: "purple",
};
