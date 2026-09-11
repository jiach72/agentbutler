import { useMemo } from "react";
import { Badge, Col, Flex, Row, Typography } from "antd";
import { useTheme } from "../../theme/ThemeProvider.js";
import {
  ChartEmpty,
  TrendArea,
  TrendBar,
  TrendCard,
  TrendLine,
  TrendScatter,
} from "../../components/charts/index.js";
import {
  chartThemeFor,
  horizontalBarAxes,
  primaryFill,
  quietAxes,
  semanticSeries,
} from "../../components/charts/chartTheme.js";
import type { EvolutionOverviewPayload } from "./types.js";

const stageLabel: Record<string, string> = {
  blocked: "已拦截",
  preflight: "预检",
  execute: "执行",
  evaluate: "评估",
  accepted: "已采用",
};

const toneLabel: Record<string, string> = {
  blocked: "受阻",
  active: "进行中",
  accepted: "已采用",
};

function compactLabel(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function timeLabel(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

export function EvolutionCharts({ overview }: { overview: EvolutionOverviewPayload }) {
  const { mode } = useTheme();
  const theme = useMemo(() => chartThemeFor(mode), [mode]);
  const sessions = overview.trend.map((item) => ({ date: item.date, value: item.sessions }));
  const toolCalls = overview.trend.map((item) => ({ date: item.date, value: item.toolCalls }));
  const rates = overview.trend
    .filter((item) => item.successRate !== null)
    .map((item) => ({ date: item.date, value: (item.successRate ?? 0) * 100 }));
  const failures = (() => {
    const top = overview.failures.slice(0, 6);
    const remaining = overview.failures.slice(6);
    const items = top.map((item) => ({
      category: compactLabel(item.title),
      count: item.count,
      impact: item.impact === "blocking" ? "阻断" : item.impact === "high" ? "高影响" : "一般",
    }));
    const otherCount = remaining.reduce((total, item) => total + item.count, 0);
    return otherCount > 0 ? [...items, { category: "其他", count: otherCount, impact: "一般" }] : items;
  })();
  const timeline = overview.evolution.timeline
    .slice(0, 12)
    .reverse()
    .map((item) => ({
      time: timeLabel(item.at),
      stage: stageLabel[item.stage] ?? item.stage,
      status: item.status,
      tone: item.stage === "blocked" ? "受阻" : item.stage === "accepted" ? "已采用" : "进行中",
      detail: item.detail,
      runId: item.runId,
    }));
  const timelineTones = ["受阻", "进行中", "已采用"].map((tone) => ({
    tone,
    count: timeline.filter((item) => item.tone === tone).length,
  }));
  const usageColors = semanticSeries(mode, [
    ["会话", "会话", "accent"],
    ["工具调用", "工具调用", "teal"],
  ]);
  const rateAxes = quietAxes(theme);

  return (
    <Flex vertical gap={16}>
      <TrendCard
        title="近 7 天使用趋势"
        summary={overview.source === "logs" ? "日志估算，字段不完整" : "会话与工具调用分别计量"}
      >
        {sessions.length === 0 ? (
          <ChartEmpty hint="尚未采集到可绘制的会话或工具调用" />
        ) : (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Flex vertical gap={8}>
                <Flex align="baseline" gap={8}>
                  <Typography.Text type="secondary">工具调用</Typography.Text>
                  <Typography.Text strong>
                    {toolCalls.reduce((total, item) => total + item.value, 0).toLocaleString()}
                  </Typography.Text>
                </Flex>
                <TrendArea
                  data={toolCalls}
                  xField="date"
                  yField="value"
                  theme={theme.g2Theme}
                  autoFit
                  height={168}
                  shapeField="smooth"
                  scale={{ color: { range: [usageColors[1].color] } }}
                  axis={quietAxes(theme)}
                  tooltip={{ items: [{ channel: "y", name: "工具调用" }] }}
                />
              </Flex>
            </Col>
            <Col xs={24} md={12}>
              <Flex vertical gap={8}>
                <Flex align="baseline" gap={8}>
                  <Typography.Text type="secondary">会话</Typography.Text>
                  <Typography.Text strong>
                    {sessions.reduce((total, item) => total + item.value, 0).toLocaleString()}
                  </Typography.Text>
                </Flex>
                <TrendLine
                  data={sessions}
                  xField="date"
                  yField="value"
                  theme={theme.g2Theme}
                  autoFit
                  height={168}
                  shapeField="smooth"
                  scale={{ color: { range: [usageColors[0].color] } }}
                  axis={quietAxes(theme)}
                  tooltip={{ items: [{ channel: "y", name: "会话" }] }}
                />
              </Flex>
            </Col>
          </Row>
        )}
      </TrendCard>
      <TrendCard title="成功率趋势" summary="仅基于明确结果，未知结果不计入成功">
        {rates.length === 0 ? (
          <ChartEmpty hint="暂无明确成功或失败结果" />
        ) : (
          <Flex vertical gap={8}>
            <Flex align="baseline" gap={8}>
              <Typography.Text type="secondary">当前成功率</Typography.Text>
              <Typography.Text strong>{Math.round(rates.at(-1)?.value ?? 0)}%</Typography.Text>
            </Flex>
            <TrendArea
              data={rates}
              xField="date"
              yField="value"
              theme={theme.g2Theme}
              autoFit
              height={188}
              shapeField="smooth"
              scale={{ y: { domain: [0, 100] }, color: { range: [primaryFill(mode)] } }}
              axis={{
                ...rateAxes,
                y: { ...rateAxes.y, labelFormatter: (value: unknown) => `${value}%` },
              }}
              tooltip={{
                items: [
                  {
                    channel: "y",
                    name: "成功率",
                    valueFormatter: (value: number) => `${Math.round(value)}%`,
                  },
                ],
              }}
            />
          </Flex>
        )}
      </TrendCard>
      <TrendCard title="失败归因分布" summary="优先展示出现最多的六类失败，剩余合并">
        {failures.length === 0 ? (
          <ChartEmpty hint="当前范围没有已归类失败" />
        ) : (
          <TrendBar
            data={failures}
            xField="count"
            yField="category"
            colorField="impact"
            theme={theme.g2Theme}
            autoFit
            height={238}
            scale={{
              color: {
                domain: ["阻断", "高影响", "一般"],
                range: semanticSeries(mode, [
                  ["阻断", "阻断", "error"],
                  ["高影响", "高影响", "warn"],
                  ["一般", "一般", "accent"],
                ]).map((item) => item.color),
              },
            }}
            axis={horizontalBarAxes(theme)}
            legend={false}
            tooltip={{ items: [{ channel: "x", name: "出现次数" }] }}
          />
        )}
      </TrendCard>
      <TrendCard title="进化引擎状态时间线" summary="按阶段压缩展示，重复预检失败不会挤满列表">
        {timeline.length === 0 ? (
          <ChartEmpty hint="暂无进化运行记录" />
        ) : (
          <Flex vertical gap={12}>
            <TrendScatter
              data={timeline}
              xField="time"
              yField="stage"
              colorField="tone"
              theme={theme.g2Theme}
              autoFit
              height={192}
              size={8}
              scale={{
                color: {
                  domain: ["受阻", "进行中", "已采用"],
                  range: semanticSeries(mode, [
                    ["受阻", "受阻", "error"],
                    ["进行中", "进行中", "accent"],
                    ["已采用", "已采用", "ok"],
                  ]).map((item) => item.color),
                },
              }}
              axis={quietAxes(theme)}
              legend={false}
              tooltip={{
                items: [
                  { channel: "y", name: "阶段" },
                  { channel: "color", name: "状态" },
                  { channel: "x", name: "时间" },
                ],
              }}
            />
            <Flex wrap="wrap" align="center" gap={12} aria-label="运行状态汇总">
              {timelineTones
                .filter((item) => item.count > 0)
                .map((item) => (
                  <Badge
                    key={item.tone}
                    status={
                      item.tone === "受阻" ? "error" : item.tone === "已采用" ? "success" : "processing"
                    }
                    text={`${toneLabel[item.tone === "受阻" ? "blocked" : item.tone === "已采用" ? "accepted" : "active"]} ${item.count}`}
                  />
                ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                最近：{timeline.at(-1)?.status} · {timeline.at(-1)?.detail}
              </Typography.Text>
            </Flex>
          </Flex>
        )}
      </TrendCard>
    </Flex>
  );
}
