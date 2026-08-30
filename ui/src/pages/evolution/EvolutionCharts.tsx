import { useMemo } from "react";
import { Progress, Timeline } from "antd";
import { useTheme } from "../../theme/ThemeProvider.js";
import { ChartEmpty, TrendCard, TrendColumn, TrendLine } from "../../components/charts/index.js";
import { chartThemeFor, quietAxes, semanticSeries, topLegend } from "../../components/charts/chartTheme.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionCharts({ overview }: { overview: EvolutionOverviewPayload }) {
  const { mode } = useTheme();
  const theme = useMemo(() => chartThemeFor(mode), [mode]);
  const volume = overview.trend.flatMap((item) => [{ date: item.date, series: "会话", value: item.sessions }, { date: item.date, series: "工具调用", value: item.toolCalls }]);
  const rates = overview.trend.filter((item) => item.successRate !== null).map((item) => ({ date: item.date, value: (item.successRate ?? 0) * 100 }));
  const failures = overview.failures.map((item) => ({ category: item.title, count: item.count }));
  return <div className="evolution-dashboard-charts">
    <TrendCard title="近 7 天使用趋势" summary={overview.source === "logs" ? "日志估算，字段不完整" : "会话量与工具调用量"}>
      {volume.length === 0 ? <ChartEmpty hint="尚未采集到可绘制的会话或工具调用" /> : <TrendLine data={volume} xField="date" yField="value" colorField="series" theme={theme.g2Theme} autoFit height={220} scale={{ color: { range: semanticSeries(mode, [["会话", "会话", "accent"], ["工具调用", "工具调用", "teal"]]).map((item) => item.color) } }} axis={quietAxes(theme)} legend={topLegend(theme)} />}
    </TrendCard>
    <TrendCard title="成功率趋势" summary="只对明确结果计算，不把 unknown 当成功">
      {rates.length === 0 ? <ChartEmpty hint="暂无明确成功/失败结果" /> : <TrendLine data={rates} xField="date" yField="value" theme={theme.g2Theme} autoFit height={220} scale={{ y: { domain: [0, 100] } }} axis={quietAxes(theme)} tooltip={{ items: [{ channel: "y", name: "成功率", valueFormatter: (value: number) => `${Math.round(value)}%` }] }} />}
    </TrendCard>
    <TrendCard title="失败归因分布" summary="区分环境依赖、运行环境、数据、引擎与目标问题">
      {failures.length === 0 ? <ChartEmpty hint="当前范围没有已归类失败" /> : <TrendColumn data={failures} xField="category" yField="count" theme={theme.g2Theme} autoFit height={220} axis={quietAxes(theme)} />}
    </TrendCard>
    <TrendCard title="进化引擎状态时间线" summary="预检、执行、评估、采用或拦截">
      {overview.evolution.timeline.length === 0 ? <ChartEmpty hint="暂无进化运行记录" /> : <Timeline items={overview.evolution.timeline.slice(0, 8).map((item) => ({ color: item.stage === "accepted" ? "green" : item.stage === "blocked" ? "red" : "blue", children: <div><strong>{item.status}</strong><span className="evolution-timeline-detail">{item.runId.slice(0, 10)} · {item.detail}</span></div> }))} />}
    </TrendCard>
    <TrendCard title="内存容量水位" summary={overview.memory.source === "memory-service" ? "记忆条目容量" : "记忆服务不可用"}>
      {overview.memory.percent === null ? <ChartEmpty hint="暂时无法读取内存容量" /> : <div className="evolution-memory-meter"><Progress type="circle" percent={overview.memory.percent} format={(value) => `${value}%`} /><div><strong>{overview.memory.used} / {overview.memory.capacity} {overview.memory.unit}</strong><span>当前只展示可观测到的记忆条目，不伪造字节数。</span></div></div>}
    </TrendCard>
  </div>;
}
