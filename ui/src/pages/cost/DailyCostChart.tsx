import { useMemo, useState } from "react";
import { Flex, Segmented } from "antd";
import { BarChartOutlined, LineChartOutlined } from "@ant-design/icons";
import { money } from "../../lib/format.js";

interface DayData {
  date: string;
  tokens: number;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

interface DailyCostChartProps {
  days: DayData[];
  maxDayCost: number;
  totalCost: number | null;
}

function getCubicBezierPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export function DailyCostChart({ days, maxDayCost, totalCost }: DailyCostChartProps) {
  const [viewMode, setViewMode] = useState<"bars" | "area">("bars");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const dayCount = days.length;
  const avgCost = useMemo(() => {
    if (totalCost === null || dayCount === 0) return 0;
    return totalCost / dayCount;
  }, [totalCost, dayCount]);

  const activeDay = hoveredIdx !== null ? days[hoveredIdx] : null;

  // SVG Area calculations
  const svgWidth = 800;
  const svgHeight = 140;
  const paddingX = 16;
  const paddingTop = 14;
  const paddingBottom = 16;
  const plotWidth = svgWidth - paddingX * 2;
  const plotHeight = svgHeight - paddingTop - paddingBottom;

  const points = useMemo(() => {
    if (dayCount === 0) return [];
    const max = Math.max(0.000001, maxDayCost);
    return days.map((day, idx) => {
      const cost = day.actualCostUsd ?? day.estimatedCostUsd ?? 0;
      const x = dayCount === 1 ? svgWidth / 2 : paddingX + (idx / (dayCount - 1)) * plotWidth;
      const y = paddingTop + plotHeight - (cost / max) * plotHeight;
      return { x, y, day, cost };
    });
  }, [days, dayCount, maxDayCost, plotWidth, plotHeight]);

  const splinePath = useMemo(() => getCubicBezierPath(points), [points]);
  const areaPath = useMemo(() => {
    if (points.length < 2) return "";
    const firstX = points[0].x;
    const lastX = points[points.length - 1].x;
    const bottomY = paddingTop + plotHeight;
    return `${splinePath} L ${lastX.toFixed(1)} ${bottomY} L ${firstX.toFixed(1)} ${bottomY} Z`;
  }, [splinePath, points, plotHeight]);

  // Selected date ticks for X-Axis (e.g. 5 distributed labels)
  const axisDateIndices = useMemo(() => {
    if (dayCount <= 5) return days.map((_, i) => i);
    return [
      0,
      Math.floor(dayCount * 0.25),
      Math.floor(dayCount * 0.5),
      Math.floor(dayCount * 0.75),
      dayCount - 1,
    ];
  }, [dayCount, days]);

  return (
    <div className="daily-cost-chart flex flex-col gap-3">
      {/* Top HUD: Summary Stats & Mode Switcher */}
      <Flex justify="space-between" align="center" wrap="wrap" gap={8} className="pb-1">
        <div>
          {activeDay !== null ? (
            <div className="flex items-center gap-3 animate-entrance">
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                {activeDay.date}
              </span>
              <span className="text-base font-bold font-mono text-on-surface">
                {money(activeDay.actualCostUsd ?? activeDay.estimatedCostUsd)}
              </span>
              <span className="text-xs text-on-surface-variant font-mono">
                {activeDay.tokens.toLocaleString()} tokens
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-4 text-xs font-mono text-on-surface-variant">
              <span>
                峰值 <strong className="text-on-surface font-semibold">{money(maxDayCost >= 0.000001 ? maxDayCost : 0)}</strong>
              </span>
              <span className="text-outline-variant/60">·</span>
              <span>
                日均 <strong className="text-on-surface font-semibold">{money(avgCost)}</strong>
              </span>
              <span className="text-outline-variant/60">·</span>
              <span>
                合计 <strong className="text-primary font-semibold">{money(totalCost)}</strong>
              </span>
            </div>
          )}
        </div>

        <Segmented
          size="small"
          value={viewMode}
          onChange={(val) => setViewMode(val as "bars" | "area")}
          options={[
            { value: "bars", icon: <BarChartOutlined />, label: "柱状分布" },
            { value: "area", icon: <LineChartOutlined />, label: "平滑趋势" },
          ]}
        />
      </Flex>

      {/* Main Chart Area */}
      {viewMode === "bars" ? (
        <div
          className="relative w-full h-[140px] pt-4 pb-2 px-1 flex items-end gap-1 select-none"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {/* Subtle horizontal reference lines */}
          <div className="absolute inset-x-0 top-4 border-b border-dashed border-outline-variant/20 pointer-events-none" />
          <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-outline-variant/15 pointer-events-none" />
          <div className="absolute inset-x-0 bottom-2 border-b border-outline-variant/30 pointer-events-none" />

          {days.map((day, idx) => {
            const cost = day.actualCostUsd ?? day.estimatedCostUsd ?? 0;
            const pct = Math.max(3, Math.round((cost / Math.max(0.000001, maxDayCost)) * 100));
            const isHovered = hoveredIdx === idx;
            const isAnyHovered = hoveredIdx !== null;

            return (
              <div
                key={day.date}
                className="relative flex-1 h-full flex items-end justify-center group cursor-pointer"
                onMouseEnter={() => setHoveredIdx(idx)}
                tabIndex={0}
                role="img"
                aria-label={`${day.date}：${money(cost)}`}
              >
                {/* Full-height pill background track */}
                <div
                  className={`w-full h-full rounded-[4px] transition-colors duration-150 ${
                    isHovered ? "bg-primary/10" : "bg-primary/[0.025]"
                  }`}
                />

                {/* Animated bar capsule with gradient and rounded cap */}
                <div
                  className="absolute bottom-0 w-full transition-all duration-200"
                  style={{
                    height: `${pct}%`,
                    borderRadius: "4px 4px 1.5px 1.5px",
                    background: isHovered
                      ? "linear-gradient(180deg, #0071e3 0%, #2997ff 100%)"
                      : "linear-gradient(180deg, #0071e3 0%, rgba(0, 113, 227, 0.45) 100%)",
                    boxShadow: isHovered
                      ? "0 0 12px rgba(0, 113, 227, 0.45), 0 2px 4px rgba(0, 0, 0, 0.1)"
                      : "none",
                    opacity: isAnyHovered && !isHovered ? 0.45 : 1,
                    transform: isHovered ? "translateY(-1.5px)" : "none",
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : (
        /* Smooth Spline Area Curve View */
        <div
          className="relative w-full h-[140px] select-none"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {/* Subtle horizontal reference lines */}
          <div className="absolute inset-x-0 top-[14px] border-b border-dashed border-outline-variant/20 pointer-events-none" />
          <div className="absolute inset-x-0 top-1/2 border-b border-dashed border-outline-variant/15 pointer-events-none" />
          <div className="absolute inset-x-0 bottom-[16px] border-b border-outline-variant/30 pointer-events-none" />

          <svg
            className="w-full h-full overflow-visible"
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="costAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0071e3" stopOpacity="0.25" />
                <stop offset="70%" stopColor="#0071e3" stopOpacity="0.04" />
                <stop offset="100%" stopColor="#0071e3" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Shaded Area Fill */}
            {areaPath && (
              <path d={areaPath} fill="url(#costAreaGradient)" className="transition-all duration-300" />
            )}

            {/* Glowing Spline Curve */}
            {splinePath && (
              <path
                d={splinePath}
                fill="none"
                stroke="#0071e3"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-300"
              />
            )}

            {/* Hover Crosshair & Indicator Dot */}
            {hoveredIdx !== null && points[hoveredIdx] && (
              <g>
                <line
                  x1={points[hoveredIdx].x}
                  y1={paddingTop}
                  x2={points[hoveredIdx].x}
                  y2={paddingTop + plotHeight}
                  stroke="#0071e3"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                  opacity="0.6"
                />
                <circle
                  cx={points[hoveredIdx].x}
                  cy={points[hoveredIdx].y}
                  r="5"
                  fill="#ffffff"
                  stroke="#0071e3"
                  strokeWidth="2.5"
                  className="filter drop-shadow(0 2px 4px rgba(0, 113, 227, 0.4))"
                />
              </g>
            )}
          </svg>

          {/* Transparent interactive trigger overlays for mouse hover across entire curve */}
          <div className="absolute inset-0 flex items-stretch">
            {days.map((_, idx) => (
              <div
                key={idx}
                className="flex-1 h-full cursor-pointer"
                onMouseEnter={() => setHoveredIdx(idx)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Bottom X-Axis Timeline Dates */}
      <div className="flex justify-between items-center px-1 text-xs font-mono text-on-surface-variant/75 select-none">
        {axisDateIndices.map((idx) => {
          const item = days[idx];
          if (!item) return null;
          // Format as M/D (e.g. "9/15")
          const parts = item.date.split("-");
          const label = parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : item.date;
          return (
            <span
              key={item.date}
              className={`transition-colors duration-150 ${
                hoveredIdx === idx ? "text-primary font-semibold" : ""
              }`}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
