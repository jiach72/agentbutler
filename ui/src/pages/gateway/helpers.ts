/**
 * 网关页共享模型与文案映射：payload 类型、标签字典、
 * 状态 → 徽标 tone 的唯一换算出口，以及纯函数工具。
 */
import type { SemanticTone } from "../../components/StatusBadge.js";

export interface RateLimitMatch {
  signature: string;
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
}

export interface PatchSuggestion {
  patchId: string;
  param: string;
  current: number;
  suggested: number;
  level: "warn" | "critical";
  reason: string;
}

export interface RateLimitView {
  overall: "ok" | "warn" | "critical" | string;
  totalEvents: number;
  last24h: number;
  matched: RateLimitMatch[];
  suggestions: PatchSuggestion[];
}

export interface PatchParamSchema {
  default: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface GatewayPatch {
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

export interface AlertItem {
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

export interface AlertsView {
  reachable: boolean;
  counts: Record<string, number>;
  degradedChannels: string[];
  items: AlertItem[];
}

export interface GatewayPayload {
  watchReachable?: boolean;
  rateLimit?: RateLimitView | null;
  patches?: GatewayPatch[];
  alerts?: AlertsView;
}

export interface MessageBridgeView {
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
  channelDetails?: Record<string, {
    status: string;
    unavailableReason: string | null;
    unavailableFix: string | null;
    retryable: boolean;
    loginState?: ChannelDirectoryEntryView["loginState"];
    account?: string;
  }>;
  coverage: Record<string, string>;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
}

export interface MessageItemView {
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
  metadata: Record<string, unknown>;
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

/** 消息链路一键接管开关状态（镜像 web MessageStatusView.relay）。 */
export interface RelayControlView {
  enabled: boolean;
  pending: boolean;
  updatedAt: string | null;
}

/** 通道目录条目（镜像 contract ChannelDirectoryEntry，来自 GET /api/messages/channels）。 */
export interface ChannelDirectoryEntryView {
  id: string;
  label: string;
  kind: "qr-login" | "credential" | "builtin";
  enabled: boolean;
  credentialsConfigured: boolean;
  loginState: "logged_in" | "logged_out" | "configuring" | "unknown";
  account?: string;
}

/** 通道启停应答（镜像 Bridge 新契约）：restarting=false 表示已保存但未触发通道重启。 */
export interface ChannelToggleAck {
  restarting?: boolean;
  warning?: string;
}

export interface MessageOverviewPayload {
  reachable: boolean;
  status: null | {
    bridge: MessageBridgeView;
    counts: Record<string, number>;
    relay?: RelayControlView;
  };
  messages: {
    counts: Record<string, number>;
    items: MessageItemView[];
  };
  degraded: string[];
}

export interface TaskEventView {
  runId: string;
  sequence: number;
  sessionId: string;
  kind: string;
  summary?: string;
  etaSec?: number;
  occurredAt: string;
}

export interface MessageTaskView {
  runId: string;
  sessionId: string;
  state: string;
  lastEventSequence: number;
  updatedAt: string;
  events: TaskEventView[];
}

export interface DriftDiff {
  anchorIndex: number;
  anchorPreview: string;
  reason: string;
  context: string[];
}

export interface DriftReport {
  patchId: string;
  status:
    "ok" | "observed" | "drifted" | "not-applied" | "missing-target" | "missing-backup" | string;
  params?: Record<string, number>;
  diffs?: DriftDiff[];
  checkedAt?: string;
  targetPath?: string;
}

/** 补丁参数草稿：数字或 null（输入被清空时回退已生效值/默认值）。 */
export type PatchDrafts = Record<string, Record<string, number | null>>;
export type PatchAction = "apply" | "reapply" | "detect";
export type PendingPatchAction = {
  patch: GatewayPatch;
  action: Exclude<PatchAction, "detect">;
  params: Record<string, number>;
  busyKey: string;
  instanceId?: string;
  preview?: ConfigChangeSetView;
};

export interface ConfigChangeSetView {
  targetPath: string;
  changes: Array<{ path: string; before: number | string | boolean | null; after: number | string | boolean | null; impact?: string }>;
  redacted: boolean;
}

export const REFRESH_INTERVAL_MS = 10_000;

export const PARAM_LABELS: Record<string, string> = {
  minSendIntervalSec: "最小发送间隔",
  silentFirstDelaySec: "静默后首条延迟",
  attachmentBudgetPerMsg: "单次回复附件预算",
  splitThresholdChars: "超长文本阈值",
};

export const MESSAGE_STATE_LABELS: Record<string, string> = {
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

export const COVERAGE_LABELS: Record<string, string> = {
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
  "task:awaiting-terminal": "等待任务完成",
  "digest:batch-aggregated": "按聊天批次汇总",
  "digest:batch-duplicate-absorbed": "重复通知已合并",
  "digest:terminal-duplicate-absorbed": "重复终态结果已合并",
};
const TASK_EVENT_LABELS: Record<string, string> = {
  started: "已开始",
  progress: "进行中",
  completing: "准备结束",
  done: "已完成",
  failed: "已失败",
};

export function channelLabel(channel: string | null | undefined): string {
  if (channel === null || channel === undefined || channel === "") return "—";
  return CHANNEL_LABELS[channel.toLowerCase()] ?? channel;
}

export function messageKindLabel(value: string): string {
  return MESSAGE_KIND_LABELS[value] ?? value;
}

export function transportLabel(value: string): string {
  return TRANSPORT_LABELS[value.toLowerCase()] ?? value;
}

export function transformTraceLabel(step: string): string {
  if (TRACE_LABELS[step] !== undefined) return TRACE_LABELS[step];
  if (step.startsWith("dnd:")) return step.includes("held") ? "免打扰暂存" : "免打扰检查";
  return step;
}

export function taskEventLabel(kind: string): string {
  return TASK_EVENT_LABELS[kind] ?? kind;
}

export function sourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined || source === "") return "—";
  const labels: Record<string, string> = {
    watch: "管家检查",
    gateway: "消息通知",
    hermes: "Hermes",
  };
  return labels[source.toLowerCase()] ?? source;
}

/** 状态 → 语义徽标（tone + 文案），收编旧 badgeForStatus 的类名拼接。 */
export function statusTone(status: string): { tone: SemanticTone; label: string } {
  const normalized = status.toLowerCase();
  if (["ok", "healthy", "delivered", "applied", "done", "completed"].includes(normalized)) {
    return { tone: "ok", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
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
    return { tone: "error", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
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
    return { tone: "warn", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
  }
  if (normalized === "observed") {
    return { tone: "warn", label: "手工已生效" };
  }
  return { tone: "muted", label: MESSAGE_STATE_LABELS[status] ?? "其他" };
}

/** 接管开关状态 → 卡片标题与说明文案。 */
export function relayModeCopy(relay: RelayControlView): { title: string; detail: string } {
  if (relay.enabled) {
    return relay.pending
      ? { title: "消息接管中（待生效）", detail: "正在切回消息接管，生效后面板会自动更新。" }
      : { title: "消息接管中", detail: "出站消息经过合并、免打扰与频率控制后再发送。" };
  }
  return relay.pending
    ? { title: "原通道直发中（待生效）", detail: "正在切到原通道，生效后面板会自动更新。" }
    : { title: "原通道直发中", detail: "消息由本机 AI 直接发送，不再经过合并与限速；记录仍然保留。" };
}

/** 通道登录态 → 面板文案。 */
export function loginStateCopy(state: ChannelDirectoryEntryView["loginState"]): string {
  switch (state) {
    case "logged_in": return "已登录";
    case "logged_out": return "未登录";
    case "configuring": return "待配置";
    default: return "未知";
  }
}

/** 通道接入类型 → 面板文案。 */
export function channelKindLabel(kind: ChannelDirectoryEntryView["kind"]): string {
  switch (kind) {
    case "qr-login": return "扫码登录";
    case "credential": return "凭据接入";
    default: return "内置";
  }
}

export function formatTimestamp(ts: string | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "—";
  const value = new Date(ts);
  if (Number.isNaN(value.getTime())) return ts;
  return value.toLocaleString("zh-CN", { hour12: false });
}

export function shortId(value: string | null | undefined, length = 12): string {
  if (value === undefined || value === null || value === "") return "—";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function effectivePatchParams(patch: GatewayPatch): Record<string, number> | undefined {
  return patch.applied?.params ?? patch.observed?.params;
}

export function responseError(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const body = data as Record<string, unknown>;
  const detail = body["detail"];
  if (typeof detail === "string" && detail !== "") return detail;
  const error = body["error"];
  return typeof error === "string" ? error : "";
}

/** postJson 的 data 为 unknown：收敛为通道启停应答形状，不是对象时返回 null。 */
export function channelToggleAck(data: unknown): ChannelToggleAck | null {
  if (data === null || typeof data !== "object") return null;
  return data as ChannelToggleAck;
}

/**
 * 通道启停/配置启用成功后的警示文案：
 * - Bridge 返回 warning（如停用被环境变量强制启用的通道）→ 原样展示；
 * - restarting === false → 已保存但未触发重启，需要手动重启本机 AI。
 * 返回需要 message.warning 逐条展示的文案列表（可能为空）。
 */
export function channelToggleWarnings(ack: ChannelToggleAck | null): string[] {
  if (ack === null) return [];
  const notices: string[] = [];
  if (typeof ack.warning === "string" && ack.warning.trim() !== "") notices.push(ack.warning);
  if (ack.restarting === false) {
    notices.push("已保存，但未触发通道重启，需要手动重启本机 AI 后生效");
  }
  return notices;
}

/**
 * 通道启停、接管切换、重新连接等简单动作的失败文案：
 * 优先取响应体 error/detail（responseError，如 web 代理 502 {error}），
 * 取不到（如 Bridge 503 {code:E302/E303} 只带 code）按状态码给通用文案；status=0 表示请求未送达。
 */
export function channelActionError(status: number, data: unknown): string {
  const detail = responseError(data);
  if (detail !== "") return detail;
  if (status === 0) return "请求未送达，请确认管家服务正在运行";
  return `操作失败（HTTP ${status}），请稍后重试`;
}

export function seedDrafts(current: PatchDrafts, patches: GatewayPatch[]): PatchDrafts {
  const next: PatchDrafts = { ...current };
  for (const patch of patches) {
    const existing = next[patch.id] ?? {};
    const draft = { ...existing };
    const effective = effectivePatchParams(patch);
    for (const [name, schema] of Object.entries(patch.params)) {
      if (draft[name] !== undefined) continue;
      draft[name] = effective?.[name] ?? schema.default;
    }
    next[patch.id] = draft;
  }
  return next;
}

export function schemaHint(schema: PatchParamSchema): string {
  const parts: string[] = [];
  if (schema.min !== undefined) parts.push(`最小 ${schema.min}`);
  if (schema.max !== undefined) parts.push(`最大 ${schema.max}`);
  if (schema.integer === true) parts.push("整数");
  return parts.join(" · ") || `默认 ${schema.default}`;
}

export function patchActionError(status: number, data: unknown): string {
  const detail = responseError(data);
  if (status === 400) return detail || "参数不对，请检查后重试";
  if (status === 404) return "这个调整没有登记过";
  if (status === 409) return detail || "这个调整和现有文件冲突";
  if (status === 502) return "管家服务暂时连不上";
  if (status === 503) return "暂时没有可操作的管家";
  if (status === 0) return "请求未送达";
  return detail || "操作失败，请稍后重试";
}

/** 实例维度锁键的实例段：留空表示自动选择。 */
export function instanceKeyOf(selectedInstance: string): string {
  const trimmed = selectedInstance.trim();
  return trimmed === "" ? "*" : trimmed;
}

/** per-patch（含实例维度）busy 锁键。 */
export function patchBusyKey(action: PatchAction, patchId: string, instKey: string): string {
  return `${action}:${instKey}:${patchId}`;
}
