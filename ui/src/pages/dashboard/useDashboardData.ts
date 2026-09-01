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
  DiscoveredLlmPayload,
  InspectionHistoryPayload,
  LlmStatusView,
  MessageStatusPayload,
  OpenClawStatusView,
  RunbooksPayload,
} from "./types.js";

export function useDashboardData() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [connections, setConnections] = useState<ConnectionsPayload | null>(null);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusView | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [deliveryHistory, setDeliveryHistory] = useState<DeliveryHistoryPayload | null>(null);
  const [inspectionHistory, setInspectionHistory] = useState<InspectionHistoryPayload | null>(null);
  const [runbooks, setRunbooks] = useState<RunbooksPayload | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatusView | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredLlmPayload["configs"] | null>(null);
  const [readinessRefreshing, setReadinessRefreshing] = useState(false);
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
      fetchJson<RunbooksPayload>("/api/runbooks").then((nextRunbooks) => {
        if (nextRunbooks !== null) setRunbooks(nextRunbooks);
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
    }
    if (messageStatus !== null) {
      setDashboard((current) =>
        current === null ? current : { ...current, messageStatus },
      );
    }
  }, []);

  // 模型发现可能读取 WSL 文件，只在首屏、手动复查和低频轮询时执行，避免抢占连接操作。
  const refreshReadiness = useCallback(async () => {
    setReadinessRefreshing(true);
    try {
      const [status, discovered] = await Promise.all([
        fetchJson<LlmStatusView>("/api/llm/status", 10_000),
        fetchJson<DiscoveredLlmPayload>("/api/llm/discovered", 10_000),
      ]);
      if (status !== null) setLlmStatus(status);
      if (discovered !== null) setDiscoveredModels(discovered.configs);
    } finally {
      setReadinessRefreshing(false);
    }
  }, []);

  // 首屏：聚合端点一次取齐。
  useEffect(() => {
    void refresh(true);
    void refreshConnections();
    void refreshReadiness();
  }, [refresh, refreshConnections, refreshReadiness]);

  // 状态条需要跟随告警/通道变化，额外每 10 秒刷新一次。
  usePolling(() => void refresh(), 10_000);

  // 连接状态包含启停动作和端口探测，使用更短的轮询窗口让按钮反馈不滞后。
  usePolling(() => void refreshConnections(), 5_000);

  usePolling(() => void refreshReadiness(), 30_000);

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
    alerts,
    initialLoad,
    refresh,
    refreshConnections,
    criticalLoadFailed,
    deliveryHistory,
    inspectionHistory,
    runbooks,
    llmStatus,
    discoveredModels,
    readinessRefreshing,
    refreshReadiness,
  };
}
