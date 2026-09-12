/**
 * 顶部通知中心（规范 03 §3.8）。
 *
 * 【本轮的三个修正（评审 P1-8）】
 * 1. 计数口径统一：徽标数原来取服务端全量未读，列表却先 `filter(important)` 再按偏好收窄，
 *    结果可以是「铃铛显示 3 条未读、点开列表是空的」。现在两者都用同一次过滤结果计算。
 * 2. 条目信息补齐：数据里有 severity / body / createdAt / mergedCount / status，
 *    原先只渲染了 title —— 用户看不出「这是提醒还是紧急」，也看不出「这已经是第 3 次了」。
 * 3. 条目可处置：点击不再只标记已读，而是标记已读 + 跳到对应页面（映射见 notificationTarget）。
 *    在服务端给通知项补 target 字段之前，先按 kind/source 做前端映射，映射不到就回落到事件中心。
 *
 * 容量：规范要求保留最近 50 条（原为 12 条）。
 */
import { BellOutlined, CheckOutlined, ReloadOutlined } from "@ant-design/icons";
import { Badge, Button, Popover, Spin } from "antd";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePreferences } from "../lib/preferences.js";
import {
  countUnread,
  useNotifications,
  visibleForPreference,
  type NotificationItem,
} from "../hooks/useNotifications.js";
import { Empty } from "./Empty.js";
import { StatusBadge } from "./StatusBadge.js";
import type { SemanticTone } from "./StatusBadge.js";

/** 规范 §3.8：通知中心保留最近 50 条。 */
const MAX_ITEMS = 50;

const SEVERITY_META: Record<NotificationItem["severity"], { tone: SemanticTone; label: string }> = {
  critical: { tone: "error", label: "紧急" },
  warn: { tone: "warn", label: "提醒" },
  info: { tone: "brand", label: "提示" },
};

/** 相对时间：通知是「刚刚发生的事」，绝对时间戳反而要多想一步。 */
function relativeTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 通知 → 目标页面映射。服务端在通知项上补 `target` 字段后，这里应退化为
 * 「优先用 target，缺失时才映射」，本函数保持为唯一的回落出口。
 */
export function notificationTarget(item: NotificationItem): { to: string; label: string } {
  const key = `${item.kind} ${item.source}`.toLowerCase();
  if (/(gateway|message|bridge|delivery|dnd)/.test(key)) return { to: "/gateway", label: "查看消息" };
  if (/(budget|cost|spend)/.test(key)) return { to: "/cost", label: "查看成本" };
  if (/(upgrade|canary|version)/.test(key)) return { to: "/canary", label: "查看升级策略" };
  if (/memory/.test(key)) return { to: "/memory-diff", label: "查看记忆变更" };
  if (/approval/.test(key)) return { to: "/approvals", label: "查看待审批" };
  if (/(runbook|inspect|service|probe|watch)/.test(key)) return { to: "/troubleshoot", label: "去排查" };
  return { to: "/events", label: "查看事件中心" };
}

/**
 * 徽标与列表共用同一份「可见通知」计算。
 * 只要两边都走这个 hook，就不可能出现「徽标 3 条未读、列表为空」的口径失配（评审 P1-8）。
 */
function useVisibleNotifications() {
  const notifications = useNotifications();
  const [preferences] = usePreferences();
  const narrowed = preferences.notificationMinSeverity === "critical";
  const visibleItems = notifications.items.filter((item) =>
    visibleForPreference(item, preferences.notificationMinSeverity),
  );
  return {
    ...notifications,
    visibleItems,
    visibleUnreadCount: countUnread(visibleItems),
    narrowed,
  };
}

/**
 * 通知预览列表：每条三行 —— 严重度 + 时间 / 标题 / 正文摘要（+ 合并次数、失败原因）。
 * 未读用小圆点 + `aria-label="未读"` 表达，不依赖颜色单独传达（规范 §6）。
 */
