/**
 * 消息通知页 · 通道健康：按通道聚合近 30 天的送达结果（结构化指标），
 * 回答"哪个通道最近老出问题"，不再依赖错误文案的正则猜测。
 */
import { useCallback, useEffect, useState } from "react";
import { Flex, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { loadJson, type FetchState } from "../../lib/api.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { channelLabel } from "./helpers.js";

interface ChannelMetricRow {
  channel: string;
  delivered: number;
  failed: number;
  uncertain: number;
  total: number;
  successRate: number;
  p50LatencyMs?: number | null;
  p95LatencyMs?: number | null;
  latencySamples?: number;
  retries?: number | null;
}

interface MetricsPayload {
  reachable: boolean;
  days: number;
  channels: ChannelMetricRow[];
  latency?: { p50Ms: number | null; p95Ms: number | null; samples: number; unknown: number };
  retries?: number | null;
}

function latencyText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "未知";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

const COLUMNS: TableColumnsType<ChannelMetricRow> = [
  {
    title: "通道",
    dataIndex: "channel",
    key: "channel",
    render: (channel: string) => channelLabel(channel),
  },
  { title: "近 30 天", dataIndex: "total", key: "total", width: 88, align: "right" },
  {
    title: "送达率",
    dataIndex: "successRate",
    key: "successRate",
    width: 96,
    align: "right",
    render: (rate: number) => (
      <Typography.Text type={rate >= 0.95 ? undefined : rate >= 0.8 ? "warning" : "danger"}>
        {`${Math.round(rate * 100)}%`}
      </Typography.Text>
    ),
  },
  {
    title: "P95 等待",
    dataIndex: "p95LatencyMs",
    key: "p95LatencyMs",
    width: 104,
    align: "right",
    render: (value: number | null | undefined) => <Typography.Text type="secondary">{latencyText(value)}</Typography.Text>,
  },
  {
    title: "重试",
    dataIndex: "retries",
    key: "retries",
    width: 72,
    align: "right",
    render: (value: number | undefined) => <Typography.Text type={value !== undefined && value > 0 ? "warning" : "secondary"}>{value ?? "未知"}</Typography.Text>,
  },
  {
    title: "需关注",
    key: "attention",
    width: 88,
    align: "right",
    render: (_: unknown, row: ChannelMetricRow) =>
      row.failed + row.uncertain === 0 ? (
        <Typography.Text type="secondary">0</Typography.Text>
      ) : (
        <Typography.Text type="warning">{`${row.failed + row.uncertain} 条`}</Typography.Text>
      ),
  },
];

export function ChannelMetricsCard() {
  const [metrics, setMetrics] = useState<FetchState<MetricsPayload>>({ status: "loading" });

  const load = useCallback(async () => {
    const result = await loadJson<MetricsPayload>("/api/messages/metrics?days=30", 8_000);
    setMetrics(result.ok ? { status: "ready", data: result.data } : { status: "failed", reason: result.reason });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (metrics.status === "failed") {
    return (
      <DegradedBanner
        severity="warn"
        message="通道健康数据暂时读不到"
        description={metrics.reason}
      />
    );
  }

  const rows = metrics.status === "ready" ? metrics.data.channels : [];
  const attention = rows.filter((row) => row.failed + row.uncertain > 0);
  const latency = metrics.status === "ready" ? metrics.data.latency : undefined;

  return (
    <Flex vertical gap={8}>
      <Typography.Text strong>通道健康（近 30 天）</Typography.Text>
      {metrics.status === "ready" && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          端到端等待 P50 {latencyText(latency?.p50Ms)} · P95 {latencyText(latency?.p95Ms)} · 已记录重试 {metrics.data.retries ?? "未知"} 次
          {latency !== undefined && latency.unknown > 0 ? ` · ${latency.unknown} 条缺少可用时间戳` : ""}；费用/Token 当前无可靠来源，显示未知。
        </Typography.Text>
      )}
      {rows.length === 0 ? (
        <Typography.Text type="secondary">
          还没有足够的送达记录；消息经过网关后会按通道汇总送达率。
        </Typography.Text>
      ) : (
        <>
          {attention.length > 0 && (
            <Typography.Text type="warning" style={{ fontSize: 13 }}>
              {attention
                .map((row) => `${channelLabel(row.channel)} 有 ${row.failed + row.uncertain} 条需关注`)
                .join("；")}
            </Typography.Text>
          )}
          <Table<ChannelMetricRow>
            size="small"
            rowKey="channel"
            columns={COLUMNS}
            dataSource={rows}
            pagination={false}
            loading={metrics.status === "loading"}
          />
        </>
      )}
    </Flex>
  );
}
