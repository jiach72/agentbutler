/**
 * 进化页真实评估指标对比：质量、可靠性、运行时长分开呈现。
 * history 由 Watch 按评估完成时间排序返回；没有相应指标时显示明确空态。
 */
import { useMemo } from "react";
import type { ThemeMode } from "../../theme/tokens.js";
import { ChartEmpty, TrendCard, TrendLine } from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";

export interface EvolutionHistoryMetrics {
  baselineQuality?: number;
  candidateQuality?: number;
  successRate?: number;
  failureRate?: number;
  elapsedSeconds?: number;
}

interface MetricRow {
  run: string;
  series: string;
  value: number;
}

function buildRows(
  history: EvolutionHistoryMetrics[],
  valueOf: (item: EvolutionHistoryMetrics) => Array<[string, number | undefined]>,
): MetricRow[] {
  const rows: MetricRow[] = [];
  history.forEach((item, index) => {
    const run = `#${index + 1}`;
    for (const [series, value] of valueOf(item)) {
      if (typeof value === "number" && Number.isFinite(value)) rows.push({ run, series, value });
    }
  });
  return rows;
}

function MetricChart({
  title,
  summary,
  rows,
  colors,
  theme,
  formatter,
}: {
  title: string;
  summary: string;
  rows: MetricRow[];
  colors: string[];
  theme: ReturnType<typeof chartThemeFor>;
  formatter: (value: number) => string;
}) {
  if (rows.length === 0) return <ChartEmpty hint={summary} />;
  return (
    <TrendCard title={title} summary={summary}>
      <TrendLine
        data={rows}
        xField="run"
        yField="value"
        colorField="series"
        theme={theme.g2Theme}
        autoFit
        height={190}
        scale={{ color: { range: colors } }}
        axis={quietAxes(theme, { integerY: false })}
        legend={topLegend(theme)}
        style={{ lineWidth: 2 }}
        tooltip={{ items: [{ channel: "y", name: "值", valueFormatter: formatter }] }}
      />
    </TrendCard>
  );
}

export function MetricProgressChart({
  history,
  mode,
}: {
  history: EvolutionHistoryMetrics[];
  mode: ThemeMode;
}) {
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const qualitySeries = useMemo(
    () => semanticSeries(mode, [["基线", "基线", "muted"], ["候选", "候选", "accent"]]),
    [mode],
  );
  const reliabilitySeries = useMemo(
    () => semanticSeries(mode, [["成功率", "成功率", "ok"], ["失败率", "失败率", "error"]]),
    [mode],
  );
  const durationSeries = useMemo(
    () => semanticSeries(mode, [["运行时长", "运行时长", "teal"]]),
    [mode],
  );

  const qualityRows = useMemo(
    () => buildRows(history, (item) => [["基线", item.baselineQuality], ["候选", item.candidateQuality]]),
    [history],
  );
  const reliabilityRows = useMemo(
    () => buildRows(history, (item) => [["成功率", item.successRate], ["失败率", item.failureRate]]),
    [history],
  );
  const durationRows = useMemo(
    () => buildRows(history, (item) => [["运行时长", item.elapsedSeconds]]),
    [history],
  );

  return (
    <div className="evolution-charts">
      <MetricChart
        title="质量对比"
        summary="每次评估的 baseline 与候选质量分"
        rows={qualityRows}
        colors={qualitySeries.map((item) => item.color)}
        theme={chartTheme}
        formatter={(value) => value.toFixed(3)}
      />
      <MetricChart
        title="可靠性"
        summary="成功率与失败率来自 Hermes 评估结果"
        rows={reliabilityRows}
        colors={reliabilitySeries.map((item) => item.color)}
        theme={chartTheme}
        formatter={(value) => `${Math.round(value * 100)}%`}
      />
      <MetricChart
        title="运行时长"
        summary="每次隔离运行的耗时（秒）"
        rows={durationRows}
        colors={durationSeries.map((item) => item.color)}
        theme={chartTheme}
        formatter={(value) => `${value.toFixed(1)} 秒`}
      />
    </div>
  );
}
