import type { CSSProperties } from "react";

interface SparklineProps {
  values: number[];
  label: string;
  tone?: "accent" | "ok" | "warn" | "error";
  width?: number;
  height?: number;
}

export function Sparkline({
  values,
  label,
  tone = "accent",
  width = 96,
  height = 28,
}: SparklineProps) {
  const safeValues = values.filter((value) => Number.isFinite(value));
  const max = Math.max(...safeValues, 1);
  const min = Math.min(...safeValues, 0);
  const range = Math.max(max - min, 1);
  const points = safeValues
    .map((value, index) => {
      const x = safeValues.length <= 1 ? width / 2 : (index / (safeValues.length - 1)) * width;
      const y = height - 4 - ((value - min) / range) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const style = { "--sparkline-color": `var(--butler-${tone})` } as CSSProperties;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      style={style}
    >
      {points !== "" ? (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      ) : (
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="currentColor" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
