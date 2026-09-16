/**
 * 大屏（/wall）数据获取：全部走既有 /api 端点，分层轮询（15s 快照 /
 * 30s 状态 / 60s 聚合），复用 lib/api 的 fetchJson（失败吞并为 null，
 * 页面按「无数据」降级，绝不伪造数值）。
 *
 * Token 用量三件套（K7/堆叠面积/环形占比）依赖 Watch llm-probe 的
 * model/prompt_tokens/completion_tokens 采集，尚未落地：接口层预留
 * fetchLlmUsage，404/不可达时页面渲染「待接入」灰态。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

/* ────────────────────────────── 类型（字段对齐服务端） ───────────────────────────── */

export interface WallInstance {
  instanceId: string;
  state: string;
}

export interface WallConnection {
  instanceId: string;
  frameworkId: string;
  displayName: string;
  state: string;
  connected: boolean;
  runtime: string;
  version: string | null;
  lastCheckedAt: string | null;
}

export interface WallChannelMetric {
  channel: string;
  delivered: number;
  failed: number;
  uncertain: number;
  total: number;
  successRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  latencySamples: number;
  retries: number;
}

export interface WallDailyMetric {
  date: string;
  channel: string;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface WallMessageMetrics {
  days: number;
  channels: Array<WallChannelMetric>;
  daily: Array<WallDailyMetric>;
  latency: { p50Ms: number | null; p95Ms: number | null; samples: number; unknown: number };
  retries: number;
}

export interface WallMessageStatus {
  reachable: boolean;
  status?: {
    bridge: { connected: boolean; running: boolean; attached: boolean; outboxWritable: boolean };
    counts?: Record<string, number>;
    relay?: { enabled: boolean; pending: boolean; updatedAt: string | null };
  } | null;
}

export interface WallDashboard {
  instances?: Array<WallInstance>;
  fingerprints?: Array<Record<string, unknown>>;
}

export interface WallAlerts {
  reachable: boolean;
  counts?: Record<string, number>;
  items?: Array<{ severity?: string; status?: string; title?: string }>;
}

export interface WallHostSample {
  capturedAt: string;
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
}

export interface WallHostMetrics {
  machine: WallHostSample;
  agents: Array<{ instanceId: string; cpuPercent: number | null; rssBytes: number | null }>;
  samples: Array<WallHostSample>;
}

export interface WallHealth {
  ok: boolean;
  services: {
    gateway: { reachable: boolean; serviceVersion: string | null; latencyMs: number | null };
    watch: { reachable: boolean; serviceVersion: string | null; latencyMs: number | null };
  };
}

export interface WallSkillUsage {
  rangeDays: number;
  series: Array<{ date: string; calls: number }>;
  skills: Array<{
    name: string;
    calls: number;
    lastUsedAt: string | null;
    successRate: number | null;
    status: "known" | "unknown";
  }>;
  notice: string;
}

export interface WallProposals {
  proposals?: Array<Record<string, unknown>>;
}

/** Token 用量（Watch 只读聚合 Hermes session_model_usage；不可用时页面保持灰态）。 */
export interface WallLlmUsage {
  rangeDays: number;
  days: Array<{ date: string; tokens: number }>;
  models: Array<{ model: string; tokens: number; /** 与 days 对齐的每日 token。 */ daily?: number[] }>;
}

/** 成本汇总（/api/llm/cost/summary，金额字段单位美元，展示层统一折算 ¥）。 */
export interface WallCostSummary {
  rangeDays: number;
  costAvailable: boolean;
  total: { estimatedUsd: number | null; actualUsd: number | null; verifiedUsd: number | null };
  days: Array<{ date: string; tokens: number; estimatedCostUsd: number | null; actualCostUsd: number | null }>;
  models: Array<{ model: string; tokens: number; estimatedCostUsd: number | null; actualCostUsd: number | null }>;
}

/** 月度预算（/api/budget）。 */
export interface WallBudget {
  enabled: boolean;
  budgetUsd: number;
  month: string;
  spentUsd: number | null;
  ratio: number | null;
  threshold: "ok" | "80%" | "100%" | "over";
}

/** 版本载荷（/api/versions，只取大屏要用的快照与最近升级任务）。 */
export interface WallVersions {
  upgradeJob?: {
    jobId: string;
    targetVersion: string;
    status: string;
    rolledBack?: boolean;
    startedAt: string;
    finishedAt?: string;
  } | null;
  snapshots?: Array<{ id: number; instance: string; label: string | null; createdAt: string; status: string }>;
  watchReachable?: boolean;
}

/** 备份载荷（/api/backups，字段对齐 settings/helpers.ts）。 */
export interface WallBackupItem {
  id: number;
  kind: "full" | "memory" | "event";
  label: string | null;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export interface WallBackups {
  watchReachable: boolean;
  items: Array<WallBackupItem>;
  status: null | { enabled: boolean; lastFullAt: string | null };
}

/* ────────────────────────────── 待处理态判定 ───────────────────────────── */

/** Outbox 视为「待处理」的状态集合（captured→ready 尚未投递完成）。 */
const PENDING_OUTBOX_STATES = new Set(["captured", "policy_pending", "held_dnd", "held_pacing", "ready"]);

/* ────────────────────────────── Hook ───────────────────────────── */

export interface WallData {
  dashboard: WallDashboard | null;
  connections: Array<WallConnection> | null;
  metrics: WallMessageMetrics | null;
  messageStatus: WallMessageStatus | null;
  alerts: WallAlerts | null;
  hostMetrics: WallHostMetrics | null;
  health: WallHealth | null;
  skillUsage: WallSkillUsage | null;
  proposals: WallProposals | null;
  llmUsage: WallLlmUsage | null | "unavailable";
  costSummary: WallCostSummary | null;
  budget: WallBudget | null;
  versions: WallVersions | null;
  backups: WallBackups | null;
  lastRefreshAt: Date | null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function usePolledState<T>(): [T | null, (next: T | null) => void] {
  const [value, setValue] = useState<T | null>(null);
  const update = useCallback((next: T | null) => {
    if (next === null) return;
    setValue((current) => (sameJson(current, next) ? current : next));
  }, []);
  return [value, update];
}

export function useWallData(): WallData & { refreshAll: () => void } {
  const [dashboard, setDashboard] = usePolledState<WallDashboard>();
  const [messageStatus, setMessageStatus] = usePolledState<WallMessageStatus>();
  const [alerts, setAlerts] = usePolledState<WallAlerts>();
  const [hostMetrics, setHostMetrics] = usePolledState<WallHostMetrics>();
  const [connections, setConnections] = usePolledState<Array<WallConnection>>();
  const [health, setHealth] = usePolledState<WallHealth>();
  const [metrics, setMetrics] = usePolledState<WallMessageMetrics>();
  const [skillUsage, setSkillUsage] = usePolledState<WallSkillUsage>();
  const [proposals, setProposals] = usePolledState<WallProposals>();
  const [costSummary, setCostSummary] = usePolledState<WallCostSummary>();
  const [budget, setBudget] = usePolledState<WallBudget>();
  const [versions, setVersions] = usePolledState<WallVersions>();
  const [backups, setBackups] = usePolledState<WallBackups>();
  const [llmUsage, setLlmUsage] = useState<WallLlmUsage | null | "unavailable">(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const llmUnavailableRef = useRef(false);

  const refreshFast = useCallback(() => {
    void Promise.all([
      fetchJson<WallDashboard>("/api/dashboard", 8_000).then(setDashboard),
      fetchJson<WallMessageStatus>("/api/messages/status", 8_000).then(setMessageStatus),
      fetchJson<WallAlerts>("/api/alerts", 8_000).then(setAlerts),
      fetchJson<WallHostMetrics>("/api/host/metrics", 8_000).then(setHostMetrics),
    ]).then(() => setLastRefreshAt(new Date()));
  }, [setAlerts, setDashboard, setHostMetrics, setMessageStatus]);

  const refreshMedium = useCallback(() => {
    void Promise.all([
      fetchJson<{ reachable: boolean; connections?: Array<WallConnection> }>("/api/connections", 12_000)
        .then((payload) => setConnections(payload?.connections ?? null)),
      fetchJson<WallHealth>("/api/health", 8_000).then(setHealth),
    ]);
  }, [setConnections, setHealth]);

  const refreshSlow = useCallback(() => {
    void Promise.all([
      fetchJson<WallMessageMetrics>("/api/messages/metrics?days=7", 12_000).then(setMetrics),
      fetchJson<WallSkillUsage>("/api/skills/usage?range=30&granularity=day", 12_000).then(setSkillUsage),
      fetchJson<WallProposals>("/api/evolution/proposals", 12_000).then(setProposals),
      fetchJson<WallCostSummary>("/api/llm/cost/summary?days=30", 12_000).then(setCostSummary),
      fetchJson<WallBudget>("/api/budget", 12_000).then(setBudget),
      fetchJson<WallVersions>("/api/versions", 12_000).then(setVersions),
      fetchJson<WallBackups>("/api/backups", 12_000).then(setBackups),
    ]);
    // Token 用量：llm-probe 未落地前端点不存在，确认 404 后不再反复请求。
    if (!llmUnavailableRef.current) {
      void fetchJson<WallLlmUsage>("/api/llm/usage?days=7", 8_000).then((result) => {
        if (result === null) {
          llmUnavailableRef.current = true;
          setLlmUsage("unavailable");
        } else {
          setLlmUsage(result);
        }
      });
    }
  }, [setBackups, setBudget, setCostSummary, setMetrics, setProposals, setSkillUsage, setVersions]);

  useEffect(() => {
    refreshFast();
    refreshMedium();
    refreshSlow();
  }, [refreshFast, refreshMedium, refreshSlow]);

  usePolling(refreshFast, 15_000);
  usePolling(refreshMedium, 30_000);
  usePolling(refreshSlow, 60_000);

  return {
    dashboard,
    connections,
    metrics,
    messageStatus,
    alerts,
    hostMetrics,
    health,
    skillUsage,
    proposals,
    llmUsage,
    costSummary,
    budget,
    versions,
    backups,
    lastRefreshAt,
    refreshAll: refreshFast,
  };
}

/** 派生视图：KPI 数值、趋势序列、TOP5 等，全部由真实载荷计算。 */
export function deriveWallView(data: WallData) {
  const { dashboard, metrics, messageStatus, alerts, hostMetrics, skillUsage } = data;

  const instances = dashboard?.instances ?? [];
  const onlineInstances = instances.filter((item) => item.state === "running" || item.state === "healthy").length;

  const channelAgg = (metrics?.channels ?? []).reduce(
    (acc, item) => {
      acc.delivered += item.delivered;
      acc.failed += item.failed;
      acc.uncertain += item.uncertain;
      return acc;
    },
    { delivered: 0, failed: 0, uncertain: 0 },
  );
  const metricTotal = channelAgg.delivered + channelAgg.failed + channelAgg.uncertain;
  const successRate = metricTotal > 0 ? (channelAgg.delivered / metricTotal) * 100 : null;

  // 近 7 日按日聚合的送达/失败趋势（metrics.daily 为「日期 × 通道」粒度）。
  const dailyMap = new Map<string, { delivered: number; failed: number }>();
  for (const row of metrics?.daily ?? []) {
    const bucket = dailyMap.get(row.date) ?? { delivered: 0, failed: 0 };
    bucket.delivered += row.delivered;
    bucket.failed += row.failed;
    dailyMap.set(row.date, bucket);
  }
  const trend = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({ date: date.slice(5), delivered: bucket.delivered, failed: bucket.failed }));

  const counts = messageStatus?.status?.counts ?? {};
  const pendingMessages = Array.from(Object.entries(counts)).reduce(
    (sum, [state, value]) => sum + (PENDING_OUTBOX_STATES.has(state) ? Number(value) : 0),
    0,
  );

  const alertItems = alerts?.items ?? [];
  const openAlerts = alertItems.filter((item) => item.status !== "resolved").length;

  const machine = hostMetrics?.machine;
  const cpuPercent = machine?.cpuPercent ?? null;
  const memPercent =
    machine?.memTotalBytes && machine.memFreeBytes !== null
      ? ((machine.memTotalBytes - machine.memFreeBytes) / machine.memTotalBytes) * 100
      : null;
  const diskPercent =
    machine?.diskTotalBytes && machine.diskUsedBytes !== null && machine.diskTotalBytes > 0
      ? (machine.diskUsedBytes / machine.diskTotalBytes) * 100
      : null;
  const cpuSeries = (hostMetrics?.samples ?? [])
    .slice(-24)
    .map((s) => s.cpuPercent)
    .filter((v): v is number => v !== null);

  const rssTop = (hostMetrics?.agents ?? [])
    .filter((a) => a.rssBytes !== null)
    .sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0))
    .slice(0, 3)
    .map((a) => ({ id: a.instanceId, mb: Math.round((a.rssBytes ?? 0) / (1024 * 1024)) }));

