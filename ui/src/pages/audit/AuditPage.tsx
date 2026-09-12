/**
 * 行为审计页（Trust Layer M1.2）：
 * 「过去 N 小时我的 agent 动了哪些文件、跑了哪些命令、往外发了什么」。
 * - 按天分组的垂直时间线；高危动作（删除/外发/危险命令）红色信号边标出；
 * - 顶部过滤 chips（类型 / 严重度 / 时间窗）；
 * - 采集器降级态（no-sources / no-matches）显式展示，不假装一切正常。
 */
import { Button, Card, Flex, Segmented, Select, Timeline, Tooltip, Typography } from "antd";
import {
  CodeOutlined,
  DeleteOutlined,
  GlobalOutlined,
  LinkOutlined,
  MailOutlined,
  PushpinOutlined,
  QuestionOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { useUrlState } from "../../hooks/useUrlState.js";
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

/** 动作类型 → 展示元信息。颜色不再写死 antd 调色板，时间线点统一走品牌信号色（高危=error，其余=primary）。 */
const KIND_META: Record<ActionEvent["kind"], { label: string; icon: React.ReactNode }> = {
  "file-delete": { label: "文件删除", icon: <DeleteOutlined /> },
  "file-write": { label: "文件写入", icon: <PushpinOutlined /> },
  "shell-exec": { label: "命令执行", icon: <CodeOutlined /> },
  "api-call": { label: "API 调用", icon: <LinkOutlined /> },
  "message-send": { label: "外发消息", icon: <MailOutlined /> },
  "web-fetch": { label: "网络抓取", icon: <GlobalOutlined /> },
  raw: { label: "原始记录", icon: <QuestionOutlined /> },
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
  // 时间窗 / 类型 / 严重度筛选同步到 URL（规范 03 §3.12）：刷新/分享能还原同一视图（评审 P1-7）。
  const [windowHours, setWindowHours] = useUrlState<number>("range", 24);
  const [kindFilter, setKindFilter] = useUrlState<string>("kind", "all");
  const [severityFilter, setSeverityFilter] = useUrlState<string>("sev", "all");
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

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 原来挂在两条 Alert 上的「读不到 / 采集降级」信息并入结论，避免说两遍（评审 P0-2）。
   * 结论只陈述已读到的字段：读不到就说读不到，不猜、不填充。
   */
  const lastActionLabel =
    summary !== null && summary.lastActionAt !== null ? new Date(summary.lastActionAt).toLocaleString() : null;
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "审计数据暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在读取行为审计", copy: `正在拉取最近 ${windowHours} 小时的动作记录。` }
        : degraded && collector?.mode === "no-sources"
          ? {
              tone: "unknown",
              title: "还没有发现可解析的执行日志",
              copy: "采集器尚未在指定路径发现 agent 写入的执行日志；可用 BUTLER_AUDIT_LOG_PATHS 指定路径，有日志后会自动开始记录。",
            }
          : degraded
            ? {
                tone: "warn",
                title: "已启用采集，但还没匹配到结构化动作",
                copy: `解析器版本 ${collector?.parserVersion ?? "v1"}：当前日志格式未命中任何动作模式；未匹配的行不会猜测补齐，也不记录对话正文。`,
              }
            : summary === null
              ? {
                  tone: "unknown",
                  title: `最近 ${windowHours} 小时的动作明细已读到`,
                  copy: "概览合计数字这次没算出来，时间线照常展示；刷新可补上。",
                }
              : summary.highRisk > 0
                ? {
                    tone: "error",
                    title: `最近 ${windowHours} 小时有 ${summary.highRisk} 个高危动作`,
                    copy: `共记录 ${summary.total} 个动作${lastActionLabel !== null ? `，最近一次在 ${lastActionLabel}` : ""}。高危动作已用红色左边标出，点开会话可看时间线。`,
                  }
                : {
                    tone: "ok",
                    title: `最近 ${windowHours} 小时记录了 ${summary.total} 个动作`,
                    copy: `无高危${lastActionLabel !== null ? `；最近一次在 ${lastActionLabel}` : "；本窗口暂无任何动作"}。`,
                  };

  const auditStats: StatStripItem[] =
    summary === null
      ? []
      : [
          {
            key: "total",
            label: "动作总数",
            value: summary.total,
            unit: "个",
            sub: lastActionLabel !== null ? `最近一次 ${lastActionLabel}` : `窗口 ${summary.windowHours} 小时`,
          },
          {
            key: "high-risk",
            label: "高危动作",
            value: summary.highRisk,
            unit: "个",
            tone: summary.highRisk > 0 ? "error" : undefined,
            sub: summary.highRisk > 0 ? "已在时间线红边标出" : "本窗口无高危",
          },
        ];

  return (
    <section className="audit-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="行为审计"
          description={`agent 执行动作的时间线。默认保留 ${collector?.retentionDays ?? 14} 天，只记动作，不记对话内容。`}
        />

        {/* §2.3 ② 结论条：读不到 / 采集降级 / 高危概览都归到这里，不另立 Alert。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={auditStats} />

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
              title="窗口内还没有匹配的动作记录"
              hint="换一个时间窗或筛选条件看看；有动作后这里会按天列出时间线。"
              mascotWidth={72}
            />
          ) : (
            <Flex vertical gap={20}>
              {grouped.map(([day, events]) => (
                <div key={day}>
                  <Typography.Text type="secondary" strong>
                    {day}
                  </Typography.Text>
                  <Timeline
                    style={{ marginTop: 12 }}
                    items={events.map((event) => {
                      const meta = KIND_META[event.kind] ?? KIND_META.raw;
                      const snippet = snippetOf(event);
                      const high = event.severity === "high";
                      return {
                        color: high ? "var(--ab-error)" : "var(--ab-primary)",
                        dot: meta.icon,
                        children: (
                          <div
                            style={{
                              borderLeft: high ? "3px solid var(--ab-error)" : undefined,
                              paddingLeft: high ? 8 : 0,
                            }}
                          >
                            <Flex gap={8} align="center" wrap="wrap">
                              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                {meta.icon}
                                <Typography.Text>{meta.label}</Typography.Text>
                              </span>
                              {high && <StatusBadge tone="error" label="高危" />}
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {new Date(event.ts).toLocaleTimeString()}
                              </Typography.Text>
                              {event.sessionId !== null && (
                                <Tooltip title={`打开会话时间线：${event.sessionId}`}>
                                  <Link to={`/sessions/${encodeURIComponent(event.sessionId)}`}>
                                    <StatusBadge tone="brand" label={`会话 ${event.sessionId.slice(0, 10)}…`} />
                                  </Link>
                                </Tooltip>
                              )}
                            </Flex>
                            <Typography.Paragraph
                              className="is-mono"
                              style={{ marginBottom: snippet === "" ? 0 : 4, marginTop: 4, fontSize: 12 }}
                              ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}
                            >
                              {event.target}
                            </Typography.Paragraph>
                            {snippet !== "" && snippet !== event.target && (
                              <Typography.Paragraph
                                type="secondary"
                                className="is-mono"
                                style={{ marginBottom: 0, fontSize: "var(--ab-text-size-xs)" }}
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
