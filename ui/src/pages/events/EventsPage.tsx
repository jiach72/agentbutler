/**
 * 事件中心（Trust Layer M2.2）：告警、指纹、预算、急停等分散信号收敛为一处。
 * 左列表（regressed/active 置顶，severity×频率排序）+ 右详情（证据链 + 处理动作）。
 * 「回归是一等公民」：resolved 后同键复发自动标 regressed 置顶。
 *
 * 展示层遵循规范 03 §2.3：页头 → 结论条 → 主内容。
 * 结论只来自真实数据（评审 P0-2）；筛选落 URL 便于把「你看这个」贴给同事（评审 P1-7）；
 * 选中态与分隔线走品牌令牌，不再用 antd 默认蓝与半透明灰（评审 P1-2 / P2-4）。
 */
import { Button, Card, Col, Collapse, Descriptions, Flex, Row, Segmented, Typography } from "antd";
import { CheckOutlined, FlagOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import { useUrlState } from "../../hooks/useUrlState.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { eventKindCopy } from "./kindCopy.js";
import "./events.css";

interface TrustEvent {
  id: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: "active" | "acknowledged" | "resolved" | "regressed";
  evidence: unknown[];
  relatedIds: unknown[];
  dedupeKey: string;
  updatedAt: string;
}

/** 严重度只映射到品牌 6 档语义色，不用 antd 预设色名（预设色由算法派生，与品牌信号色不同值）。 */
const SEVERITY_TONE: Record<TrustEvent["severity"], SemanticTone | null> = {
  critical: "error",
  warn: "warn",
  /** 提示级不占用状态色：它表达「有条记录」，不是「有坏事」。 */
  info: null,
};

const SEVERITY_LABEL: Record<TrustEvent["severity"], string> = {
  critical: "严重",
  warn: "警告",
  info: "提示",
};

const STATUS_LABEL: Record<TrustEvent["status"], string> = {
  regressed: "回归",
  active: "进行中",
  acknowledged: "已确认",
  resolved: "已解决",
};

function evidenceText(event: TrustEvent): string {
  try {
    return JSON.stringify(event.evidence, null, 2);
  } catch {
    return "";
  }
}

/**
 * 证据链可读化：evidence 通常是「一条对象」或「对象数组」，把一层键值
 * 摊平成可读描述；键走平实映射，复杂值（对象/数组）折叠进原始 JSON。
 * 解析失败或结构意外时回退原始 JSON 文本，绝不渲染空白。
 */
const EVIDENCE_KEY_LABEL: Record<string, string> = {
  approvalId: "审批单",
  actionId: "动作记录",
  kind: "动作类型",
  target: "目标",
  path: "路径",
  command: "命令",
  expiresAt: "应答截止",
  status: "状态",
  channel: "渠道",
  actor: "操作人",
  reason: "原因",
  respondedAt: "应答时间",
  detail: "详情",
  source: "来源",
  fingerprint: "指纹",
  sessionId: "会话",
  count: "次数",
  template: "告警模板",
  body: "内容",
  probe: "探针",
  endpoint: "端点",
  category: "类别",
  // ── 复盘补全（2026-09-14）：逐一核对 watch 全部 trustEvents.record 产出的
  //    evidence 键，以下键此前缺映射、界面上显示英文裸键。未命中仍回退原键。
  at: "时间",
  version: "版本",
  changedAt: "变更时间",
  seenAt: "发现时间",
  signature: "错误指纹",
  instanceId: "实例",
  runId: "运行记录",
  regressions: "回归事件",
  rollbackNote: "回滚说明",
  spentUsd: "已花费（美元）",
  budgetUsd: "预算（美元）",
  trigger: "触发方式",
  stoppedInstanceIds: "已停止实例",
  stopFailures: "停止失败",
  snapshotId: "状态快照",
  snapshotError: "快照错误",
  failedToRestart: "重启失败",
  streak: "连续次数",
  lastClaimAt: "最后声明时间",
  outcome: "会话结果",
  actionCount: "动作数",
  observable: "可观测",
  note: "说明",
};

function isPlainValue(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function EvidenceReadable({ event }: { event: TrustEvent }) {
  const raw = event.evidence;
  const entries: Array<{ record: Record<string, unknown>; index: number; total: number }> = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        entries.push({ record: item as Record<string, unknown>, index, total: raw.length });
      }
    });
  } else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    entries.push({ record: raw as Record<string, unknown>, index: 0, total: 1 });
  }

  // 结构不是「对象（数组）」：原样给 JSON，不猜。
  if (entries.length === 0) {
    return <pre className="events-evidence">{evidenceText(event) || "（无证据记录）"}</pre>;
  }

  return (
    <Flex vertical gap={8}>
      {entries.map(({ record, index, total }) => {
        const keys = Object.keys(record);
        const simple = keys.filter((key) => isPlainValue(record[key]));
        const complex = keys.filter((key) => !isPlainValue(record[key]));
        return (
          <div key={index}>
            {total > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                记录 {index + 1} / {total}
              </Typography.Text>
            )}
            {simple.length > 0 && (
              <Descriptions size="small" column={1} className="events-evidence-kv">
                {simple.map((key) => (
                  <Descriptions.Item key={key} label={EVIDENCE_KEY_LABEL[key] ?? key}>
                    {String(record[key])}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
            {complex.length > 0 && (
              <Collapse
                size="small"
                ghost
                items={complex.map((key) => ({
                  key,
                  label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>{EVIDENCE_KEY_LABEL[key] ?? key}（原始数据）</Typography.Text>,
                  children: (
                    <pre className="events-evidence">
                      {(() => {
                        try {
                          return JSON.stringify(record[key], null, 2);
                        } catch {
                          return String(record[key]);
                        }
                      })()}
                    </pre>
                  ),
                }))}
              />
            )}
          </div>
        );
      })}
    </Flex>
  );
}

/** 「要不要标记已解决」的状态引导：随事件状态变化的一句话。 */
function statusGuidance(status: TrustEvent["status"]): string {
  switch (status) {
    case "active":
      return "这条正在发生。实际问题解决后再标记已解决；只是先认下、还没处理完，就先标记已确认。";
    case "acknowledged":
      return "已有人认领但还没解决。问题真正修好后请标记已解决，否则它会一直留在未解决列表里。";
    case "resolved":
      return "已标记为解决。同样的情况再出现时，这条会自动回到进行中（回归）。";
    case "regressed":
      return "同样的问题又出现了，请重新处理后再次标记已解决。";
  }
}

export function EventsPage() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<TrustEvent[] | null>(null);
  // 筛选同步到 URL：刷新、返回、贴链接都能还原同一个视图（评审 P1-7）。
  const [statusFilter, setStatusFilter] = useUrlState<string>("status", "open");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void loadJson<{ events: TrustEvent[] }>("/api/trust/events?limit=100", 6_000).then((result) => {
      if (result.ok) {
        setEvents(result.data.events);
        setError(null);
        setSelectedId((current) => {
          if (current !== null && result.data.events.some((event) => event.id === current)) return current;
          return result.data.events[0]?.id ?? null;
        });
      } else {
        setError(result.reason);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 15_000);

  const setStatus = async (id: number, status: "acknowledged" | "resolved" | "active") => {
    const result = await postJson(`/api/trust/events/${id}/status`, { status });
    if (result.ok) {
      refresh();
    }
  };

  const visible = useMemo(() => {
    const list = events ?? [];
    if (statusFilter === "open") return list.filter((event) => event.status !== "resolved");
    if (statusFilter === "all") return list;
    return list.filter((event) => event.status === statusFilter);
  }, [events, statusFilter]);

  const selected = useMemo(
    () => visible.find((event) => event.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

  const counts = useMemo(() => {
    const list = events ?? [];
    const criticalActive = list.filter(
      (event) => event.severity === "critical" && (event.status === "active" || event.status === "regressed"),
    ).length;
    return {
      regressed: list.filter((event) => event.status === "regressed").length,
      active: list.filter((event) => event.status === "active").length,
      criticalActive,
      acknowledged: list.filter((event) => event.status === "acknowledged").length,
    };
  }, [events]);

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 顺序即优先级：读不到 → 回归 → 严重进行中 → 一般进行中 → 没有进行中的（评审 P0-2）。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "事件中心暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : events === null
        ? { tone: "unknown", title: "正在读取事件", copy: "告警、指纹与预算事件会汇总到这里。" }
        : counts.regressed > 0
          ? {
              tone: "error",
              title: `有 ${counts.regressed} 个问题回归了`,
              copy: "之前已解决的同键问题又出现了；回归优先级最高，先看这几条。",
              action: <Button type="primary" onClick={() => navigate("/troubleshoot")}>去排查</Button>,
            }
          : counts.criticalActive > 0
            ? {
                tone: "error",
                title: `有 ${counts.criticalActive} 个严重事件正在进行`,
                copy: "这些事件会影响 agent 的正常工作，建议先处理。",
                action: <Button type="primary" onClick={() => navigate("/troubleshoot")}>去排查</Button>,
              }
            : counts.active > 0
              ? {
                  tone: "warn",
                  title: `有 ${counts.active} 个事件正在进行`,
                  copy:
                    counts.acknowledged > 0
                      ? `另有 ${counts.acknowledged} 个已确认待解决。`
                      : "目前没有回归，也没有严重级事件。",
                }
              : {
                  tone: "ok",
                  title: "没有正在进行的事件",
                  copy:
                    counts.acknowledged > 0
                      ? `另有 ${counts.acknowledged} 个已确认待解决，不着急。`
                      : "告警、指纹、预算与急停都没有新动作。",
                };

  return (
    <section className="events-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="事件中心"
        />

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <Flex gap={8} wrap="wrap">
          <Segmented
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as string)}
            options={[
              { value: "open", label: `未解决 (${counts.regressed + counts.active + counts.acknowledged})` },
              { value: "regressed", label: `回归 (${counts.regressed})` },
              { value: "resolved", label: "已解决" },
              { value: "all", label: "全部" },
            ]}
          />
        </Flex>
        <Row gutter={16}>
          <Col xs={24} lg={10}>
            <Card title="事件列表" styles={{ body: { padding: 0, maxHeight: 560, overflow: "auto" } }}>
              {visible.length === 0 ? (
                <Empty
                  className="events-empty"
                  title="没有待处理的事件"
                  hint="换个筛选看看，或等管家报告新的异常——没问题时这里本来就该是空的。"
                  mascotWidth={80}
                />
              ) : (
                <Flex vertical>
                  {visible.map((event) => {
                    const tone = SEVERITY_TONE[event.severity];
                    const kindCopy = eventKindCopy(event.kind);
                    const isSelected = selected?.id === event.id;
                    return (
                      <button
                        key={event.id}
                        type="button"
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => setSelectedId(event.id)}
                        className={`events-row${isSelected ? " is-selected" : ""}`}
                      >
                        <Flex gap={6} align="center" wrap="wrap" style={{ marginBottom: 4 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {kindCopy.label}
                          </Typography.Text>
                          {tone === null ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {SEVERITY_LABEL[event.severity]}
                            </Typography.Text>
                          ) : (
                            <StatusBadge tone={tone} label={SEVERITY_LABEL[event.severity]} />
                          )}
                          {event.status === "regressed" ? (
                            <StatusBadge tone="error" label={STATUS_LABEL.regressed} />
                          ) : (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {STATUS_LABEL[event.status]}
                            </Typography.Text>
                          )}
                          {event.count > 1 && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              共 {event.count} 次
                            </Typography.Text>
                          )}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {new Date(event.lastSeen).toLocaleString()}
                          </Typography.Text>
                        </Flex>
                        <Typography.Text strong={event.severity !== "info"} style={{ fontSize: 13 }}>
                          {event.title}
                        </Typography.Text>
                      </button>
                    );
                  })}
                </Flex>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card
              title={selected !== null ? "事件详情" : "详情"}
              extra={
                selected !== null && (selected.status === "active" || selected.status === "regressed")
                  ? (
                    <Flex gap={8}>
                      <Button
                        size="small"
                        icon={<FlagOutlined />}
                        onClick={() => void setStatus(selected.id, "acknowledged")}
                      >
                        标记已确认
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        icon={<CheckOutlined />}
                        onClick={() => void setStatus(selected.id, "resolved")}
                      >
                        标记已解决
                      </Button>
                    </Flex>
                  )
                  : selected !== null && selected.status !== "active"
                    ? (
                      <Button size="small" onClick={() => void setStatus(selected.id, "active")}>
                        重新打开
                      </Button>
                    )
                    : undefined
              }
            >
              {selected === null ? (
                <Empty title="先选一条事件" hint="左侧列表里点一条，这里会展示它的证据链和处理动作。" mascotWidth={72} />
              ) : (
                <Flex vertical gap={12}>
                  <Typography.Title level={5} style={{ marginTop: 0 }}>{selected.title}</Typography.Title>
                  {(() => {
                    const kindCopy = eventKindCopy(selected.kind);
                    return (
                      <div
                        className="events-kind-explain"
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          background: "var(--ab-surface-2, rgba(127,127,127,0.08))",
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 13 }}>{kindCopy.label}</Typography.Text>
                        <Typography.Paragraph type="secondary" style={{ margin: "2px 0 0", fontSize: 12 }}>
                          {kindCopy.what}
                        </Typography.Paragraph>
                        <Typography.Paragraph style={{ margin: 0, fontSize: 12 }}>
                          {kindCopy.action}
                        </Typography.Paragraph>
                      </div>
                    );
                  })()}
                  <Flex gap={6} wrap="wrap" align="center">
                    {SEVERITY_TONE[selected.severity] === null ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {SEVERITY_LABEL[selected.severity]}
                      </Typography.Text>
                    ) : (
                      <StatusBadge
                        tone={SEVERITY_TONE[selected.severity] as SemanticTone}
                        label={SEVERITY_LABEL[selected.severity]}
                      />
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {eventKindCopy(selected.kind).label}
                      <small style={{ marginLeft: 4, opacity: 0.7 }}>{selected.kind}</small>
                    </Typography.Text>
                    {selected.status === "regressed" ? (
                      <StatusBadge tone="error" label={STATUS_LABEL.regressed} />
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {STATUS_LABEL[selected.status]}
                      </Typography.Text>
                    )}
                    {selected.count > 1 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        发生 {selected.count} 次
                      </Typography.Text>
                    )}
                  </Flex>
                  {/* 「要不要标记已解决」的引导（客户：不知道要不要标记）。 */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {statusGuidance(selected.status)}
                  </Typography.Text>
                  <div className="events-evidence-timeline">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>时间线</Typography.Text>
                    <dl className="kv">
                      <dt>首次出现</dt>
                      <dd>{new Date(selected.firstSeen).toLocaleString()}</dd>
                      <dt>最近出现</dt>
                      <dd>{new Date(selected.lastSeen).toLocaleString()}</dd>
                      <dt>状态更新</dt>
                      <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
                    </dl>
                  </div>
                  <Typography.Text type="secondary">证据链（脱敏）</Typography.Text>
                  <EvidenceReadable event={selected} />
                  {/* 原始事件键挪进折叠区：排查对照有用，但不该占主视觉。 */}
                  <Collapse
                    size="small"
                    ghost
                    items={[
                      {
                        key: "dedupe",
                        label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>排查信息（事件键）</Typography.Text>,
                        children: (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable>
                            事件键：{selected.dedupeKey}
                          </Typography.Text>
                        ),
                      },
                    ]}
                  />
                  {selected.status === "resolved" && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      同类问题再次出现会自动标为回归并置顶。
                    </Typography.Text>
                  )}
                </Flex>
              )}
            </Card>
          </Col>
        </Row>
      </Flex>
    </section>
  );
}
