import { BellOutlined, CheckOutlined, ReloadOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Popover, Spin } from "antd";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatRelative } from "../lib/format.js";
import { usePreferences } from "../lib/preferences.js";
import { useNotifications, type NotificationItem } from "../hooks/useNotifications.js";
import { StatusBadge } from "./StatusBadge.js";

function visibleForPreference(item: NotificationItem, minSeverity: "warn" | "critical"): boolean {
  return minSeverity === "critical" ? item.severity === "critical" : true;
}

function severityLabel(severity: NotificationItem["severity"]): string {
  if (severity === "critical") return "紧急";
  if (severity === "warn") return "留意";
  return "信息";
}

function NotificationContent({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, loading, markAllRead, markRead, refresh } = useNotifications();
  const [preferences] = usePreferences();
  const visibleItems = useMemo(
    () => items.filter((item) => visibleForPreference(item, preferences.notificationMinSeverity)).slice(0, 12),
    [items, preferences.notificationMinSeverity],
  );

  return (
    <section className="notification-panel" aria-label="重要通知">
      <header className="notification-panel-head">
        <div>
          <strong>重要通知</strong>
          <span>{unreadCount > 0 ? `${unreadCount} 条未读` : "目前没有未读"}</span>
        </div>
        <div className="notification-panel-actions">
          <Button type="text" icon={<ReloadOutlined />} aria-label="刷新通知" title="刷新通知" onClick={() => void refresh()} />
          <Button type="text" icon={<CheckOutlined />} aria-label="全部标记已读" title="全部标记已读" disabled={unreadCount === 0} onClick={() => void markAllRead()} />
        </div>
      </header>
      {loading && visibleItems.length === 0 ? (
        <div className="notification-panel-loading"><Spin size="small" /></div>
      ) : visibleItems.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需要留意的通知" />
      ) : (
        <ul className="notification-list">
          {visibleItems.map((item) => (
            <li key={item.id} className={`notification-item${item.readAt === null ? " is-unread" : ""}`}>
              <button type="button" className="notification-item-main" onClick={() => void markRead(item.id)}>
                <span className={`notification-severity is-${item.severity}`}><i />{severityLabel(item.severity)}</span>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
                <small>{formatRelative(item.createdAt)} · {item.source}</small>
              </button>
              {item.readAt === null && <span className="notification-unread-dot" aria-label="未读" />}
            </li>
          ))}
        </ul>
      )}
      <footer className="notification-panel-foot">
        <Link to="/gateway" onClick={onClose}>查看完整通知队列</Link>
        {preferences.notificationMinSeverity === "critical" && (
          <StatusBadge tone="error" label="仅显示紧急" />
        )}
      </footer>
    </section>
  );
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { unreadCount } = useNotifications();
  const [preferences] = usePreferences();
  const count = preferences.notificationBadgeEnabled ? unreadCount : 0;
  const label = count > 0 ? `重要通知，${count} 条未读` : "重要通知";

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      overlayClassName="notification-popover"
      content={<NotificationContent onClose={() => setOpen(false)} />}
    >
      <Badge className="notification-badge" count={count} overflowCount={99} size="small" offset={[-2, 2]}>
        <Button type="text" className="notification-trigger" icon={<BellOutlined />} aria-label={label} title={label} />
      </Badge>
    </Popover>
  );
}
