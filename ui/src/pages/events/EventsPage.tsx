/**
 * 事件中心（Trust Layer M2.2）：告警、指纹、预算、急停等分散信号收敛为一处。
 * 左列表（regressed/active 置顶，severity×频率排序）+ 右详情（证据链 + 处理动作）。
 * 「回归是一等公民」：resolved 后同键复发自动标 regressed 置顶。
 *
 * 展示层遵循规范 03 §2.3：页头 → 结论条 → 主内容。
 * 结论只来自真实数据（评审 P0-2）；筛选落 URL 便于把「你看这个」贴给同事（评审 P1-7）；
 * 选中态与分隔线走品牌令牌，不再用 antd 默认蓝与半透明灰（评审 P1-2 / P2-4）。
 */
import { Button, Card, Col, Flex, Row, Segmented, Typography } from "antd";
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
          description="告警、回归和预算事件都汇总在这一页，处理进度也在这里更新。"
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
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{selected.kind}</Typography.Text>
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
                  <pre className="events-evidence">{evidenceText(selected) || "（无证据记录）"}</pre>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    事件键：{selected.dedupeKey}
                    {selected.status === "resolved"
                      ? "。同类问题再次出现会自动标为回归并置顶。"
                      : ""}
                  </Typography.Text>
                </Flex>
              )}
            </Card>
          </Col>
        </Row>
      </Flex>
    </section>
  );
}
