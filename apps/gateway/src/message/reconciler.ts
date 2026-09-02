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

const TASK_RESULT_STABILIZATION_MS = 500;

/** content hash 对账后不重新决策的行状态：终态/投递中/未知，交由既有流程收敛。 */
const NON_REDECIDABLE_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "absorbed",
  "dead_letter",
  "cancelled",
  "delivering",
  "delivery_unknown",
]);

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
    let batch;
    try {
      batch = unwrap(
        await this.options.adapter.listChanges(this.options.instance, cursor, 200),
        "list changes",
      );
    } catch (error) {
      throw workerError("list changes", error);
    }
    // Projection and cursor are durable before any side-effecting policy call.
    this.options.store.ingestBatch(batch, this.options.instance.instanceId);

    const candidate = this.options.store.listPolicyCandidates(
      now,
      this.options.instance.instanceId,
    )[0];
    if (candidate === undefined || candidate.state === "delivery_unknown") return;
    await this.processCandidate(candidate, now, batch.items);
  }

  private async processCandidate(
    candidate: OutboxMessageView,
    now: string,
    batchItems: readonly OutboxMessageView[],
  ): Promise<void> {
    const taskHold = this.taskCompletionHold(candidate, now);
    if (taskHold !== undefined) {
      // 新决策取代可能残留的旧 pending（例如上一轮 staged 的 ready），否则
      // stageDecision 的防冲突守卫会让整轮 reconcile 永久失败。
      this.options.store.clearPendingDecision(candidate.messageId);
      await this.applyDecision(taskHold);
      return;
    }
    if (candidate.attemptCount >= this.options.config.delivery.maxAttempts) {
      this.options.store.clearPendingDecision(candidate.messageId);
      await this.applyDecision(
        buildMessageDecision(
          candidate,
          this.options.config.version,
          "cancelled",
          [...candidate.transformTrace, "delivery:attempt-limit"],
          "delivery attempt limit reached",
        ),
      );
      return;
    }
    // ready 决策 + Bridge 行 + 决策所依据的消息行；source 必须与决策同行，避免把
    // 过期的 contentSha256 通过 appendTrace 写回新的 ready 决策。
    const ready = await this.resolveReadyDecision(candidate, now, batchItems);
    if (ready === undefined) return;
    let readyDecision = ready.decision;
    let readyRow = ready.row;

    // Bridge's ready state is durable before channel readiness is probed. A replayed ready
    // decision intentionally follows this same path so a restart cannot skip prewarm.
    const prewarm = await this.prewarm(ready.source, now);
    if (prewarm.hold !== undefined) {
      await this.applyDecision(prewarm.hold);
      return;
    }
    if (prewarm.trace.length > 0) {
      readyDecision = appendTrace(ready.source, readyDecision, prewarm.trace);
      const applied = await this.applyDecision(readyDecision);
      if (applied.mismatch || applied.row.state !== "ready") return;
      readyRow = applied.row;
    }

    // Preserve this exact ready request until delivery is acknowledged. Transport loss then
    // causes the next cycle to replay it before another delivery attempt.
    this.options.store.stageDecision(readyDecision.messageId, readyDecision);
    await this.deliverReady(readyRow, now, readyDecision.decisionId);
  }

  /**
   * Resolves the ready decision for the queue head from a pending replay or a fresh
   * decision. Returns undefined when the head must not proceed this cycle.
   */
  private async resolveReadyDecision(
    candidate: OutboxMessageView,
    now: string,
    batchItems: readonly OutboxMessageView[],
  ): Promise<
    | { decision: MessageDecision; row: OutboxMessageView; source: OutboxMessageView }
    | undefined
  > {
    const pending = this.options.store.pendingDecision(candidate.messageId);
    if (pending === undefined) {
      const fresh = await this.decideAndApply(candidate, now);
      return fresh === undefined ? undefined : { ...fresh, source: candidate };
    }
    let replay: { row: OutboxMessageView; mismatch: boolean };
    try {
      replay = await this.applyDecision(pending);
    } catch (error) {
      const terminalState = terminalStateFromConflict(error);
      if (terminalState !== undefined) {
        // Another Bridge-side writer may have finalized this message (for example,
        // Hermes absorbing an older terminal result when a newer canonical result arrives).
        // Treat the 409 as an idempotent observation and heal the local projection so the
        // stale queue head cannot block newer messages forever.
        const recoveredAt =
          terminalState === "delivered" ? candidate.deliveredAt ?? now : candidate.deliveredAt;
        this.options.store.updateRemoteView(
          {
            ...candidate,
            state: terminalState,
            availableAt: null,
            deliveredAt: recoveredAt,
            lastError: `Bridge already terminal: ${terminalState}`,
            transformTrace: [
              ...candidate.transformTrace,
              `replay:bridge-terminal-${terminalState}`,
            ],
          },
          pending.decisionId,
        );
        return undefined;
      }
      if (!isContentHashConflict(error)) throw error;
      // Hermes 编辑消息（managed_edit → update_pending_content）会改写内容/hash 但不清
      // decision_id，回放的 staged 决策带着过期 expectedContentSha256 被 Bridge 以
      // 409 "content hash conflict" 拒绝。对账：清掉本地 pending，用本轮 batch 里的
      // Bridge 权威行刷新投影后按正常流程重新决策；batch 里没有该行则跳过本轮
      // （下一轮 listChanges 会带回权威行）。
      this.options.store.clearPendingDecision(candidate.messageId);
      const authoritative = batchItems.find((item) => item.messageId === candidate.messageId);
      if (authoritative === undefined) return undefined;
      this.options.store.updateRemoteView(authoritative);
      if (NON_REDECIDABLE_STATES.has(authoritative.state)) return undefined;
      const fresh = await this.decideAndApply(authoritative, now);
      return fresh === undefined ? undefined : { ...fresh, source: authoritative };
    }
    if (replay.mismatch) return undefined;
    if (pending.state === "ready") {
      return { decision: pending, row: replay.row, source: candidate };
    }
    // A held decision is only valid until its release time. Once the
    // replay succeeds, discard that old hold and recompute policy so a
    // stale queue head cannot block later terminal results forever.
    this.options.store.clearPendingDecision(candidate.messageId);
    const fresh = await this.decideAndApply(replay.row, now);
    return fresh === undefined ? undefined : { ...fresh, source: replay.row };
  }

  /** Re-decides from the given row and applies the decision (with companions). */
  private async decideAndApply(
    message: OutboxMessageView,
    now: string,
  ): Promise<{ decision: MessageDecision; row: OutboxMessageView } | undefined> {
    const policy = this.decide(message, now);
    for (const companion of policy.companionDecisions) {
      const applied = await this.applyDecision(companion);
      if (applied.mismatch) return undefined;
    }
    const applied = await this.applyDecision(policy.decision);
    if (applied.mismatch || applied.row.state !== "ready") return undefined;
    return { decision: policy.decision, row: applied.row };
  }

  private decide(message: OutboxMessageView, now: string) {
    const channelPolicy = this.options.config.channels[message.channel];
    const channelLane = this.lane(
      `channel:${message.channel}`,
      message.channel,
      null,
      channelPolicy?.initialRatePerMin ?? 1,
    );
    const chatLane = this.lane(
      `chat:${message.channel}:${message.chatId}`,
      message.channel,
      message.chatId,
      channelPolicy?.initialRatePerMin ?? 1,
    );
    const result = decideOutboundPolicy({
      message,
      holder:
        message.messageKind === "final" || message.messageKind === "failure"
          ? this.options.store.latestActiveRunResult(message)
          : message.channel === "weixin" && (message.runId === undefined || message.runId === null)
            ? this.options.store.earliestActiveChatBatchHolder(
                message,
                this.options.config.digest.windowSec,
              )
            : this.options.store.earliestActiveProgressHolder(message),
      taskEvents:
        typeof message.runId === "string" && message.runId !== ""
          ? (this.options.store.taskView(message.runId)?.events ?? [])
          : [],
      dndRules: this.options.store.resolveDndRules(),
      channelLane,
      chatLane,
      now,
      config: this.options.config,
    });
    return result;
  }

  private taskCompletionHold(message: OutboxMessageView, now: string): MessageDecision | undefined {
    if (
      message.channel !== "weixin" ||
      message.metadata.taskReceipt === true ||
      (message.messageKind !== "final" && message.messageKind !== "failure") ||
      typeof message.runId !== "string" ||
      message.runId === ""
    ) {
      return undefined;
    }
    const task = this.options.store.taskView(message.runId);
    if (task === undefined) return undefined;
    if (task.state === "done" || task.state === "failed") {
      const terminalEvent = [...task.events]
        .reverse()
        .find((event) => event.kind === "done" || event.kind === "failed");
      const terminalAt = terminalEvent?.occurredAt ?? task.updatedAt;
      const terminalAtMs = Date.parse(terminalAt);
      const nowMs = Date.parse(now);
      if (Number.isFinite(terminalAtMs) && Number.isFinite(nowMs)) {
        const availableAtMs = terminalAtMs + TASK_RESULT_STABILIZATION_MS;
        if (availableAtMs > nowMs) {
          return buildMessageDecision(
            message,
            this.options.config.version,
            "held_pacing",
            [...message.transformTrace, "task:awaiting-result-stability"],
            "waiting for late terminal results",
            undefined,
            new Date(availableAtMs).toISOString(),
          );
        }
      }
      return undefined;
    }
    const availableAt = new Date(Date.parse(now) + 1_000).toISOString();
    return buildMessageDecision(
      message,
      this.options.config.version,
      "held_pacing",
      [...message.transformTrace, "task:awaiting-terminal"],
      "waiting for task terminal state",
      undefined,
      availableAt,
    );
  }

  private async prewarm(
    message: OutboxMessageView,
    now: string,
  ): Promise<{ trace: string[]; hold?: MessageDecision }> {
    const cached = this.options.store.getPrewarm(message.channel);
    if (cached?.warmed && cached.expiresAt !== null && cached.expiresAt > now) return { trace: [] };
    let ack: PrewarmAck;
    try {
      ack = unwrap(
        await this.options.adapter.prewarmChannel(this.options.instance, message.channel),
        "prewarm",
      );
    } catch {
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

  private prewarmFailure(
    message: OutboxMessageView,
    now: string,
    trace: string,
  ): { trace: string[]; hold?: MessageDecision } {
    if (message.priority === "urgent" || message.messageKind === "failure")
      return { trace: [trace] };
    const retryAt = new Date(
      Date.parse(now) + this.options.config.delivery.retryBaseSec * 1_000,
    ).toISOString();
    return {
      trace: [trace],
      hold: buildMessageDecision(
        message,
        this.options.config.version,
        "held_pacing",
        ["policy:queued-push", trace],
        "channel prewarm unavailable",
        undefined,
        retryAt,
      ),
    };
  }

  private async applyDecision(
    decision: MessageDecision,
  ): Promise<{ row: OutboxMessageView; mismatch: boolean }> {
    this.options.store.stageDecision(decision.messageId, decision);
    let row: OutboxMessageView;
    try {
      row = unwrap(
        await this.options.adapter.decideOutbound(this.options.instance, decision),
        "decision",
      );
    } catch (error) {
      throw workerError("decision", error);
    }
    this.options.store.updateRemoteView(row, decision.decisionId);
    return { row, mismatch: row.state !== decision.state };
  }

  private async deliverReady(
    row: OutboxMessageView,
    now: string,
    readyDecisionId: string,
  ): Promise<void> {
    const request = {
      messageId: row.messageId,
      attemptId: this.randomUUID(),
      expectedContentSha256: row.contentSha256,
    };
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
    const availableAt =
      ack.state === "retry_wait" ? retryAt(now, attemptCount, this.options.config) : null;
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

  private lane(
    laneKey: string,
    channel: string,
    chatId: string | null,
    initialRatePerMin: number,
  ): PacingLane {
    const existing = this.options.store.getPacingLane(laneKey);
    if (existing !== undefined) return existing;
    return this.options.store.savePacingLane({
      laneKey,
      channel,
      chatId,
      ratePerMin: initialRatePerMin,
      successCount: 0,
      cooldownUntil: null,
      lastSentAt: null,
      lastCongestionReason: null,
    });
  }

  private recordSuccess(message: OutboxMessageView, now: string): void {
    const policy = this.options.config.channels[message.channel];
    if (policy === undefined) return;
    const channel = this.lane(
      `channel:${message.channel}`,
      message.channel,
      null,
      policy.initialRatePerMin,
    );
    const chat = this.lane(
      `chat:${message.channel}:${message.chatId}`,
      message.channel,
      message.chatId,
      policy.initialRatePerMin,
    );
    this.options.store.savePacingLane(recordPacingSuccess(channel, policy, now));
    this.options.store.savePacingLane(recordPacingSuccess(chat, policy, now));
  }

  private recordCongestion(message: OutboxMessageView, error: string, now: string): void {
    const policy = this.options.config.channels[message.channel];
    if (policy === undefined) return;
    const retryAfterSec = retryAfter(error);
    for (const lane of [
      this.lane(`channel:${message.channel}`, message.channel, null, policy.initialRatePerMin),
      this.lane(
        `chat:${message.channel}:${message.chatId}`,
        message.channel,
        message.chatId,
        policy.initialRatePerMin,
      ),
    ]) {
      this.options.store.savePacingLane(
        recordPacingCongestion({ lane, policy, now, retryAfterSec, reason: error }),
      );
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function appendTrace(
  message: OutboxMessageView,
  decision: MessageDecision,
  trace: string[],
): MessageDecision {
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
  return error instanceof MessageWorkerError
    ? error
    : new MessageWorkerError(operation, error instanceof Error ? error.message : String(error));
}

function terminalStateFromConflict(error: unknown): OutboxMessageView["state"] | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  const match = /already terminal:\s*(delivered|absorbed|dead_letter|cancelled)\b/i.exec(detail);
  return match?.[1] as OutboxMessageView["state"] | undefined;
}

function isContentHashConflict(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /content hash conflict/i.test(detail);
}

function retryAt(now: string, attemptCount: number, config: MessagePolicyConfig): string {
  const seconds = Math.min(
    config.delivery.retryBaseSec * 2 ** Math.max(0, attemptCount - 1),
    config.delivery.retryMaxSec,
  );
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

function isCongestion(error: string): boolean {
  return /\b429\b|rate[- ]?limit|disconnect|circuit/i.test(error);
}

function retryAfter(error: string): number | undefined {
  const match = /retry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(error);
  return match === null ? undefined : Number(match[1]);
}
