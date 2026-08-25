/**
 * 管家首页：面向小白的「先结论、再操作、高级详情折叠」入口。
 *
 * - 首屏经 /api/dashboard 聚合端点一次取齐（实例 / 每实例最新检查 / 同类错误 / 检查状态）；
 * - 之后复用 /ws 事件流机制：收到检查、修复方案、错误聚合相关事件时节流 5s 重新拉取；
 * - 「立即检查」和「修复一下」都是触发即走（202 提示已启动，结果经事件流观察，不阻塞）；
 * - 管家控制通道离线（reachable:false）时如实展示降级，不伪造健康结论。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { DisconnectOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Card, Space } from "antd";
import { PageProgress } from "../components/PageProgress.js";
import { fetchJson, postJson } from "../lib/api.js";
import { disposeWebSocket } from "../lib/websocket.js";

/* --------------------------------- 数据类型 -------------------------------- */

interface InstanceView {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  version: string | null;
  confidence: number;
}

interface InspectionCheckView {
  id: string;
  status: string;
  detail: unknown;
  durationMs: number | null;
}

interface InspectionView {
  instanceId: string;
  ts: string;
  overall: string | null;
  confidence: number | null;
  checks: InspectionCheckView[];
}

interface FingerprintView {
  signature: string;
  count: number;
  status: string;
  firstSeen: string;
  lastSeen: string;
  lastSample: string | null;
  instance?: string;
}

interface RunbookView {
  id: string;
  label: string;
  description?: string;
  impact?: string;
  steps?: string[];
  breakerTripped?: boolean;
  lastRun?: { at: string; success: boolean } | null;
}

interface RunbooksPayload {
  reachable: boolean;
  runbooks?: RunbookView[];
}

interface RecoveryActionView {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  impact: string;
  estimatedSeconds: number;
  requiresConfirmation: boolean;
  available: boolean;
  unavailableReason?: string;
}

interface RecoveryDiagnosisView {
  incidentId: string;
  severity: "ok" | "warn" | "error";
  rootCause: string;
  probes: Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }>;
  recommendedActions: RecoveryActionView[];
  checkedAt: string;
}

interface InspectStatusView {
  reachable: boolean;
  lastAt?: string | null;
  nextAt?: string | null;
  intervalMin?: number | null;
  inFlight?: boolean;
  criticalProbe?: {
    intervalMin: number;
    slaMin: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    nextAt: string | null;
    deadlineAt: string | null;
    lastDurationMs: number | null;
    lastStatus: string | null;
    lastWithinSla: boolean | null;
    overdue: boolean;
    inFlight: boolean;
    runCount: number;
    missedTicks: number;
  };
}

interface DashboardPayload {
  instances?: InstanceView[];
  latestInspections?: InspectionView[];
  fingerprints?: FingerprintView[];
  inspectStatus?: InspectStatusView;
}

interface ConnectionCheckView {
  id: string;
  label: string;
  status: string;
  detail: string;
  durationMs: number | null;
}

interface ConnectionView {
  instanceId: string;
  frameworkId: string;
  displayName: string;
  state: string;
  connectionState: "connected" | "disconnected" | "checking" | "error" | "unknown" | string;
  connected: boolean;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  effectiveLevel: number | null;
  capabilities: Record<string, string>;
  checks: ConnectionCheckView[];
  anomalies: string[];
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  lastAction: string | null;
  latencyMs: number | null;
  lastError: string | null;
}

interface ConnectionsPayload {
  reachable: boolean;
  checkedAt?: string;
  connections?: ConnectionView[];
}

interface AlertsPayload {
  reachable: boolean;
  counts?: Record<string, number>;
  items?: Array<{ severity?: string; status?: string; title?: string }>;
}

interface LogSourceView {
  id: string;
  path: string;
  format: string;
  modifiedAt: string | null;
  sizeBytes: number;
}

interface LogTailView {
  sourceId: string;
  path: string;
  format: string;
  lines: string[];
  truncated: boolean;
  limit: number;
  totalLines: number;
  pageStart: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  error?: string;
}

interface LogIssueView {
  id: string;
  kind: string;
  severity: "error" | "warn";
  title: string;
  detail: string;
  count: number;
  sources: string[];
  examples: string[];
  suggestedAction: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
}

interface LogAnalyzeView {
  reachable?: boolean;
  issues?: LogIssueView[];
  scannedSources?: number;
  scannedLines?: number;
  analyzedAt?: string | null;
}

/** 首页待办：用大白话说明“哪里需要注意”，并尽量给出下一步。 */
interface IssueView {
  id: string;
  tone: "ok" | "warn" | "error" | "idle";
  title: string;
  detail: string;
  runbook?: RunbookView;
}

interface StatusCardView {
  id: string;
  tone: "ok" | "warn" | "error" | "idle";
  label: string;
  value: string;
  detail: string;
  action?: { label: string; kind: "link" | "detail"; to?: string };
}

/** 事件流节流刷新间隔（收到相关事件后最多每 5s 拉一次聚合端点）。 */
const REFRESH_THROTTLE_MS = 5000;

/** 触发首页刷新的事件类型前缀（与 Task 10 数据面相关的事件族）。 */
const REFRESH_EVENT_PREFIXES = ["inspection-", "runbook-", "fingerprint-"];

/** 常见检查项的通俗名称；未知检查项仍展示原始 id，不编造。 */
const CHECK_LABELS: Record<string, string> = {
  process: "进程是否在运行",
  liveness: "服务是否能响应",
  dashboard: "官方管理页是否能连接",
  memory: "记忆读写是否正常",
  channel: "消息通道是否正常",
  model: "AI 模型能否连接",
  "process-alive": "AI 进程是否在运行",
  "api-connectivity": "服务是否能连接",
  "memory-probe": "记忆读写是否正常",
  "channel-probe": "消息通道是否正常",
  "llm-probe": "AI 模型能否连接",
  "stall-write": "数据是否还在正常写入",
};

function isRefreshRelevant(type: string): boolean {
  return REFRESH_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function instanceLabel(instanceId: string): string {
  if (instanceId === "hermes-main") return "Hermes 主实例";
  if (instanceId === "") return "主实例";
  return instanceId;
}

function instanceRuntimeLabel(runtime: string): string {
  if (runtime === "process") return "本机运行";
  if (runtime === "docker") return "Docker 容器";
  return runtime || "—";
}

function frameworkLabel(frameworkId: string): string {
  if (frameworkId === "hermes") return "Hermes";
  if (frameworkId === "openclaw") return "OpenClaw";
  return frameworkId || "未知框架";
}

function connectionStateLabel(state: string): string {
  if (state === "connected") return "已连接";
  if (state === "disconnected") return "已断开";
  if (state === "checking") return "检查中";
  if (state === "error") return "操作失败";
  return "待确认";
}

/* --------------------------------- 展示辅助 -------------------------------- */

/** 实例状态色点：运行绿 / 崩溃红 / 停止灰 / 其他黄。 */
function stateDotClass(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("crash")) return "down";
  if (["serving", "running", "active"].includes(s)) return "up";
  if (["stopped", "stopped.", "removed", "idle"].includes(s)) return "idle";
  return "warn";
}

