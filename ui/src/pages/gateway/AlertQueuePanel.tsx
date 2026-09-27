/**
 * 待处理通知面板：告警队列计数 + 队列表（antd Table）。
 */
import { Button, Drawer, Flex, Table, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdvancedEvidence } from "../../components/AdvancedEvidence.js";
import type { TableColumnsType } from "antd";
import { Empty } from "../../components/Empty.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import { formatNumber, formatRelative } from "../../lib/format.js";
import { channelLabel, sourceLabel, statusTone } from "./helpers.js";
import type { AlertItem, AlertsView } from "./helpers.js";

interface AlertQueuePanelProps {
  alerts: AlertsView | null;
  history?: boolean;
  onNavigate?: (path: string) => void;
}

const QUEUE_COLUMNS: TableColumnsType<AlertItem> = [
  {
    title: "级别",
    width: 88,
    dataIndex: "severity",
    render: (_, item) => <StatusBadge {...statusTone(item.severity)} />,
  },
  {
    title: "提醒",
    width: 260,
    dataIndex: "title",
    render: (_, item) => (
      <Flex vertical gap={2}>
        <Typography.Text strong>{item.title}</Typography.Text>
        <Flex align="center" gap={6} wrap="wrap">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sourceLabel(item.source)}
          </Typography.Text>
          <CopySnippetButton text={String(item.id)} label={`#${item.id}`} />
        </Flex>
      </Flex>
    ),
  },
  {
    title: "状态",
    width: 96,
    dataIndex: "status",
    render: (_, item) => <StatusBadge {...statusTone(item.status)} />,
  },
  {
    title: "尝试",
    dataIndex: "attempts",
    width: 72,
    align: "right",
    render: (value: number) => formatNumber(value),
  },
  {
    title: "通道",
    width: 96,
    dataIndex: "channel",
    render: (_, item) => channelLabel(item.channel),
  },
  {
    title: "入队时间",
    width: 120,
    dataIndex: "createdAt",
    render: (_, item) => formatRelative(item.createdAt),
  },
];

export function AlertQueuePanel({ alerts, history = false, onNavigate }: AlertQueuePanelProps) {
  const [selected, setSelected] = useState<AlertItem | null>(null);
  let routerNavigate: ((to: string) => void) | null = null;
  try {
    routerNavigate = useNavigate();
  } catch {
    // Graceful fallback when rendered outside Router context (e.g. isolated SSR / unit tests)
  }

  const handleNavigate = (path: string) => {
    if (onNavigate) {
      onNavigate(path);
    } else if (routerNavigate) {
      routerNavigate(path);
    } else if (typeof window !== "undefined") {
      window.location.href = path;
    }
  };

  const items = (alerts?.items ?? []).filter((item) => history || item.status === "failed");
  const columns: TableColumnsType<AlertItem> = [
    ...QUEUE_COLUMNS,
    {
      title: "操作",
      key: "action",
      width: 100,
      render: (_, item) => (
        <Button type="link" onClick={() => setSelected(item)}>
          查看详情
        </Button>
      ),
    },
  ];
  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} component="h2" style={{ marginBottom: 0 }}>
        {history ? "通知历史" : "发送失败的通知"}
      </Typography.Title>
      {alerts === null || !alerts.reachable ? (
        <Empty mascot={false} title="暂时无法确认通知状态" hint="服务恢复后刷新重试。" />
      ) : (
        <>
          {history && (
            <Flex wrap="wrap" gap={16} align="center" aria-label="告警队列计数">
              {(["pending", "delivering", "delivered", "failed", "resolved"] as const).map((status) => (
                <Flex key={status} align="center" gap={6}>
                  <StatusBadge {...statusTone(status)} />
                  <Typography.Text strong>{alerts.counts[status] ?? 0}</Typography.Text>
                </Flex>
              ))}
            </Flex>
          )}
          {items.length === 0 ? (
            <Empty
              mascot={false}
              title={
                history
                  ? "还没有通知记录"
                  : (alerts.counts.failed ?? 0) > 0
                    ? `有 ${alerts.counts.failed} 条失败通知，当前记录未包含明细`
                    : "没有发送失败的通知"
              }
            />
          ) : (
            <Table<AlertItem>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={items}
              scroll={{ x: 860 }}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
            />
          )}
          {!history && (alerts.counts.failed ?? 0) > 0 && (
            <Button onClick={() => handleNavigate("/gateway?tab=channels")}>检查消息通道</Button>
          )}
        </>
      )}
      <Drawer
        title={
          selected !== null ? (
            <Flex align="center" gap={8} wrap="wrap">
              <span>通知详情</span>
              <CopySnippetButton text={String(selected.id)} label={`#${selected.id}`} />
            </Flex>
          ) : (
            "通知详情"
          )
        }
        open={selected !== null}
        onClose={() => setSelected(null)}
        size={640}
        styles={{ wrapper: { maxWidth: "100%" } }}
      >
        {selected !== null && (
          <Flex vertical gap={16} style={{ overflowWrap: "anywhere" }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {selected.title}
              </Typography.Title>
              <CopySnippetButton text={() => JSON.stringify(selected, null, 2)} label="复制通知 JSON" />
            </Flex>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
              {selected.body}
            </Typography.Paragraph>
            {selected.status === "failed" && (
              <Button onClick={() => handleNavigate("/gateway?tab=channels")}>检查消息通道</Button>
            )}
            <AdvancedEvidence>
              {selected.lastError && (
                <Flex justify="space-between" align="flex-start" gap={8} style={{ marginBottom: 6 }}>
                  <Typography.Paragraph style={{ margin: 0, flex: 1 }}>{selected.lastError}</Typography.Paragraph>
                  <CopySnippetButton text={selected.lastError} label="复制错误" />
                </Flex>
              )}
              <Typography.Text>
                {selected.source} · {selected.status} · {selected.attempts} 次尝试
              </Typography.Text>
            </AdvancedEvidence>
          </Flex>
        )}
      </Drawer>
    </Flex>
  );
}
