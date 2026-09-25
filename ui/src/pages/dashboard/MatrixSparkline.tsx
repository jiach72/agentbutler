import { useId, useMemo } from "react";
import { getMonotoneCubicSplinePath, useContainerDimensions } from "./chartUtils.js";

export interface MatrixSparklineProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  showPulse?: boolean;
  ariaLabel?: string;
  fillOpacity?: number;
  baselineValue?: number;
}

export function MatrixSparkline({
  data,
  color,
  height = 34,
  width: initialWidth = 160,
  showPulse = true,
  ariaLabel = "指标微趋势",
  fillOpacity = 0.16,
  baselineValue,
}: MatrixSparklineProps) {
  const gradientId = useId();
  const { containerRef, width: dynamicWidth } = useContainerDimensions(initialWidth, height);
  const actualWidth = dynamicWidth > 0 ? dynamicWidth : initialWidth;

  const paddingX = 6;
  const paddingTop = 6;
  const paddingBottom = 6;
  const plotWidth = Math.max(10, actualWidth - paddingX * 2);
  const plotHeight = Math.max(10, height - paddingTop - paddingBottom);

  const points = useMemo(() => {
    if (!data || data.length === 0) return [];

    const minVal = baselineValue !== undefined ? Math.min(baselineValue, ...data) : Math.min(...data);
    const maxVal = Math.max(...data);
    const range = maxVal - minVal;

    // Check if values are essentially flat (e.g. constant 100% uptime or 0 errors)
    const isFlat = range <= 0.0001;

    return data.map((val, idx) => {
      const x = paddingX + (idx / Math.max(1, data.length - 1)) * plotWidth;

      let normalizedY = 0.5;
      if (isFlat) {
        // Render a subtle, breathing nominal heartbeat cadence (±1.5px) so the instrument feels alive
        const pulseCycle = Math.sin((idx / Math.max(1, data.length - 1)) * Math.PI * 4);
        normalizedY = 0.65 + pulseCycle * 0.08;
      } else {
        normalizedY = (val - minVal) / range;
        // Softly clamp into [0.15, 0.85] for visual elegance and headroom
        normalizedY = 0.15 + normalizedY * 0.7;
      }

      const y = paddingTop + plotHeight - normalizedY * plotHeight;
      return { x, y, val };
    });
  }, [data, actualWidth, height, baselineValue, plotWidth, plotHeight]);

  const splinePath = useMemo(() => getMonotoneCubicSplinePath(points), [points]);

  const areaPath = useMemo(() => {
    if (points.length < 2) return "";
    const firstX = points[0].x;
    const lastX = points[points.length - 1].x;
    const bottomY = height;
    return `${splinePath} L ${lastX.toFixed(1)} ${bottomY} L ${firstX.toFixed(1)} ${bottomY} Z`;
  }, [splinePath, points, height]);

  const lastPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div
      ref={containerRef}
      className="relative overflow-visible select-none pointer-events-none w-full"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    >
      <svg
        viewBox={`0 0 ${actualWidth} ${height}`}
        className="w-full h-full overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
            <stop offset="80%" stopColor={color} stopOpacity={fillOpacity * 0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Subtle Precision Baseline Guideline */}
        <line
          x1={paddingX}
          y1={paddingTop + plotHeight}
          x2={actualWidth - paddingX}
          y2={paddingTop + plotHeight}
          stroke="currentColor"
          className="text-outline-variant/15"
          strokeWidth="0.8"
          strokeDasharray="2 3"
        />

        {/* Shaded Area Under Spline */}
        {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} className="transition-all duration-300" />}

        {/* Monotone Spline Line */}
        {splinePath && (
          <path
            d={splinePath}
            fill="none"
            stroke={color}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="transition-all duration-300"
          />
        )}

        {/* Precision Telemetry Terminal Node */}
        {lastPoint && (
          <g>
            {showPulse && (
              <circle
                cx={lastPoint.x}
                cy={lastPoint.y}
                r={4}
                fill={color}
                opacity={0.3}
                className="animate-ping motion-reduce:animate-none"
                style={{ transformOrigin: `${lastPoint.x}px ${lastPoint.y}px` }}
              />
            )}
            <circle
              cx={lastPoint.x}
              cy={lastPoint.y}
              r={2}
              fill="#ffffff"
              stroke={color}
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
    </div>
  );
}
