/**
 * 会话时间线（Trust Layer M2.3）：/sessions/:id
 * - 左轴垂直时间线：会话开始 → 动作（高危红边）→ 异常标记 → 会话结束；
 * - 每个动作节点可展开原始载荷（已脱敏片段，来自审计流）；
 * - 隐私边界显式提示：不展示对话正文。
 */
import { Alert, Button, Card, Descriptions, Empty, Flex, Tag, Timeline, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson } from "../../lib/api.js";
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

interface TimelineNode {
  kind: "session-start" | "session-end" | "action" | "anomaly";
  at: string;
  label: string;
  severity: "info" | "warn" | "critical";
  detail?: string;
  payload?: unknown;
}

interface DetailPayload {
  session: SessionItem;
  timeline: TimelineNode[];
  kinds: Record<string, number>;
}

const OUTCOME_LABEL: Record<string, string> = {
  ok: "正常结束",
  error: "错误结束",
  running: "进行中",
  unknown: "未知",
};

const NODE_COLOR: Record<TimelineNode["kind"], string> = {
  "session-start": "blue",
  "session-end": "gray",
  action: "gray",
  anomaly: "red",
};

export function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const sessionId = params.id ?? "";
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (sessionId === "") return;
    void loadJson<DetailPayload>(`/api/sessions/${encodeURIComponent(sessionId)}`, 20_000).then((result) => {
      if (result.ok) {
        setDetail(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 60_000);

  const session = detail?.session;

  return (
    <section className="session-detail-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层 · 会话追踪"
          title={sessionId === "" ? "会话时间线" : sessionId}
          description="回放这次会话的动作链：读了什么、写了什么、发了什么——每一步都有据可查。"
          extra={
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/sessions")}>
              返回列表
            </Button>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="无法加载会话" description={error} />}

        {session !== undefined && (
          <Card title="会话概况">
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
              <Descriptions.Item label="开始时间">
                {session.startedAt === null ? "—" : new Date(session.startedAt).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="结束时间">
                {session.endedAt === null ? "—" : new Date(session.endedAt).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="时长">
                {session.durationMs === null ? "—" : `${Math.round(session.durationMs / 1000)}s`}
              </Descriptions.Item>
              <Descriptions.Item label="模型">{session.model ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="任务类型">{session.taskType ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="终态">
                <Tag color={session.outcome === "error" ? "red" : session.outcome === "ok" ? "green" : "default"}>
                  {OUTCOME_LABEL[session.outcome] ?? session.outcome}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Token">
                {session.tokenIn === null && session.tokenOut === null
                  ? "—"
                  : `入 ${session.tokenIn ?? 0} / 出 ${session.tokenOut ?? 0}`}
              </Descriptions.Item>
              <Descriptions.Item label="成本">{session.costUsd === null ? "—" : `$${session.costUsd.toFixed(2)}`}</Descriptions.Item>
              <Descriptions.Item label="动作 / 高危">
                {session.actionCount}
                {session.highRiskCount > 0 ? ` / ${session.highRiskCount}` : ""}
              </Descriptions.Item>
            </Descriptions>
            {session.anomalies.length > 0 && (
              <Flex gap={6} wrap="wrap" style={{ marginTop: 12 }}>
                {session.anomalies.map((anomaly) => (
                  <Tag key={anomaly.kind} color={anomaly.severity === "critical" ? "red" : "orange"}>
                    {anomaly.detail}
                  </Tag>
                ))}
              </Flex>
            )}
          </Card>
        )}

        <Alert
          type="info"
          showIcon
          message="隐私边界"
          description="本页只展示结构化动作（脱敏片段）与元数据，不包含对话正文；完整回放（正文采集）尚未实现。"
        />

        <Card
          title="动作时间线"
          extra={
            detail !== null && Object.keys(detail.kinds).length > 0 ? (
              <Flex gap={4} wrap="wrap">
                {Object.entries(detail.kinds).map(([kind, count]) => (
                  <Tag key={kind}>{kind} × {count}</Tag>
                ))}
              </Flex>
            ) : undefined
          }
        >
          {detail === null || detail.timeline.length === 0 ? (
            <Empty description="该会话没有可回放的动作记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Timeline
              items={detail.timeline.map((node, index) => {
                const high = node.severity === "critical";
                return {
                  key: `${node.kind}-${index}`,
                  color: high ? "red" : NODE_COLOR[node.kind],
                  children: (
                    <div
                      style={{
                        borderLeft: node.kind === "anomaly" ? "3px solid #cf1322" : undefined,
                        paddingLeft: node.kind === "anomaly" ? 8 : 0,
                      }}
                    >
                      <Flex gap={8} align="center" wrap="wrap">
                        <Tag color={node.kind === "anomaly" ? "red" : node.kind === "session-start" ? "blue" : "default"}>
                          {node.kind}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {new Date(node.at).toLocaleString()}
                        </Typography.Text>
                      </Flex>
                      <Typography.Paragraph style={{ marginBottom: 0, marginTop: 4, fontFamily: "monospace", fontSize: 12 }}>
                        {node.label}
                      </Typography.Paragraph>
                      {node.detail !== undefined && node.detail !== "" && (
                        <Typography.Paragraph
                          type="secondary"
                          style={{ marginBottom: 0, fontSize: 12 }}
                          ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
                        >
                          {node.detail}
                        </Typography.Paragraph>
                      )}
                      {node.payload !== undefined && (
                        <Typography.Paragraph
                          type="secondary"
                          style={{ marginBottom: 0, marginTop: 4, fontSize: 11, fontFamily: "monospace" }}
                          ellipsis={{ rows: 3, expandable: true, symbol: "查看载荷" }}
                        >
                          {JSON.stringify(node.payload)}
                        </Typography.Paragraph>
                      )}
                    </div>
                  ),
                };
              })}
            />
          )}
        </Card>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提示：成本页 / 审计页 / 事件中心的会话标签均可一键跳转到本页。<Link to="/cost">去成本页</Link>
        </Typography.Text>
      </Flex>
    </section>
  );
}
