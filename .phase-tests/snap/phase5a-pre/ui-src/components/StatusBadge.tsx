/**
 * 语义状态徽标：全站唯一的徽标渲染出口。
 *
 * 规范依据 docs/brand/03 §3.2（tone 全集与样式）+ 02 §4.4（状态图标固定映射）。
 *
 * v2.0 变更：
 *   · tone 收敛为规范定义的 6 种：ok / warn / error / offline / unknown / brand。
 *     删除 `pulse`（紫色不在品牌色板内）与 `info`（蓝是交互色，不进徽标语义）。
 *   · 取色改走品牌信号色（--ab-* 变量），不再用 antd 预设色名 ——
 *     预设色名由 antd 算法派生，与品牌信号色不是同一个值。
 *   · 补齐状态图标（02 §4.4 固定映射），满足"状态不能只靠颜色"：
 *     颜色 + 图标 + 文字三者齐备。
 *
 * 样式见 styles/primitives.css 的 .status-badge（高度 22 / padding 8 / 字号 12 / 字重 500 / 圆角 6）。
 */
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DisconnectOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";

/** 规范 03 §3.2 定义的徽标语义全集，不增不减。 */
export type SemanticTone = "ok" | "warn" | "error" | "offline" | "unknown" | "brand";

/** 02 §4.4 固定映射：状态图标不许换。brand 是标记（推荐/当前版本/已备份），不带状态图标。 */
const TONE_ICON: Record<SemanticTone, React.ReactNode> = {
  ok: <CheckCircleFilled aria-hidden="true" />,
  warn: <ExclamationCircleFilled aria-hidden="true" />,
  error: <CloseCircleFilled aria-hidden="true" />,
  offline: <DisconnectOutlined aria-hidden="true" />,
  unknown: <ClockCircleOutlined aria-hidden="true" />,
  brand: null,
};

/** 各 tone 的兜底说明，供只有图标语义的场合补 title。 */
export const TONE_TITLE: Record<SemanticTone, string> = {
  ok: "正常",
  warn: "提醒",
  error: "异常",
  offline: "离线",
  unknown: "读取中",
  brand: "标记",
};

interface StatusBadgeProps {
  tone: SemanticTone;
  label: React.ReactNode;
  title?: string;
}

export function StatusBadge({ tone, label, title }: StatusBadgeProps) {
  return (
    <span className="status-badge" data-tone={tone} title={title}>
      {TONE_ICON[tone]}
      <span className="status-badge-label">{label}</span>
    </span>
  );
}
