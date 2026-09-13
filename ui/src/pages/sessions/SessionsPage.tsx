/**
 * 会话追踪列表（Trust Layer M2.3）：
 * - 结论条：一句话说清「有没有异常 / 数据源能否读到」；
 * - 概览：会话总数 / 异常数 / state.db 可用性与命中表（StatStrip，色走品牌语义）；
 * - 过滤：仅异常、终态；
 * - 表格：会话元数据 + 动作聚合 + 异常标记，点击进入 /sessions/:id 时间线。
 * 数据真相原则：Hermes 会话表/列缺失时对应维度显示「—」，不臆测；正文永不展示。
 */
import { money } from "../../lib/format.js";
import { Alert, Button, Card, Flex, Segmented, Select, Space, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ClockCircleOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  SyncOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useUrlState } from "../../hooks/useUrlState.js";

interface SessionAnomaly {
  kind: string;
  severity: "warn" | "critical";
  detail: string;
}

interface SessionItem {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  taskType: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
  costUsd: number | null;
  outcome: string;
  anomalies: SessionAnomaly[];
  actionCount: number;
  highRiskCount: number;
  lastActionAt: string | null;
}

interface SessionsPayload {
  items: SessionItem[];
  summary: {
    total: number;
    anomalies: number;
    returned: number;
    windowDays: number;
    source: { stateDbAvailable: boolean; sessionTable: string | null; reason: string };
    replay: { enabled: boolean; note: string };
    unimplementedRules: string[];
  };
  lastRefresh: { scanned: number; indexed: number; stateDbAvailable: boolean; sessionTable: string | null; reason: string; at: string | null };
}

/** 终态 → 品牌语义 tone（antd 预设色名 red/green/processing 与品牌信号色不是同一值，统一走 StatusBadge）。 */
const OUTCOME_TONE: Record<string, SemanticTone> = {
  ok: "ok",
  error: "error",
  running: "brand",
  aborted: "warn",
  unknown: "unknown",
};

const OUTCOME_LABEL: Record<string, string> = {
  ok: "正常结束",
  error: "错误结束",
  running: "进行中",
  aborted: "中断",
  unknown: "未知",
};

const ANOMALY_TONE: Record<SessionAnomaly["severity"], SemanticTone> = {
  warn: "warn",
  critical: "error",
};

const ANOMALY_LABEL: Record<string, string> = {
  "error-terminated": "错误结束",
  "orphan-reaped": "中断",
  "context-truncated": "上下文截断",
  "long-running": "长会话",
  "high-risk-actions": "高危动作",
};

const durationText = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};


