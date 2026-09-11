/**
 * 事件中心（Trust Layer M2.2）：告警、指纹、预算、急停等分散信号收敛为一处。
 * 左列表（regressed/active 置顶，severity×频率排序）+ 右详情（证据链 + 处理动作）。
 * 「回归是一等公民」：resolved 后同键复发自动标 regressed 置顶。
 */
import { Button, Card, Col, Empty, Flex, Row, Segmented, Tag, Timeline, Typography } from "antd";
import { CheckOutlined, FlagOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

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

const SEVERITY_META: Record<TrustEvent["severity"], { label: string; color: string }> = {
  critical: { label: "严重", color: "red" },
  warn: { label: "警告", color: "orange" },
  info: { label: "提示", color: "blue" },
};

const STATUS_META: Record<TrustEvent["status"], { label: string; color: string }> = {
  regressed: { label: "回归", color: "volcano" },
  active: { label: "进行中", color: "red" },
  acknowledged: { label: "已确认", color: "gold" },
  resolved: { label: "已解决", color: "green" },
};

function evidenceText(event: TrustEvent): string {
  try {
    return JSON.stringify(event.evidence, null, 2);
  } catch {
    return "";
  }
}

export function EventsPage() {
  const [events, setEvents] = useState<TrustEvent[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");
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
    return {
      regressed: list.filter((event) => event.status === "regressed").length,
      active: list.filter((event) => event.status === "active").length,
      acknowledged: list.filter((event) => event.status === "acknowledged").length,
    };
  }, [events]);

  return (
    <section className="events-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="事件中心"
          description="发生了什么、影响了什么、怎么处理、处理好没有——只看这一个地方。"
        />
        {error !== null && <Typography.Text type="warning">事件中心不可用：{error}</Typography.Text>}
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
                  style={{ padding: 32 }}
                  description="没有待处理的事件——安心"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              ) : (
                <Flex vertical>
                  {visible.map((event) => {
                    const severity = SEVERITY_META[event.severity];
                    const status = STATUS_META[event.status];
                    const isSelected = selected?.id === event.id;
                    return (
                      <button
                        key={event.id}
                        type="button"
                        onClick={() => setSelectedId(event.id)}
                        style={{
                          textAlign: "left",
                          border: "none",
                          borderLeft: `3px solid ${isSelected ? "#1677ff" : "transparent"}`,
                          borderBottom: "1px solid rgba(128,128,128,0.15)",
                          background: isSelected ? "rgba(22,119,255,0.06)" : "transparent",
                          padding: "10px 14px",
                          cursor: "pointer",
                          width: "100%",
                        }}
                      >
                        <Flex gap={6} align="center" wrap="wrap" style={{ marginBottom: 4 }}>
                          <Tag color={severity.color}>{severity.label}</Tag>
                          <Tag color={status.color}>{status.label}</Tag>
                          {event.count > 1 && <Tag>×{event.count}</Tag>}
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
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
                <Empty description="选择左侧事件查看证据链" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Flex vertical gap={12}>
                  <Typography.Title level={5} style={{ marginTop: 0 }}>{selected.title}</Typography.Title>
                  <Flex gap={6} wrap="wrap">
                    <Tag color={SEVERITY_META[selected.severity].color}>
                      {SEVERITY_META[selected.severity].label}
                    </Tag>
                    <Tag>{selected.kind}</Tag>
                    <Tag color={STATUS_META[selected.status].color}>{STATUS_META[selected.status].label}</Tag>
                    {selected.count > 1 && <Tag>发生 {selected.count} 次</Tag>}
                  </Flex>
                  <Timeline
                    items={[
                      { children: `首次出现：${new Date(selected.firstSeen).toLocaleString()}` },
                      { children: `最近出现：${new Date(selected.lastSeen).toLocaleString()}` },
                      { children: `状态更新：${new Date(selected.updatedAt).toLocaleString()}` },
                    ]}
                  />
                  <Typography.Text type="secondary">证据链（脱敏）</Typography.Text>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      background: "rgba(128,128,128,0.08)",
                      borderRadius: 8,
                      fontSize: 12,
                      overflow: "auto",
                      maxHeight: 240,
                    }}
                  >
                    {evidenceText(selected) || "（无证据记录）"}
                  </pre>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    事件键：{selected.dedupeKey}
                    {selected.status === "resolved"
                      ? "。同键复发会自动转「回归」并置顶——回归是一等公民。"
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
