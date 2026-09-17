/**
 * 即时通讯工作台（WeChatHistoryView / IMWorkbench 集成层）：
 * 1. 今日消息整理吞吐与 30 天趋势卡片；
 * 2. 现代即时通讯工作台（IMWorkbench）：左侧会话列表、右侧对话视窗、Hermes 原生直连通道与 ✨ 提示词增强。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Col,
  Flex,
  Row,
  Tag,
  Typography,
} from "antd";
import {
  DownOutlined,
  LineChartOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { MessageItemView, MessageTaskView } from "./helpers.js";
import { loadJson } from "../../lib/api.js";
import { ChartEmpty, TrendColumn } from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";
import { IMWorkbench } from "./im/IMWorkbench.js";
import type { InboundHistoryItem } from "./im/imTypes.js";

const { Text } = Typography;

const OPT_BUCKETS = ["自动整理", "快捷指令", "原样发送"] as const;
const DAY_MS = 86_400_000;

function dayLabel(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function optimizationBucket(mode: string | undefined): (typeof OPT_BUCKETS)[number] {
  if (mode === "quick") return "快捷指令";
  if (mode === undefined || mode === "pass-through") return "原样发送";
  return "自动整理";
}

interface TrendRow {
  date: string;
  bucket: string;
  count: number;
}

function buildOptimizationTrend(items: InboundHistoryItem[], days = 30) {
  const counts = new Map<string, Map<string, number>>();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    counts.set(dayLabel(new Date(now.getTime() - i * DAY_MS)), new Map());
  }
  let total = 0;
  for (const item of items) {
    if (item.decision === null) continue;
    const at = new Date(item.inbound.receivedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayLabel(at);
    const perDay = counts.get(key);
    if (perDay === undefined) continue;
    const bucket = optimizationBucket(item.decision.mode);
    perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1);
    total += 1;
  }
  const rows: TrendRow[] = [];
  for (const [date, perDay] of counts) {
    for (const bucket of OPT_BUCKETS) {
      rows.push({ date, bucket, count: perDay.get(bucket) ?? 0 });
    }
  }
  const rewritten = items.filter(
    (item) => item.decision !== null && item.decision.mode !== "pass-through"
  ).length;
  const rewrittenShare = total === 0 ? 0 : Math.round((rewritten / total) * 100);
  return {
    rows,
    hasData: total > 0,
    summary: `近 ${days} 天处理 ${total} 条 · 整理占比 ${rewrittenShare}%`,
  };
}

export interface WeChatHistoryViewProps {
  items: MessageItemView[];
  counts: Record<string, number>;
  reachable: boolean;
  selectedMessage: MessageItemView | null;
  onSelectMessage: (messageId: string | null) => void;
  taskData: MessageTaskView | null;
  taskLoading: boolean;
  onRedeliver?: (messageId: string) => void;
  redeliverBusy?: boolean;
  onExpedite?: (messageId: string) => void;
  expediteBusy?: boolean;
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function WeChatHistoryView(props: WeChatHistoryViewProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";
  const todayStr = useMemo(() => toLocalDateString(new Date()), []);

  const [inboundItems, setInboundItems] = useState<InboundHistoryItem[]>([]);
  const loadInboundHistory = useCallback(async () => {
    const res = await loadJson<{ reachable: boolean; items: InboundHistoryItem[] }>(
      "/api/messages/optimization-history?limit=100",
      8_000
    );
    if (res.ok && Array.isArray(res.data?.items)) {
      setInboundItems(res.data.items);
    }
  }, []);

  useEffect(() => {
    void loadInboundHistory();
  }, [loadInboundHistory]);

  const [showTrend, setShowTrend] = useState(false);
  const trend = useMemo(() => buildOptimizationTrend(inboundItems), [inboundItems]);
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const trendSeries = useMemo(
    () =>
      semanticSeries(mode, [
        ["自动整理", "自动整理", "accent"],
        ["快捷指令", "快捷指令", "brand"],
        ["原样发送", "原样发送", "ok"],
      ]),
    [mode]
  );
  const trendColors = useMemo(() => trendSeries.map((s) => s.color), [trendSeries]);

  const todayInbound = useMemo(
    () => inboundItems.filter((it) => toLocalDateString(new Date(it.inbound.receivedAt)) === todayStr),
    [inboundItems, todayStr]
  );
  const todayRewritten = todayInbound.filter(
    (item) => item.decision !== null && item.decision.mode !== "pass-through"
  ).length;
  const todayQuick = todayInbound.filter((item) => item.decision?.mode === "quick").length;
  const todayPassed = todayInbound.filter(
    (item) => item.decision !== null && item.decision.mode === "pass-through"
  ).length;
  const todayTotal = todayInbound.length;
  const todayRewrittenShare = todayTotal === 0 ? 0 : Math.round((todayRewritten / todayTotal) * 100);

  return (
    <Flex vertical gap={16}>
      {/* 0. 消息整理概览与 30 天趋势折叠卡 */}
      <Card
        size="small"
        style={{
          borderRadius: 12,
          border: "1px solid var(--ant-color-border-secondary)",
          background: isDark ? "rgba(255, 255, 255, 0.02)" : "#fafafa",
        }}
        styles={{ body: { padding: "12px 16px" } }}
      >
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <LineChartOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
              <Text strong style={{ fontSize: 13 }}>
                今日消息整理概览
              </Text>
              <Tag color="blue" style={{ margin: 0 }}>
                近30天处理 {inboundItems.length} 条
              </Tag>
            </Flex>
            <Button
              type="text"
              size="small"
              icon={showTrend ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setShowTrend((prev) => !prev)}
            >
              {showTrend ? "收起 30 天整理趋势图" : "展开 30 天整理趋势图"}
            </Button>
          </Flex>

          <Row gutter={[12, 8]}>
            <Col xs={12} sm={6}>
              <Flex vertical gap={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>今日接收消息</Text>
                <Text strong style={{ fontSize: 16 }}>{todayTotal} <span style={{ fontSize: 12, fontWeight: "normal" }}>条</span></Text>
              </Flex>
            </Col>
            <Col xs={12} sm={6}>
              <Flex vertical gap={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>自动规则整理</Text>
                <Text strong style={{ fontSize: 16, color: "var(--ant-color-primary)" }}>
                  {todayRewritten} <span style={{ fontSize: 12, fontWeight: "normal" }}>条 ({todayRewrittenShare}%)</span>
                </Text>
              </Flex>
            </Col>
            <Col xs={12} sm={6}>
              <Flex vertical gap={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>快捷指令调用</Text>
                <Text strong style={{ fontSize: 16 }}>{todayQuick} <span style={{ fontSize: 12, fontWeight: "normal" }}>条</span></Text>
              </Flex>
            </Col>
            <Col xs={12} sm={6}>
              <Flex vertical gap={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>原样直接转交</Text>
                <Text strong style={{ fontSize: 16 }}>{todayPassed} <span style={{ fontSize: 12, fontWeight: "normal" }}>条</span></Text>
              </Flex>
            </Col>
          </Row>

          {showTrend && (
            <div style={{ marginTop: 8, paddingTop: 12, borderTop: "1px dashed var(--ant-color-border-secondary)" }}>
              {trend.hasData ? (
                <TrendColumn
                  data={trend.rows}
                  xField="date"
                  yField="count"
                  colorField="bucket"
                  transform={[{ type: "stackY" }]}
                  theme={chartTheme.g2Theme}
                  autoFit
                  height={180}
                  scale={{ color: { range: trendColors } }}
                  axis={quietAxes(chartTheme)}
                  legend={topLegend(chartTheme)}
                  style={{ maxWidth: 22, radiusTopLeft: 3, radiusTopRight: 3 }}
                />
              ) : (
                <ChartEmpty hint="暂无足够的历史整理记录，收到消息后将自动汇总近 30 天趋势。" />
              )}
            </div>
          )}
        </Flex>
      </Card>

      {/* 1. 现代化即时通讯工作台（左侧对话列表 + 右侧对话窗口 + Hermes 直连 + ✨ 提示词增强） */}
      <IMWorkbench {...props} />
    </Flex>
  );
}