export function SessionsPage() {
  const [data, setData] = useState<SessionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 过滤同步到 URL（规范 03 §3.12）：刷新/分享能还原同一视图（评审 P1-7）。
  const [anomaly, setAnomaly] = useUrlState<string>("anomaly", "all");
  const [outcome, setOutcome] = useUrlState<string>("outcome", "all");
  const [busy, setBusy] = useState(false);

  const anomalyOnly = anomaly === "anomaly";

  const refresh = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (anomalyOnly) params.set("anomalyOnly", "1");
    if (outcome !== "all") params.set("outcome", outcome);
    void loadJson<SessionsPayload>(`/api/sessions?${params.toString()}`, 20_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, [anomalyOnly, outcome]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 60_000);

  const reindex = useCallback(async () => {
    setBusy(true);
    const result = await postJson("/api/sessions/reindex", {}, 60_000);
    setBusy(false);
    if (result.ok) refresh();
  }, [refresh]);

  const columns: ColumnsType<SessionItem> = [
    {
      title: "会话",
      dataIndex: "sessionId",
      key: "sessionId",
      ellipsis: true,
      width: 220,
      render: (sessionId: string) => <Link to={`/sessions/${encodeURIComponent(sessionId)}`}>{sessionId}</Link>,
    },
    {
      title: "开始时间",
      dataIndex: "startedAt",
      key: "startedAt",
      width: 165,
      render: (value: string | null) => (value === null ? "—" : new Date(value).toLocaleString()),
    },
    { title: "时长", dataIndex: "durationMs", key: "durationMs", width: 90, render: (value: number | null) => durationText(value) },
    { title: "模型", dataIndex: "model", key: "model", ellipsis: true, render: (value: string | null) => value ?? "—" },
    { title: "任务类型", dataIndex: "taskType", key: "taskType", ellipsis: true, render: (value: string | null) => value ?? "—" },
    {
      title: "Token",
      key: "tokens",
      width: 120,
      render: (_: unknown, row: SessionItem) =>
        row.tokenIn === null && row.tokenOut === null
          ? "—"
          : `${((row.tokenIn ?? 0) + (row.tokenOut ?? 0)).toLocaleString()}`,
    },
    { title: "成本", dataIndex: "costUsd", key: "costUsd", width: 90, render: (value: number | null) => money(value) },
    {
      title: "终态",
      dataIndex: "outcome",
      key: "outcome",
      width: 100,
      render: (value: string) => (
        <StatusBadge tone={OUTCOME_TONE[value] ?? "unknown"} label={OUTCOME_LABEL[value] ?? value} />
      ),
    },
    {
      title: "动作 / 高危",
      key: "actions",
      width: 110,
      render: (_: unknown, row: SessionItem) => (
        <span>
          {row.actionCount}
          {row.highRiskCount > 0 && (
            <Typography.Text style={{ color: "var(--ab-error)", fontSize: 12 }}> / {row.highRiskCount}</Typography.Text>
          )}
        </span>
      ),
    },
    {
      title: "异常",
      key: "anomalies",
      width: 220,
      render: (_: unknown, row: SessionItem) =>
        row.anomalies.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Flex gap={4} wrap="wrap">
            {row.anomalies.map((anomaly) => (
              <Tooltip key={anomaly.kind} title={anomaly.detail}>
                <span>
                  <StatusBadge
                    tone={ANOMALY_TONE[anomaly.severity]}
                    label={ANOMALY_LABEL[anomaly.kind] ?? anomaly.kind}
                  />
                </span>
              </Tooltip>
            ))}
          </Flex>
        ),
    },
  ];

  const summary = data?.summary;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 会话页要区分「有会话但都正常」与「有会话失败/异常」：异常数 > 0 走 warn，
   * 数据源读不到走 error（索引本身可能不完整）。读不到不猜、不填 0。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "会话索引暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在加载会话索引", copy: "刚打开页面，稍等片刻。" }
        : summary === undefined
          ? { tone: "unknown", title: "正在整理会话索引", copy: "数据已返回但摘要缺失，稍后重试。" }
          : !summary.source.stateDbAvailable
            ? {
                tone: "error",
                title: "数据源（Hermes state.db）读不到",
                copy: `${summary.source.reason}。当前索引可能不完整${
                  summary.anomalies > 0 ? `，且已检出 ${summary.anomalies} 个会话带异常` : ""
                }；点「重建索引」重试。`,
                action: <Button onClick={() => void reindex()}>重建索引</Button>,
              }
            : summary.anomalies > 0
              ? {
                  tone: "warn",
                  title: `近 ${summary.windowDays} 天有 ${summary.anomalies} 个会话带异常`,
                  copy: `共索引 ${summary.total} 个会话；点开任一行看动作链与异常明细。`,
                }
              : {
                  tone: "ok",
                  title: `近 ${summary.windowDays} 天记录了 ${summary.total} 个会话`,
                  copy: "没有异常标记。",
                };

  const stats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          {
            key: "total",
            icon: ClockCircleOutlined,
            label: `索引会话（近 ${summary.windowDays} 天）`,
            value: summary.total,
            sub: "已建索引的会话数",
          },
          {
            key: "anomalies",
            icon: WarningOutlined,
            label: "含异常会话",
            value: summary.anomalies,
            tone: summary.anomalies > 0 ? "warn" : undefined,
            sub: summary.anomalies > 0 ? "点开可看异常明细" : "暂无异常标记",
          },
          {
            key: "source",
            icon: DatabaseOutlined,
            label: "数据源（Hermes state.db）",
            value: summary.source.stateDbAvailable ? (summary.source.sessionTable ?? "仅用量表") : "不可用",
            tone: summary.source.stateDbAvailable ? undefined : "error",
            sub: summary.source.reason !== "" ? summary.source.reason : "读到的数据表",
          },
        ];

  return (
    <section className="sessions-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="会话追踪"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Tooltip title="立即重建索引（读 Hermes state.db + 动作流）">
                <Button type="primary" icon={<SyncOutlined />} loading={busy} onClick={() => void reindex()}>
                  重建索引
                </Button>
              </Tooltip>
            </Space>
          }
        />

        {/* §2.3 ② 结论条。原「会话索引不可用」Alert 与离线结论同一件事，已并入此条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={stats} />

        {summary !== undefined && (
          <Alert
            type="info"
            showIcon
            message="首版覆盖范围与隐私边界"
            description={
              <Flex vertical gap={4}>
                <span>{summary.replay.note}</span>
                {summary.unimplementedRules.length > 0 && (
                  <span>
                    尚未实现的规则（Hermes 侧缺少数据源）：
                    {summary.unimplementedRules.join("；")}
                  </span>
                )}
              </Flex>
            }
          />
        )}

        <Card
          title="会话列表"
          extra={
            <Space>
              <Segmented
                options={[
                  { label: "全部", value: "all" },
                  { label: "仅异常", value: "anomaly" },
                ]}
                value={anomaly}
                onChange={(value) => setAnomaly(value as string)}
              />
              <Select
                value={outcome}
                style={{ width: 130 }}
                onChange={setOutcome}
                options={[
                  { value: "all", label: "全部终态" },
                  { value: "ok", label: "正常结束" },
                  { value: "error", label: "错误结束" },
                  { value: "aborted", label: "中断" },
                  { value: "running", label: "进行中" },
                  { value: "unknown", label: "未知" },
                ]}
              />
            </Space>
          }
        >
          {data !== null && data.items.length === 0 ? (
            <Empty
              title="窗口内还没有会话记录"
              hint="等采集器跑一轮，或点「重建索引」。"
              mascotWidth={72}
            />
          ) : (
            <Table<SessionItem>
              rowKey="sessionId"
              columns={columns}
              dataSource={data?.items ?? []}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1200 }}
            />
          )}
        </Card>
      </Flex>
    </section>
  );
}
