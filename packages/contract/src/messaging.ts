import type { ChannelId, InstanceId, InstanceRef, Result } from "./common.js";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const TRANSPORT_CLASSES = ["queued-push", "inline-response"] as const;

export const MESSAGE_KINDS = [
  "final",
  "task-progress",
  "failure",
  "alert",
  "system",
  "mutation",
] as const;

export const OUTBOX_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "absorbed",
  "policy_error",
  "dead_letter",
  "cancelled",
] as const;

export const TASK_EVENT_KINDS = ["started", "progress", "completing", "done", "failed"] as const;

export type TransportClass = (typeof TRANSPORT_CLASSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];
export type MessagePriority = "urgent" | "normal" | "low";
export type Unsubscribe = () => void;

/** Bridge 捕获并持久化的标准出站信封。 */
export interface OutboundEnvelope {
  messageId: string;
  instanceId: InstanceId;
  adapterId: string;
  channel: ChannelId;
  accountId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  runId?: string;
  inboundMessageId?: string;
  messageKind: MessageKind;
  transport: TransportClass;
  priority: MessagePriority;
  content: string;
  contentSha256: string;
  replyTo?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
}

/** 入站消息与 Hermes 会话/任务关联所需的最小信封。 */
export interface InboundEnvelope {
  inboundMessageId: string;
  instanceId: InstanceId;
  adapterId: string;
  channel: ChannelId;
  chatId: string;
  threadId?: string;
  userId?: string;
  sessionId?: string;
  runId?: string;
  content: string;
  receivedAt: string;
}

/** runId 在每次 Hermes turn 内唯一；sequence 在同一 run 内严格递增。 */
export interface TaskEvent {
  runId: string;
  sequence: number;
  sessionId: string;
  kind: TaskEventKind;
  summary?: string;
  etaSec?: number;
  occurredAt: string;
}

export interface BridgeHealth {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  bridgeVersion: string;
  instanceId: InstanceId;
  attached: boolean;
  outboxWritable: boolean;
  policyVersion: string | null;
  channels: Record<ChannelId, "ok" | "degraded" | "unavailable">;
}

export interface AttachAck {
  instanceId: InstanceId;
  attachedAt: string;
  channels: ChannelId[];
  bridgeVersion: string;
}

/** Outbox 的只读 API 视图，不包含凭据和本地附件绝对路径。 */
export interface OutboxMessageView extends OutboundEnvelope {
  sequence: number;
  state: OutboxState;
  availableAt: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  transformTrace: string[];
}

export interface OutboxChangeBatch {
  afterSequence: number;
  nextSequence: number;
  items: OutboxMessageView[];
  taskEvents: TaskEvent[];
  inbound: InboundEnvelope[];
}

export type DecisionState = Extract<
  OutboxState,
  "held_dnd" | "held_pacing" | "ready" | "absorbed" | "policy_error" | "cancelled"
>;

export interface MessageDecision {
  messageId: string;
  expectedContentSha256: string;
  state: DecisionState;
  availableAt?: string;
  optimizedContent?: string;
  transformTrace: string[];
  policyVersion: string;
  reason: string;
}

export interface DeliveryRequest {
  messageId: string;
  attemptId: string;
  expectedContentSha256: string;
}

export type DeliveryTerminalState = Extract<
  OutboxState,
  "delivered" | "retry_wait" | "delivery_unknown" | "dead_letter"
>;

export interface DeliveryAck {
  messageId: string;
  attemptId: string;
  accepted: boolean;
  deduped: boolean;
  state: DeliveryTerminalState;
  providerMessageId: string | null;
  finishedAt: string;
  error?: string;
}

export interface InboundDecision {
  inboundMessageId: string;
  action: "forward" | "consume-command";
  optimizedText: string;
  transformTrace: string[];
}

export interface PrewarmAck {
  channel: ChannelId;
  warmed: boolean;
  checkedAt: string;
  expiresAt: string | null;
  detail?: string;
}

/** Hermes L3 数据面通过本机 Bridge HTTP 协议实现，而非跨进程函数回调。 */
export interface MessagingAdapter {
  attachOutbound(instance: InstanceRef): Promise<Result<AttachAck>>;
  health(instance: InstanceRef): Promise<Result<BridgeHealth>>;
  listChanges(
    instance: InstanceRef,
    afterSequence: number,
    limit?: number,
  ): Promise<Result<OutboxChangeBatch>>;
  decideOutbound(
    instance: InstanceRef,
    decision: MessageDecision,
  ): Promise<Result<OutboxMessageView>>;
  deliver(instance: InstanceRef, request: DeliveryRequest): Promise<Result<DeliveryAck>>;
  forwardInbound(
    instance: InstanceRef,
    decision: InboundDecision,
  ): Promise<Result<InboundDecision>>;
  subscribeTaskEvents(instance: InstanceRef, cb: (event: TaskEvent) => void): Unsubscribe;
  prewarmChannel(instance: InstanceRef, channel: ChannelId): Promise<Result<PrewarmAck>>;
}

export function isOutboxState(value: unknown): value is OutboxState {
  return typeof value === "string" && (OUTBOX_STATES as readonly string[]).includes(value);
}
