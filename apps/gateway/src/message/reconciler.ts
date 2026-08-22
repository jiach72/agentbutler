import { randomUUID as defaultRandomUUID } from "node:crypto";

import type {
  DeliveryAck,
  InstanceRef,
  MessageDecision,
  MessagingAdapter,
  OutboxMessageView,
  PrewarmAck,
  Result,
} from "@butler/contract";

import { buildMessageDecision, decideOutboundPolicy } from "./policy.js";
import { recordPacingCongestion, recordPacingSuccess } from "./pacing.js";
import type { PacingLane } from "./store.js";
import { MessagePolicyStore } from "./store.js";
import type { MessagePolicyConfig } from "./types.js";

export class MessageWorkerError extends Error {
  constructor(operation: string, detail: string) {
    super(`${operation} failed: ${detail}`);
    this.name = "MessageWorkerError";
  }
}

export interface MessageReconcilerOptions {
  adapter: MessagingAdapter;
  instance: InstanceRef;
  store: MessagePolicyStore;
  config: MessagePolicyConfig;
  clock?: () => Date;
  randomUUID?: () => string;
}

/** One-at-a-time durable reconciliation and delivery worker for the Bridge outbox. */
export class MessageReconciler {
  private readonly clock: () => Date;
  private readonly randomUUID: () => string;

  constructor(private readonly options: MessageReconcilerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? defaultRandomUUID;
  }

  async reconcileOnce(): Promise<void> {
    const now = this.now();
    const cursor = this.options.store.cursor(this.options.instance.instanceId);
    const batch = unwrap(await this.options.adapter.listChanges(this.options.instance, cursor, 200), "list changes");
    // Projection and cursor are durable before any side-effecting policy call.
    this.options.store.ingestBatch(batch, this.options.instance.instanceId);

    const candidate = this.options.store.listPolicyCandidates(now)[0];
    if (candidate === undefined || candidate.state === "delivery_unknown") return;
    await this.processCandidate(candidate, now);
  }

  private async processCandidate(candidate: OutboxMessageView, now: string): Promise<void> {
    const pending = this.options.store.pendingDecision(candidate.messageId);
    let readyDecision: MessageDecision;
    let readyRow: OutboxMessageView;
    if (pending !== undefined) {
      const replay = await this.applyDecision(pending);
      if (replay.mismatch || replay.row.state !== "ready") return;
      readyDecision = pending;
      readyRow = replay.row;
    } else {
      const policy = this.decide(candidate, now);
      for (const companion of policy.companionDecisions) {
        const applied = await this.applyDecision(companion);
        if (applied.mismatch) return;
      }
      const applied = await this.applyDecision(policy.decision);
      if (applied.mismatch || applied.row.state !== "ready") return;
      readyDecision = policy.decision;
      readyRow = applied.row;
    }

    // Bridge's ready state is durable before channel readiness is probed. A replayed ready
    // decision intentionally follows this same path so a restart cannot skip prewarm.
    const prewarm = await this.prewarm(candidate, now);
    if (prewarm.hold !== undefined) {
      await this.applyDecision(prewarm.hold);
      return;
    }
    if (prewarm.trace.length > 0) {
      readyDecision = appendTrace(candidate, readyDecision, prewarm.trace);
      const applied = await this.applyDecision(readyDecision);
      if (applied.mismatch || applied.row.state !== "ready") return;
      readyRow = applied.row;
    }

    // Preserve this exact ready request until delivery is acknowledged. Transport loss then
    // causes the next cycle to replay it before another delivery attempt.
    this.options.store.stageDecision(readyDecision.messageId, readyDecision);
    await this.deliverReady(readyRow, now, readyDecision.decisionId);
  }

  private decide(message: OutboxMessageView, now: string) {
    const channelPolicy = this.options.config.channels[message.channel];
    const channelLane = this.lane(`channel:${message.channel}`, message.channel, null, channelPolicy?.initialRatePerMin ?? 1);
    const chatLane = this.lane(`chat:${message.channel}:${message.chatId}`, message.channel, message.chatId, channelPolicy?.initialRatePerMin ?? 1);
    const result = decideOutboundPolicy({
      message,
      holder: this.options.store.earliestActiveProgressHolder(message),
      taskEvents: message.runId === undefined ? [] : (this.options.store.taskView(message.runId)?.events ?? []),
      dndRules: this.options.store.resolveDndRules(),
      channelLane,
      chatLane,
      now,
      config: this.options.config,
    });
    return result;
  }

  private async prewarm(message: OutboxMessageView, now: string): Promise<{ trace: string[]; hold?: MessageDecision }> {
    const cached = this.options.store.getPrewarm(message.channel);
    if (cached?.warmed && cached.expiresAt !== null && cached.expiresAt > now) return { trace: [] };
    let ack: PrewarmAck;
    try {
      ack = unwrap(await this.options.adapter.prewarmChannel(this.options.instance, message.channel), "prewarm");
    } catch (error) {
      return this.prewarmFailure(message, now, "prewarm:failed");
    }
    this.options.store.savePrewarm({
      channel: ack.channel,
      warmed: ack.warmed,
      checkedAt: ack.checkedAt,
      expiresAt: ack.expiresAt,
      detail: ack.detail ?? null,
    });
    if (ack.warmed) return { trace: [] };
    return this.prewarmFailure(message, now, "prewarm:unwarmed");
  }

