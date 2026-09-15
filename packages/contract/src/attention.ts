export type AttentionSeverity = "blocking" | "action" | "watch";

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  title: string;
  impact: string;
  actionLabel: string;
  actionHref: string;
  evidenceCount?: number;
  lastSeenAt: string;
}

export interface UserHealthSummary {
  status: "healthy" | "degraded" | "action_required" | "blocked";
  headline: string;
  explanation: string;
  attention: AttentionItem[];
}

export type CapabilityHealth = "available" | "degraded" | "unavailable" | "unknown";

export interface HealthInstanceInput {
  instanceId: string;
  state: string;
  connected?: boolean | null;
}

export interface HealthAlertInput {
  id?: string | number;
  status?: string;
  severity?: string;
  title?: string;
  /** Notification delivery/read state is not an incident resolution state. */
  requiresAction?: boolean;
  resolutionStatus?: string;
  lastSeenAt?: string;
}

export interface UserHealthInput {
  /** Caller supplies observation time; derivation never reads the clock. */
  observedAt: string;
  instances: readonly HealthInstanceInput[] | null;
  alerts: readonly HealthAlertInput[] | null;
  /** Pending only, not expired/escalation history or the total approval count. */
  pendingApprovals: number | null;
  messages: {
    connected: boolean | null;
    failed: number | null;
    unknown: number | null;
  } | null;
  model: CapabilityHealth;
  memory: CapabilityHealth;
}

export function normalizeInstanceState(state: string): "online" | "offline" | "unknown" {
  const normalized = state.trim().toLowerCase();
  if (["serving", "running", "healthy", "active"].includes(normalized)) return "online";
  if (["stopped", "stopped.", "removed", "idle", "down", "offline", "failed"].includes(normalized)
    || normalized.includes("crash")) return "offline";
  return "unknown";
}

export function isInstanceOnline(instance: HealthInstanceInput): boolean {
  return normalizeInstanceState(instance.state) === "online" && instance.connected === true;
}

export function isActionableAlert(alert: HealthAlertInput): boolean {
  const state = alert.status?.toLowerCase();
  const resolution = alert.resolutionStatus?.toLowerCase();
  if (["resolved", "expired", "dismissed", "ignored"].includes(resolution ?? "")
    || ["resolved", "expired", "dismissed", "ignored"].includes(state ?? "")) return false;
  if (alert.requiresAction === false) return false;
  if (alert.requiresAction === true || ["open", "active", "regressed"].includes(resolution ?? "")) return true;
  // Pending/delivered/read describe notification transport, not user work.
  return ["open", "active", "regressed", "failed", "delivery_unknown"].includes(state ?? "");
}

