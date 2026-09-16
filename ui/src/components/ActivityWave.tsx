/**
 * 管家实时活动微波形（Activity Wave）：
 * 3 柱纯 CSS 驱动的事件心跳指示器，灵感源自 Uiverse 精致音频与心跳微动效。
 *
 * 作用：
 * - 嵌入到日志流头部、探针活跃态或顶栏，直观传达 Agent 正在监听事件或流式输出；
 * - 零 JS 动效开销，严格遵循 prefers-reduced-motion 降级与 ARIA 状态语义。
 */
import type { CSSProperties } from "react";

export interface ActivityWaveProps {
  /** 是否处于活跃波动状态，默认 true。为 false 时呈现安静的低平静态状态。 */
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  /** 供屏幕阅读器读取的状态描述，如"管家正在监听事件" */
  label?: string;
}

export function ActivityWave({
  active = true,
  className,
  style,
  label = "管家正在监听事件",
}: ActivityWaveProps) {
  return (
    <span
      className={`ab-activity-wave${active ? " is-active" : " is-idle"}${className ? ` ${className}` : ""}`}
      style={style}
      role="status"
      aria-label={label}
    >
      <span
        className="ab-wave-bar"
        aria-hidden="true"
        style={active ? undefined : { animation: "none", transform: "scaleY(0.3)" }}
      />
      <span
        className="ab-wave-bar"
        aria-hidden="true"
        style={active ? undefined : { animation: "none", transform: "scaleY(0.3)" }}
      />
      <span
        className="ab-wave-bar"
        aria-hidden="true"
        style={active ? undefined : { animation: "none", transform: "scaleY(0.3)" }}
      />
    </span>
  );
}