  private prewarmFailure(message: OutboxMessageView, now: string, trace: string): { trace: string[]; hold?: MessageDecision } {
    if (message.priority === "urgent" || message.messageKind === "failure") return { trace: [trace] };
    const retryAt = new Date(Date.parse(now) + this.options.config.delivery.retryBaseSec * 1_000).toISOString();
    return {
      trace: [trace],
      hold: buildMessageDecision(message, this.options.config.version, "held_pacing", ["policy:queued-push", trace], "channel prewarm unavailable", undefined, retryAt),
    };
  }

  private async applyDecision(decision: MessageDecision): Promise<{ row: OutboxMessageView; mismatch: boolean }> {
    this.options.store.stageDecision(decision.messageId, decision);
    let row: OutboxMessageView;
    try {
      row = unwrap(await this.options.adapter.decideOutbound(this.options.instance, decision), "decision");
    } catch (error) {
      throw workerError("decision", error);
    }
    this.options.store.updateRemoteView(row, decision.decisionId);
    return { row, mismatch: row.state !== decision.state };
  }

  private async deliverReady(row: OutboxMessageView, now: string, readyDecisionId: string): Promise<void> {
    const request = { messageId: row.messageId, attemptId: this.randomUUID(), expectedContentSha256: row.contentSha256 };
    let ack: DeliveryAck;
    try {
      ack = unwrap(await this.options.adapter.deliver(this.options.instance, request), "delivery");
    } catch (error) {
      // The staged ready request remains durable. A subsequent cycle must replay it before another send.
      throw workerError("delivery", error);
    }
    if (ack.messageId !== row.messageId || ack.attemptId !== request.attemptId) {
      throw new MessageWorkerError("delivery", "Bridge acknowledgement does not match request");
    }
    const attemptCount = row.attemptCount + 1;
    const availableAt = ack.state === "retry_wait" ? retryAt(now, attemptCount, this.options.config) : null;
    const local: OutboxMessageView = {
      ...row,
      state: ack.state,
      availableAt,
      attemptCount,
      providerMessageId: ack.providerMessageId,
      deliveredAt: ack.state === "delivered" ? ack.finishedAt : row.deliveredAt,
      lastError: ack.error ?? null,
      transformTrace: [...row.transformTrace, `delivery:${ack.state}`],
    };
    this.options.store.updateRemoteView(local, readyDecisionId);
    if (ack.state === "delivered") {
      this.recordSuccess(row, ack.finishedAt);
    } else if (ack.state === "retry_wait" && ack.error !== undefined && isCongestion(ack.error)) {
      this.recordCongestion(row, ack.error, now);
    }
  }

  private lane(laneKey: string, channel: string, chatId: string | null, initialRatePerMin: number): PacingLane {
    const existing = this.options.store.getPacingLane(laneKey);
    if (existing !== undefined) return existing;
    return this.options.store.savePacingLane({ laneKey, channel, chatId, ratePerMin: initialRatePerMin, successCount: 0, cooldownUntil: null, lastSentAt: null, lastCongestionReason: null });
  }

  private recordSuccess(message: OutboxMessageView, now: string): void {
    const policy = this.options.config.channels[message.channel];
    if (policy === undefined) return;
    const channel = this.lane(`channel:${message.channel}`, message.channel, null, policy.initialRatePerMin);
    const chat = this.lane(`chat:${message.channel}:${message.chatId}`, message.channel, message.chatId, policy.initialRatePerMin);
    this.options.store.savePacingLane(recordPacingSuccess(channel, policy, now));
    this.options.store.savePacingLane(recordPacingSuccess(chat, policy, now));
  }

  private recordCongestion(message: OutboxMessageView, error: string, now: string): void {
    const policy = this.options.config.channels[message.channel];
    if (policy === undefined) return;
    const retryAfterSec = retryAfter(error);
    for (const lane of [
      this.lane(`channel:${message.channel}`, message.channel, null, policy.initialRatePerMin),
      this.lane(`chat:${message.channel}:${message.chatId}`, message.channel, message.chatId, policy.initialRatePerMin),
    ]) {
      this.options.store.savePacingLane(recordPacingCongestion({ lane, policy, now, retryAfterSec, reason: error }));
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function appendTrace(message: OutboxMessageView, decision: MessageDecision, trace: string[]): MessageDecision {
  return buildMessageDecision(
    message,
    decision.policyVersion,
    decision.state,
    [...decision.transformTrace, ...trace],
    decision.reason,
    decision.optimizedContent,
    decision.availableAt,
  );
}

function unwrap<T>(result: Result<T>, operation: string): T {
  if (result.ok && result.data !== undefined) return result.data;
  throw new MessageWorkerError(operation, result.error?.message ?? "invalid adapter result");
}

function workerError(operation: string, error: unknown): MessageWorkerError {
  return error instanceof MessageWorkerError ? error : new MessageWorkerError(operation, error instanceof Error ? error.message : String(error));
}

function retryAt(now: string, attemptCount: number, config: MessagePolicyConfig): string {
  const seconds = Math.min(config.delivery.retryBaseSec * 2 ** Math.max(0, attemptCount - 1), config.delivery.retryMaxSec);
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

function isCongestion(error: string): boolean {
  return /\b429\b|rate[- ]?limit|disconnect|circuit/i.test(error);
}

function retryAfter(error: string): number | undefined {
  const match = /retry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(error);
  return match === null ? undefined : Number(match[1]);
}