  const knownSkills = (skillUsage?.skills ?? []).filter((s) => s.status === "known");
  const topSkills = knownSkills
    .filter((s) => s.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5)
    .map((s) => ({ name: s.name, calls: s.calls }));
  const series = skillUsage?.series ?? [];
  const calls24h = series.length > 0 ? series[series.length - 1]?.calls ?? 0 : 0;
  const calls7d = series.slice(-7).reduce((sum, p) => sum + p.calls, 0);
  const active7d = knownSkills.filter((s) => {
    if (s.lastUsedAt === null) return false;
    return Date.now() - new Date(s.lastUsedAt).getTime() <= 7 * 86_400_000;
  }).length;

  const channels = (metrics?.channels ?? [])
    .filter((ch) => ch.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);

  // 4K 新增模块的派生值：成本趋势/分解、预算执行、升级与备份记录。
  // 金额换算放展示层（money/USD_TO_CNY），这里只整理形状。
  const cost = data.costSummary ?? null;
  const costAvailable = cost?.costAvailable === true;
  const costTotalUsd = cost === null
    ? null
    : cost.total.actualUsd ?? cost.total.estimatedUsd;
  const costDays = (cost?.days ?? []).map((d) => ({
    date: d.date.slice(5),
    costUsd: d.actualCostUsd ?? d.estimatedCostUsd,
    tokensWan: Math.round(d.tokens / 10_000),
  }));
  const costModels = [...(cost?.models ?? [])]
    .sort((a, b) => (b.actualCostUsd ?? b.estimatedCostUsd ?? 0) - (a.actualCostUsd ?? a.estimatedCostUsd ?? 0))
    .slice(0, 5);
  const costModelsTokenSum = costModels.reduce((sum, m) => sum + m.tokens, 0);
  const budgetEnabled = data.budget?.enabled === true;
  const budgetRatioPct = budgetEnabled && data.budget?.ratio !== null && data.budget?.ratio !== undefined
    ? Math.round(data.budget.ratio * 100)
    : null;
  const bridge = data.messageStatus?.status?.bridge ?? null;
  const relayPending = data.messageStatus?.status?.relay?.pending ?? null;
  const recentBackups = [...(data.backups?.items ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  const recentSnapshots = [...(data.versions?.snapshots ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);
  const upgradeJob = data.versions?.upgradeJob ?? null;

  return {
    onlineInstances,
    totalInstances: instances.length,
    successRate,
    p95Ms: metrics?.latency.p95Ms ?? null,
    pendingMessages,
    openAlerts,
    trend,
    cpuPercent,
    memPercent,
    diskPercent,
    cpuSeries,
    rssTop,
    topSkills,
    skillTotal: knownSkills.length,
    active7d,
    calls24h,
    calls7d,
    channels,
    fingerprints: dashboard?.fingerprints?.length ?? null,
    relayEnabled: messageStatus?.status?.relay?.enabled ?? null,
    alertEvents: alertItems.slice(0, 5),
    costAvailable,
    costTotalUsd,
    costDays,
    costModels,
    costModelsTokenSum,
    budgetEnabled,
    budgetRatioPct,
    bridge,
    relayPending,
    recentBackups,
    recentSnapshots,
    upgradeJob,
  };
}
