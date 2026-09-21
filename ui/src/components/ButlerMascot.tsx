/**
 * C2 管家吉祥物组件 (Butler Mascot)
 * 基于选定的 C2 方圆机器人 IP 形象，提供多档状态微表情（就绪、警惕、故障、离线、巡检中）。
 */
import { type FC } from "react";
import { Tooltip } from "antd";

export type ButlerMascotStatus = "normal" | "alert" | "blocked" | "offline" | "inspecting" | "idle";

export interface ButlerMascotProps {
  status?: ButlerMascotStatus;
  size?: "sm" | "md" | "lg";
  className?: string;
  onClick?: () => void;
  tooltipText?: string;
}

const SIZE_MAP = {
  sm: 32,
  md: 48,
  lg: 64,
};

const VISOR_COLORS: Record<ButlerMascotStatus, { fill: string; border: string; label: string }> = {
  normal: { fill: "#BFE8C4", border: "#22C55E", label: "就绪待命 · 运行平稳" },
  idle: { fill: "#BFE8C4", border: "#22C55E", label: "就绪待命" },
  alert: { fill: "#FED7AA", border: "#F59E0B", label: "需留意 · 存在提醒事项" },
  blocked: { fill: "#FECACA", border: "#EF4444", label: "异常阻断 · 需要检查" },
  offline: { fill: "#E2E8F0", border: "#94A3B8", label: "管家离线 · 连接未就绪" },
  inspecting: { fill: "#BAE6FD", border: "#0EA5E9", label: "正在巡检诊断中…" },
};

export const ButlerMascot: FC<ButlerMascotProps> = ({
  status = "normal",
  size = "md",
  className = "",
  onClick,
  tooltipText,
}) => {
  const pixelSize = SIZE_MAP[size];
  const visor = VISOR_COLORS[status] || VISOR_COLORS.normal;
  const tip = tooltipText ?? `C2 管家状态：${visor.label}`;

  const renderEyes = () => {
    switch (status) {
      case "offline":
        // 睡眠闭眼弧线 ︶ ︶
        return (
          <>
            <path d="M40 52 Q44 56 48 52" fill="none" stroke="#282D34" strokeWidth="2.8" strokeLinecap="round" />
            <path d="M72 52 Q76 56 80 52" fill="none" stroke="#282D34" strokeWidth="2.8" strokeLinecap="round" />
          </>
        );
      case "blocked":
        // 故障晕眩横线 — —
        return (
          <>
            <line x1="39" y1="51" x2="49" y2="51" stroke="#282D34" strokeWidth="3" strokeLinecap="round" />
            <line x1="71" y1="51" x2="81" y2="51" stroke="#282D34" strokeWidth="3" strokeLinecap="round" />
          </>
        );
      case "alert":
        // 警觉圆睁眼睛
        return (
          <>
            <circle cx="44" cy="50" r="5.5" fill="#282D34" />
            <circle cx="76" cy="50" r="5.5" fill="#282D34" />
          </>
        );
      case "inspecting":
        // 巡检专注小眼神
        return (
          <>
            <ellipse cx="44" cy="50" rx="4.5" ry="5.5" fill="#282D34" />
            <ellipse cx="76" cy="50" rx="4.5" ry="5.5" fill="#282D34" />
            <circle cx="45.5" cy="48.5" r="1.5" fill="#FFFFFF" />
            <circle cx="77.5" cy="48.5" r="1.5" fill="#FFFFFF" />
          </>
        );
      case "normal":
      case "idle":
      default:
        // 萌萌温和双眼 + 柔和高光
        return (
          <>
            <ellipse cx="44" cy="50" rx="5" ry="5.5" fill="#282D34" />
            <ellipse cx="76" cy="50" rx="5" ry="5.5" fill="#282D34" />
            <circle cx="46" cy="48" r="1.6" fill="#FFFFFF" />
            <circle cx="78" cy="48" r="1.6" fill="#FFFFFF" />
          </>
        );
    }
  };

  const renderMouth = () => {
    if (status === "offline") return null;
    if (status === "blocked") {
      return <line x1="56" y1="57" x2="64" y2="57" stroke="#282D34" strokeWidth="2.2" strokeLinecap="round" />;
    }
    if (status === "alert") {
      return <circle cx="60" cy="57" r="1.8" fill="#282D34" />;
    }
    // normal / inspecting 浅浅微笑弧线
    return <path d="M57 55 Q60 58.5 63 55" fill="none" stroke="#282D34" strokeWidth="2.2" strokeLinecap="round" />;
  };

  const svgContent = (
    <div
      className={`c2-butler-mascot c2-status-${status} ${className}`}
      style={{
        width: pixelSize,
        height: pixelSize,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: onClick ? "pointer" : "default",
        flexShrink: 0,
      }}
      onClick={onClick}
      role="img"
      aria-label={tip}
    >
      <svg
        viewBox="0 0 120 120"
        width="100%"
        height="100%"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 顶部天线 */}
        <rect x="56" y="8" width="8" height="14" rx="4" fill={visor.fill} />

        {/* 左右耳扣 */}
        <rect x="10" y="44" width="8" height="26" rx="4" fill="#1F242C" />
        <rect x="102" y="44" width="8" height="26" rx="4" fill="#1F242C" />

        {/* 主躯干 */}
        <rect x="15" y="18" width="90" height="94" rx="30" fill="#282D34" />

        {/* 状态视窗 */}
        <rect
          x="25"
          y="32"
          width="70"
          height="38"
          rx="19"
          fill={visor.fill}
          stroke={visor.border}
          strokeWidth="1.5"
        />

        {/* 眼睛与表情 */}
        {renderEyes()}
        {renderMouth()}

        {/* 腹部弧线 */}
        <path d="M36 112 C36 96, 84 96, 84 112 Z" fill={visor.fill} opacity="0.9" />
      </svg>
    </div>
  );

  return tip ? <Tooltip title={tip}>{svgContent}</Tooltip> : svgContent;
};
