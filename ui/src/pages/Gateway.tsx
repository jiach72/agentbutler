/**
 * 消息网关工作台：严格接管数据面 + Hermes 补丁与限流观察面。
 *
 * - /api/messages/overview 提供 Bridge、SQLite Outbox、coverage 与真实消息投影；
 * - /api/messages/tasks/:runId 提供所选消息的任务生命周期；
 * - /api/gateway 保留限流画像、补丁登记状态与管家告警队列；
 * - 每 10 秒刷新一次，各数据分区独立降级。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DangerConfirmModal } from "../components/DangerConfirmModal.js";
import { fetchJson, postJson } from "../lib/api.js";
import { PromptOptimizationPanel } from "../components/PromptOptimizationPanel.js";

interface RateLimitMatch {
  signature: string;
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
}

interface PatchSuggestion {
  patchId: string;
  param: string;
  current: number;
  suggested: number;
  level: "warn" | "critical";
  reason: string;
}

interface RateLimitView {
  overall: "ok" | "warn" | "critical" | string;
  totalEvents: number;
  last24h: number;
  matched: RateLimitMatch[];
  suggestions: PatchSuggestion[];
}

interface PatchParamSchema {
  default: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

interface GatewayPatch {
  id: string;
  title: string;
  description: string;
  target: string;
  requires?: string[];
  params: Record<string, PatchParamSchema>;
  applied: null | {
    params: Record<string, number>;
    appliedAt: string;
    targetPath: string;
  };
  observed?: null | {
    params: Record<string, number>;
    checkedAt: string;
    targetPath: string;
  };
}

interface AlertItem {
  id: number;
  kind: string;
  severity: "info" | "warn" | "critical" | string;
  title: string;
  body: string;
  source: string;
  status: string;
  attempts: number;
  mergedCount: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  channel: string | null;
}

interface AlertsView {
  reachable: boolean;
  counts: Record<string, number>;
  degradedChannels: string[];
  items: AlertItem[];
}

interface GatewayPayload {
  watchReachable?: boolean;
  rateLimit?: RateLimitView | null;
  patches?: GatewayPatch[];
  alerts?: AlertsView;
}

interface MessageBridgeView {
  connected: boolean;
  running: boolean;
  inFlight: boolean;
  attached: boolean;
  outboxWritable: boolean;
  protocolVersion: number | null;
  bridgeVersion: string | null;
  instanceId: string | null;
  policyVersion: string | null;
  remotePolicyVersion: string | null;
  channels: Record<string, string>;
  coverage: Record<string, string>;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
}

interface MessageItemView {
  messageId: string;
  instanceId: string;
  adapterId: string;
  channel: string;
  chatId: string;
  sessionId: string;
  runId?: string | null;
  inboundMessageId?: string | null;
  messageKind: string;
  transport: string;
  priority: string;
  content: string;
  capturedAt: string;
  sequence: number;
  state: string;
  availableAt: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  transformTrace: string[];
  lastPolicyError: string | null;
  updatedAt: string;
}

interface MessageOverviewPayload {
  reachable: boolean;
  status: null | {
    bridge: MessageBridgeView;
    counts: Record<string, number>;
  };
  messages: {
    counts: Record<string, number>;
    items: MessageItemView[];
  };
  degraded: string[];
}

interface TaskEventView {
  runId: string;
  sequence: number;
  sessionId: string;
  kind: string;
  summary?: string;
  etaSec?: number;
  occurredAt: string;
}

interface MessageTaskView {
  runId: string;
  sessionId: string;
  state: string;
  lastEventSequence: number;
  updatedAt: string;
  events: TaskEventView[];
}

interface DriftDiff {
  anchorIndex: number;
  anchorPreview: string;
  reason: string;
  context: string[];
}

interface DriftReport {
  patchId: string;
  status:
    "ok" | "observed" | "drifted" | "not-applied" | "missing-target" | "missing-backup" | string;
  params?: Record<string, number>;
  diffs?: DriftDiff[];
  checkedAt?: string;
  targetPath?: string;
}

type PatchDrafts = Record<string, Record<string, string>>;
type Toast = { kind: "ok" | "err"; text: string };
type PatchAction = "apply" | "reapply" | "detect";
type PendingPatchAction = {
  patch: GatewayPatch;
  action: Exclude<PatchAction, "detect">;
  params: Record<string, number>;
  instanceId?: string;
};

const REFRESH_INTERVAL_MS = 10_000;

const PARAM_LABELS: Record<string, string> = {
  minSendIntervalSec: "最小发送间隔",
  silentFirstDelaySec: "静默后首条延迟",
  attachmentBudgetPerMsg: "单次回复附件预算",
  splitThresholdChars: "超长文本阈值",
};

const MESSAGE_STATE_LABELS: Record<string, string> = {
  captured: "刚收到",
  policy_pending: "正在判断",
  held_dnd: "免打扰暂存",
  held_pacing: "间隔暂存",
  ready: "等待发送",
  delivering: "发送中",
  retry_wait: "等待重试",
  delivered: "已送达",
  delivery_unknown: "结果未知",
  absorbed: "已合并",
  policy_error: "判断异常",
  dead_letter: "发送失败",
  cancelled: "已取消",
  pending: "等待发送",
  failed: "发送失败",
  critical: "紧急",
  warn: "需注意",
  info: "提示",
};

const COVERAGE_LABELS: Record<string, string> = {
  runtime: "运行时",
  adapterAttach: "适配器挂载",
  queuedSend: "排队发送",
  a2aWaiter: "A2A 等待",
  a2aPush: "A2A 推送",
  edit: "消息编辑",
  media: "媒体出口",
  inbound: "入站关联",
  runLifecycle: "任务生命周期",
  progress: "进度事件",
  apiJson: "JSON API",
  apiSse: "SSE API",
};

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

function badgeForStatus(status: string): { cls: string; label: string } {
  const normalized = status.toLowerCase();
  if (["ok", "healthy", "delivered", "applied", "done", "completed"].includes(normalized)) {
    return { cls: "badge-healthy", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
  }
  if (
    [
      "critical",
      "failed",
      "drifted",
      "missing-target",
      "missing-backup",
      "dead_letter",
      "policy_error",
      "delivery_unknown",
      "unavailable",
    ].includes(normalized)
  ) {
    return { cls: "badge-down", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
  }
  if (
    [
      "warn",
      "pending",
      "delivering",
      "open",
      "not-applied",
      "captured",
      "policy_pending",
      "held_dnd",
      "held_pacing",
      "ready",
      "retry_wait",
      "degraded",
    ].includes(normalized)
  ) {
    return { cls: "badge-degraded", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
  }
  if (normalized === "observed") {
    return { cls: "badge-degraded", label: "手工已生效" };
  }
  return { cls: "badge-muted", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
}

function formatTimestamp(ts: string | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "—";
  const value = new Date(ts);
  if (Number.isNaN(value.getTime())) return ts;
  return value.toLocaleString("zh-CN", { hour12: false });
}

function shortId(value: string | null | undefined, length = 12): string {
  if (value === undefined || value === null || value === "") return "—";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  wechat: "微信",
  weixin: "微信",
  wecom: "企业微信",
  a2a: "A2A",
  "api-server": "服务接口",
  email: "邮件",
  sms: "短信",
  desktop: "桌面通知",
  webhook: "网页通知",
};

function channelLabel(channel: string | null | undefined): string {
  if (channel === null || channel === undefined || channel === "") return "—";
  return CHANNEL_LABELS[channel.toLowerCase()] ?? channel;
}

const MESSAGE_KIND_LABELS: Record<string, string> = {
  final: "最终回复",
  "task-progress": "任务进度",
  failure: "失败提醒",
  alert: "重要提醒",
  system: "系统消息",
  mutation: "操作确认",
};
const TRANSPORT_LABELS: Record<string, string> = {
  "queued-push": "队列推送",
  "inline-response": "即时回复",
};
const TRACE_LABELS: Record<string, string> = {
  "policy:queued-push": "进入待发送队列",
  "digest:events-deduped": "重复进度已合并",
  "digest:truncated": "内容过长已精简",
  "digest:final-absorbed": "最终回复已合并进度",
  "digest:duplicate-absorbed": "重复进度已合并",
  "dnd:bypass-failure": "失败消息，跳过免打扰",
  "dnd:bypass-urgent": "紧急消息，跳过免打扰",
  "dnd:bypass-solicited-reply": "用户正在等待，跳过免打扰",
  "dnd:none": "免打扰未命中",
  "pacing:held": "发送间隔未到，先暂存",
  "pacing:ready": "发送间隔已到",
  "classified:final": "识别为最终回复",
  "aggregate-progress": "进度已合并",
  ready: "可以发送",
  "delivery:ok": "发送成功",
  "delivery:failed": "发送失败",
  "delivery:unknown": "发送结果未知",
};
const TASK_EVENT_LABELS: Record<string, string> = {
  started: "已开始",
  progress: "进行中",
  completing: "准备结束",
  done: "已完成",
  failed: "已失败",
};

function messageKindLabel(value: string): string {
  return MESSAGE_KIND_LABELS[value] ?? value;
}

function transportLabel(value: string): string {
  return TRANSPORT_LABELS[value.toLowerCase()] ?? value;
}

function transformTraceLabel(step: string): string {
  if (TRACE_LABELS[step] !== undefined) return TRACE_LABELS[step];
  if (step.startsWith("dnd:")) return step.includes("held") ? "免打扰暂存" : "免打扰检查";
  return step;
}

function taskEventLabel(kind: string): string {
  return TASK_EVENT_LABELS[kind] ?? kind;
}

function sourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined || source === "") return "—";
  const labels: Record<string, string> = {
    watch: "管家检查",
    gateway: "消息通知",
    hermes: "Hermes",
  };
  return labels[source.toLowerCase()] ?? source;
}

function effectivePatchParams(patch: GatewayPatch): Record<string, number> | undefined {
  return patch.applied?.params ?? patch.observed?.params;
}

function responseError(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const body = data as Record<string, unknown>;
  const detail = body["detail"];
  if (typeof detail === "string" && detail !== "") return detail;
  const error = body["error"];
  return typeof error === "string" ? error : "";
}

function seedDrafts(current: PatchDrafts, patches: GatewayPatch[]): PatchDrafts {
  const next: PatchDrafts = { ...current };
  for (const patch of patches) {
    const existing = next[patch.id] ?? {};
    const draft = { ...existing };
    const effective = effectivePatchParams(patch);
    for (const [name, schema] of Object.entries(patch.params)) {
      if (draft[name] !== undefined) continue;
      const value = effective?.[name] ?? schema.default;
      draft[name] = String(value);
    }
    next[patch.id] = draft;
  }
  return next;
}

function schemaHint(schema: PatchParamSchema): string {
  const parts: string[] = [];
  if (schema.min !== undefined) parts.push(`最小 ${schema.min}`);
  if (schema.max !== undefined) parts.push(`最大 ${schema.max}`);
  if (schema.integer === true) parts.push("整数");
  return parts.join(" · ") || `默认 ${schema.default}`;
}

function readParamValue(
  patch: GatewayPatch | undefined,
  param: string,
  drafts: PatchDrafts,
): number | undefined {
  if (patch === undefined) return undefined;
  const raw = drafts[patch.id]?.[param];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return effectivePatchParams(patch)?.[param] ?? patch.params[param]?.default;
}

function parsePatchParams(
  patch: GatewayPatch,
  patches: GatewayPatch[],
  drafts: PatchDrafts,
): { ok: true; params: Record<string, number> } | { ok: false; error: string } {
  const params: Record<string, number> = {};
  const effective = effectivePatchParams(patch);
  for (const [name, schema] of Object.entries(patch.params)) {
    const raw = drafts[patch.id]?.[name] ?? String(effective?.[name] ?? schema.default);
    const value = Number(raw);
    const label = PARAM_LABELS[name] ?? name;
    if (raw.trim() === "" || !Number.isFinite(value))
      return { ok: false, error: `${label}必须是数字` };
    if (schema.integer === true && !Number.isInteger(value))
      return { ok: false, error: `${label}必须是整数` };
    if (schema.min !== undefined && value < schema.min) {
      return { ok: false, error: `${label}不能低于 ${schema.min}` };
    }
    if (schema.max !== undefined && value > schema.max) {
      return { ok: false, error: `${label}不能高于 ${schema.max}` };
    }
    params[name] = value;
  }

  const throttle = patches.find((item) => item.id === "wx-send-throttle");
  const silent = patches.find((item) => item.id === "wx-silent-first-delay");
  const interval =
    patch.id === "wx-send-throttle"
      ? params["minSendIntervalSec"]
      : readParamValue(throttle, "minSendIntervalSec", drafts);
  const firstDelay =
    patch.id === "wx-silent-first-delay"
      ? params["silentFirstDelaySec"]
      : readParamValue(silent, "silentFirstDelaySec", drafts);
  if (interval !== undefined && firstDelay !== undefined && firstDelay > interval) {
    return { ok: false, error: `静默后首条延迟 ${firstDelay}s 不能超过发送间隔 ${interval}s` };
  }
  return { ok: true, params };
}

function patchActionError(status: number, data: unknown): string {
  const detail = responseError(data);
  if (status === 400) return detail || "参数不对，请检查后重试";
  if (status === 404) return "这个调整没有登记过";
  if (status === 409) return detail || "这个调整和现有文件冲突";
  if (status === 502) return "管家服务暂时连不上";
  if (status === 503) return "暂时没有可操作的管家";
  if (status === 0) return "请求未送达";
  return detail || "操作失败，请稍后重试";
}

export function GatewayPage() {
  const [data, setData] = useState<GatewayPayload | null>(null);
  const [messageData, setMessageData] = useState<MessageOverviewPayload | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [taskData, setTaskData] = useState<MessageTaskView | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [drafts, setDrafts] = useState<PatchDrafts>({});
  const [driftReports, setDriftReports] = useState<Record<string, DriftReport>>({});
  const [selectedInstance, setSelectedInstance] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [pendingPatchAction, setPendingPatchAction] = useState<PendingPatchAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [promptFlash, setPromptFlash] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const promptFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashPromptSection = () => {
    setPromptFlash(true);
    if (promptFlashTimer.current !== undefined) clearTimeout(promptFlashTimer.current);
    promptFlashTimer.current = setTimeout(() => setPromptFlash(false), 2200);
  };

  const showToast = useCallback((kind: Toast["kind"], text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const [payload, messages] = await Promise.all([
      fetchJson<GatewayPayload>("/api/gateway"),
      fetchJson<MessageOverviewPayload>("/api/messages/overview?limit=60"),
    ]);
    if (payload !== null) {
      setData(payload);
      setDrafts((current) => seedDrafts(current, payload.patches ?? []));
    }
    if (messages !== null) {
      setMessageData(messages);
      setSelectedMessageId((current) => {
        if (
          current !== null &&
          messages.messages.items.some((item) => item.messageId === current)
        ) {
          return current;
        }
        return messages.messages.items[0]?.messageId ?? null;
      });
    }
    if (payload !== null || messages !== null) setLastUpdated(new Date());
    setLoadError(payload === null || messages === null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const patches = data?.patches ?? [];
  const rateLimit = data?.rateLimit ?? null;
  const alerts = data?.alerts ?? null;
  const messageItems = messageData?.messages.items ?? [];
  const messageCounts = messageData?.messages.counts ?? messageData?.status?.counts ?? {};
  const messageBridge = messageData?.status?.bridge ?? null;
  const selectedMessage =
    messageItems.find((item) => item.messageId === selectedMessageId) ?? messageItems[0] ?? null;

  useEffect(() => {
    const runId = selectedMessage?.runId;
    if (runId === undefined || runId === null || runId === "") {
      setTaskData(null);
      setTaskLoading(false);
      return;
    }
    let active = true;
    setTaskData(null);
    setTaskLoading(true);
    void fetchJson<MessageTaskView>(`/api/messages/tasks/${encodeURIComponent(runId)}`).then(
      (task) => {
        if (!active) return;
        setTaskData(task);
        setTaskLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedMessage?.runId]);

  const updateDraft = (patchId: string, param: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [patchId]: { ...current[patchId], [param]: value },
    }));
  };

  const useSuggestion = (suggestion: PatchSuggestion) => {
    updateDraft(suggestion.patchId, suggestion.param, String(suggestion.suggested));
    const label = PARAM_LABELS[suggestion.param] ?? suggestion.param;
    showToast("ok", `${label}已写入草稿；确认后再应用，不会自动修改源码`);
  };

  const runPatchAction = async (patch: GatewayPatch, action: PatchAction) => {
    const key = `${patch.id}:${action}`;
    if (busyAction !== "") return;

    if (action === "detect") {
      setBusyAction(key);
      const body = selectedInstance.trim() === "" ? {} : { instanceId: selectedInstance.trim() };
      const result = await postJson(
        `/api/gateway/patches/${encodeURIComponent(patch.id)}/detect`,
        body,
        10_000,
      );
      if (result.status === 200 && result.data !== null && typeof result.data === "object") {
        const report = (result.data as Record<string, unknown>)["report"];
        if (report !== null && typeof report === "object") {
          setDriftReports((current) => ({ ...current, [patch.id]: report as DriftReport }));
          showToast("ok", `漂移检测完成：${(report as DriftReport).status}`);
        } else {
          showToast("err", "漂移检测响应缺少 report");
        }
      } else {
        showToast("err", patchActionError(result.status, result.data));
      }
      setBusyAction("");
      return;
    }

    const parsed = parsePatchParams(patch, patches, drafts);
    if (!parsed.ok) {
      showToast("err", parsed.error);
      return;
    }
    setPendingPatchAction({
      patch,
      action,
      params: parsed.params,
      ...(selectedInstance.trim() === "" ? {} : { instanceId: selectedInstance.trim() }),
    });
  };

  const executePendingPatchAction = async (pending: PendingPatchAction): Promise<void> => {
    const key = `${pending.patch.id}:${pending.action}`;
    const verb = pending.action === "apply" ? "应用" : "重打";
    setBusyAction(key);
    try {
      const body: { params: Record<string, number>; instanceId?: string } = { params: pending.params };
      if (pending.instanceId !== undefined) body.instanceId = pending.instanceId;
      const result = await postJson(
        `/api/gateway/patches/${encodeURIComponent(pending.patch.id)}/${pending.action}`,
        body,
        10_000,
      );
      if (result.status === 200) {
        const outcome =
          result.data !== null && typeof result.data === "object"
            ? String((result.data as Record<string, unknown>)["result"] ?? "ok")
            : "ok";
        showToast("ok", `${pending.patch.title} ${verb}成功（${outcome}）`);
        await refresh();
      } else {
        showToast("err", patchActionError(result.status, result.data));
      }
    } finally {
      setBusyAction("");
      setPendingPatchAction(null);
    }
  };

  if (data === null && messageData === null && loading) {
    return (
      <section className="page">
        <h1>消息通知</h1>
        <div className="empty-state">正在读取消息状态、发送记录和通知规则…</div>
      </section>
    );
  }

  const overallBadge = badgeForStatus(rateLimit?.overall ?? "unknown");
  const channelBadge =
    alerts === null
      ? { cls: "badge-muted", label: "未知" }
      : !alerts.reachable
        ? { cls: "badge-down", label: "离线" }
        : { cls: "badge-healthy", label: "就绪" };
  const pendingAlerts = alerts?.counts["pending"] ?? 0;
  const failedAlerts = alerts?.counts["failed"] ?? 0;
  const coverageEntries = Object.entries(messageBridge?.coverage ?? {}).filter(
    ([path]) => COVERAGE_LABELS[path] !== undefined,
  );
  const coverageOk = coverageEntries.filter(([, status]) => status === "ok").length;
  const bridgeReady =
    messageBridge?.connected === true && messageBridge.attached && messageBridge.outboxWritable;
  const activeMessages = [
    "captured",
    "policy_pending",
    "held_dnd",
    "held_pacing",
    "ready",
    "delivering",
    "retry_wait",
  ].reduce((total, state) => total + (messageCounts[state] ?? 0), 0);
  const exceptionMessages = ["delivery_unknown", "policy_error", "dead_letter"].reduce(
    (total, state) => total + (messageCounts[state] ?? 0),
    0,
  );

  return (
    <section className="page gateway-page">
      <div className="page-heading gateway-heading">
        <div>
          <span className="product-eyebrow">消息通知</span>
          <h1>帮你管住消息频率，重要消息不丢</h1>
          <p className="hint gateway-mode-note">
            管家会记录本机 AI 发出的消息，自动合并类似内容、避开免打扰时间，
            重要消息仍然会按时送达。技术细节收在下方。
          </p>
        </div>
        <div className="gateway-refresh">
          <span className={`gateway-live-state${loading ? " is-refreshing" : ""}`}>
            <i />
            {loading ? "正在同步" : "10 秒实时刷新"}
          </span>
          <span>更新于 {lastUpdated?.toLocaleTimeString("zh-CN", { hour12: false }) ?? "—"}</span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "刷新中" : "刷新"}
          </button>
          <a
            href="#prompt-optimization"
            className="btn btn-secondary gateway-prompt-link"
            onClick={flashPromptSection}
          >
            查看消息优化
          </a>
        </div>
      </div>

      {toast !== null && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
      {loadError && (
        <div className="banner banner-warn">⚠ 部分服务暂时连不上，当前显示上一次成功数据</div>
      )}
      {messageData !== null && !messageData.reachable && (
        <div className="banner banner-critical">⚠ 暂时读不到消息记录；管家稍后会自动重试。</div>
      )}
      {(messageData?.degraded.length ?? 0) > 0 && messageData?.reachable === true && (
        <div className="banner banner-warn">⚠ 部分消息记录暂时不完整，稍后会自动补回来</div>
      )}
      {messageBridge !== null && !bridgeReady && (
        <div className="banner banner-critical">
          ⚠ 消息接管还没准备好：请确认本机 AI 正在运行，稍后刷新重试。
        </div>
      )}
      {data?.watchReachable === false && (
        <div className="banner banner-warn">
          ⚠ 管家服务暂时连不上：消息频率和通知设置需要等服务恢复后查看。
        </div>
      )}
      {alerts !== null && !alerts.reachable && (
        <div className="banner banner-warn">
          ⚠ 通知服务暂时离线：正在排队中的提醒暂不可见，稍后会自动恢复。
        </div>
      )}

      <div className="gateway-overview" aria-label="消息通知状态摘要">
        <div className="gateway-metric">
          <span className="gateway-metric-label">消息管理</span>
          <strong>{bridgeReady ? "已接管" : messageBridge === null ? "正在读取" : "未就绪"}</strong>
          <span>管家会自动发现并接管本机 AI 的消息</span>
        </div>
        <div className="gateway-metric">
          <span className="gateway-metric-label">等待发送</span>
          <strong>{messageBridge?.outboxWritable === true ? "可写入" : "待确认"}</strong>
          <span>
            {activeMessages} 条正在处理 · {messageCounts["held_dnd"] ?? 0} 条免打扰暂存
          </span>
        </div>
        <div className="gateway-metric">
          <span className="gateway-metric-label">常用路径</span>
          <strong>
            {coverageEntries.length === 0 ? "—" : `${coverageOk}/${coverageEntries.length}`}
          </strong>
          <span>
            {coverageEntries.length === 12 && coverageOk === 12
              ? "常用路径已验证"
              : "按最新消息记录显示"}
          </span>
        </div>
        <div className="gateway-metric">
          <span className="gateway-metric-label">送达结果</span>
          <strong>{messageCounts["delivered"] ?? 0}</strong>
          <span>已送达 · {exceptionMessages} 条需关注</span>
        </div>
      </div>

      <details className="advanced-details gateway-message-advanced">
        <summary>
          <span>
            <strong>消息明细</strong>
            <small>发送前处理、通道状态和每一条消息的详细记录</small>
          </span>
          <span className="advanced-toggle">展开</span>
        </summary>
        <div className="advanced-details-body gateway-message-body">
          <section className="gateway-dataplane" aria-labelledby="gateway-dataplane-title">
            <div className="gateway-dataplane-head">
              <div>
                <span className="product-kicker">消息处理</span>
                <h2 id="gateway-dataplane-title">发送前会先经过这里</h2>
              </div>
              <div className="gateway-bridge-meta">
                <span title={messageBridge?.bridgeVersion ?? "接管组件既未就绪"}>
                  接管组件{" "}
                  {messageBridge?.bridgeVersion === null ||
                  messageBridge?.bridgeVersion === undefined
                    ? "未就绪"
                    : "已就绪"}
                </span>
                <span title={messageBridge?.policyVersion ?? "未启用规则"}>
                  消息规则{" "}
                  {messageBridge?.policyVersion === null ||
                  messageBridge?.policyVersion === undefined
                    ? "未启用"
                    : "已启用"}
                </span>
                <span>最近处理 {formatRelative(messageBridge?.lastCycleAt)}</span>
              </div>
            </div>

            <div className="gateway-channel-row" aria-label="消息通道状态">
              {Object.entries(messageBridge?.channels ?? {}).length === 0 ? (
                <span className="gateway-muted-copy">尚未收到通道状态</span>
              ) : (
                Object.entries(messageBridge?.channels ?? {}).map(([channel, status]) => {
                  const badge = badgeForStatus(status);
                  return (
                    <span className="gateway-channel" key={channel}>
                      <i className={status === "ok" ? "is-ok" : "is-warn"} />
                      {channelLabel(channel)}
                      <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                    </span>
                  );
                })
              )}
            </div>

            <div className="gateway-coverage-grid" aria-label="运行路径覆盖">
              {coverageEntries.length === 0 ? (
                <div className="empty-state">消息接管后，这里会显示真实经过处理的消息路径。</div>
              ) : (
                coverageEntries.map(([path, status]) => (
                  <div className={`gateway-coverage-item is-${status}`} key={path}>
                    <i />
                    <span>{COVERAGE_LABELS[path] ?? "其他路径"}</span>
                    <small>{badgeForStatus(status).label}</small>
                  </div>
                ))
              )}
            </div>
          </section>

          <div className="gateway-section-heading gateway-message-heading">
            <div>
              <h2 className="section-title">最近发送的消息</h2>
              <p className="hint">
                选择一条消息，可以查看它是否按时送达、被合并或暂存过；不会显示演示数据。
              </p>
            </div>
            <div className="message-state-strip" aria-label="消息关键状态计数">
              {(["captured", "held_dnd", "ready", "delivered", "dead_letter"] as const).map(
                (state) => (
                  <span key={state}>
                    {MESSAGE_STATE_LABELS[state]}
                    <strong>{messageCounts[state] ?? 0}</strong>
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="gateway-message-workspace">
            <section className="message-feed" aria-label="消息列表">
              <div className="message-feed-head">
                <span>最近 {messageItems.length} 条</span>
                <small>按时间从新到旧</small>
              </div>
              {messageItems.length === 0 ? (
                <div className="message-feed-empty">
                  <strong>
                    {messageData?.reachable === false ? "暂时读不到消息" : "还没有消息记录"}
                  </strong>
                  <span>真实消息经过管家后会出现在这里；不会生成演示数据。</span>
                </div>
              ) : (
                <div className="message-feed-list">
                  {messageItems.map((message) => {
                    const badge = badgeForStatus(message.state);
                    const isSelected = selectedMessage?.messageId === message.messageId;
                    return (
                      <button
                        type="button"
                        className={`message-feed-row${isSelected ? " is-selected" : ""}`}
                        aria-pressed={isSelected}
                        key={message.messageId}
                        onClick={() => setSelectedMessageId(message.messageId)}
                      >
                        <span className="message-feed-row-top">
                          <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                          <time>{formatRelative(message.updatedAt)}</time>
                        </span>
                        <strong>{message.content || "（空消息内容）"}</strong>
                        <span className="message-feed-row-meta">
                          {channelLabel(message.channel)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="message-inspector" aria-label="所选消息详情">
              {selectedMessage === null ? (
                <div className="message-inspector-empty">
                  <span>消息详情</span>
                  <strong>选择一条消息查看完整轨迹</strong>
                  <p>这里会显示发送状态、是否被合并、是否暂存以及最终结果。</p>
                </div>
              ) : (
                <>
                  <div className="message-inspector-head">
                    <div>
                      <span className="product-kicker">第 {selectedMessage.sequence} 条消息</span>
                      <h3>{MESSAGE_STATE_LABELS[selectedMessage.state] ?? "其他状态"}</h3>
                    </div>
                    <span className={`badge-pill ${badgeForStatus(selectedMessage.priority).cls}`}>
                      {badgeForStatus(selectedMessage.priority).label}
                    </span>
                  </div>

                  <div className="message-content-block">
                    {selectedMessage.content || "（空消息内容）"}
                  </div>

                  <dl className="message-facts">
                    <div>
                      <dt>会话 / 通道</dt>
                      <dd>
                        {shortId(selectedMessage.sessionId)} ·{" "}
                        {channelLabel(selectedMessage.channel)}
                      </dd>
                    </div>
                    <div>
                      <dt>发送方式</dt>
                      <dd>
                        {transportLabel(selectedMessage.transport)} ·{" "}
                        {messageKindLabel(selectedMessage.messageKind)}
                      </dd>
                    </div>
                    <div>
                      <dt>收到 / 送达</dt>
                      <dd>
                        {formatTimestamp(selectedMessage.capturedAt)} /{" "}
                        {formatTimestamp(selectedMessage.deliveredAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>尝试次数</dt>
                      <dd>{selectedMessage.attemptCount}</dd>
                    </div>
                  </dl>

                  <details className="message-tech-details">
                    <summary>
                      <span>技术编号</span>
                      <span className="advanced-toggle">展开</span>
                    </summary>
                    <div className="message-tech-body">
                      <dl className="message-facts message-tech-facts">
                        <div>
                          <dt>消息编号</dt>
                          <dd title={selectedMessage.messageId}>
                            {shortId(selectedMessage.messageId, 18)}
                          </dd>
                        </div>
                        <div>
                          <dt>任务编号</dt>
                          <dd title={selectedMessage.runId ?? undefined}>
                            {shortId(selectedMessage.runId, 18)}
                          </dd>
                        </div>
                        <div>
                          <dt>相关消息编号</dt>
                          <dd title={selectedMessage.inboundMessageId ?? undefined}>
                            {shortId(selectedMessage.inboundMessageId, 18)}
                          </dd>
                        </div>
                        <div>
                          <dt>平台消息编号</dt>
                          <dd title={selectedMessage.providerMessageId ?? undefined}>
                            {shortId(selectedMessage.providerMessageId ?? undefined, 18)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </details>

                  {(selectedMessage.lastError !== null ||
                    selectedMessage.lastPolicyError !== null) && (
                    <div className="message-error-block">
                      <strong>需要处理</strong>
                      <span>{selectedMessage.lastPolicyError ?? selectedMessage.lastError}</span>
                    </div>
                  )}

                  <div className="message-inspector-section">
                    <h4>消息处理步骤</h4>
                    {selectedMessage.transformTrace.length === 0 ? (
                      <span className="gateway-muted-copy">没有记录处理步骤</span>
                    ) : (
                      <ol className="message-trace">
                        {selectedMessage.transformTrace.map((step, index) => (
                          <li key={`${step}:${String(index)}`}>
                            <i />
                            <span title={step}>{transformTraceLabel(step)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="message-inspector-section">
                    <h4>相关任务进度</h4>
                    {selectedMessage.runId === undefined || selectedMessage.runId === null ? (
                      <span className="gateway-muted-copy">这条消息没有关联正在运行的 AI 任务</span>
                    ) : taskLoading ? (
                      <span className="gateway-muted-copy">正在读取任务事件…</span>
                    ) : taskData === null || taskData.runId !== selectedMessage.runId ? (
                      <span className="gateway-muted-copy">没有找到相关任务进度</span>
                    ) : (
                      <ol className="task-timeline">
                        {taskData.events.map((event) => (
                          <li key={`${event.runId}:${String(event.sequence)}`}>
                            <i />
                            <div>
                              <strong>{event.summary ?? taskEventLabel(event.kind)}</strong>
                              <span>{taskEventLabel(event.kind)} · 管家已记录</span>
                              <time>{formatTimestamp(event.occurredAt)}</time>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>
      </details>

      <details className="advanced-details gateway-advanced">
        <summary>
          <span>
            <strong>高级设置</strong>
            <small>频率规则、消息参数和通知队列；普通用户通常不需要动</small>
          </span>
          <span className="advanced-toggle">展开</span>
        </summary>
        <div className="advanced-details-body gateway-advanced-body">
          <div className="gateway-secondary-status" aria-label="观察面状态">
            <span>
              发送频率 <i className={`badge-pill ${overallBadge.cls}`}>{overallBadge.label}</i>
            </span>
            <span>近 24 小时 {rateLimit?.last24h ?? "—"} 次</span>
            <span>
              备用告警 <i className={`badge-pill ${channelBadge.cls}`}>{channelBadge.label}</i>
            </span>
            <span>
              {pendingAlerts} 待投递 · {failedAlerts} 失败
            </span>
          </div>

          <h2 className="section-title">消息频率建议</h2>
          {rateLimit === null ? (
            <div className="empty-state">
              管家服务连上后，这里会显示消息频率是否正常、是否需要调整。
            </div>
          ) : (
            <>
              {rateLimit.suggestions.length === 0 ? (
                <div className="gateway-quiet-state">
                  <span className="badge-pill badge-healthy">无需调整</span>
                  <span>近 24 小时没有形成需要调参的限流趋势。</span>
                </div>
              ) : (
                <div className="gateway-suggestions">
                  {rateLimit.suggestions.map((suggestion) => {
                    const badge = badgeForStatus(suggestion.level);
                    return (
                      <div
                        className="gateway-suggestion"
                        key={`${suggestion.patchId}:${suggestion.param}`}
                      >
                        <div>
                          <div className="gateway-suggestion-title">
                            <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                            <strong>{PARAM_LABELS[suggestion.param] ?? suggestion.param}</strong>
                            <span className="gateway-value-change">
                              {suggestion.current} → {suggestion.suggested}
                            </span>
                          </div>
                          <p>{suggestion.reason}</p>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => useSuggestion(suggestion)}
                        >
                          写入参数草稿
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {rateLimit.matched.length === 0 ? (
                <div className="empty-state gateway-spaced">暂时没有发现频率相关的异常。</div>
              ) : (
                <div className="card table-card gateway-spaced">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>错误模板</th>
                        <th>累计</th>
                        <th>状态</th>
                        <th>最近出现</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rateLimit.matched.map((match) => {
                        const badge = badgeForStatus(match.status);
                        return (
                          <tr key={match.signature}>
                            <td className="fp-sample" title={match.template}>
                              {match.template}
                            </td>
                            <td>{match.count}</td>
                            <td>
                              <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                            </td>
                            <td>{formatRelative(match.lastSeen)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div className="gateway-section-heading">
            <div>
              <h2 className="section-title">消息规则与参数</h2>
              <p className="hint">这里是高级设置；只有登记过的文件才会被修改，升级后可重新匹配。</p>
            </div>
            <label className="gateway-instance-field">
              <span>管家实例（可选）</span>
              <input
                className="text-input"
                value={selectedInstance}
                onChange={(event) => setSelectedInstance(event.target.value)}
                placeholder="留空自动选择正在运行的管家"
              />
            </label>
          </div>

          {patches.length === 0 ? (
            <div className="empty-state">暂时没有可调整的消息规则，请稍后刷新。</div>
          ) : (
            <div className="cards-stack">
              {patches.map((patch) => {
                const report = driftReports[patch.id];
                const reportBadge = report === undefined ? null : badgeForStatus(report.status);
                const missingRequires = (patch.requires ?? []).filter((requiredId) => {
                  const required = patches.find((item) => item.id === requiredId);
                  return (
                    required === undefined ||
                    (required.applied === null && (required.observed ?? null) === null)
                  );
                });
                const isObserved = (patch.observed ?? null) !== null && patch.applied === null;
                const actionDisabled =
                  busyAction !== "" ||
                  isObserved ||
                  missingRequires.length > 0 ||
                  data?.watchReachable === false;
                return (
                  <article className="card patch-panel" key={patch.id}>
                    <div className="patch-head">
                      <div>
                        <div className="patch-title-row">
                          <h3>{patch.title}</h3>
                          <span
                            className={`badge-pill ${
                              patch.applied !== null
                                ? "badge-healthy"
                                : isObserved
                                  ? "badge-degraded"
                                  : "badge-muted"
                            }`}
                          >
                            {patch.applied !== null
                              ? "已纳管"
                              : isObserved
                                ? "手工已生效 · 未纳管"
                                : "未应用"}
                          </span>
                        </div>
                        <p>{patch.description}</p>
                        <code className="patch-target">{patch.target}</code>
                      </div>
                      {patch.requires !== undefined && patch.requires.length > 0 && (
                        <span className="patch-dependency">依赖：{patch.requires.join("、")}</span>
                      )}
                    </div>

                    <div className="patch-param-grid">
                      {Object.entries(patch.params).map(([name, schema]) => (
                        <label className="patch-param" key={name}>
                          <span>{PARAM_LABELS[name] ?? name}</span>
                          <input
                            className="number-input"
                            type="number"
                            min={schema.min}
                            max={schema.max}
                            step={schema.integer === true ? 1 : "any"}
                            value={drafts[patch.id]?.[name] ?? ""}
                            disabled={isObserved}
                            onChange={(event) => updateDraft(patch.id, name, event.target.value)}
                          />
                          <small>{isObserved ? "只读 · 从当前源码提取" : schemaHint(schema)}</small>
                        </label>
                      ))}
                    </div>

                    {patch.applied !== null && (
                      <dl className="patch-applied-meta">
                        <dt>上次应用</dt>
                        <dd>{formatRelative(patch.applied.appliedAt)}</dd>
                        <dt>实际文件</dt>
                        <dd title={patch.applied.targetPath}>{patch.applied.targetPath}</dd>
                      </dl>
                    )}
                    {isObserved && patch.observed !== undefined && patch.observed !== null && (
                      <>
                        <dl className="patch-applied-meta">
                          <dt>源码识别</dt>
                          <dd>{formatRelative(patch.observed.checkedAt)}</dd>
                          <dt>实际文件</dt>
                          <dd title={patch.observed.targetPath}>{patch.observed.targetPath}</dd>
                        </dl>
                        <div className="patch-inline-warning">
                          当前能力来自 Hermes 源码中的手工实现，Butler
                          只读观察，不会应用或重打覆盖。
                        </div>
                      </>
                    )}
                    {missingRequires.length > 0 && (
                      <div className="patch-inline-warning">
                        请先应用前置补丁：{missingRequires.join("、")}
                      </div>
                    )}
                    {report !== undefined && reportBadge !== null && (
                      <div className="drift-result">
                        <span className={`badge-pill ${reportBadge.cls}`}>{reportBadge.label}</span>
                        <span>检测于 {formatRelative(report.checkedAt)}</span>
                        {(report.diffs?.length ?? 0) > 0 && (
                          <span>{report.diffs!.length} 处差异</span>
                        )}
                      </div>
                    )}

                    <div className="patch-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={actionDisabled}
                        onClick={() => void runPatchAction(patch, "apply")}
                      >
                        {busyAction === `${patch.id}:apply` ? "应用中" : "应用这个调整"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={actionDisabled}
                        onClick={() => void runPatchAction(patch, "reapply")}
                      >
                        {busyAction === `${patch.id}:reapply` ? "恢复中" : "恢复官方默认"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busyAction !== "" || data?.watchReachable === false}
                        onClick={() => void runPatchAction(patch, "detect")}
                      >
                        {busyAction === `${patch.id}:detect` ? "检查中" : "检查是否被改过"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <h2 className="section-title">待处理通知</h2>
          {alerts === null || !alerts.reachable ? (
            <div className="empty-state">
              管家连上后，这里会显示排队中的提醒和当前通知状态。
            </div>
          ) : (
            <>
              <div className="queue-counts" aria-label="告警队列计数">
                {(["pending", "delivering", "delivered", "failed"] as const).map((status) => {
                  const badge = badgeForStatus(status);
                  return (
                    <span key={status}>
                      <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                      <strong>{alerts.counts[status] ?? 0}</strong>
                    </span>
                  );
                })}
              </div>
              {alerts.items.length === 0 ? (
                <div className="empty-state gateway-spaced">没有等待处理的通知。</div>
              ) : (
                <div className="card table-card gateway-spaced">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>级别</th>
                        <th>提醒</th>
                        <th>状态</th>
                        <th>尝试</th>
                        <th>通道</th>
                        <th>入队时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.items.map((item) => {
                        const severityBadge = badgeForStatus(item.severity);
                        const statusBadge = badgeForStatus(item.status);
                        return (
                          <tr key={item.id}>
                            <td>
                              <span className={`badge-pill ${severityBadge.cls}`}>
                                {severityBadge.label}
                              </span>
                            </td>
                            <td className="alert-title-cell" title={item.body}>
                              <strong>{item.title}</strong>
                              <span>{sourceLabel(item.source)}</span>
                            </td>
                            <td>
                              <span className={`badge-pill ${statusBadge.cls}`}>
                                {statusBadge.label}
                              </span>
                            </td>
                            <td>{item.attempts}</td>
                            <td>{channelLabel(item.channel)}</td>
                            <td>{formatRelative(item.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </details>

      <div id="prompt-optimization" className={`gateway-prompt-section${promptFlash ? " is-flashing" : ""}`}>
        <PromptOptimizationPanel />
      </div>
      {pendingPatchAction !== null && (
        <DangerConfirmModal
          open
          title={pendingPatchAction.action === "apply" ? "确认应用消息调整" : "确认恢复官方默认"}
          busy={busyAction !== ""}
          confirmLabel={pendingPatchAction.action === "apply" ? "确认应用" : "确认恢复"}
          onCancel={() => {
            if (busyAction === "") setPendingPatchAction(null);
          }}
          onConfirm={() => executePendingPatchAction(pendingPatchAction)}
          steps={[
            "再次校验配置不变式和补丁锚点",
            "首次应用前保留官方原文备份",
            "写入已登记的 Hermes 源文件并记录审计",
          ]}
        >
          <p>
            将对「{pendingPatchAction.patch.title}」执行
            {pendingPatchAction.action === "apply" ? "应用" : "恢复官方默认"}，目标文件为
            <code>{pendingPatchAction.patch.target}</code>。
          </p>
          <p className="danger-impact">
            这是实际的源码写入操作。漂移、手工实现或配置不变式不满足时，服务端会拒绝执行；本次确认前不会修改任何文件。
          </p>
          <p className="hint">
            参数：
            {Object.entries(pendingPatchAction.params)
              .map(([name, value]) => (PARAM_LABELS[name] ?? name) + "=" + String(value))
              .join(" · ")}
            {pendingPatchAction.instanceId === undefined
              ? "；实例：自动选择"
              : "；实例：" + pendingPatchAction.instanceId}
          </p>
        </DangerConfirmModal>
      )}
    </section>
  );
}
