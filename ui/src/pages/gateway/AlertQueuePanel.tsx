/**
 * 待处理通知面板：告警队列计数 + 队列表（antd Table）。
 */
import { Table } from "antd";
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
      <div className="alert-title-cell" title={item.body}>
        <strong>{item.title}</strong>
        <span>{sourceLabel(item.source)}</span>
      </div>
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
    <>
      <h2 className="section-title">待处理通知</h2>
      {alerts === null || !alerts.reachable ? (
        <div className="empty-state">管家连上后，这里会显示排队中的提醒和当前通知状态。</div>
      ) : (
        <>
          <div className="queue-counts" aria-label="告警队列计数">
            {(["pending", "delivering", "delivered", "failed"] as const).map((status) => (
              <span key={status}>
                <StatusBadge {...statusTone(status)} />
                <strong>{alerts.counts[status] ?? 0}</strong>
              </span>
            ))}
          </div>
          {alerts.items.length === 0 ? (
            <div className="empty-state gateway-spaced">没有等待处理的通知。</div>
          ) : (
            <div className="card table-card gateway-spaced">
              <Table<AlertItem>
                size="small"
                rowKey="id"
                columns={QUEUE_COLUMNS}
                dataSource={alerts.items}
                scroll={{ x: 760 }}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