export function NotificationPreviewList({
  items,
  onRead,
}: {
  items: NotificationItem[];
  onRead: (item: NotificationItem) => void;
}) {
  return (
    <ul className="notification-list">
      {items.map((item) => {
        const severity = SEVERITY_META[item.severity];
        const merged = item.mergedCount ?? 0;
        const failed = item.status === "failed";
        return (
          <li key={item.id} className={`notification-item${item.readAt === null ? " is-unread" : ""}`}>
            <button type="button" className="notification-item-main" onClick={() => onRead(item)}>
              <span className="notification-item-meta">
                <StatusBadge tone={severity.tone} label={severity.label} />
                <span className="notification-item-time">{relativeTime(item.createdAt)}</span>
              </span>
              <strong>{item.title}</strong>
              {item.body !== "" && <span className="notification-item-body">{item.body}</span>}
              {merged > 1 || failed ? (
                <span className="notification-item-note">
                  {merged > 1 && `同类已合并 ${merged} 次`}
                  {merged > 1 && failed && " · "}
                  {failed && `最近一次发送失败${item.lastError != null ? `：${item.lastError}` : ""}`}
                </span>
              ) : null}
            </button>
            {item.readAt === null && <span className="notification-unread-dot" aria-label="未读" />}
          </li>
        );
      })}
    </ul>
  );
}

function NotificationContent({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const {
    items,
    visibleItems,
    unreadCount,
    visibleUnreadCount,
    loading,
    markAllRead,
    markRead,
    refresh,
    optionalChannels,
    narrowed,
  } = useVisibleNotifications();
  const shown = visibleItems.slice(0, MAX_ITEMS);

  /** 点击即处置：先标记已读（不 await——一次写入失败不该把导航卡住），再进目标页面。 */
  const openItem = (item: NotificationItem) => {
    void markRead(item.id);
    const target = notificationTarget(item);
    onClose();
    navigate(target.to);
  };

  return (
    <section className="notification-panel" aria-label="重要通知">
      <header className="notification-panel-head">
        <div>
          <strong>重要通知</strong>
          <span>
            {visibleUnreadCount > 0
              ? `${visibleUnreadCount} 条未读`
              : items.length === 0
                ? "目前没有需要留意的通知"
                : "都看过了"}
          </span>
        </div>
        <div className="notification-panel-actions">
          <Button
            type="text"
            icon={<ReloadOutlined />}
            aria-label="刷新通知"
            title="刷新通知"
            onClick={() => void refresh()}
          />
          <Button
            type="text"
            icon={<CheckOutlined />}
            aria-label="全部标记已读"
            title="全部标记已读"
            disabled={unreadCount === 0}
            onClick={() => void markAllRead()}
          />
        </div>
      </header>
      {loading && shown.length === 0 ? (
        <div className="notification-panel-loading"><Spin size="small" /></div>
      ) : shown.length === 0 ? (
        <div className="notification-panel-empty">
          <Empty
            title={narrowed ? "当前只显示紧急通知" : "没有需要留意的通知"}
            hint={
              narrowed
                ? "偏好里把通知收窄到了「仅紧急」；改回「提醒及以上」就能看到其余内容。"
                : "管家只会在状态真的发生变化时通知你，没问题时这里本来就是空的。"
            }
            mascotWidth={80}
            action={
              narrowed ? (
                <Link to="/settings?tab=preferences" onClick={onClose}>
                  调整通知偏好
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <NotificationPreviewList items={shown} onRead={openItem} />
      )}
      {items.length > shown.length && (
        <p className="notification-panel-more">仅显示最近 {shown.length} 条，更早的在通知队列里。</p>
      )}
      {optionalChannels.length > 0 && (
        <details className="notification-panel-optional">
          <summary>可选通知通道（{optionalChannels.length} 个未配置）</summary>
          <ul className="notification-list">
            {optionalChannels.map((ch) => (
              <li key={ch} className="notification-item">
                <span>{ch.replace(":missing-credentials", "（未配置凭据）")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <footer className="notification-panel-foot">
        <Link to="/gateway" onClick={onClose}>查看完整通知队列</Link>
        {narrowed && <StatusBadge tone="error" label="仅显示紧急" />}
      </footer>
    </section>
  );
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { visibleUnreadCount } = useVisibleNotifications();
  const [preferences] = usePreferences();
  // 徽标数与列表用同一份过滤结果，不会再出现「显示 3 条未读、列表为空」（评审 P1-8）。
  const count = preferences.notificationBadgeEnabled ? visibleUnreadCount : 0;
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
      <Badge className="notification-badge" count={count} overflowCount={999} size="small" offset={[-2, 2]}>
        <Button type="text" className="notification-trigger" icon={<BellOutlined />} aria-label={label} title={label} />
      </Badge>
    </Popover>
  );
}

/** 兼容旧名字：外部只消费「预览列表」这一层。 */
export const NotificationTitleList = NotificationPreviewList;
