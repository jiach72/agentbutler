/**
 * 语义状态徽标：全站唯一的徽标渲染出口（antd Tag），
 * 页面不再各自手写 badge-pill 拼接。
 */
import { Tag } from "antd";
import { TONE_TAG_COLOR } from "../lib/badges.js";

export type SemanticTone = "ok" | "info" | "warn" | "error" | "muted" | "pulse";

interface StatusBadgeProps {
  tone: SemanticTone;
  label: React.ReactNode;
  title?: string;
}

export function StatusBadge({ tone, label, title }: StatusBadgeProps) {
  return (
    <Tag color={TONE_TAG_COLOR[tone]} title={title} style={{ marginInlineEnd: 0 }}>
      {label}
    </Tag>
  );
}
