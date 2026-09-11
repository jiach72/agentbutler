/**
 * 会话追踪列表（Trust Layer M2.3）：
 * - 汇总卡：会话总数 / 异常数 / state.db 可用性与命中表 / 未实现规则（显式声明）；
 * - 过滤：仅异常、终态；
 * - 表格：会话元数据 + 动作聚合 + 异常标记，点击进入 /sessions/:id 时间线。
 * 数据真相原则：Hermes 会话表/列缺失时对应维度显示「—」，不臆测；正文永不展示。
 */
import { Alert, Button, Card, Empty, Flex, Segmented, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

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

const OUTCOME_TAG: Record<string, { color: string; label: string }> = {
  ok: { color: "green", label: "正常结束" },
  error: { color: "red", label: "错误结束" },
  running: { color: "processing", label: "进行中" },
  unknown: { color: "default", label: "未知" },
};

const ANOMALY_LABEL: Record<string, string> = {
  "error-terminated": "错误结束",
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

const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(2)}`);

export function SessionsPage() {
  const [data, setData] = useState<SessionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anomalyOnly, setAnomalyOnly] = useState(false);
  const [outcome, setOutcome] = useState<string>("all");
  const [busy, setBusy] = useState(false);

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
    { title: "成本", dataIndex: "costUsd", key: "costUsd", width: 90, render: (value: number | null) => usd(value) },
    {
      title: "终态",
      dataIndex: "outcome",
      key: "outcome",
      width: 100,
      render: (value: string) => {
        const meta = OUTCOME_TAG[value] ?? OUTCOME_TAG.unknown!;
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: "动作 / 高危",
      key: "actions",
      width: 110,
      render: (_: unknown, row: SessionItem) => (
        <span>
          {row.actionCount}
          {row.highRiskCount > 0 && <Typography.Text type="danger"> / {row.highRiskCount}</Typography.Text>}
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
                <Tag color={anomaly.severity === "critical" ? "red" : "orange"}>
                  {ANOMALY_LABEL[anomaly.kind] ?? anomaly.kind}
                </Tag>
              </Tooltip>
            ))}
          </Flex>
        ),
    },
  ];

  const summary = data?.summary;

  return (
    <section className="sessions-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="会话追踪"
          description="凌晨三点 agent 干了什么——按会话回放它的动作链，而不是对着原始日志猜。"
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

        {error !== null && <Alert type="warning" showIcon message="会话索引不可用" description={error} />}

        {summary !== undefined && (
          <>
            <Flex gap={16} wrap="wrap">
              <Card style={{ flex: "1 1 180px" }}>
                <Statistic title={`索引会话（近 ${summary.windowDays} 天）`} value={summary.total} />
              </Card>
              <Card style={{ flex: "1 1 180px" }}>
                <Statistic
                  title="含异常会话"
                  value={summary.anomalies}
                  valueStyle={summary.anomalies > 0 ? { color: "#d46b08" } : undefined}
                />
              </Card>
              <Card style={{ flex: "2 1 320px" }}>
                <Statistic
                  title="数据源（Hermes state.db）"
                  value={summary.source.stateDbAvailable ? (summary.source.sessionTable ?? "仅用量表") : "不可用"}
                  valueStyle={summary.source.stateDbAvailable ? undefined : { color: "#cf1322" }}
                  suffix={
                    summary.source.reason !== "" ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {summary.source.reason}
                      </Typography.Text>
                    ) : undefined
                  }
                />
              </Card>
            </Flex>

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
          </>
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
                value={anomalyOnly ? "anomaly" : "all"}
                onChange={(value) => setAnomalyOnly(value === "anomaly")}
              />
              <Select
                value={outcome}
                style={{ width: 130 }}
                onChange={setOutcome}
                options={[
                  { value: "all", label: "全部终态" },
                  { value: "ok", label: "正常结束" },
                  { value: "error", label: "错误结束" },
                  { value: "running", label: "进行中" },
                  { value: "unknown", label: "未知" },
                ]}
              />
            </Space>
          }
        >
          {data !== null && data.items.length === 0 ? (
            <Empty description="窗口内没有会话记录：等采集器跑一轮，或点「重建索引」" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
