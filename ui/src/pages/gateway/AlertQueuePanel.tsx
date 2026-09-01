/**
 * 待处理通知面板：告警队列计数 + 队列表（antd Table）。
 */
import { Card, Empty, Flex, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatNumber, formatRelative } from "../../lib/format.js";
import { channelLabel, sourceLabel, statusTone } from "./helpers.js";
import type { AlertItem, AlertsView } from "./helpers.js";

interface AlertQueuePanelProps {
  alerts: AlertsView | null;
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
      <Flex vertical gap={2} title={item.body}>
        <Typography.Text strong>{item.title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {sourceLabel(item.source)}
        </Typography.Text>
      </Flex>
    ),
  },
  {
    title: "状态",
    width: 96,
    dataIndex: "status",
    render: (_, item) => <StatusBadge {...statusTone(item.status)} />,
  },
  { title: "尝试", dataIndex: "attempts", width: 72, align: "right", render: (value: number) => formatNumber(value) },
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

export function AlertQueuePanel({ alerts }: AlertQueuePanelProps) {
  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} component="h2" style={{ marginBottom: 0 }}>
        待处理通知
      </Typography.Title>
      {alerts === null || !alerts.reachable ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="管家连上后，这里会显示排队中的提醒和当前通知状态。"
        />
      ) : (
        <>
          <Flex wrap="wrap" gap={16} align="center" aria-label="告警队列计数">
            {(["pending", "delivering", "delivered", "failed"] as const).map((status) => (
              <Flex key={status} align="center" gap={6}>
                <StatusBadge {...statusTone(status)} />
                <Typography.Text strong>{alerts.counts[status] ?? 0}</Typography.Text>
              </Flex>
            ))}
          </Flex>
          {alerts.items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有等待处理的通知。" />
          ) : (
            <Card styles={{ body: { padding: 0 } }}>
              <Table<AlertItem>
                size="small"
                rowKey="id"
                columns={QUEUE_COLUMNS}
                dataSource={alerts.items}
                scroll={{ x: 760 }}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
              />
            </Card>
          )}
        </>
      )}
    </Flex>
  );
}
