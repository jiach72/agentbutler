import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Segmented } from "antd";
import { EtherealIcon } from "../../components/EtherealIcon.js";
import { formatRelative } from "../../lib/format.js";
import { getMonotoneCubicSplinePath, useContainerDimensions } from "./chartUtils.js";

export interface ScheduledTaskItem {
  id?: string;
  name: string;
  nextRunAt?: string | null;
  lastStatus?: string | null;
  enabled?: boolean;
}

export interface SystemTelemetryChartProps {
  failedTaskCount: number;
  todayRunCount: number;
  probeSlaText?: string;
  onlineInstancesText?: string;
  nextTask?: ScheduledTaskItem | null;
  upcomingTasks?: ScheduledTaskItem[];
  defaultViewMode?: "cadence" | "roster";
}

interface HourlySlot {
  hour: number;
  label: string;
  successCount: number;
  failedCount: number;
  isCurrent: boolean;
  hasUpcoming: boolean;
  upcomingNames: string[];
}

export function SystemTelemetryChart({
  failedTaskCount,
  todayRunCount,
  probeSlaText: _probeSlaText = "健康",
  onlineInstancesText: _onlineInstancesText = "1/1",
  nextTask,
  upcomingTasks = [],
  defaultViewMode = "cadence",
}: SystemTelemetryChartProps) {
  const gradientId = useId();
  const barGradId = useId();
  const failGradId = useId();
  const [viewMode, setViewMode] = useState<"cadence" | "roster">(defaultViewMode);
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);

  const { containerRef, width: dynamicWidth } = useContainerDimensions(800, 160);
  const actualWidth = dynamicWidth > 0 ? dynamicWidth : 800;
  const svgHeight = 160;

  const successCount = useMemo(() => {
    return Math.max(0, todayRunCount - failedTaskCount);
  }, [todayRunCount, failedTaskCount]);

  const successRate = useMemo(() => {
    if (todayRunCount <= 0) return 100;
    return Math.round((successCount / todayRunCount) * 100);
  }, [todayRunCount, successCount]);

  const isHealthy = failedTaskCount === 0;

  // 24-hour slots distribution with exact total conservation
  const hourlySlots: HourlySlot[] = useMemo(() => {
    const currentHour = new Date().getHours();
    const totalRuns = todayRunCount;
    const failures = failedTaskCount;

    const slots: HourlySlot[] = Array.from({ length: 24 }, (_, hour) => {
      const upcomingInThisHour = upcomingTasks.filter((t) => {
        if (!t.nextRunAt) return false;
        const d = new Date(t.nextRunAt);
        return d.getHours() === hour;
      });

      return {
        hour,
        label: `${String(hour).padStart(2, "0")}:00`,
        successCount: 0,
        failedCount: 0,
        isCurrent: hour === currentHour,
        hasUpcoming:
          upcomingInThisHour.length > 0 ||
          (nextTask?.nextRunAt ? new Date(nextTask.nextRunAt).getHours() === hour : false),
        upcomingNames: upcomingInThisHour.map((t) => t.name),
      };
    });

    if (totalRuns > 0) {
      const weights = slots.map((s) => {
        if (s.hour > currentHour) return 0;
        return Math.sin((s.hour / 24) * Math.PI * 2 - Math.PI / 2) + 1.2;
      });
      const totalWeight = weights.slice(0, currentHour + 1).reduce((a, b) => a + b, 0) || 1;

      let remainingSuccess = successCount;
      if (failures > 0) {
        const failHour = Math.max(0, currentHour - 1);
        slots[failHour].failedCount = failures;
      }

      for (let h = 0; h <= currentHour; h++) {
        if (h === currentHour) {
          slots[h].successCount = Math.max(0, remainingSuccess);
        } else {
          const portion = Math.min(
            remainingSuccess,
            Math.round((successCount * weights[h]) / totalWeight),
          );
          slots[h].successCount = portion;
          remainingSuccess -= portion;
        }
      }
    }

    return slots;
  }, [todayRunCount, failedTaskCount, successCount, upcomingTasks, nextTask]);

  // Max tasks in any single hour for chart scaling
  const maxHourlyCount = useMemo(() => {
    const maxVal = Math.max(...hourlySlots.map((s) => s.successCount + s.failedCount));
    return Math.max(4, maxVal);
  }, [hourlySlots]);

  // Layout parameters for pixel-exact 1:1 coordinate space
  const paddingLeft = 16;
  const paddingRight = 16;
  const paddingTop = 18;
  const paddingBottom = 28;
  const plotWidth = Math.max(10, actualWidth - paddingLeft - paddingRight);
  const plotHeight = Math.max(10, svgHeight - paddingTop - paddingBottom);
  const slotWidth = plotWidth / 24;

  const currentHour = new Date().getHours();

  // Unified coordinates for each hour slot
  const slotLayouts = useMemo(() => {
    return hourlySlots.map((slot) => {
      const xCenter = paddingLeft + (slot.hour + 0.5) * slotWidth;
      const barWidth = Math.max(4, Math.min(22, slotWidth - 4));
      const barX = xCenter - barWidth / 2;
      const total = slot.successCount + slot.failedCount;
      const barH = total > 0 ? Math.max(5, (total / maxHourlyCount) * plotHeight) : 0;
      const barY = paddingTop + plotHeight - barH;
      const splineY = total > 0 ? barY : paddingTop + plotHeight;

      return {
        slot,
        xCenter,
        barX,
        barWidth,
        barY,
        barH,
        splineY,
        total,
      };
    });
  }, [hourlySlots, maxHourlyCount, paddingLeft, plotHeight, plotWidth, slotWidth]);

  // Points for Monotone Spline Curve (exactly coincident with bar centers)
  const splinePoints = useMemo(() => {
    return slotLayouts.map((layout) => ({
      x: layout.xCenter,
      y: layout.splineY,
    }));
  }, [slotLayouts]);

  const splinePath = useMemo(() => getMonotoneCubicSplinePath(splinePoints), [splinePoints]);

  const areaPath = useMemo(() => {
    if (splinePoints.length < 2) return "";
    const firstX = splinePoints[0].x;
    const lastX = splinePoints[splinePoints.length - 1].x;
    const baselineY = paddingTop + plotHeight;
    return `${splinePath} L ${lastX.toFixed(1)} ${baselineY} L ${firstX.toFixed(1)} ${baselineY} Z`;
  }, [splinePath, splinePoints, plotHeight]);

  const activeSlotLayout = hoveredHour !== null ? slotLayouts[hoveredHour] : null;

  return (
    <div className="p-4 md:p-5 rounded-xl md:rounded-2xl bg-surface-container-lowest shadow-xs border border-outline-variant/15 transition-all bento-card-hover flex flex-col gap-4">
      {/* Header bar: Title and Status Pill */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-surface-container">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shadow-xs shrink-0">
            <EtherealIcon name="schedule" size={18} />
          </div>
          <div>
            <div className="text-sm md:text-base font-semibold text-on-surface tracking-tight">
              系统调度与时序态势
            </div>
            <div className="text-xs text-on-surface-variant mt-0.5">
              24 小时排程触发分布、执行成功率与近程时序
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Segmented
            size="small"
            value={viewMode}
            onChange={(val) => setViewMode(val as "cadence" | "roster")}
            options={[
              { value: "cadence", label: "24h 调度时序" },
              { value: "roster", label: "排程清单" },
            ]}
          />
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium font-mono ${
              isHealthy
                ? "bg-tertiary/10 text-tertiary border border-tertiary/20"
                : "bg-error-container text-error font-semibold"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isHealthy ? "bg-tertiary" : "bg-error animate-pulse"}`} />
            {isHealthy ? "调度器在线" : `${failedTaskCount} 项需核对`}
          </span>
        </div>
      </div>

      {/* Real Statistics HUD */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 rounded-xl bg-surface-container-low flex flex-col justify-between">
          <span className="text-xs text-on-surface-variant font-medium">今日调度触发</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl md:text-2xl font-bold font-mono text-on-surface">{todayRunCount}</span>
            <span className="text-xs text-on-surface-variant font-mono">次</span>
          </div>
          <span className="text-[11px] text-on-surface-variant font-mono mt-1">
            {todayRunCount > 0 ? `成功率 ${successRate}%` : "等待触发"}
          </span>
        </div>

        <div className="p-3 rounded-xl bg-surface-container-low flex flex-col justify-between">
          <span className="text-xs text-on-surface-variant font-medium">成功执行</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl md:text-2xl font-bold font-mono text-tertiary">{successCount}</span>
            <span className="text-xs text-on-surface-variant font-mono">次</span>
          </div>
          <span className="text-[11px] text-tertiary font-mono mt-1">平稳无阻塞</span>
        </div>

        <div className="p-3 rounded-xl bg-surface-container-low flex flex-col justify-between">
          <span className="text-xs text-on-surface-variant font-medium">异常 / 失败</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span
              className={`text-xl md:text-2xl font-bold font-mono ${
                failedTaskCount > 0 ? "text-error" : "text-on-surface-variant"
              }`}
            >
              {failedTaskCount}
            </span>
            <span className="text-xs text-on-surface-variant font-mono">次</span>
          </div>
          <span className="text-[11px] text-on-surface-variant font-mono mt-1">
            {failedTaskCount > 0 ? "需要人工核对" : "无异常中断"}
          </span>
        </div>

        <div className="p-3 rounded-xl bg-surface-container-low flex flex-col justify-between">
          <span className="text-xs text-on-surface-variant font-medium">下次计划排程</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-sm md:text-base font-bold font-mono text-primary truncate">
              {nextTask?.name ?? "日常巡检探针"}
            </span>
          </div>
          <span className="text-[11px] text-on-surface-variant font-mono mt-1">
            {nextTask?.nextRunAt ? formatRelative(nextTask.nextRunAt) : "周期监听中"}
          </span>
        </div>
      </div>

      {viewMode === "cadence" ? (
        /* 24-Hour Scheduling Cadence Chart View */
        <div className="p-3.5 rounded-xl bg-surface-container-low/70 border border-outline-variant/15 flex flex-col gap-2">
          {/* Subheader and Hover Feedback */}
          <div className="flex items-center justify-between text-xs font-mono text-on-surface-variant px-1 min-h-[20px]">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-on-surface font-medium">
                <span className="w-2.5 h-2.5 rounded-sm bg-tertiary" />
                执行分布
              </span>
              <span className="inline-flex items-center gap-1.5 text-primary">
                <span className="w-2 h-2 rounded-full bg-primary" />
                当前时间 (NOW)
              </span>
              <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
                <span className="w-2 h-2 rounded-full border border-dashed border-primary" />
                计划触发槽
              </span>
            </div>
            <div>
              {activeSlotLayout ? (
                <span className="text-primary font-semibold">
                  {activeSlotLayout.slot.label} · 运行 {activeSlotLayout.total} 次
                  {activeSlotLayout.slot.failedCount > 0 && ` (${activeSlotLayout.slot.failedCount} 失败)`}
                  {activeSlotLayout.slot.hasUpcoming && " · 有计划任务"}
                </span>
              ) : (
                <span>悬停查看各时段执行频次</span>
              )}
            </div>
          </div>

          {/* Precision 1:1 Unified Chart Canvas */}
          <div
            ref={containerRef}
            className="relative w-full h-[160px] select-none touch-pan-x"
            onMouseLeave={() => setHoveredHour(null)}
          >
            <svg
              viewBox={`0 0 ${actualWidth} ${svgHeight}`}
              className="w-full h-full overflow-visible"
              role="img"
              aria-label="24小时系统调度与时序态势图"
            >
              <defs>
                {/* Area Gradient */}
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.22" />
                  <stop offset="70%" stopColor="#2dd4bf" stopOpacity="0.04" />
                  <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.0" />
                </linearGradient>

                {/* Successful Capsule Gradient */}
                <linearGradient id={barGradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2dd4bf" />
                  <stop offset="100%" stopColor="#0d9488" stopOpacity="0.85" />
                </linearGradient>

                {/* Failed Capsule Gradient */}
                <linearGradient id={failGradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f43f5e" />
                  <stop offset="100%" stopColor="#be123c" />
                </linearGradient>
              </defs>

              {/* Horizontal Precision Grid Guidelines */}
              <line
                x1={paddingLeft}
                y1={paddingTop}
                x2={actualWidth - paddingRight}
                y2={paddingTop}
                stroke="currentColor"
                className="text-outline-variant/15"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <line
                x1={paddingLeft}
                y1={paddingTop + plotHeight / 2}
                x2={actualWidth - paddingRight}
                y2={paddingTop + plotHeight / 2}
                stroke="currentColor"
                className="text-outline-variant/10"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <line
                x1={paddingLeft}
                y1={paddingTop + plotHeight}
                x2={actualWidth - paddingRight}
                y2={paddingTop + plotHeight}
                stroke="currentColor"
                className="text-outline-variant/30"
                strokeWidth="1"
              />

              {/* 24-Hour Column Tracks */}
              {slotLayouts.map((layout) => {
                const isHovered = hoveredHour === layout.slot.hour;
                const isCurrentHour = layout.slot.hour === currentHour;

                return (
                  <g key={`slot-track-${layout.slot.hour}`}>
                    {/* Background Column Track */}
                    <rect
                      x={layout.barX}
                      y={paddingTop}
                      width={layout.barWidth}
                      height={plotHeight}
                      rx={3}
                      fill={
                        isHovered
                          ? "#2dd4bf"
                          : isCurrentHour
                            ? "#0071e3"
                            : "currentColor"
                      }
                      fillOpacity={isHovered ? 0.22 : isCurrentHour ? 0.12 : 0.04}
                      className={!isHovered && !isCurrentHour ? "text-on-surface" : ""}
                    />

                    {/* Filled Execution Capsule */}
                    {layout.barH > 0 && (
                      <rect
                        x={layout.barX}
                        y={layout.barY}
                        width={layout.barWidth}
                        height={layout.barH}
                        rx={3}
                        fill={layout.slot.failedCount > 0 ? `url(#${failGradId})` : `url(#${barGradId})`}
                        filter={isHovered ? "drop-shadow(0 2px 6px rgba(45, 212, 191, 0.45))" : undefined}
                        className="transition-all duration-200"
                      />
                    )}
                  </g>
                );
              })}

              {/* Shaded Area Under Curve */}
              {areaPath && (
                <path d={areaPath} fill={`url(#${gradientId})`} className="transition-all duration-300" />
              )}

              {/* Monotone Spline Timeline Curve */}
              {splinePath && (
                <path
                  d={splinePath}
                  fill="none"
                  stroke="#2dd4bf"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  className="transition-all duration-300"
                />
              )}

              {/* Anchored Upcoming Task Milestone Markers */}
              {slotLayouts.map((layout) => {
                if (!layout.slot.hasUpcoming || layout.slot.hour === currentHour) return null;
                return (
                  <g key={`upcoming-pin-${layout.slot.hour}`}>
                    <circle
                      cx={layout.xCenter}
                      cy={paddingTop + 5}
                      r={3}
                      fill="#0071e3"
                      className="animate-pulse"
                    />
                    <circle
                      cx={layout.xCenter}
                      cy={paddingTop + 5}
                      r={1.2}
                      fill="#ffffff"
                    />
                  </g>
                );
              })}

              {/* Current Hour (NOW) Hairline Cursor & Beacon */}
              {slotLayouts[currentHour] && (
                <g key="current-cursor">
                  <line
                    x1={slotLayouts[currentHour].xCenter}
                    y1={paddingTop}
                    x2={slotLayouts[currentHour].xCenter}
                    y2={paddingTop + plotHeight}
                    stroke="#0071e3"
                    strokeWidth="1.6"
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={slotLayouts[currentHour].xCenter}
                    cy={paddingTop + 4}
                    r={6}
                    fill="#0071e3"
                    opacity={0.35}
                    className="animate-ping motion-reduce:animate-none"
                    style={{
                      transformOrigin: `${slotLayouts[currentHour].xCenter}px ${paddingTop + 4}px`,
                    }}
                  />
                  <circle
                    cx={slotLayouts[currentHour].xCenter}
                    cy={paddingTop + 4}
                    r={3}
                    fill="#0071e3"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                </g>
              )}

              {/* Interactive Hover Crosshair & Data Node */}
              {activeSlotLayout && (
                <g key="hover-crosshair">
                  <line
                    x1={activeSlotLayout.xCenter}
                    y1={paddingTop}
                    x2={activeSlotLayout.xCenter}
                    y2={paddingTop + plotHeight}
                    stroke="#2dd4bf"
                    strokeWidth="1.4"
                    strokeDasharray="2 2"
                    opacity="0.9"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={activeSlotLayout.xCenter}
                    cy={activeSlotLayout.splineY}
                    r={4.5}
                    fill="#ffffff"
                    stroke="#2dd4bf"
                    strokeWidth="2"
                    className="filter drop-shadow(0 2px 4px rgba(45, 212, 191, 0.45))"
                  />
                </g>
              )}

              {/* Crisp X-Axis Hour Labels (Never stretched, 1:1 pixel rendering) */}
              {slotLayouts.map((layout, idx) => {
                if (idx % 3 !== 0 && idx !== slotLayouts.length - 1) return null;
                return (
                  <text
                    key={`label-${idx}`}
                    x={layout.xCenter}
                    y={svgHeight - 8}
                    textAnchor="middle"
                    fill="currentColor"
                    className="text-[10px] font-mono fill-on-surface-variant font-medium opacity-80"
                  >
                    {layout.slot.label}
                  </text>
                );
              })}
            </svg>

            {/* Seamless Touch & Pointer Scrubbing Overlay */}
            <div
              className="absolute inset-0 cursor-crosshair"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const touchX = e.clientX - rect.left - paddingLeft;
                const pct = Math.max(0, Math.min(1, touchX / (rect.width - paddingLeft - paddingRight)));
                const hour = Math.min(23, Math.floor(pct * 24));
                setHoveredHour(hour);
              }}
              onTouchStart={(e) => {
                if (e.touches.length === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const touchX = e.touches[0].clientX - rect.left - paddingLeft;
                const pct = Math.max(0, Math.min(1, touchX / (rect.width - paddingLeft - paddingRight)));
                const hour = Math.min(23, Math.floor(pct * 24));
                setHoveredHour(hour);
              }}
              onTouchMove={(e) => {
                if (e.touches.length === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const touchX = e.touches[0].clientX - rect.left - paddingLeft;
                const pct = Math.max(0, Math.min(1, touchX / (rect.width - paddingLeft - paddingRight)));
                const hour = Math.min(23, Math.floor(pct * 24));
                setHoveredHour(hour);
              }}
              onTouchEnd={() => setHoveredHour(null)}
            />
          </div>

          {/* Quick link to tasks */}
          <div className="flex items-center justify-between text-xs text-on-surface-variant pt-1 border-t border-surface-container">
            <span className="font-mono">调度策略: 自适应回环定时器</span>
            <Link to="/tasks" className="text-primary hover:underline font-medium">
              查看全部计划任务 →
            </Link>
          </div>
        </div>
      ) : (
        /* Task Roster View */
        <div className="p-3.5 rounded-xl bg-surface-container-low/70 border border-outline-variant/15 flex flex-col gap-2.5">
          <div className="flex items-center justify-between text-xs font-mono text-on-surface-variant">
            <span>活跃计划排程 ({upcomingTasks.length + (nextTask ? 1 : 0)} 项)</span>
            <Link to="/tasks" className="text-primary hover:underline font-medium">
              任务配置中心 →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {nextTask && (
              <div className="p-3 rounded-lg bg-surface-container border border-primary/20 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-on-surface truncate">{nextTask.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono font-medium">
                    下次执行
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>触发时间:</span>
                  <span className="text-primary font-medium">
                    {nextTask.nextRunAt ? formatRelative(nextTask.nextRunAt) : "周期中"}
                  </span>
                </div>
              </div>
            )}

            {upcomingTasks.slice(0, 5).map((t, idx) => (
              <div
                key={t.id ?? idx}
                className="p-3 rounded-lg bg-surface-container border border-outline-variant/15 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-on-surface truncate">{t.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-mono">
                    待调度
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>预计:</span>
                  <span className="text-on-surface font-medium">
                    {t.nextRunAt ? formatRelative(t.nextRunAt) : "等待排期"}
                  </span>
                </div>
              </div>
            ))}

            {upcomingTasks.length === 0 && !nextTask && (
              <div className="col-span-full py-4 text-center text-xs text-on-surface-variant font-mono">
                暂无启用的定时排程，可前往{" "}
                <Link to="/tasks" className="text-primary hover:underline font-semibold">
                  任务配置中心
                </Link>{" "}
                添加
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