/** 实例状态的大白话。 */
function instanceStateLabel(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("crash")) return "异常（可能已崩溃）";
  if (["serving", "running", "active"].includes(s)) return "运行正常";
  if (["stopped", "stopped.", "removed", "idle"].includes(s)) return "已停止";
  return state || "未知";
}

/** 整体检查结果：正常绿 / 提醒黄 / 异常红 / 等待灰。 */
function overallBadge(overall: string | null): { cls: string; label: string } {
  switch (overall) {
    case "healthy":
      return { cls: "badge-healthy", label: "正常" };
    case "degraded":
      return { cls: "badge-degraded", label: "需要留意" };
    case "down":
      return { cls: "badge-down", label: "异常" };
    default:
      return { cls: "badge-muted", label: "等待检查" };
  }
}

/** 检查项状态徽标：通过绿 / 提醒黄 / 异常红 / 跳过灰。 */
function checkBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "pass":
      return { cls: "badge-healthy", label: "正常" };
    case "warn":
      return { cls: "badge-degraded", label: "需要留意" };
    case "fail":
      return { cls: "badge-down", label: "异常" };
    case "skipped":
      return { cls: "badge-muted", label: "已跳过" };
    default:
      return { cls: "badge-muted", label: status };
  }
}

/** 同类错误状态标签：活跃黄、已知灰、其他灰。 */
function fingerprintBadge(status: string): { cls: string; label: string } {
  if (status === "open") return { cls: "badge-degraded", label: "待处理" };
  if (status === "known") return { cls: "badge-muted", label: "已知问题" };
  return { cls: "badge-muted", label: status };
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，异常回退原始字符串。 */
function formatRelative(ts: string | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "—";
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return ts;
  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return `${Math.floor(diffMs / 86_400_000)} 天前`;
}

function formatDuration(ms: number | null): string {
  return ms === null ? "—" : `${ms}ms`;
}

/** 关键记忆探针状态：区分探针本身异常与 SLA 逾期。 */
function criticalProbeBadge(probe: InspectStatusView["criticalProbe"]): { cls: string; label: string } {
  if (probe === undefined) return { cls: "badge-muted", label: "未接入" };
  if (probe.overdue) return { cls: "badge-down", label: "已逾期" };
  if (probe.lastStatus === "fail") return { cls: "badge-down", label: "异常" };
  if (probe.lastStatus === "warn") return { cls: "badge-degraded", label: "需要留意" };
  if (probe.lastStatus === "skipped") return { cls: "badge-muted", label: "无可检查对象" };
  if (probe.lastStatus === "pass") return { cls: "badge-healthy", label: "正常" };
  return { cls: "badge-muted", label: "等待检查" };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/** detail 摘要：字符串截断，对象 JSON 化后截断。 */
function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined || detail === "") return "—";
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 同类错误模板 sample 前 80 字符。 */
function formatSample(sample: string | null): string {
  if (sample === null || sample === "") return "—";
  return sample.length > 80 ? `${sample.slice(0, 80)}…` : sample;
}

/* --------------------------------- 页面主体 -------------------------------- */

export function DashboardPage() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [connections, setConnections] = useState<ConnectionsPayload | null>(null);
  const [runbooks, setRunbooks] = useState<RunbooksPayload | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmRunbook, setConfirmRunbook] = useState<RunbookView | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logSources, setLogSources] = useState<LogSourceView[]>([]);
  const [activeLog, setActiveLog] = useState<LogTailView | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logIssues, setLogIssues] = useState<LogIssueView[]>([]);
  const [logAnalyzeLoading, setLogAnalyzeLoading] = useState(false);
  const [confirmFix, setConfirmFix] = useState<LogIssueView | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryDiagnosisView | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [confirmRecovery, setConfirmRecovery] = useState<RecoveryActionView | null>(null);
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState({
    dashboard: false,
    runbooks: false,
    alerts: false,
    finished: false,
  });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const advancedRef = useRef<HTMLDetailsElement>(null);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const openLogPanel = useCallback(async () => {
    setLogOpen(true);
    setLogLoading(true);
    setLogError(null);
    void loadLogAnalyze();
    const payload = await fetchJson<{ reachable: boolean; sources?: LogSourceView[] }>(
      "/api/logs",
      8_000,
    );
    if (payload === null || payload.reachable !== true) {
      setLogSources([]);
      setLogError("管家服务暂时连不上，稍后再试。");
    } else {
      setLogSources(payload.sources ?? []);
      if ((payload.sources ?? []).length === 0) {
        setLogError("暂未发现日志文件。");
      }
    }
    setLogLoading(false);
  }, []);

  const loadLogAnalyze = useCallback(async () => {
    setLogAnalyzeLoading(true);
    const payload = await fetchJson<LogAnalyzeView>("/api/logs/analyze", 8_000);
    setLogIssues(payload?.issues ?? []);
    setLogAnalyzeLoading(false);
  }, []);

  const runLogFix = useCallback(async () => {
    if (confirmFix === null || confirmFix.suggestedAction === null) return;
    setFixBusy(true);
    const result = await postJson("/api/logs/fix", {
      action: confirmFix.suggestedAction,
      confirmed: true,
    });
    setFixBusy(false);
    setConfirmFix(null);
    if (result.ok) {
      showToast("ok", `修复已开始：${confirmFix.actionLabel ?? "重启服务"}。稍后自动复检。`);
      window.setTimeout(() => void loadLogAnalyze(), 2_000);
      window.setTimeout(() => void loadLogAnalyze(), 10_000);
    } else if (result.status === 409) {
      showToast("err", "修复暂时被保护机制拦住（熔断），稍后再试。");
    } else {
      showToast("err", "修复没有启动成功，请确认 Hermes 实例是否在线。");
    }
  }, [confirmFix, loadLogAnalyze, showToast]);

  const diagnoseRecovery = useCallback(async (autoRepair = false) => {
    setRecoveryBusy(true);
    const diagnosis = await postJson("/api/recovery/diagnose", {}, 15_000);
    if (!diagnosis.ok || diagnosis.data === null || typeof diagnosis.data !== "object") {
      setRecoveryBusy(false);
      showToast("err", "诊断没有完成，请确认管家服务和 Watch 控制通道是否在线");
      return;
    }
    const next = diagnosis.data as RecoveryDiagnosisView;
    setRecovery(next);
    if (autoRepair) {
      const lowRisk = next.recommendedActions.find((action) => action.available && action.risk === "low");
      if (lowRisk !== undefined) {
        const result = await postJson(`/api/recovery/actions/${encodeURIComponent(lowRisk.id)}/execute`, {}, 70_000);
        if (result.ok) showToast("ok", `已自动执行「${lowRisk.label}」，正在复验结果`);
        else showToast("err", `诊断完成，但「${lowRisk.label}」执行失败`);
      } else {
        showToast("ok", `诊断完成：${next.rootCause}。请从下方选择合适处理方式`);
      }
    }
    setRecoveryBusy(false);
  }, [showToast]);

  const executeRecoveryAction = useCallback(async (action: RecoveryActionView) => {
    setRecoveryBusy(true);
    const result = await postJson(`/api/recovery/actions/${encodeURIComponent(action.id)}/execute`, { confirmed: true }, 70_000);
    setRecoveryBusy(false);
    setConfirmRecovery(null);
    if (result.ok) {
      showToast("ok", `已开始「${action.label}」，完成后会自动复验`);
      window.setTimeout(() => void diagnoseRecovery(false), 10_000);
    } else if (result.status === 409) {
      showToast("err", `「${action.label}」暂时不能执行：${typeof result.data === "object" && result.data !== null && "detail" in result.data ? String(result.data.detail) : "保护机制或当前状态不允许"}`);
    } else {
      showToast("err", `「${action.label}」执行失败，请查看诊断详情`);
    }
  }, [diagnoseRecovery, showToast]);

  const loadLogTail = useCallback(async (sourceId: string, before?: number | null) => {
    setLogLoading(true);
    setLogError(null);
    setActiveLog((current) => (current !== null && current.sourceId !== sourceId ? null : current));
    const query = new URLSearchParams({ limit: "300" });
    if (before !== undefined && before !== null) query.set("before", String(before));
    const payload = await fetchJson<LogTailView>(
      `/api/logs/${encodeURIComponent(sourceId)}?${query.toString()}`,
      8_000,
    );
    if (payload === null) {
      setLogError("读取日志失败；管家服务可能暂时不可用。");
    } else {
      setActiveLog(payload);
    }
    setLogLoading(false);
  }, []);

  const closeLogPanel = useCallback(() => {
    setLogOpen(false);
    setActiveLog(null);
    setLogError(null);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    },
    [],
  );

  const refresh = useCallback(async (trackInitial = false) => {
    const mark = (key: "dashboard" | "runbooks" | "alerts") => {
      if (trackInitial) setInitialLoad((current) => ({ ...current, [key]: true }));
    };
    await Promise.all([
      fetchJson<DashboardPayload>("/api/dashboard").then((dash) => {
        if (dash !== null) setDashboard(dash);
        mark("dashboard");
      }),
      fetchJson<RunbooksPayload>("/api/runbooks").then((books) => {
        if (books !== null) setRunbooks(books);
        mark("runbooks");
      }),
      fetchJson<AlertsPayload>("/api/alerts").then((nextAlerts) => {
        if (nextAlerts !== null) setAlerts(nextAlerts);
        mark("alerts");
      }),
    ]);
    if (trackInitial) setInitialLoad((current) => ({ ...current, finished: true }));
  }, []);

  const refreshConnections = useCallback(async () => {
    const next = await fetchJson<ConnectionsPayload>("/api/connections", 8_000);
    if (next !== null) setConnections(next);
  }, []);

  // 首屏：聚合端点一次取齐。
  useEffect(() => {
    void refresh(true);
    void refreshConnections();
  }, [refresh, refreshConnections]);

  // 状态条需要跟随告警/通道变化，额外每 10 秒刷新一次。
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 连接状态包含启停动作和端口探测，使用更短的轮询窗口让按钮反馈不滞后。
  useEffect(() => {
    const timer = setInterval(() => void refreshConnections(), 2_000);
    return () => clearInterval(timer);
  }, [refreshConnections]);

  // 实时性：复用 /ws 事件流机制（同 EventTicker），相关事件触发节流 5s 的聚合刷新。
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = Date.now();
    let closed = false;

    const maybeRefresh = () => {
      const elapsed = Date.now() - lastRefresh;
      if (elapsed >= REFRESH_THROTTLE_MS) {
        lastRefresh = Date.now();
        void refresh();
        return;
      }
      if (pendingTimer === undefined) {
        pendingTimer = setTimeout(() => {
          pendingTimer = undefined;
          lastRefresh = Date.now();
          void refresh();
        }, REFRESH_THROTTLE_MS - elapsed);
      }
    };

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data as string) as {
            type?: string;
            items?: Array<{ type: string }>;
          };
          if (data.type !== "events" || !Array.isArray(data.items)) return;
          if (data.items.some((event) => isRefreshRelevant(event.type))) {
            maybeRefresh();
            void refreshConnections();
          }
        } catch {
          // 忽略无法解析的帧
        }
      };
      socket.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 5000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      disposeWebSocket(socket);
    };
  }, [refresh, refreshConnections]);

  const instances = dashboard?.instances ?? [];
  const connectionItems = connections?.connections ?? [];
  const latestInspections = dashboard?.latestInspections ?? [];
  const fingerprints = dashboard?.fingerprints ?? [];
  const inspectStatus = dashboard?.inspectStatus ?? null;
  const inspectionByInstance = useMemo(
    () => new Map(latestInspections.map((item) => [item.instanceId, item])),
    [latestInspections],
  );

  const firstAvailableRunbook = useMemo(
    () => (runbooks?.runbooks ?? []).find((item) => item.breakerTripped !== true) ?? null,
    [runbooks],
  );

  const issues = useMemo<IssueView[]>(() => {
    const list: IssueView[] = [];

    if (dashboard === null) {
      list.push({
        id: "reading",
        tone: "idle",
        title: "正在读取管家状态",
        detail: "首次加载中；如果一直没更新，可以点击下方「立即检查」再试一次。",
        runbook: firstAvailableRunbook ?? undefined,
      });
      return list;
    }

    if (inspectStatus === null) {
      list.push({
        id: "unknown-inspect",
        tone: "idle",
        title: "还没有读取到管家状态",
        detail: "暂时无法判断本机 AI 是否正常，建议先点击「立即检查」。",
        runbook: firstAvailableRunbook ?? undefined,
      });
    } else if (!inspectStatus.reachable) {
      list.push({
        id: "watch-offline",
        tone: "warn",
        title: "管家服务暂时连不上",
        detail: "已看到部分旧数据，但暂时无法开始新的检查。请稍等管家恢复后再试。",
        runbook: firstAvailableRunbook ?? undefined,
      });
    }

    for (const inspection of latestInspections) {
      const failed = inspection.checks.filter((check) => check.status === "fail").length;
      const warned = inspection.checks.filter((check) => check.status === "warn").length;
      if (inspection.overall === "down") {
        list.push({
          id: `down-${inspection.instanceId}`,
          tone: "error",
          title: `AI 助手（${instanceLabel(inspection.instanceId)}）出问题了`,
          detail: `${failed} 项检查不通过${warned > 0 ? `，另有 ${warned} 项提醒` : ""}；可能是进程未运行或服务暂时连不上。`,
          runbook: firstAvailableRunbook ?? undefined,
        });
      } else if (inspection.overall === "degraded") {
        list.push({
          id: `degraded-${inspection.instanceId}`,
          tone: "warn",
          title: `AI 助手（${instanceLabel(inspection.instanceId)}）需要留意`,
          detail: `${warned} 项检查提醒${failed > 0 ? `，${failed} 项不通过` : ""}；不影响使用时可以先观察。`,
          runbook: firstAvailableRunbook ?? undefined,
        });
      }
    }

    for (const fp of fingerprints) {
      list.push({
        id: `fingerprint-${fp.signature}`,
        tone: "error",
        title: `最近出现 ${fp.count} 次相同问题`,
        detail: `最近一次在 ${formatRelative(fp.lastSeen)}；可以在「高级详情」里查看错误内容。`,
        runbook: firstAvailableRunbook ?? undefined,
      });
    }

    if (list.length === 0 && latestInspections.length > 0 && instances.length > 0) {
      list.push({
        id: "all-ok",
        tone: "ok",
        title: "一切正常",
        detail: `管家刚检查过 ${latestInspections.length} 个 AI 助手，没有发现需要处理的事。`,
        runbook: firstAvailableRunbook ?? undefined,
      });
    } else if (list.length === 0 && instances.length === 0 && inspectStatus?.reachable === true) {
      list.push({
        id: "no-instance",
        tone: "idle",
        title: "暂未发现可管理的 AI 助手",
        detail: "可能还没接入 AI 助手，或者管家还没有完成一次检查。",
        runbook: firstAvailableRunbook ?? undefined,
      });
    } else if (list.length === 0) {
      list.push({
        id: "no-result",
        tone: "idle",
        title: "还没有检查结果",
        detail: "管家还没完成第一次检查，点击「立即检查」开始。",
        runbook: firstAvailableRunbook ?? undefined,
      });
    }
    return list;
  }, [
    dashboard,
    firstAvailableRunbook,
    fingerprints,
    inspectStatus,
    instances.length,
    latestInspections,
  ]);

  const attentionCount = issues.filter(
    (item) => item.tone === "error" || item.tone === "warn",
  ).length;
  const hasError = issues.some((item) => item.tone === "error");
  const hasWarn = issues.some((item) => item.tone === "warn");
  const healthyInspectionCount = latestInspections.filter(
    (item) => item.overall === "healthy",
  ).length;
  const availableRunbooks = (runbooks?.runbooks ?? []).filter(
    (item) => item.breakerTripped !== true,
  );
  const alertCounts = alerts?.counts ?? {};
  const alertItems = alerts?.items ?? [];
  const failedAlertCount = alertCounts["failed"] ?? 0;
  const undeliveredCriticalCount = alertItems.filter(
    (item) => item.severity === "critical" && item.status !== "delivered",
  ).length;
  const deliveredCriticalCount = alertItems.filter(
    (item) => item.severity === "critical" && item.status === "delivered",
  ).length;
  const downInstanceCount = latestInspections.filter(
    (item) => item.overall === "down",
  ).length;
  const degradedInstanceCount = latestInspections.filter(
    (item) => item.overall === "degraded",
  ).length;

  const hero = useMemo(() => {
    if (dashboard === null) {
      return {
        tone: "idle",
        title: "正在确认管家状态",
        copy: "正在读取本机 AI 的运行情况，请稍等。",
      };
    }
    if (hasError)
      return {
        tone: "error",
        title: `有 ${attentionCount} 件事需要你处理`,
        copy: "管家发现问题了，下面按重要程度排好，照着点就行。",
      };
    if (hasWarn)
      return {
        tone: "warn",
        title: `有 ${attentionCount} 件事需要留意`,
        copy: "这些不影响正常使用，有空的时候看一眼就行。",
      };
    const okIssue = issues.find((item) => item.tone === "ok");
    if (okIssue !== undefined) return { tone: "ok", title: "一切正常", copy: okIssue.detail };
    if (instances.length === 0)
      return {
        tone: "idle",
        title: "暂未发现 AI 助手",
        copy: "管家还没有发现可管理的实例，可能是尚未接入。",
      };
    return {
      tone: "idle",
      title: "还没有检查结果",
      copy: "点击「立即检查」，管家会开始确认本机 AI 是否正常。",
    };
  }, [attentionCount, dashboard, hasError, hasWarn, instances.length, issues]);

  const executeRunbook = async (runbook: RunbookView) => {
    const result = await postJson(`/api/runbooks/${encodeURIComponent(runbook.id)}/execute`);
    if (result.status === 202) {
      showToast("ok", `已开始处理「${runbook.label}」，完成后页面会自动刷新`);
    } else if (result.status === 409) {
      showToast("err", `「${runbook.label}」已在执行或当前条件不满足，请稍后再试`);
    } else if (result.status === 404) {
      showToast("err", `「${runbook.label}」不存在或已被移除`);
    } else if (result.status === 502) {
      showToast("err", "管家暂时连接不上，无法开始处理");
    } else if (result.status === 503) {
      showToast("err", `「${runbook.label}」暂时不能处理（管家忙碌或已暂停）`);
    } else {
      showToast("err", `「${runbook.label}」执行失败，请稍后重试`);
    }
  };

  const runInspect = async () => {
    setInspectionRequested(true);
    const result = await postJson("/api/inspect/run");
    if (result.status === 202) {
      showToast("ok", "已开始检查，完成后页面会自动更新");
      await refresh();
    } else if (result.status === 409) {
      showToast("err", "检查正在进行中，请稍后再试");
    } else if (result.status === 502) {
      showToast("err", "管家检查通道连接不上，无法开始检查");
    } else {
      showToast("err", "开始检查失败，请稍后重试");
    }
    window.setTimeout(() => setInspectionRequested(false), 1_500);
  };

  const runConnectionCheck = async (instanceId?: string) => {
    const key = instanceId ?? "all";
    setConnectionBusy(`check-${key}`);
    const targets = instanceId
      ? [instanceId]
      : (connections?.connections ?? []).map((item) => item.instanceId);
    if (targets.length === 0) {
      setConnectionBusy(null);
      showToast("err", "还没有发现可检查的 Hermes 或 OpenClaw 实例");
      return;
    }
    const results = await Promise.all(
      targets.map((target) => postJson("/api/connections/check", { instanceId: target }, 15_000)),
    );
    await refreshConnections();
    setConnectionBusy(null);
    const passed = results.every((result) => {
      if (!result.ok || result.data === null || typeof result.data !== "object") return false;
      return (result.data as { status?: unknown }).status === "checked";
    });
    if (passed) {
      showToast("ok", "连接检查已完成，状态信息已更新");
    } else {
      showToast("err", "部分连接检查失败，请查看实例卡片中的原因");
    }
  };

  const runConnectionAction = async (instanceId: string, action: "connect" | "disconnect") => {
    setConnectionBusy(`${action}-${instanceId}`);
    const result = await postJson(
      `/api/connections/${encodeURIComponent(instanceId)}/${action}`,
      {},
      70_000,
    );
    await refreshConnections();
    setConnectionBusy(null);
    if (result.ok) {
      showToast("ok", action === "connect" ? "已发起连接并完成复核" : "已断开连接并完成复核");
    } else if (result.status === 409) {
      showToast("err", "操作未完成，请查看实例卡片中的错误原因");
    } else if (result.status === 502) {
      showToast("err", "管家控制通道暂时连不上");
    } else {
      showToast("err", action === "connect" ? "连接失败，请先检查配置和服务" : "断开失败，请稍后重试");
    }
  };

  const confirmRepair = () => {
    if (confirmRunbook === null) return;
    const runbook = confirmRunbook;
    setConfirmRunbook(null);
    void executeRunbook(runbook);
  };

  const openAdvanced = () => {
    setAdvancedOpen(true);
    requestAnimationFrame(() => {
      advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const summary = advancedRef.current?.querySelector("summary");
      if (summary instanceof HTMLElement) summary.focus({ preventScroll: true });
    });
  };

  const visibleIssues = issuesExpanded ? issues : issues.slice(0, 5);

  const statusCards = useMemo<StatusCardView[]>(() => {
    const assistantTone: StatusCardView["tone"] =
      downInstanceCount > 0
        ? "error"
        : degradedInstanceCount > 0
          ? "warn"
          : healthyInspectionCount > 0
            ? "ok"
            : "idle";
    return [
      {
        id: "watch",
        tone: inspectStatus === null ? "idle" : inspectStatus.reachable ? "ok" : "warn",
        label: "管家服务",
        value: inspectStatus === null ? "读取中" : inspectStatus.reachable ? "在线" : "离线",
        detail:
          inspectStatus === null
            ? "正在读取本机状态"
            : inspectStatus.reachable
              ? `上次检查 ${formatRelative(inspectStatus.lastAt)}`
              : "暂时连不上，稍后会自动重试",
      },
      {
        id: "gateway",
        tone:
          alerts === null
            ? "idle"
            : !alerts.reachable || undeliveredCriticalCount > 0 || failedAlertCount > 0
              ? "error"
              : deliveredCriticalCount > 0
                ? "warn"
                : "ok",
        label: "消息通知",
        value:
          alerts === null
            ? "读取中"
            : !alerts.reachable || undeliveredCriticalCount > 0 || failedAlertCount > 0
              ? "离线"
              : "正常",
        detail:
          alerts === null
            ? "正在读取通知通道"
            : !alerts.reachable
              ? "提醒会保留在面板，不会丢"
              : undeliveredCriticalCount > 0
                ? `有 ${undeliveredCriticalCount} 条紧急提醒没送到`
              : failedAlertCount > 0
                ? `${failedAlertCount} 条提醒发送失败`
                : deliveredCriticalCount > 0
                  ? `有 ${deliveredCriticalCount} 条紧急提醒已送到`
                : "通知通道正常",
        action:
          alerts === null
            ? undefined
            : !alerts.reachable || undeliveredCriticalCount > 0 || failedAlertCount > 0
              ? { label: "去处理", kind: "link", to: "/gateway" }
              : deliveredCriticalCount > 0
                ? { label: "去看看", kind: "link", to: "/gateway" }
                : undefined,
      },
      {
        id: "attention",
        tone: hasError ? "error" : hasWarn ? "warn" : "ok",
        label: "待处理",
        value: `${attentionCount} 项`,
        detail: hasError
          ? "有需要立即处理的问题"
          : hasWarn
            ? "有需要留意的事"
            : "暂无待办",
        action: attentionCount > 0 ? { label: "查看详情", kind: "detail" } : undefined,
      },
      {
        id: "assistant",
        tone: assistantTone,
        label: "AI 助手",
        value: `${healthyInspectionCount}/${instances.length} 正常`,
        detail:
          downInstanceCount > 0
            ? `${downInstanceCount} 个出问题了`
            : degradedInstanceCount > 0
              ? `${degradedInstanceCount} 个需要留意`
              : instances.length === 0
                ? "尚未发现可管理的助手"
                : "运行正常",
      },
    ];
  }, [
    alerts,
    attentionCount,
    degradedInstanceCount,
    deliveredCriticalCount,
    downInstanceCount,
    failedAlertCount,
    hasError,
    hasWarn,
    healthyInspectionCount,
    inspectStatus,
    instances.length,
    undeliveredCriticalCount,
  ]);

  if (!initialLoad.finished) {
    return (
      <section className="page product-page dashboard-page manager-home">
        <header className="page-heading product-heading manager-heading">
          <div>
            <span className="product-eyebrow">首页</span>
            <h1>你的本地 AI 管家</h1>
            <p className="hint">正在汇总服务、检查结果和消息状态。</p>
          </div>
        </header>
        <PageProgress
          title="正在读取管家状态"
          detail="每一项完成后都会立即更新，不需要重复刷新页面。"
          steps={[
            { label: "运行与检查", state: initialLoad.dashboard ? "done" : "active" },
            {
              label: "修复方案",
              state: initialLoad.runbooks ? "done" : initialLoad.dashboard ? "active" : "pending",
            },
            {
              label: "消息状态",
              state: initialLoad.alerts ? "done" : initialLoad.runbooks ? "active" : "pending",
            },
          ]}
        />
      </section>
    );
  }

  return (
    <section className="page product-page dashboard-page manager-home">
      <header className="page-heading product-heading manager-heading">
        <div>
          <span className="product-eyebrow">首页</span>
          <h1>你的本地 AI 管家</h1>
          <p className="hint">管家帮你看着电脑上的 AI，有问题先说清楚，再告诉你怎么处理。</p>
        </div>
        <span className={`page-live ${inspectStatus?.reachable ? "is-online" : "is-offline"}`}>
          <i />
          {inspectStatus?.reachable ? "管家服务已连接" : "管家服务暂时连不上"}
        </span>
      </header>

      {toast !== null && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}

      <div className={`manager-hero is-${hero.tone}`}>
        <span className="manager-hero-band" aria-hidden="true" />
        <div className="manager-hero-icon" aria-hidden="true">
          {hero.tone === "ok" ? "✓" : hero.tone === "error" || hero.tone === "warn" ? "!" : "…"}
        </div>
        <div className="manager-hero-copy">
          <span className="manager-hero-kicker">当前状态</span>
          <h2>{hero.title}</h2>
          <p>{hero.copy}</p>
        </div>
        <div className="manager-hero-actions">
          <button
            type="button"
            className="btn btn-primary manager-action"
            onClick={() => void runInspect()}
            disabled={inspectStatus?.inFlight === true}
          >
            {inspectStatus?.inFlight === true ? "正在检查…" : "立即检查"}
          </button>
          <button
            type="button"
            className="btn manager-action"
            onClick={() => void diagnoseRecovery(true)}
            disabled={recoveryBusy || (hasError === false && hasWarn === false)}
          >
            {recoveryBusy ? "正在诊断…" : "诊断并处理"}
          </button>
        </div>
        <div className="manager-hero-meta">
          <span>上次检查：{formatRelative(inspectStatus?.lastAt)}</span>
          <span>自动检查：{inspectStatus?.intervalMin ?? "—"} 分钟一次</span>
          <span>管家服务：{inspectStatus?.reachable ? "在线" : "未连接"}</span>
        </div>
      </div>

      <div className="manager-status-rail" role="status" aria-label="当前状态总览">
        {statusCards.map((card) => (
          <article className={`manager-status-card is-${card.tone}`} key={card.id}>
            <div className="manager-status-head">
              <span className={`manager-status-dot is-${card.tone}`} aria-hidden="true" />
              <span className="manager-status-label">{card.label}</span>
            </div>
            <strong className="manager-status-value">{card.value}</strong>
            <p className="manager-status-detail">{card.detail}</p>
            {card.action !== undefined &&
              (card.action.kind === "link" ? (
                <Link className="manager-status-action" to={card.action.to ?? "/gateway"}>
                  {card.action.label} →
                </Link>
              ) : (
                <button type="button" className="manager-status-action" onClick={openAdvanced}>
                  {card.action.label} →
                </button>
              ))}
          </article>
        ))}
      </div>

      <section className="connection-section" aria-labelledby="connection-section-title">
        <div className="connection-section-head">
          <div>
            <span className="product-kicker">服务连接</span>
            <h2 id="connection-section-title">Hermes / OpenClaw 连接状态</h2>
            <p>这里显示最近一次探测、响应耗时和可用能力；连接动作会在完成后自动复核。</p>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => void runConnectionCheck()}
            disabled={connectionBusy !== null || connectionItems.length === 0}
          >
            {connectionBusy === "check-all" ? "检查中…" : "手动检查连接"}
          </Button>
        </div>
        {connections === null || connections.reachable !== true ? (
          <Alert
            type="warning"
            showIcon
            message="管家控制通道暂时连不上"
            description="无法读取 Hermes / OpenClaw 的实时连接状态，服务恢复后会自动重试。"
          />
        ) : connectionItems.length === 0 ? (
          <div className="connection-empty">还没有发现 Hermes 或 OpenClaw 实例，请先配置对应运行目录。</div>
        ) : (
          <div className="connection-grid">
            {connectionItems.map((connection) => {
              const actionBusy = connectionBusy === `connect-${connection.instanceId}` || connectionBusy === `disconnect-${connection.instanceId}`;
              const checkBusy = connectionBusy === `check-${connection.instanceId}`;
              const stateClass = connection.connectionState === "connected"
                ? "ok"
                : connection.connectionState === "disconnected" || connection.connectionState === "error"
                  ? "error"
                  : connection.connectionState === "checking"
                    ? "warn"
                    : "idle";
              return (
                <Card className={`connection-card is-${stateClass}`} key={connection.instanceId} bordered>
                  <div className="connection-card-head">
                    <div>
                      <span className="connection-framework">{frameworkLabel(connection.frameworkId)}</span>
                      <h3>{connection.displayName || instanceLabel(connection.instanceId)}</h3>
                    </div>
                    <Badge
                      status={stateClass === "ok" ? "success" : stateClass === "error" ? "error" : stateClass === "warn" ? "warning" : "default"}
                      text={connectionStateLabel(connection.connectionState)}
                    />
                  </div>
                  <div className="connection-meta">
                    <span>{instanceRuntimeLabel(connection.runtime)}</span>
                    <span>{connection.version ?? "版本未知"}</span>
                    <span>{connection.latencyMs === null ? "尚未测延迟" : `响应 ${connection.latencyMs}ms`}</span>
                    <span title={connection.rootPath}>{connection.rootPath || "未配置目录"}</span>
                  </div>
                  <div className="connection-summary">
                    <strong>{connection.connected ? "服务可达" : connection.connectionState === "checking" ? "正在探测服务" : "服务不可达"}</strong>
                    <span>最近检查：{formatRelative(connection.lastCheckedAt)}</span>
                    <span>最近动作：{formatRelative(connection.lastActionAt)}</span>
                  </div>
                  {connection.lastError !== null && <p className="connection-error">{connection.lastError}</p>}
                  {connection.checks.length > 0 && (
                    <ul className="connection-checks">
                      {connection.checks.slice(0, 6).map((check) => (
                        <li key={`${connection.instanceId}-${check.id}`}>
                          <span>{check.label}</span>
                          <span className={`badge-pill ${check.status === "pass" ? "badge-healthy" : check.status === "fail" ? "badge-down" : "badge-degraded"}`}>
                            {check.status === "pass" ? "正常" : check.status === "fail" ? "异常" : "需留意"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="connection-actions">
                    <Space wrap>
                    <Button
                      type="default"
                      icon={<ReloadOutlined />}
                      onClick={() => void runConnectionCheck(connection.instanceId)}
                      disabled={connectionBusy !== null}
                    >
                      {checkBusy ? "检查中…" : "重新检查"}
                    </Button>
                    <Button
                      danger={connection.connected}
                      type={connection.connected ? "default" : "primary"}
                      icon={connection.connected ? <DisconnectOutlined /> : <LinkOutlined />}
                      onClick={() => void runConnectionAction(connection.instanceId, connection.connected ? "disconnect" : "connect")}
                      disabled={connectionBusy !== null || actionBusy || connection.connectionState === "checking"}
                    >
                      {actionBusy ? "处理中…" : connection.connected ? "断开连接" : "连接服务"}
                    </Button>
                    </Space>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <div className="manager-section">
        <div className="manager-section-head">
          <div>
            <span className="product-kicker">当前状态</span>
            <h2>{attentionCount > 0 ? `有 ${attentionCount} 件事需要处理` : "管家正在替你看着"}</h2>
          </div>
          <span className="manager-section-note">没事就不用管；专业细节收在下面</span>
        </div>
        <div className="issue-list">
          {visibleIssues.map((issue) => (
            <article className={`issue-card is-${issue.tone}`} key={issue.id}>
              <div className="issue-main">
                <strong>{issue.title}</strong>
                <p>{issue.detail}</p>
              </div>
              <div className="issue-actions">
                {issue.runbook !== undefined && issue.tone !== "ok" && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirmRunbook(issue.runbook!)}
                  >
                    一键修复
                  </button>
                )}
                <button type="button" className="btn btn-quiet" onClick={openAdvanced}>
                  查看详情
                </button>
              </div>
            </article>
          ))}
        </div>
        {issues.length > 5 && (
          <div className="issues-toggle-wrap">
            <button
              type="button"
              className="btn btn-quiet issues-toggle"
              aria-expanded={issuesExpanded}
              onClick={() => setIssuesExpanded((value) => !value)}
            >
              {issuesExpanded ? "收起" : `展开全部 ${issues.length} 条`}
            </button>
          </div>
        )}
      </div>

      <section className="manager-advanced">
        <section className="recovery-panel" aria-live="polite">
          <div className="manager-section-head">
            <div>
              <span className="manager-section-kicker">专业处理</span>
              <h2>诊断与分级修复</h2>
            </div>
            <Button size="small" loading={recoveryBusy} onClick={() => void diagnoseRecovery(false)}>
              重新诊断
            </Button>
          </div>
          {recovery === null ? (
            <Alert
              type="info"
              showIcon
              message="先诊断再处理"
              description="系统会先确认根因，再按低、中、高风险给出动作；不会默认直接重启实例。"
            />
          ) : (
            <>
              <Alert
                type={recovery.severity === "error" ? "error" : recovery.severity === "warn" ? "warning" : "success"}
                showIcon
                message={recovery.rootCause}
                description={`诊断时间：${formatRelative(recovery.checkedAt)} · 事件 ${recovery.incidentId}`}
              />
              <div className="recovery-probes">
                {recovery.probes.map((probe) => (
                  <span className={`badge-pill badge-${probe.status === "pass" ? "healthy" : probe.status === "fail" ? "down" : "degraded"}`} key={probe.id} title={probe.detail}>
                    {probe.label}：{probe.status === "pass" ? "正常" : probe.status === "fail" ? "异常" : "需留意"}
                  </span>
                ))}
              </div>
              <div className="recovery-actions">
                {recovery.recommendedActions.map((action) => (
                  <Card size="small" key={action.id} className="recovery-action-card">
                    <div className="recovery-action-head">
                      <strong>{action.label}</strong>
                      <Badge status={action.risk === "high" ? "error" : action.risk === "medium" ? "warning" : "success"} text={action.risk === "high" ? "高风险" : action.risk === "medium" ? "需确认" : "低风险"} />
                    </div>
                    <p>{action.description}</p>
                    <small>{action.impact} · 约 {action.estimatedSeconds} 秒</small>
                    <Button
                      size="small"
                      type={action.risk === "high" ? "primary" : "default"}
                      danger={action.risk === "high"}
                      disabled={!action.available || recoveryBusy}
                      onClick={() => action.requiresConfirmation ? setConfirmRecovery(action) : void executeRecoveryAction(action)}
                    >
                      {!action.available ? action.unavailableReason ?? "暂不可用" : action.requiresConfirmation ? "确认执行" : "执行"}
                    </Button>
                  </Card>
                ))}
              </div>
            </>
          )}
        </section>

        <details
          ref={advancedRef}
          className="advanced-details"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>高级详情</strong>
              <small>检查明细、AI 助手状态、处理方案、管家检查和经常出现的问题</small>
            </span>
            <span className="advanced-toggle">{advancedOpen ? "收起" : "展开"}</span>
          </summary>
          <div className="advanced-details-body">
            <h3 className="manager-subhead">AI 助手状态</h3>
            {instances.length === 0 ? (
              <div className="empty-state">
                还没有发现可管理的 AI 助手：管家检查完成后，这里会显示它的状态。
              </div>
            ) : (
              <div className="cards-grid">
                {instances.map((instance) => {
                  const inspection = inspectionByInstance.get(instance.instanceId) ?? null;
                  const overall = overallBadge(inspection?.overall ?? null);
                  const confidence = inspection?.confidence ?? instance.confidence;
                  return (
                    <div className="card instance-card" key={instance.instanceId}>
                      <div className="instance-title">
                        <span className={`state-dot ${stateDotClass(instance.state)}`} />
                        <span className="instance-name">{instanceLabel(instance.instanceId)}</span>
                        <span className={`badge-pill ${overall.cls}`}>{overall.label}</span>
                      </div>
                      <div className="instance-meta">
                        <span>{instanceStateLabel(instance.state)}</span>
                        <span>{instanceRuntimeLabel(instance.runtime)}</span>
                        <span>{instance.version ?? "版本未知"}</span>
                        <span>把握 {Math.round((confidence ?? 0) * 100)}%</span>
                      </div>
                      <div className="card-head">
                        上次检查：{formatRelative(inspection?.ts)}
                        {inspection?.confidence !== null && inspection?.confidence !== undefined
                          ? ` · 把握 ${Math.round(inspection.confidence * 100)}%`
                          : ""}
                      </div>
                      {inspection === null ? (
                        <div className="check-empty">尚无检查明细</div>
                      ) : (
                        <ul className="check-list">
                          {inspection.checks.map((check) => {
                            const badge = checkBadge(check.status);
                            return (
                              <li className="check-row" key={check.id}>
                                <span className="check-name" title={check.id}>
                                  {CHECK_LABELS[check.id] ?? "其他检查"}
                                </span>
                                <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                                <span className="check-detail" title={formatDetail(check.detail)}>
                                  {formatDetail(check.detail)}
                                </span>
                                <span className="check-duration">
                                  {formatDuration(check.durationMs)}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <h3 className="manager-subhead">可以一键处理</h3>
            {runbooks !== null && !runbooks.reachable && (
              <div className="banner banner-warn">⚠ 管家暂时连不上：处理方案列表暂不可用</div>
            )}
            {runbooks !== null && runbooks.reachable && availableRunbooks.length === 0 && (
              <div className="empty-state">管家在线，但还没有可以一键处理的问题。</div>
            )}
            {runbooks !== null && runbooks.reachable && (
              <div className="cards-stack">
                {availableRunbooks.map((runbook) => (
                  <div className="card runbook-item" key={runbook.id}>
                    <div className="runbook-main">
                      <div className="runbook-title">
                        <span className="instance-name">{runbook.label}</span>
                        {runbook.breakerTripped === true && (
                          <span className="badge-pill badge-down">已暂停</span>
                        )}
                      </div>
                      {runbook.description !== undefined && runbook.description !== "" && (
                        <div className="runbook-desc">{runbook.description}</div>
                      )}
                      <div className="runbook-lastrun">
                        上次执行：
                        {runbook.lastRun
                          ? `${formatRelative(runbook.lastRun.at)}（${runbook.lastRun.success ? "成功" : "失败"}）`
                          : "从未执行"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setConfirmRunbook(runbook)}
                    >
                      开始处理
                    </button>
                  </div>
                ))}
              </div>
            )}

            <h3 className="manager-subhead">管家最近检查</h3>
            <div className="card inspect-card">
              {inspectStatus === null || !inspectStatus.reachable ? (
                <div className="empty-state">
                  管家服务暂时连不上：看不到最近检查，也无法开始新的检查。
                </div>
            ) : (
              <>
                {(() => {
                  const criticalProbe = inspectStatus.criticalProbe;
                  const criticalBadge = criticalProbeBadge(criticalProbe);
                  return criticalProbe === undefined ? null : (
                    <>
                      <div className="inspect-sla" role="status">
                        <span className={`badge-pill ${criticalBadge.cls}`}>{criticalBadge.label}</span>
                        <span>关键记忆探针：每 {criticalProbe.intervalMin} 分钟，SLA {criticalProbe.slaMin} 分钟</span>
                        {criticalProbe.lastDurationMs !== null ? (
                          <span>最近耗时 {formatDuration(criticalProbe.lastDurationMs)}</span>
                        ) : null}
                      </div>
                    </>
                  );
                })()}
                <dl className="kv">
                    <dt>上次检查</dt>
                    <dd>{formatRelative(inspectStatus.lastAt)}</dd>
                    <dt>下次预计</dt>
                    <dd>{formatRelative(inspectStatus.nextAt)}</dd>
                    <dt>多久检查一次</dt>
                    <dd>{inspectStatus.intervalMin ?? "—"} 分钟</dd>
                    <dt>现在</dt>
                    <dd>{inspectStatus.inFlight ? "正在检查" : "没有在检查"}</dd>
                  </dl>
                  <div className="inspect-actions">
                    <button type="button" className="btn" onClick={() => void runInspect()}>
                      立即检查
                    </button>
                  </div>
                </>
              )}
            </div>

            <h3 className="manager-subhead">经常出现的问题</h3>
            {fingerprints.length === 0 ? (
              <div className="empty-state">
                暂时没有经常出现的问题；如果以后出现，会显示在这里。
              </div>
            ) : (
              <div className="card table-card">
                <table className="table">
                  <thead>
                    <tr>
                      <th>问题内容</th>
                      <th>影响组件</th>
                      <th>首次出现</th>
                      <th>次数</th>
                      <th>状态</th>
                      <th>最近出现</th>
                      <th>日志</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fingerprints.map((fp) => {
                      const badge = fingerprintBadge(fp.status);
                      return (
                        <tr key={fp.signature}>
                          <td className="fp-sample" title={fp.lastSample ?? undefined}>
                            {formatSample(fp.lastSample)}
                          </td>
                          <td>{fp.instance ? instanceLabel(fp.instance) : "未知"}</td>
                          <td>{formatRelative(fp.firstSeen)}</td>
                          <td>{fp.count}</td>
                          <td>
                            <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                          </td>
                          <td>{formatRelative(fp.lastSeen)}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => void openLogPanel()}
                            >
                              查看日志
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="manager-logs-entry">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void openLogPanel()}
              >
                打开系统日志
              </button>
              <span>Hermes 运行日志、网关日志与探针日志（只读查看，不会修改任何文件）</span>
            </div>
          </div>
        </details>
      </section>

      {confirmRunbook !== null && (
        <div
          className="danger-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="repair-modal-title"
        >
          <div className="danger-modal-card">
            <div className="danger-modal-icon">!</div>
            <h3 id="repair-modal-title">确认处理这个问题</h3>
            <p>
              管家将处理「<strong>{confirmRunbook.label}</strong>」。
              {confirmRunbook.description !== undefined && confirmRunbook.description !== ""
                ? ` ${confirmRunbook.description}`
                : null}
            </p>
            {confirmRunbook.impact !== undefined && confirmRunbook.impact !== "" && (
              <p className="danger-impact">{confirmRunbook.impact}</p>
            )}
            {confirmRunbook.steps !== undefined && confirmRunbook.steps.length > 0 && (
              <div className="repair-steps">
                <span>管家会按顺序执行：</span>
                <ol>
                  {confirmRunbook.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
            <p className="danger-impact">
              请确认你理解这次操作会影响什么。管家只会执行你确认的处理。
            </p>
            <div className="danger-modal-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirmRunbook(null)}
              >
                先不修复
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmRepair}>
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {(inspectionRequested || inspectStatus?.inFlight === true) && (
        <PageProgress
          compact
          indeterminate
          title="正在检查本机 AI"
          detail="管家正在检查进程、接口、记忆、消息通道和模型连接，完成后本页会自动更新。"
        />
      )}

      {confirmFix !== null && (
        <div
          className="danger-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="log-fix-modal-title"
        >
          <div className="danger-modal-card">
            <div className="danger-modal-icon">!</div>
            <h3 id="log-fix-modal-title">确认一键修复</h3>
            <p>
              管家将执行修复方案「<strong>{confirmFix.actionLabel ?? "重启服务"}</strong>」，
              期间 Hermes 可能短暂不可用，修复完成后会自动复检。
            </p>
            <p className="danger-impact">
              该操作会重启或重连相关服务。确认前不会执行任何修改。
            </p>
            <div className="danger-modal-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setConfirmFix(null)}>
                先不修复
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={fixBusy}
                onClick={() => void runLogFix()}
              >
                {fixBusy ? "正在执行…" : "确认修复"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRecovery !== null && (
        <div className="danger-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-modal-title">
          <div className="danger-modal-card">
            <div className="danger-modal-icon">!</div>
            <h3 id="recovery-modal-title">确认执行「{confirmRecovery.label}」</h3>
            <p>{confirmRecovery.description}</p>
            <p className="danger-impact">影响：{confirmRecovery.impact}。预计耗时约 {confirmRecovery.estimatedSeconds} 秒。</p>
            <div className="danger-modal-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setConfirmRecovery(null)}>取消</button>
              <button type="button" className="btn btn-danger" disabled={recoveryBusy} onClick={() => void executeRecoveryAction(confirmRecovery)}>
                {recoveryBusy ? "正在执行…" : "确认执行"}
              </button>
            </div>
          </div>
        </div>
      )}

      {logOpen && (
        <div
          className="log-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="log-drawer-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeLogPanel();
          }}
        >
          <div className="log-drawer">
            <div className="log-drawer-head">
              <div>
                <span className="log-drawer-eyebrow">只读查看</span>
                <h3 id="log-drawer-title">系统日志</h3>
              </div>
              <button type="button" className="btn btn-quiet" onClick={closeLogPanel}>
                关闭
              </button>
            </div>
            <div className="log-drawer-body">
              <section className="log-diagnosis">
                <div className="log-diagnosis-head">
                  <strong>智能体检</strong>
                  {logAnalyzeLoading ? (
                    <span className="log-diagnosis-state">正在扫描日志…</span>
                  ) : logIssues.length === 0 ? (
                    <span className="log-diagnosis-state is-ok">未发现明显错误</span>
                  ) : (
                    <span className="log-diagnosis-state is-warn">
                      发现 {logIssues.length} 类问题
                    </span>
                  )}
                </div>
                {logIssues.length === 0 && !logAnalyzeLoading ? (
                  <p className="log-diagnosis-empty">
                    最近一段日志没有匹配到常见错误；你仍然可以在下面直接查看原始日志。
                  </p>
                ) : (
                  <div className="log-issue-list">
                    {logIssues.map((issue) => (
                      <article className={`log-issue is-${issue.severity}`} key={issue.id}>
                        <div className="log-issue-main">
                          <strong>{issue.title}</strong>
                          <span className="log-issue-count">×{issue.count}</span>
                          <p>{issue.detail}</p>
                          {issue.examples.length > 0 && (
                            <code className="log-issue-example">{issue.examples[0]}</code>
                          )}
                        </div>
                        {issue.suggestedAction !== null && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => setConfirmFix(issue)}
                          >
                            一键修复
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <aside className="log-source-list">
                <strong>日志文件</strong>
                {logSources.map((source) => (
                  <button
                    type="button"
                    key={source.id}
                    className={`log-source-item${activeLog?.sourceId === source.id ? " is-active" : ""}`}
                    onClick={() => void loadLogTail(source.id)}
                  >
                    <span>{source.id.startsWith("butler:") ? "管家·" + source.id.split(":").pop() : source.id.split(":").pop()}</span>
                    <small>{source.format === "journald" ? "服务日志" : formatBytes(source.sizeBytes)}</small>
                  </button>
                ))}
                {!logLoading && logSources.length === 0 && (
                  <p className="log-source-empty">没有可用的日志文件</p>
                )}
              </aside>
              <section className="log-viewer">
                {logError !== null && <div className="log-viewer-error">{logError}</div>}
                {logLoading && <div className="log-viewer-loading">正在读取日志…</div>}
                {activeLog !== null && (
                  <>
                    <div className="log-viewer-meta">
                      <code title={activeLog.path}>{activeLog.path}</code>
                      <span>
                        {activeLog.truncated
                          ? `只显示最后 ${activeLog.lines.length} 行（共 ${formatNumber(activeLog.totalLines)} 行）`
                          : `共 ${formatNumber(activeLog.totalLines)} 行`}
                      </span>
                    </div>
                    {(activeLog.hasOlder || activeLog.hasNewer) && (
                      <div className="log-viewer-pager">
                        {activeLog.hasOlder && (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            disabled={logLoading}
                            onClick={() => void loadLogTail(activeLog.sourceId, activeLog.pageStart)}
                          >
                            更早的日志
                          </button>
                        )}
                        {activeLog.hasNewer && (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            disabled={logLoading}
                            onClick={() => void loadLogTail(activeLog.sourceId, null)}
                          >
                            回到最新
                          </button>
                        )}
                      </div>
                    )}
                    {activeLog.error !== undefined ? (
                      <div className="log-viewer-error">读取失败：{activeLog.error}</div>
                    ) : (
                      <pre className="log-lines">
                        {activeLog.lines.map((line, index) => (
                          <code key={index}>{line}</code>
                        ))}
                      </pre>
                    )}
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
