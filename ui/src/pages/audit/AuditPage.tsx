/**
 * 行为审计页（Trust Layer M1.2）：
 * 「过去 N 小时我的 agent 动了哪些文件、跑了哪些命令、往外发了什么」。
 * - 按天分组的垂直时间线；高危动作（删除/外发/危险命令）红色信号边标出；
 * - 顶部过滤 chips（类型 / 严重度 / 时间窗）；
 * - 采集器降级态（no-sources / no-matches）显式展示，不假装一切正常。
 */
import { Alert, Card, Empty, Flex, Segmented, Select, Tag, Timeline, Tooltip, Typography } from "antd";
import { DeleteOutlined, LinkOutlined, MailOutlined, PushpinOutlined, CodeOutlined, GlobalOutlined, QuestionOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

interface ActionEvent {
  id: number;
  ts: string;
  kind: "file-write" | "file-delete" | "shell-exec" | "api-call" | "message-send" | "web-fetch" | "raw";
  severity: "info" | "high";
  target: string;
  detailJson: string;
  sessionId: string | null;
  parserVersion: string;
}

interface ActionsResponse {
  windowHours: number;
  actions: ActionEvent[];
  collector: {
    enabled: boolean;
    mode: "structured" | "no-matches" | "no-sources";
    retentionDays: number;
    parserVersion: string;
    lastParsedAt: string | null;
    sources: Array<{ path: string; parsedBytes: number; lastParsedAt: string | null }>;
  };
}

interface AuditSummary {
  windowHours: number;
  total: number;
  highRisk: number;
  byKind: Record<string, number>;
  lastActionAt: string | null;
}

const KIND_META: Record<ActionEvent["kind"], { label: string; color: string; icon: React.ReactNode }> = {
  "file-delete": { label: "文件删除", color: "#cf1322", icon: <DeleteOutlined /> },
  "file-write": { label: "文件写入", color: "#1677ff", icon: <PushpinOutlined /> },
  "shell-exec": { label: "命令执行", color: "#d4380d", icon: <CodeOutlined /> },
  "api-call": { label: "API 调用", color: "#722ed1", icon: <LinkOutlined /> },
  "message-send": { label: "外发消息", color: "#cf1322", icon: <MailOutlined /> },
  "web-fetch": { label: "网络抓取", color: "#08979c", icon: <GlobalOutlined /> },
  raw: { label: "原始记录", color: "#8c8c8c", icon: <QuestionOutlined /> },
};

const WINDOWS = [
  { value: 24, label: "24 小时" },
  { value: 72, label: "3 天" },
  { value: 168, label: "7 天" },
];

function dayKey(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
}

function snippetOf(event: ActionEvent): string {
  try {
    const detail = JSON.parse(event.detailJson) as { snippet?: string };
    return typeof detail.snippet === "string" ? detail.snippet : "";
  } catch {
    return "";
  }
}

export function AuditPage() {
  const [windowHours, setWindowHours] = useState(24);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [data, setData] = useState<ActionsResponse | null>(null);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const params = new URLSearchParams({ hours: String(windowHours), limit: "300" });
    void loadJson<ActionsResponse>(`/api/audit/actions?${params.toString()}`, 8_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
    void loadJson<AuditSummary>(`/api/audit/summary?hours=${windowHours}`, 6_000).then((result) => {
      if (result.ok) setSummary(result.data);
    });
  }, [windowHours]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 20_000);

  const filtered = useMemo(() => {
    let actions = data?.actions ?? [];
    if (kindFilter !== "all") actions = actions.filter((item) => item.kind === kindFilter);
    if (severityFilter !== "all") actions = actions.filter((item) => item.severity === severityFilter);
    return actions;
  }, [data, kindFilter, severityFilter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ActionEvent[]>();
    for (const event of filtered) {
      const key = dayKey(event.ts);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  const kindOptions = useMemo(() => {
    const present = new Set((data?.actions ?? []).map((item) => item.kind));
    return [
      { value: "all", label: "全部类型" },
      ...Object.entries(KIND_META)
        .filter(([key]) => present.has(key as ActionEvent["kind"]))
        .map(([key, meta]) => ({ value: key, label: meta.label })),
    ];
  }, [data]);

  const collector = data?.collector;
  const degraded = collector !== null && collector !== undefined && collector.mode !== "structured";

  return (
    <section className="audit-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="行为审计"
          description={`agent 执行动作的时间线。默认保留 ${collector?.retentionDays ?? 14} 天，只记动作不记对话（隐私红线）。`}
        />

        {error !== null && <Alert type="warning" showIcon message="审计数据不可用" description={error} />}
        {degraded && (
          <Alert
            type={collector?.mode === "no-sources" ? "info" : "warning"}
            showIcon
            message={
              collector?.mode === "no-sources"
                ? "尚未发现可解析的执行日志"
                : "已启用采集，但日志中尚未匹配到结构化动作"
            }
            description={
              collector?.mode === "no-sources"
                ? "采集器会在 agent 写入执行日志后自动开始记录（可用 BUTLER_AUDIT_LOG_PATHS 指定路径）。"
                : "解析器版本 " + (collector?.parserVersion ?? "v1") + "：当前日志格式未命中任何动作模式；未匹配的行不会被猜测补齐，也不会记录对话正文。"
            }
          />
        )}

        {summary !== null && (
          <Flex gap={8} wrap="wrap">
            <Tag color="blue">{summary.total} 个动作</Tag>
            <Tag color={summary.highRisk > 0 ? "red" : "default"}>{summary.highRisk} 个高危</Tag>
            {summary.lastActionAt !== null && (
              <Tag>最近动作 {new Date(summary.lastActionAt).toLocaleString()}</Tag>
            )}
          </Flex>
        )}

        <Card
          title="动作时间线"
          extra={
            <Flex gap={8} wrap="wrap">
              <Segmented
                size="small"
                options={WINDOWS}
                value={windowHours}
                onChange={(value) => setWindowHours(value as number)}
              />
              <Select
                size="small"
                style={{ minWidth: 120 }}
                value={kindFilter}
                onChange={setKindFilter}
                options={kindOptions}
              />
              <Select
                size="small"
                style={{ minWidth: 110 }}
                value={severityFilter}
                onChange={setSeverityFilter}
                options={[
                  { value: "all", label: "全部级别" },
                  { value: "high", label: "仅高危" },
                  { value: "info", label: "常规" },
                ]}
              />
            </Flex>
          }
        >
          {filtered.length === 0 ? (
            <Empty
              description="窗口内没有匹配的动作记录"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Flex vertical gap={20}>
              {grouped.map(([day, events]) => (
                <div key={day}>
                  <Typography.Text type="secondary" strong>{day}</Typography.Text>
                  <Timeline
                    style={{ marginTop: 12 }}
                    items={events.map((event) => {
                      const meta = KIND_META[event.kind] ?? KIND_META.raw;
                      const snippet = snippetOf(event);
                      const high = event.severity === "high";
                      return {
                        color: high ? "red" : meta.color,
                        dot: meta.icon,
                        children: (
                          <div
                            style={{
                              borderLeft: high ? "3px solid #cf1322" : undefined,
                              paddingLeft: high ? 8 : 0,
                            }}
                          >
                            <Flex gap={8} align="center" wrap="wrap">
                              <Tag color={high ? "red" : "default"}>{meta.label}</Tag>
                              {high && <Tag color="red">高危</Tag>}
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {new Date(event.ts).toLocaleTimeString()}
                              </Typography.Text>
                              {event.sessionId !== null && (
                                <Tooltip title={`打开会话时间线：${event.sessionId}`}>
                                  <Link to={`/sessions/${encodeURIComponent(event.sessionId)}`}>
                                    <Tag style={{ fontSize: 11, cursor: "pointer" }} color="blue">
                                      会话 {event.sessionId.slice(0, 10)}…
                                    </Tag>
                                  </Link>
                                </Tooltip>
                              )}
                            </Flex>
                            <Typography.Paragraph
                              style={{ marginBottom: snippet === "" ? 0 : 4, marginTop: 4, fontFamily: "monospace", fontSize: 12 }}
                              ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
                            >
                              {event.target}
                            </Typography.Paragraph>
                            {snippet !== "" && snippet !== event.target && (
                              <Typography.Paragraph
                                type="secondary"
                                style={{ marginBottom: 0, fontFamily: "monospace", fontSize: 11 }}
                                ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
                              >
                                {snippet}
                              </Typography.Paragraph>
                            )}
                          </div>
                        ),
                      };
                    })}
                  />
                </div>
              ))}
            </Flex>
          )}
        </Card>
      </Flex>
    </section>
  );
}
