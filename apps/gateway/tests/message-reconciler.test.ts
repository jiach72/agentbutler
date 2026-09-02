import { fail, ok } from "@butler/contract";
import type {
  BridgeHealth,
  DeliveryAck,
  InstanceRef,
  MessageDecision,
  MessagingAdapter,
  OutboxChangeBatch,
  OutboxMessageView,
  PolicySnapshot,
  PrewarmAck,
  Result,
} from "@butler/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MESSAGE_POLICY } from "../src/message/config";
import { buildMessageDecision } from "../src/message/policy";
import { MessageReconciler } from "../src/message/reconciler";
import { MessageGatewayService } from "../src/message/service";
import { MessagePolicyStore } from "../src/message/store";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const NOW = "2026-08-22T10:00:00.000Z";
const INSTANCE: InstanceRef = { instanceId: "hermes-main" };

function message(overrides: Partial<OutboxMessageView> = {}): OutboxMessageView {
  return {
    messageId: "m1",
    instanceId: "hermes-main",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "chat-1",
    sessionId: "session-1",
    runId: "run-1",
    messageKind: "final",
    transport: "queued-push",
    priority: "normal",
    content: "done",
    contentSha256: "content-sha-1",
    metadata: {},
    capturedAt: NOW,
    sequence: 1,
    state: "captured",
    availableAt: null,
    attemptCount: 0,
    providerMessageId: null,
    deliveredAt: null,
    lastError: null,
    transformTrace: [],
    ...overrides,
  };
}

function batch(items: OutboxMessageView[] = [message()]): OutboxChangeBatch {
  return { afterSequence: 0, nextSequence: items.length, items, taskEvents: [], inbound: [] };
}

class FakeMessagingAdapter implements MessagingAdapter {
  readonly calls: string[] = [];
  readonly decisions: MessageDecision[] = [];
  readonly deliveries: Array<{
    messageId: string;
    attemptId: string;
    expectedContentSha256: string;
  }> = [];
  readonly prewarms: string[] = [];
  readonly policies: PolicySnapshot[] = [];
  changes: OutboxChangeBatch = batch();
  decisionRows = new Map<string, OutboxMessageView>();
  decisionFailure: Error | undefined;
  deliveryResult: Result<DeliveryAck> = ok({
    messageId: "m1",
    attemptId: "attempt-1",
    accepted: true,
    deduped: false,
    state: "delivered",
    providerMessageId: "provider-1",
    finishedAt: NOW,
  });
  prewarmResult: Result<PrewarmAck> = ok({
    channel: "weixin",
    warmed: true,
    checkedAt: NOW,
    expiresAt: "2026-08-22T10:05:00.000Z",
  });
  private nextDecisionResult: Result<OutboxMessageView> | undefined;

  attachOutbound = async () =>
    ok({
      instanceId: INSTANCE.instanceId,
      attachedAt: NOW,
      channels: ["weixin"],
      bridgeVersion: "test",
    });
  health = async (): Promise<Result<BridgeHealth>> =>
    ok({
      protocolVersion: 1,
      bridgeVersion: "test",
      instanceId: INSTANCE.instanceId,
      attached: true,
      outboxWritable: true,
      policyVersion: DEFAULT_MESSAGE_POLICY.version,
      channels: { weixin: "ok" },
    });
  updatePolicy = async (_instance: InstanceRef, snapshot: PolicySnapshot) => {
    this.policies.push(snapshot);
    return ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: NOW });
  };
  listChanges = async () => {
    this.calls.push("listChanges");
    return ok(this.changes);
  };
  decideOutbound = async (
    _instance: InstanceRef,
    decision: MessageDecision,
  ): Promise<Result<OutboxMessageView>> => {
    this.calls.push(`decide:${decision.messageId}:${decision.state}`);
    this.decisions.push(structuredClone(decision));
    if (this.decisionFailure !== undefined) throw this.decisionFailure;
    if (this.nextDecisionResult !== undefined) return this.nextDecisionResult;
    const source =
      this.decisionRows.get(decision.messageId) ??
      this.changes.items.find((item) => item.messageId === decision.messageId) ??
      message({ messageId: decision.messageId });
    const row: OutboxMessageView = {
      ...source,
      state: decision.state,
      availableAt: decision.availableAt ?? null,
      content: decision.optimizedContent ?? source.content,
      transformTrace: decision.transformTrace,
    };
    this.decisionRows.set(row.messageId, row);
    return ok(row);
  };
  deliver = async (
    _instance: InstanceRef,
    request: { messageId: string; attemptId: string; expectedContentSha256: string },
  ) => {
    this.calls.push(`deliver:${request.messageId}`);
    this.deliveries.push(request);
    return this.deliveryResult;
  };
  forwardInbound = async () => fail("E002", "not used");
  subscribeTaskEvents = () => () => undefined;
  prewarmChannel = async (_instance: InstanceRef, channel: string) => {
    this.calls.push(`prewarm:${channel}`);
    this.prewarms.push(channel);
    return this.prewarmResult;
  };

  returnDifferentDecisionState(row: OutboxMessageView): void {
    this.nextDecisionResult = ok(row);
  }

  returnDecisionResult(result: Result<OutboxMessageView>): void {
    this.nextDecisionResult = result;
  }
}

