import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, postJson } from "../lib/api.js";
import { useEventStream } from "./useEventStream.js";
import { usePolling } from "./usePolling.js";

export type NotificationSeverity = "info" | "warn" | "critical";
export type NotificationStatus = "pending" | "delivering" | "delivered" | "failed" | string;

export interface NotificationItem {
  id: number;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  source: string;
  status: NotificationStatus;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  deliveredAt?: string | null;
  mergedCount?: number;
  lastError?: string | null;
}

export interface NotificationsPayload {
  reachable: boolean;
  counts?: Record<string, number>;
  unreadCount?: number;
  degradedChannels?: string[];
  items?: NotificationItem[];
}

interface NotificationsContextValue {
  payload: NotificationsPayload | null;
  /** 重要通知（warn + critical），未按用户偏好收窄。 */
  items: NotificationItem[];
  /** 服务端口径的全部未读数：只用来判断「全部标记已读」是否可点。 */
  unreadCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  markRead: (id: number) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  /** 未配置的可选外发通道（telegram/bark/serverchan/smtp），UI 用折叠区展示而非告警。 */
  optionalChannels: string[];
  /** 真正的 degraded 通道（未识别的 / critical 级），仍作为告警显示。 */
  criticalDegraded: string[];
}

const OPTIONAL_CHANNELS = new Set(["telegram", "bark", "serverchan", "smtp"]);

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function important(item: NotificationItem): boolean {
  return item.severity === "warn" || item.severity === "critical";
}

/**
 * 按用户偏好收窄可见通知。
 *
 * 【唯一出口】徽标数与列表内容必须由**同一次过滤**得出，否则会出现
 * 「铃铛显示 3 条未读、点开列表是空的」（服务端全量未读 vs 列表只留 warn+critical）——
 * 评审 P1-8。消费方请调用它并复用同一份结果，不要各自再 filter 一遍。
 */
export function visibleForPreference(
  item: NotificationItem,
  minSeverity: "warn" | "critical",
): boolean {
  return minSeverity === "critical" ? item.severity === "critical" : true;
}

/** 未读计数：只数同一份可见列表，保证与界面显示一致。 */
export function countUnread(items: NotificationItem[]): number {
  return items.filter((item) => item.readAt === null).length;
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = useState<NotificationsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    // 首次拉取才进入 loading 态；后台轮询不翻转状态、内容不变不更新，
    // 避免订阅方（顶栏铃铛、首页状态带等）每 10 秒无意义重渲染。
    const isFirstLoad = !loadedRef.current;
    if (isFirstLoad) setLoading(true);
    const next = await fetchJson<NotificationsPayload>("/api/alerts", 8_000);
    if (next !== null) {
      setPayload((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
      loadedRef.current = true;
      setLoading(false);
    } else if (isFirstLoad) {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePolling(() => void refresh(), 10_000);
  useEventStream({
    prefixes: ["alert-", "upgrade-", "runbook-", "security-", "service-"],
    onSignal: () => void refresh(),
    throttleMs: 1_000,
  });

  const markRead = useCallback(async (id: number) => {
    const result = await postJson(`/api/alerts/${encodeURIComponent(String(id))}/read`, {}, 8_000);
    if (!result.ok) return false;
    await refresh();
    return true;
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    const result = await postJson("/api/alerts/read-all", {}, 8_000);
    if (!result.ok) return false;
    await refresh();
    return true;
  }, [refresh]);

  const value = useMemo<NotificationsContextValue>(() => {
    const items = (payload?.items ?? []).filter(important);
    const unreadCount =
      typeof payload?.unreadCount === "number"
        ? payload.unreadCount
        : items.filter((item) => item.readAt === null).length;
    const degraded = payload?.degradedChannels ?? [];
    const optionalChannels = degraded.filter((ch) => OPTIONAL_CHANNELS.has(ch.split(":")[0]));
    const criticalDegraded = degraded.filter((ch) => !OPTIONAL_CHANNELS.has(ch.split(":")[0]));
    return { payload, items, unreadCount, loading, refresh, markRead, markAllRead, optionalChannels, criticalDegraded };
  }, [loading, markAllRead, markRead, payload, refresh]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}
