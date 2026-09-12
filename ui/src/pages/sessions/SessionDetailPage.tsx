/**
 * 会话时间线（Trust Layer M2.3）：/sessions/:id
 * - 会话概况：关键元数据 + 终态/异常（StatusBadge，色走品牌语义）；
 * - 动作时间线（核心信息）：会话开始 → 动作 → 异常标记 → 会话结束；
 *   节点色按动作结果取语义 tone（成功→ok、失败→error、中性→brand），保留 Timeline；
 * - 每个动作节点可展开原始载荷（已脱敏片段，来自审计流）；
 * - 隐私边界显式提示：不展示对话正文。
 */
import { money } from "../../lib/format.js";
import { Alert, Button, Card, Descriptions, Flex, Tag, Timeline, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
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

/** 终态 → 品牌语义 tone（antd 预设色名 red/green/default 与品牌信号色不是同一值，统一走 StatusBadge）。 */
const OUTCOME_TONE: Record<string, SemanticTone> = {
  ok: "ok",
  error: "error",
  running: "brand",
  unknown: "unknown",
};

const OUTCOME_LABEL: Record<string, string> = {
  ok: "正常结束",
  error: "错误结束",
  running: "进行中",
  unknown: "未知",
};

/** 时间线节点严重度 → 品牌语义 tone：成功/中性走 brand（交互色），失败走 error。 */
const NODE_TONE: Record<TimelineNode["severity"], SemanticTone> = {
  info: "brand",
  warn: "warn",
  critical: "error",
};

/** 时间线节点严重度 → 品牌信号色（直接喂给 Timeline 的 dot color，避免 antd 预设蓝/灰与原色板不同值）。 */
const NODE_COLOR: Record<TimelineNode["severity"], string> = {
  info: "var(--ab-primary)",
  warn: "var(--ab-warn)",
  critical: "var(--ab-error)",
};

const ANOMALY_TONE: Record<SessionAnomaly["severity"], SemanticTone> = {
  warn: "warn",
  critical: "error",
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
  const hasCritical = session?.anomalies.some((a) => a.severity === "critical") ?? false;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 区分「有会话但都正常」与「有会话失败/异常」：含严重异常走 error，其余异常走 warn；
   * 无异常时按终态陈述事实，不夸「健康」。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "会话记录读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : detail === null
        ? { tone: "unknown", title: "正在加载会话时间线", copy: "稍等片刻。" }
        : session !== undefined && session.anomalies.length > 0
          ? hasCritical
            ? {
                tone: "error",
                title: `该会话有 ${session.anomalies.length} 个异常，含严重项`,
                copy: "建议点开下方时间线，定位出错的环节。",
              }
            : {
                tone: "warn",
                title: `该会话有 ${session.anomalies.length} 个异常标记`,
                copy: "多为长会话或上下文截断，时间线里能看到具体环节。",
              }
          : session !== undefined && session.outcome === "ok"
            ? {
                tone: "ok",
                title: `会话 ${sessionId} 已正常结束`,
                copy: `共 ${session.actionCount} 个动作${
                  session.highRiskCount > 0 ? `，其中 ${session.highRiskCount} 个高危` : ""
                }已回放。`,
              }
            : session !== undefined && session.outcome === "running"
              ? { tone: "info", title: `会话 ${sessionId} 仍在进行中`, copy: "动作链会随 agent 继续追加。" }
              : { tone: "unknown", title: `会话 ${sessionId} 终态未知`, copy: "没有收到明确的结束信号。" };

  return (
    <section className="session-detail-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="会话追踪"
          description={`会话 ${sessionId} 的完整动作记录，每一步都能展开看详情。`}
          extra={
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/sessions")}>
              返回列表
            </Button>
          }
        />

        {/* §2.3 ② 结论条。原「无法加载会话」Alert 与离线结论同一件事，已并入此条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

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
                <StatusBadge
                  tone={OUTCOME_TONE[session.outcome] ?? "unknown"}
                  label={OUTCOME_LABEL[session.outcome] ?? session.outcome}
                />
              </Descriptions.Item>
              <Descriptions.Item label="Token">
                {session.tokenIn === null && session.tokenOut === null
                  ? "—"
                  : `入 ${session.tokenIn ?? 0} / 出 ${session.tokenOut ?? 0}`}
              </Descriptions.Item>
              <Descriptions.Item label="成本">{money(session.costUsd)}</Descriptions.Item>
              <Descriptions.Item label="动作 / 高危">
                {session.actionCount}
                {session.highRiskCount > 0 ? ` / ${session.highRiskCount}` : ""}
              </Descriptions.Item>
            </Descriptions>
            {session.anomalies.length > 0 && (
              <Flex gap={6} wrap="wrap" style={{ marginTop: 12 }}>
                {session.anomalies.map((anomaly) => (
                  <StatusBadge key={anomaly.kind} tone={ANOMALY_TONE[anomaly.severity]} label={anomaly.detail} />
                ))}
              </Flex>
            )}
          </Card>
        )}

        <Alert
          type="info"
          showIcon
          message="隐私边界"
          description="本页只展示结构化动作（脱敏片段）与元数据，不包含对话正文；完整回放需要采集正文，目前未实现。"
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
            <Empty
              title="该会话没有可回放的动作记录"
              hint="动作流为空，或索引尚未覆盖这次会话。"
              mascotWidth={72}
            />
          ) : (
            <Timeline
              items={detail.timeline.map((node, index) => {
                const tone = NODE_TONE[node.severity];
                const anomaly = node.kind === "anomaly";
                return {
                  key: `${node.kind}-${index}`,
                  color: NODE_COLOR[node.severity],
                  children: (
                    <div
                      style={{
                        borderLeft: anomaly ? "3px solid var(--ab-error)" : undefined,
                        paddingLeft: anomaly ? 8 : 0,
                      }}
                    >
                      <Flex gap={8} align="center" wrap="wrap">
                        <StatusBadge tone={tone} label={node.kind} />
                        <Typography.Text type="secondary" style={{ fontSize: "var(--ab-text-size-xs)" }}>
                          {new Date(node.at).toLocaleString()}
                        </Typography.Text>
                      </Flex>
                      <Typography.Paragraph className="is-mono" style={{ marginBottom: 0, marginTop: 4, fontSize: "var(--ab-text-size-xs)" }}>
                        {node.label}
                      </Typography.Paragraph>
                      {node.detail !== undefined && node.detail !== "" && (
                        <Typography.Paragraph
                          type="secondary"
                          style={{ marginBottom: 0, fontSize: "var(--ab-text-size-xs)" }}
                          ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
                        >
                          {node.detail}
                        </Typography.Paragraph>
                      )}
                      {node.payload !== undefined && (
                        <Typography.Paragraph
                          type="secondary"
                          className="is-mono"
                          style={{ marginBottom: 0, marginTop: 4, fontSize: "var(--ab-text-size-xs)" }}
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

        <Typography.Text type="secondary" style={{ fontSize: "var(--ab-text-size-xs)" }}>
          提示：成本页 / 审计页 / 事件中心的会话标签均可一键跳转到本页。<Link to="/cost">去成本页</Link>
        </Typography.Text>
      </Flex>
    </section>
  );
}
