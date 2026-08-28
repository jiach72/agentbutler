/**
 * 首页数据获取与刷新治理：聚合端点首屏取齐、双轮询（主刷新 10s / 连接探测 5s）、
 * 共享 /ws 事件流节流信号，以及「关键数据全部读不到」的失败可见性判定。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "../../lib/api.js";
import { useEventStream } from "../../hooks/useEventStream.js";
import { usePolling } from "../../hooks/usePolling.js";
import { REFRESH_EVENT_PREFIXES, REFRESH_THROTTLE_MS } from "./helpers.js";
import type {
  AlertsPayload,
  ConnectionsPayload,
  DashboardPayload,
  DeliveryHistoryPayload,
  InspectionHistoryPayload,
  MessageStatusPayload,
  OpenClawInstallJobView,
  OpenClawStatusView,
} from "./types.js";

export function useDashboardData() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [connections, setConnections] = useState<ConnectionsPayload | null>(null);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusView | null>(null);
  const [openClawInstallJob, setOpenClawInstallJob] = useState<OpenClawInstallJobView | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [deliveryHistory, setDeliveryHistory] = useState<DeliveryHistoryPayload | null>(null);
  const [inspectionHistory, setInspectionHistory] = useState<InspectionHistoryPayload | null>(null);
  const [initialLoad, setInitialLoad] = useState({
    dashboard: false,
    alerts: false,
    finished: false,
  });

  const refresh = useCallback(async (trackInitial = false) => {
    const mark = (key: "dashboard" | "alerts") => {
      if (trackInitial) setInitialLoad((current) => ({ ...current, [key]: true }));
    };
    await Promise.all([
      fetchJson<DashboardPayload>("/api/dashboard").then((dash) => {
        if (dash !== null) setDashboard(dash);
        mark("dashboard");
      }),
      fetchJson<AlertsPayload>("/api/alerts").then((nextAlerts) => {
        if (nextAlerts !== null) setAlerts(nextAlerts);
        mark("alerts");
      }),
      fetchJson<DeliveryHistoryPayload>("/api/messages/delivery-history?days=7").then((history) => {
        if (history !== null) setDeliveryHistory(history);
      }),
      fetchJson<InspectionHistoryPayload>("/api/inspections/history?days=14").then((history) => {
        if (history !== null) setInspectionHistory(history);
      }),
    ]);
    if (trackInitial) setInitialLoad((current) => ({ ...current, finished: true }));
  }, []);

  const refreshConnections = useCallback(async () => {
    const [next, openclaw, messageStatus] = await Promise.all([
      fetchJson<ConnectionsPayload>("/api/connections", 8_000),
      fetchJson<OpenClawStatusView>("/api/openclaw/status", 8_000),
      fetchJson<MessageStatusPayload>("/api/messages/status", 8_000),
    ]);
    if (next !== null) setConnections(next);
    if (openclaw !== null) {
      setOpenClawStatus(openclaw);
      if (openclaw.job !== undefined) setOpenClawInstallJob(openclaw.job ?? null);
    }
    if (messageStatus !== null) {
      setDashboard((current) =>
        current === null ? current : { ...current, messageStatus },
      );
    }
  }, []);

  // 首屏：聚合端点一次取齐。
  useEffect(() => {
    void refresh(true);
    void refreshConnections();
  }, [refresh, refreshConnections]);

  // 状态条需要跟随告警/通道变化，额外每 10 秒刷新一次。
  usePolling(() => void refresh(), 10_000);

  // 连接状态包含启停动作和端口探测，使用更短的轮询窗口让按钮反馈不滞后。
  usePolling(() => void refreshConnections(), 5_000);

  // 实时性：复用共享 /ws 事件流（与通知中心一致），相关事件触发节流 5s 的刷新。
  const handleEventSignal = useCallback(() => {
    void refresh();
    void refreshConnections();
  }, [refresh, refreshConnections]);
  useEventStream({
    prefixes: REFRESH_EVENT_PREFIXES,
    onSignal: handleEventSignal,
    throttleMs: REFRESH_THROTTLE_MS,
  });

  // 首屏失败可见性：关键数据全部为 null/不可达时给出整体降级与重试入口。
  const criticalLoadFailed = useMemo(
    () =>
      initialLoad.finished &&
      dashboard === null &&
      (alerts === null || alerts.reachable !== true),
    [alerts, dashboard, initialLoad.finished],
  );

  return {
    dashboard,
    connections,
    openClawStatus,
    openClawInstallJob,
    setOpenClawInstallJob,
    alerts,
    initialLoad,
    refresh,
    refreshConnections,
    criticalLoadFailed,
    deliveryHistory,
    inspectionHistory,
  };
}