describe("MessageReconciler", () => {
  let tmp: string;
  let store: MessagePolicyStore;
  let adapter: FakeMessagingAdapter;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new MessagePolicyStore(gatewayDbFile(tmp));
    adapter = new FakeMessagingAdapter();
  });
  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  function reconciler(now = NOW): MessageReconciler {
    return new MessageReconciler({
      adapter,
      instance: INSTANCE,
      store,
      config: DEFAULT_MESSAGE_POLICY,
      clock: () => new Date(now),
      randomUUID: () => "attempt-1",
    });
  }

  it("commits the Bridge batch before a decision error and replays the exact staged payload", async () => {
    adapter.decisionFailure = new Error("lost response");
    await expect(reconciler().reconcileOnce()).rejects.toThrow(/decision failed/);
    expect(store.cursor(INSTANCE.instanceId)).toBe(1);
    const pending = store.pendingDecision("m1");
    expect(pending).toBeDefined();
    store.close();
    store = new MessagePolicyStore(gatewayDbFile(tmp));
    adapter.decisionFailure = undefined;
    await reconciler().reconcileOnce();
    expect(adapter.decisions).toHaveLength(2);
    expect(adapter.decisions[1]).toEqual(pending);
    expect(adapter.prewarms).toEqual(["weixin"]);
  });

  it("keeps a future held background progress untouched while absorbing the newly captured one", async () => {
    const holder = message({
      messageId: "holder",
      messageKind: "task-progress",
      state: "held_pacing",
      availableAt: "2026-08-22T10:02:00.000Z",
      sequence: 1,
    });
    const later = message({
      messageId: "later",
      messageKind: "task-progress",
      sequence: 2,
      capturedAt: "2026-08-22T10:00:30.000Z",
    });
    adapter.changes = batch([holder, later]);
    adapter.changes.nextSequence = 2;
    adapter.changes.taskEvents = [
      {
        runId: "run-1",
        sequence: 1,
        sessionId: "session-1",
        kind: "progress",
        summary: "still working",
        occurredAt: NOW,
      },
    ];
    await reconciler("2026-08-22T10:00:30.000Z").reconcileOnce();
    expect(adapter.decisions.map((decision) => [decision.messageId, decision.state])).toEqual([
      ["later", "absorbed"],
    ]);
    expect(store.messageView("holder")).toMatchObject({
      state: "held_pacing",
      availableAt: "2026-08-22T10:02:00.000Z",
    });
  });

  it("never treats a later progress record as a holder for an earlier final", async () => {
    adapter.changes = batch([
      message({ messageId: "final-first", sequence: 1, messageKind: "final" }),
      message({ messageId: "later-progress", sequence: 2, messageKind: "task-progress" }),
    ]);
    adapter.changes.nextSequence = 2;
    adapter.deliveryResult = ok({
      messageId: "final-first",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "final-provider",
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    expect(adapter.decisions.map((decision) => decision.messageId)).toEqual(["final-first"]);
  });

  it("waits for late terminal captures and delivers the newest complete result once", async () => {
    const short = message({
      messageId: "final-short",
      sequence: 1,
      content: "先给结论",
      inboundMessageId: "inbound-1",
    });
    const terminalEvents = [
      {
        runId: "run-1",
        sequence: 1,
        sessionId: "session-1",
        kind: "started" as const,
        occurredAt: NOW,
      },
      {
        runId: "run-1",
        sequence: 2,
        sessionId: "session-1",
        kind: "completing" as const,
        occurredAt: "2026-08-22T10:00:01.000Z",
      },
      {
        runId: "run-1",
        sequence: 3,
        sessionId: "session-1",
        kind: "done" as const,
        occurredAt: "2026-08-22T10:00:01.100Z",
      },
    ];
    adapter.changes = {
      afterSequence: 0,
      nextSequence: 3,
      items: [short],
      taskEvents: terminalEvents,
      inbound: [],
    };
    await reconciler("2026-08-22T10:00:01.200Z").reconcileOnce();
    expect(adapter.deliveries).toHaveLength(0);
    expect(store.messageView("final-short")?.state).toBe("held_pacing");

    const complete = message({
      messageId: "final-complete",
      sequence: 2,
      content: "结论：完整 RWA 监管报告",
      contentSha256: "complete-sha",
      capturedAt: "2026-08-22T10:00:01.250Z",
      inboundMessageId: "inbound-1",
    });
    adapter.changes = {
      afterSequence: 3,
      nextSequence: 4,
      items: [complete],
      taskEvents: [],
      inbound: [],
    };
    await reconciler("2026-08-22T10:00:01.300Z").reconcileOnce();
    expect(store.messageView("final-complete")?.state).toBe("held_pacing");

    adapter.changes = { afterSequence: 4, nextSequence: 4, items: [], taskEvents: [], inbound: [] };
    adapter.deliveryResult = ok({
      messageId: "final-complete",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "complete-provider",
      finishedAt: NOW,
    });
    await reconciler("2026-08-22T10:00:01.700Z").reconcileOnce();
    await reconciler("2026-08-22T10:00:01.700Z").reconcileOnce();
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual(["final-complete"]);
    expect(store.messageView("final-short")?.state).toBe("absorbed");
  });

  it("recomputes an expired held decision so it cannot block a later final result", async () => {
    const held = message({
      messageId: "held-old",
      sequence: 1,
      content: "中间结果",
      contentSha256: "held-sha",
      state: "held_pacing",
      availableAt: "2026-08-22T09:59:00.000Z",
      inboundMessageId: "inbound-1",
    });
    const later = message({
      messageId: "final-latest",
      sequence: 2,
      content: "完整结果",
      contentSha256: "latest-sha",
      capturedAt: "2026-08-22T10:00:01.000Z",
      inboundMessageId: "inbound-1",
    });
    adapter.changes = {
      afterSequence: 0,
      nextSequence: 2,
      items: [held, later],
      taskEvents: [],
      inbound: [],
    };
    store.ingestBatch(adapter.changes, INSTANCE.instanceId);
    store.stageDecision(
      "held-old",
      buildMessageDecision(
        held,
        DEFAULT_MESSAGE_POLICY.version,
        "held_pacing",
        ["task:awaiting-terminal"],
        "waiting for task terminal state",
        undefined,
        "2026-08-22T09:59:00.000Z",
      ),
    );
    adapter.decisionRows.set("held-old", held);
    adapter.decisionRows.set("final-latest", later);
    adapter.changes = { afterSequence: 2, nextSequence: 2, items: [], taskEvents: [], inbound: [] };

    await reconciler().reconcileOnce();
    expect(store.messageView("held-old")?.state).toBe("absorbed");
    expect(adapter.deliveries).toHaveLength(0);

    adapter.deliveryResult = ok({
      messageId: "final-latest",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "latest-provider",
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual(["final-latest"]);
  });

  it("heals a stale pending decision when Bridge reports the message already absorbed", async () => {
    const held = message({
      messageId: "held-stale",
      sequence: 1,
      state: "held_pacing",
      availableAt: "2026-08-22T09:59:00.000Z",
    });
    const later = message({
      messageId: "final-after-stale",
      sequence: 2,
      content: "最终结果",
      contentSha256: "final-after-stale-sha",
    });
    adapter.changes = {
      afterSequence: 0,
      nextSequence: 2,
      items: [held, later],
      taskEvents: [],
      inbound: [],
    };
    store.ingestBatch(adapter.changes, INSTANCE.instanceId);
    store.stageDecision(
      "held-stale",
      buildMessageDecision(
        held,
        DEFAULT_MESSAGE_POLICY.version,
        "held_pacing",
        ["task:awaiting-terminal"],
        "waiting for task terminal state",
        undefined,
        "2026-08-22T09:59:00.000Z",
      ),
    );
    adapter.returnDecisionResult(
      fail("E002", "Hermes Bridge 409 conflict: message is already terminal: absorbed"),
    );
    adapter.changes = { afterSequence: 2, nextSequence: 2, items: [], taskEvents: [], inbound: [] };

    await reconciler().reconcileOnce();

    expect(store.messageView("held-stale")).toMatchObject({
      state: "absorbed",
      availableAt: null,
      lastError: "Bridge already terminal: absorbed",
    });
    expect(store.pendingDecision("held-stale")).toBeUndefined();
    expect(adapter.deliveries).toHaveLength(0);

    adapter.returnDecisionResult(ok({ ...later, state: "ready" }));
    adapter.deliveryResult = ok({
      messageId: "final-after-stale",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "final-after-stale-provider",
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual(["final-after-stale"]);
  });

  it("reconciles a content hash conflict from a Hermes edit instead of blocking the queue head", async () => {
    const stale = message({
      messageId: "staged-stale",
      sequence: 1,
      content: "旧内容",
      contentSha256: "old-content-sha",
    });
    adapter.changes = {
      afterSequence: 0,
      nextSequence: 1,
      items: [stale],
      taskEvents: [],
      inbound: [],
    };
    store.ingestBatch(adapter.changes, INSTANCE.instanceId);
    store.stageDecision(
      "staged-stale",
      buildMessageDecision(stale, DEFAULT_MESSAGE_POLICY.version, "ready", ["policy:ready"], "ready"),
    );

    // Hermes 侧 managed_edit 改写内容/hash（update_pending_content 会分配新 sequence），
    // 本轮 batch 带回 Bridge 权威行。
    const edited = message({
      messageId: "staged-stale",
      sequence: 5,
      content: "编辑后的新内容",
      contentSha256: "new-content-sha",
      state: "captured",
    });
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 5,
      items: [edited],
      taskEvents: [],
      inbound: [],
    };
    const rawDecide = adapter.decideOutbound.bind(adapter);
    let decideCalls = 0;
    adapter.decideOutbound = async (instance, decision) => {
      decideCalls += 1;
      if (decideCalls === 1) {
        throw new Error("Hermes Bridge 409 conflict: content hash conflict");
      }
      return rawDecide(instance, decision);
    };
    adapter.deliveryResult = ok({
      messageId: "staged-stale",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "stale-provider",
      finishedAt: NOW,
    });

    await expect(reconciler().reconcileOnce()).resolves.toBeUndefined();

    expect(store.pendingDecision("staged-stale")).toBeUndefined();
    expect(store.messageView("staged-stale")).toMatchObject({
      contentSha256: "new-content-sha",
    });
    const redecided = adapter.decisions.filter((decision) => decision.messageId === "staged-stale");
    expect(redecided.at(-1)?.expectedContentSha256).toBe("new-content-sha");
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual(["staged-stale"]);

    // 队头 healed 后不再阻塞：后一条消息在下一轮照常处理（时钟前移越过 weixin
    // nativeMinIntervalSec 的通道节流）。
    adapter.changes = {
      afterSequence: 5,
      nextSequence: 6,
      items: [message({ messageId: "behind", sequence: 6 })],
      taskEvents: [],
      inbound: [],
    };
    adapter.deliveryResult = ok({
      messageId: "behind",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "behind-provider",
      finishedAt: NOW,
    });
    await reconciler("2026-08-22T10:01:00.000Z").reconcileOnce();
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual([
      "staged-stale",
      "behind",
    ]);
  });

  it("clears a conflicting pending decision and skips the cycle when the Bridge row is absent", async () => {
    adapter.changes = {
      afterSequence: 0,
      nextSequence: 1,
      items: [message()],
      taskEvents: [],
      inbound: [],
    };
    store.ingestBatch(adapter.changes, INSTANCE.instanceId);
    store.stageDecision(
      "m1",
      buildMessageDecision(message(), DEFAULT_MESSAGE_POLICY.version, "ready", ["policy:ready"], "ready"),
    );
    // 本轮 batch 未带回该行（items 为空）：清 pending 并跳过本轮。
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 1,
      items: [],
      taskEvents: [],
      inbound: [],
    };
    const rawDecide = adapter.decideOutbound.bind(adapter);
    adapter.decideOutbound = async () =>
      Promise.reject(new Error("Hermes Bridge 409 conflict: content hash conflict"));

    await expect(reconciler().reconcileOnce()).resolves.toBeUndefined();
    expect(store.pendingDecision("m1")).toBeUndefined();
    expect(adapter.deliveries).toHaveLength(0);

    // 下一轮 listChanges 带回权威行后照常决策并投递。
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 2,
      items: [message({ messageId: "m1", sequence: 2 })],
      taskEvents: [],
      inbound: [],
    };
    adapter.decideOutbound = rawDecide;
    await reconciler().reconcileOnce();
    expect(adapter.deliveries.map((delivery) => delivery.messageId)).toEqual(["m1"]);
  });

  it("only processes candidates owned by its configured Hermes instance", async () => {
    const other = message({ messageId: "other", instanceId: "a-hermes", sequence: 1 });
    store.ingestBatch(
      { afterSequence: 0, nextSequence: 1, items: [other], taskEvents: [], inbound: [] },
      "a-hermes",
    );
    adapter.changes = batch([message({ messageId: "owned", sequence: 1 })]);
    adapter.deliveryResult = ok({
      messageId: "owned",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "owned-provider",
      finishedAt: NOW,
    });

    await reconciler().reconcileOnce();

    expect(adapter.decisions.map((decision) => decision.messageId)).toEqual(["owned"]);
    expect(store.messageView("other")?.state).toBe("captured");
  });

  it("does not aggregate Bridge-null run ids or crash while scheduling them", async () => {
    const holder = message({
      messageId: "null-holder",
      messageKind: "task-progress",
      runId: null as never,
      state: "held_pacing",
      availableAt: "2026-08-22T10:02:00.000Z",
      sequence: 1,
    });
    const incoming = message({
      messageId: "null-incoming",
      messageKind: "task-progress",
      runId: null as never,
      sequence: 2,
    });
    adapter.changes = batch([holder, incoming]);
    adapter.changes.nextSequence = 2;

    await reconciler().reconcileOnce();

    expect(adapter.decisions.map((decision) => decision.messageId)).toEqual(["null-incoming"]);
    expect(adapter.decisions[0]?.transformTrace).toContain("policy:queued-push");
  });

  it("caches prewarm successes, holds normal prewarm failures, and lets urgent failures continue", async () => {
    await reconciler().reconcileOnce();
    expect(adapter.prewarms).toEqual(["weixin"]);
    expect(adapter.calls).toEqual(
      expect.arrayContaining(["decide:m1:ready", "prewarm:weixin", "deliver:m1"]),
    );
    expect(adapter.calls.indexOf("decide:m1:ready")).toBeLessThan(
      adapter.calls.indexOf("prewarm:weixin"),
    );
    adapter.changes = { afterSequence: 1, nextSequence: 1, items: [], taskEvents: [], inbound: [] };
    await reconciler().reconcileOnce();
    expect(adapter.prewarms).toEqual(["weixin"]);

    store.savePrewarm({
      channel: "weixin",
      warmed: true,
      checkedAt: "2026-08-22T09:00:00.000Z",
      expiresAt: "2026-08-22T09:01:00.000Z",
      detail: null,
    });
    const normal = message({ messageId: "normal-unwarmed", sequence: 2, channel: "a2a" });
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 2,
      items: [normal],
      taskEvents: [],
      inbound: [],
    };
    adapter.prewarmResult = ok({
      channel: "a2a",
      warmed: false,
      checkedAt: NOW,
      expiresAt: "2026-08-22T10:05:00.000Z",
    });
    await reconciler().reconcileOnce();
    expect(adapter.decisions.at(-1)).toMatchObject({
      messageId: "normal-unwarmed",
      state: "held_pacing",
      availableAt: "2026-08-22T10:00:15.000Z",
      transformTrace: expect.arrayContaining(["prewarm:unwarmed"]),
    });

    const failed = message({ messageId: "normal-failed", sequence: 3, channel: "api-server" });
    adapter.changes = {
      afterSequence: 2,
      nextSequence: 3,
      items: [failed],
      taskEvents: [],
      inbound: [],
    };
    adapter.prewarmResult = fail("E302", "down");
    await reconciler().reconcileOnce();
    expect(adapter.decisions.at(-1)).toMatchObject({
      messageId: "normal-failed",
      state: "held_pacing",
      availableAt: "2026-08-22T10:00:15.000Z",
      transformTrace: expect.arrayContaining(["prewarm:failed"]),
    });

    const urgent = message({
      messageId: "urgent",
      sequence: 4,
      priority: "urgent",
      channel: "a2a",
    });
    adapter.changes = {
      afterSequence: 3,
      nextSequence: 4,
      items: [urgent],
      taskEvents: [],
      inbound: [],
    };
    adapter.deliveryResult = ok({
      messageId: "urgent",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "urgent-provider",
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    expect(adapter.deliveries.at(-1)?.messageId).toBe("urgent");
  });

  it("updates both lanes on delivered and schedules retry congestion after the native pacing interval", async () => {
    await reconciler().reconcileOnce();
    expect(store.getPacingLane("channel:weixin")?.lastSentAt).toBe(NOW);
    expect(store.getPacingLane("chat:weixin:chat-1")?.lastSentAt).toBe(NOW);

    const retry = message({ messageId: "retry", sequence: 2 });
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 2,
      items: [retry],
      taskEvents: [],
      inbound: [],
    };
    adapter.deliveryResult = ok({
      messageId: "retry",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "retry_wait",
      providerMessageId: null,
      finishedAt: NOW,
      error: "429 Retry-After: 60",
    });
    await reconciler("2026-08-22T10:00:30.000Z").reconcileOnce();
    expect(store.messageView("retry")).toMatchObject({
      state: "held_pacing",
      availableAt: "2026-08-22T10:00:45.000Z",
      attemptCount: 0,
    });
    await reconciler("2026-08-22T10:00:45.000Z").reconcileOnce();
    expect(store.messageView("retry")).toMatchObject({
      state: "retry_wait",
      availableAt: "2026-08-22T10:01:00.000Z",
      attemptCount: 1,
    });
    expect(store.getPacingLane("channel:weixin")?.ratePerMin).toBe(1);
  });

  it("cancels a queued message at the configured attempt limit instead of sending again", async () => {
    const exhausted = message({
      messageId: "exhausted",
      state: "retry_wait",
      availableAt: NOW,
      attemptCount: DEFAULT_MESSAGE_POLICY.delivery.maxAttempts,
    });
    adapter.changes = batch([exhausted]);

    await reconciler().reconcileOnce();

    expect(adapter.decisions).toHaveLength(1);
    expect(adapter.decisions[0]).toMatchObject({
      messageId: "exhausted",
      state: "cancelled",
      reason: "delivery attempt limit reached",
    });
    expect(adapter.deliveries).toHaveLength(0);
    expect(adapter.prewarms).toHaveLength(0);
  });

  it("does not retry delivery_unknown and replays ready after transport loss before a later delivery", async () => {
    adapter.deliveryResult = ok({
      messageId: "m1",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivery_unknown",
      providerMessageId: null,
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    await reconciler().reconcileOnce();
    expect(adapter.deliveries).toHaveLength(1);

    const fresh = message({ messageId: "fresh", sequence: 2 });
    adapter.changes = {
      afterSequence: 1,
      nextSequence: 2,
      items: [fresh],
      taskEvents: [],
      inbound: [],
    };
    adapter.deliveryResult = fail("E302", "transport lost");
    await expect(reconciler().reconcileOnce()).rejects.toThrow(/delivery failed: transport lost/);
    expect(store.pendingDecision("fresh")?.state).toBe("ready");
    adapter.deliveryResult = ok({
      messageId: "fresh",
      attemptId: "attempt-1",
      accepted: true,
      deduped: false,
      state: "delivered",
      providerMessageId: "p2",
      finishedAt: NOW,
    });
    await reconciler().reconcileOnce();
    expect(
      adapter.decisions.filter(
        (decision) => decision.messageId === "fresh" && decision.state === "ready",
      ),
    ).toHaveLength(2);
    expect(adapter.deliveries.filter((delivery) => delivery.messageId === "fresh")).toHaveLength(2);
  });

  it("handles only one main candidate per cycle", async () => {
    adapter.changes = batch([
      message({ messageId: "m1", sequence: 1 }),
      message({ messageId: "m2", sequence: 2 }),
    ]);
    adapter.changes.nextSequence = 2;
    await reconciler().reconcileOnce();
    expect(adapter.decisions.filter((decision) => decision.state !== "absorbed")).toHaveLength(1);
  });
});

describe("MessageGatewayService", () => {
  let tmp: string;
  let store: MessagePolicyStore;
  let adapter: FakeMessagingAdapter;
  beforeEach(() => {
    tmp = makeTempDir();
    store = new MessagePolicyStore(gatewayDbFile(tmp));
    adapter = new FakeMessagingAdapter();
  });
  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it("installs policy, runs immediately without overlap, exposes status, and stops idempotently", async () => {
    let scheduled: (() => void) | undefined;
    const clear = vi.fn();
    const service = new MessageGatewayService({
      adapter,
      instance: INSTANCE,
      store,
      config: DEFAULT_MESSAGE_POLICY,
      clock: () => new Date(NOW),
      scheduler: {
        setInterval: (fn) => {
          scheduled = fn;
          return 1;
        },
        clearInterval: clear,
      },
      randomUUID: () => "attempt-1",
    });
    const prune = vi.spyOn(store, "pruneMessageHistory");
    await service.start();
    expect(adapter.policies).toHaveLength(1);
    expect(adapter.decisions).toHaveLength(1);
    scheduled?.();
    scheduled?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const status = await service.status();
    expect(status).toMatchObject({
      running: true,
      inFlight: false,
      bridgeConnected: true,
      policyVersion: DEFAULT_MESSAGE_POLICY.version,
      counts: { delivered: 1 },
    });
    expect(prune).toHaveBeenCalledWith("2026-08-15T10:00:00.000Z");
    await service.stop();
    await service.stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("wakes reconciliation on demand and detaches its live config from caller mutations", async () => {
    let scheduled: (() => void) | undefined;
    const mutable = structuredClone(DEFAULT_MESSAGE_POLICY);
    const service = new MessageGatewayService({
      adapter,
      instance: INSTANCE,
      store,
      config: mutable,
      clock: () => new Date(NOW),
      scheduler: {
        setInterval: (fn) => {
          scheduled = fn;
          return 1;
        },
        clearInterval: () => undefined,
      },
      randomUUID: () => "attempt-1",
    });

    mutable.digest.windowSec = 999;
    await service.start();
    expect((adapter.policies.at(-1)?.payload.digest as { windowSec: number }).windowSec).toBe(
      DEFAULT_MESSAGE_POLICY.digest.windowSec,
    );

    const replacement = structuredClone(DEFAULT_MESSAGE_POLICY);
    replacement.digest.windowSec = 180;
    const installed = await service.updatePolicy(replacement);
    replacement.digest.windowSec = 999;
    (installed.payload.digest as { windowSec: number }).windowSec = 777;
    await service.stop();
    await service.start();
    expect((adapter.policies.at(-1)?.payload.digest as { windowSec: number }).windowSec).toBe(180);

    const callsBeforeWake = adapter.calls.filter((call) => call === "listChanges").length;
    service.wake();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.calls.filter((call) => call === "listChanges")).toHaveLength(
      callsBeforeWake + 1,
    );

    scheduled?.();
    await service.stop();
  });

  it("bounds shutdown without closing resources under an in-flight cycle", async () => {
    let releaseChanges: (() => void) | undefined;
    const changesGate = new Promise<void>((resolve) => {
      releaseChanges = resolve;
    });
    adapter.listChanges = async () => {
      adapter.calls.push("listChanges");
      await changesGate;
      return ok({ afterSequence: 0, nextSequence: 0, items: [], taskEvents: [], inbound: [] });
    };
    const clear = vi.fn();
    const service = new MessageGatewayService({
      adapter,
      instance: INSTANCE,
      store,
      config: DEFAULT_MESSAGE_POLICY,
      scheduler: { setInterval: () => 1, clearInterval: clear },
    });

    const starting = service.start();
    await vi.waitFor(() => expect(adapter.calls).toContain("listChanges"));
    await expect(service.stop(5)).rejects.toThrow(/within 5ms/);
    expect((await service.status()).running).toBe(false);

    releaseChanges?.();
    await starting;
    await service.stop(100);
    expect(clear).not.toHaveBeenCalled();
  });
});