function count(value: number | null): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Same facts yield the same conclusion on the homepage, wall and server. */
export function deriveUserHealthSummary(input: UserHealthInput): UserHealthSummary {
  const attention: AttentionItem[] = [];
  const add = (
    id: string, severity: AttentionSeverity, title: string, impact: string,
    actionLabel: string, actionHref: string, evidenceCount?: number,
  ) => attention.push({ id, severity, title, impact, actionLabel, actionHref, evidenceCount, lastSeenAt: input.observedAt });

  if (input.instances === null) {
    add("instances-unknown", "watch", "智能体连接尚未确认", "暂时无法确认服务是否可用。", "检查连接", "/setup");
  } else if (input.instances.length === 0) {
    add("instances-empty", "blocking", "尚未连接智能体", "还不能使用本机智能体服务。", "连接智能体", "/setup");
  } else {
    const offline = input.instances.filter((instance) =>
      instance.connected === false || normalizeInstanceState(instance.state) === "offline");
    const unknown = input.instances.filter((instance) => !isInstanceOnline(instance) && !offline.includes(instance));
    if (offline.length > 0) add(
      "instances-offline", offline.length === input.instances.length ? "blocking" : "action",
      `${offline.length} 个智能体不可用`, "相关智能体的对话和任务可能中断。",
      "检查连接", "/setup", offline.length,
    );
    if (unknown.length > 0) add("instances-unknown", "watch", "部分智能体状态待确认", "尚未获得完整的运行与连接证据。", "检查连接", "/setup", unknown.length);
  }

  for (const [key, label, impact, href] of [
    ["memory", "记忆", "记忆保存或回忆可能受影响。", "/skills?tab=memory"],
    ["model", "模型", "对话和任务生成可能受影响。", "/setup"],
  ] as const) {
    const state = input[key];
    if (state !== "available") add(
      key, state === "unavailable" ? "action" : "watch",
      `${label}${state === "unknown" ? "状态待确认" : state === "unavailable" ? "不可用" : "需要留意"}`,
      state === "unknown" ? `尚无足够证据确认${label}可用。` : impact,
      `检查${label}`, href,
    );
  }

  const messages = input.messages;
  if (messages === null || messages.connected === null) {
    add("messages-unavailable", "watch", "消息状态待确认", "暂时无法确认通知能否送达。", "检查消息", "/gateway");
  } else if (!messages.connected) {
    add("messages-offline", "action", "消息连接已中断", "通知可能暂时无法送达。", "检查消息", "/gateway");
  }
  if (messages !== null) {
    if (count(messages.failed) > 0) add("messages-failed", "action", `${count(messages.failed)} 条消息投递失败`, "相关通知尚未成功送达。", "处理投递失败", "/gateway", count(messages.failed));
    if (count(messages.unknown) > 0) add("messages-unknown", "action", `${count(messages.unknown)} 条消息结果未知`, "请先确认是否送达，避免重复发送。", "核对投递结果", "/gateway", count(messages.unknown));
    if (messages.failed === null || messages.unknown === null) add("message-results-unavailable", "watch", "消息结果尚未确认", "投递记录暂不可读，不能据此判断没有异常。", "检查消息", "/gateway");
  }
  if (input.pendingApprovals === null) add("approvals-unknown", "watch", "审批状态待确认", "暂时无法确认是否有操作等待你的决定。", "查看审批", "/approvals?filter=pending");
  else if (count(input.pendingApprovals) > 0) add("approvals", "action", `${count(input.pendingApprovals)} 项操作等待确认`, "需要你的决定才能完成审批。", "查看待审批", "/approvals?filter=pending", count(input.pendingApprovals));

  if (input.alerts === null) add("alerts-unknown", "watch", "提醒状态待确认", "暂时无法确认是否有新的待处理提醒。", "查看提醒", "/gateway");
  else {
    const actionable = input.alerts.filter(isActionableAlert);
    if (actionable.length > 0) add(
      "alerts", actionable.some((alert) => alert.severity === "critical") ? "blocking" : "action",
      `${actionable.length} 项提醒需要处理`, "仍有明确未解决的问题或投递失败需要核对。",
      "查看提醒", "/gateway", actionable.length,
    );
  }

  const order: Record<AttentionSeverity, number> = { blocking: 0, action: 1, watch: 2 };
  attention.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  const status = attention.some((item) => item.severity === "blocking") ? "blocked"
    : attention.some((item) => item.severity === "action") ? "action_required"
      : attention.length > 0 ? "degraded" : "healthy";
  return {
    status,
    headline: { healthy: "当前运行正常", degraded: "部分状态需要确认", action_required: "有事项需要你处理", blocked: "当前服务受阻" }[status],
    explanation: attention[0]?.impact ?? "连接、消息、模型与记忆均已确认可用，当前没有待处理事项。",
    attention,
  };
}

export interface WallAttentionSummary {
  health: UserHealthSummary;
  nextTasks: Array<{ id: string; name: string; nextRunAt: string; lastStatus: "success" | "failed" | "running" | "never" | "unknown" }>;
  messageHealth: { pending: number; failed: number; unknown: number; p95Ms: number | null };
}
