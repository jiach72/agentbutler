import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
  items: NotificationItem[];
  unreadCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  markRead: (id: number) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function important(item: NotificationItem): boolean {
  return item.severity === "warn" || item.severity === "critical";
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = useState<NotificationsPayload | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next = await fetchJson<NotificationsPayload>("/api/alerts", 8_000);
    if (next !== null) setPayload(next);
    setLoading(false);
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
    return { payload, items, unreadCount, loading, refresh, markRead, markAllRead };
  }, [loading, markAllRead, markRead, payload, refresh]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}
