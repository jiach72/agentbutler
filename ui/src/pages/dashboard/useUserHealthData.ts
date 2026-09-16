import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { deriveHealthView, type HealthSources } from "./userHealth.js";
import {
  deriveTaskPreview, toPreviewTaskList, toPreviewTaskStatus,
  type PreviewTaskList, type PreviewTaskStatus,
} from "./taskPreview.js";

const emptySources: HealthSources = {
  dashboard: null, connections: null, messageStatus: null, alerts: null, approvals: null, observedAt: "",
};

export function useUserHealthData() {
  const [sources, setSources] = useState<HealthSources>(emptySources);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [taskStatus, setTaskStatus] = useState<PreviewTaskStatus | null>(null);
  const [taskList, setTaskList] = useState<PreviewTaskList | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    setRefreshing(true);
    try {
      const [dashboard, connections, messageStatus, alerts, approvals, status, list] = await Promise.all([
        fetchJson<HealthSources["dashboard"]>("/api/dashboard", 8_000),
        fetchJson<HealthSources["connections"]>("/api/connections", 8_000),
        fetchJson<HealthSources["messageStatus"]>("/api/messages/status", 8_000),
        fetchJson<HealthSources["alerts"]>("/api/alerts", 8_000),
        fetchJson<HealthSources["approvals"]>("/api/approvals?status=pending&limit=200", 8_000),
        fetchJson<unknown>("/api/scheduled-tasks/status", 8_000),
        fetchJson<unknown>("/api/scheduled-tasks", 8_000),
      ]);
      if (!mounted.current) return;
      // Replace failed reads with unknown, not an indefinitely green cached result.
      setSources({ dashboard, connections, messageStatus, alerts, approvals, observedAt: new Date().toISOString() });
      setTaskStatus(toPreviewTaskStatus(status));
      setTaskList(toPreviewTaskList(list));
    } finally {
      active.current = false;
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  usePolling(() => { void refresh(); }, 15_000);
  return {
    ...deriveHealthView(sources), sources, loading, refreshing, refresh, taskStatus, taskList,
    tasks: deriveTaskPreview(taskStatus, taskList, Date.now()),
  };
}
