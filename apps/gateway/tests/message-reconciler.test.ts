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
  readonly deliveries: Array<{ messageId: string; attemptId: string; expectedContentSha256: string }> = [];
  readonly prewarms: string[] = [];
  readonly policies: PolicySnapshot[] = [];
  changes: OutboxChangeBatch = batch();
  decisionRows = new Map<string, OutboxMessageView>();
  decisionFailure: Error | undefined;
  deliveryResult: Result<DeliveryAck> = ok({
    messageId: "m1", attemptId: "attempt-1", accepted: true, deduped: false, state: "delivered", providerMessageId: "provider-1", finishedAt: NOW,
  });
  prewarmResult: Result<PrewarmAck> = ok({ channel: "weixin", warmed: true, checkedAt: NOW, expiresAt: "2026-08-22T10:05:00.000Z" });
  private nextDecisionResult: Result<OutboxMessageView> | undefined;

  attachOutbound = async () => ok({ instanceId: INSTANCE.instanceId, attachedAt: NOW, channels: ["weixin"], bridgeVersion: "test" });
  health = async (): Promise<Result<BridgeHealth>> => ok({ protocolVersion: 1, bridgeVersion: "test", instanceId: INSTANCE.instanceId, attached: true, outboxWritable: true, policyVersion: DEFAULT_MESSAGE_POLICY.version, channels: { weixin: "ok" } });
  updatePolicy = async (_instance: InstanceRef, snapshot: PolicySnapshot) => { this.policies.push(snapshot); return ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: NOW }); };
  listChanges = async () => { this.calls.push("listChanges"); return ok(this.changes); };
  decideOutbound = async (_instance: InstanceRef, decision: MessageDecision): Promise<Result<OutboxMessageView>> => {
    this.calls.push(`decide:${decision.messageId}:${decision.state}`);
    this.decisions.push(structuredClone(decision));
    if (this.decisionFailure !== undefined) throw this.decisionFailure;
    if (this.nextDecisionResult !== undefined) return this.nextDecisionResult;
    const source = this.decisionRows.get(decision.messageId) ?? this.changes.items.find((item) => item.messageId === decision.messageId) ?? message({ messageId: decision.messageId });
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
  deliver = async (_instance: InstanceRef, request: { messageId: string; attemptId: string; expectedContentSha256: string }) => { this.calls.push(`deliver:${request.messageId}`); this.deliveries.push(request); return this.deliveryResult; };
  forwardInbound = async () => fail("E002", "not used");
  subscribeTaskEvents = () => () => undefined;
  prewarmChannel = async (_instance: InstanceRef, channel: string) => { this.calls.push(`prewarm:${channel}`); this.prewarms.push(channel); return this.prewarmResult; };

  returnDifferentDecisionState(row: OutboxMessageView): void { this.nextDecisionResult = ok(row); }
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
  afterEach(() => { store.close(); rmTempDir(tmp); });

  function reconciler(now = NOW): MessageReconciler {
    return new MessageReconciler({ adapter, instance: INSTANCE, store, config: DEFAULT_MESSAGE_POLICY, clock: () => new Date(now), randomUUID: () => "attempt-1" });
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

  it("applies the companion holder before absorbing a duplicate and finds held holders outside due candidates", async () => {
    const holder = message({ messageId: "holder", messageKind: "task-progress", state: "held_pacing", availableAt: "2026-08-22T10:02:00.000Z", sequence: 1 });
    const later = message({ messageId: "later", messageKind: "task-progress", sequence: 2, capturedAt: "2026-08-22T10:00:30.000Z" });
    adapter.changes = batch([holder, later]);
    adapter.changes.nextSequence = 2;
    adapter.changes.taskEvents = [{ runId: "run-1", sequence: 1, sessionId: "session-1", kind: "progress", summary: "still working", occurredAt: NOW }];
    await reconciler("2026-08-22T10:00:30.000Z").reconcileOnce();
    expect(adapter.decisions.map((decision) => [decision.messageId, decision.state])).toEqual([["holder", "held_pacing"], ["later", "absorbed"]]);
  });

  it("never treats a later progress record as a holder for an earlier final", async () => {
    adapter.changes = batch([
      message({ messageId: "final-first", sequence: 1, messageKind: "final" }),
      message({ messageId: "later-progress", sequence: 2, messageKind: "task-progress" }),
    ]);
    adapter.changes.nextSequence = 2;
    adapter.deliveryResult = ok({ messageId: "final-first", attemptId: "attempt-1", accepted: true, deduped: false, state: "delivered", providerMessageId: "final-provider", finishedAt: NOW });
    await reconciler().reconcileOnce();
    expect(adapter.decisions.map((decision) => decision.messageId)).toEqual(["final-first"]);
  });

  it("caches prewarm successes, holds normal prewarm failures, and lets urgent failures continue", async () => {
    await reconciler().reconcileOnce();
    expect(adapter.prewarms).toEqual(["weixin"]);
    expect(adapter.calls).toEqual(expect.arrayContaining(["decide:m1:ready", "prewarm:weixin", "deliver:m1"]));
    expect(adapter.calls.indexOf("decide:m1:ready")).toBeLessThan(adapter.calls.indexOf("prewarm:weixin"));
    adapter.changes = { afterSequence: 1, nextSequence: 1, items: [], taskEvents: [], inbound: [] };
    await reconciler().reconcileOnce();
    expect(adapter.prewarms).toEqual(["weixin"]);

    store.savePrewarm({ channel: "weixin", warmed: true, checkedAt: "2026-08-22T09:00:00.000Z", expiresAt: "2026-08-22T09:01:00.000Z", detail: null });
    const normal = message({ messageId: "normal-unwarmed", sequence: 2, channel: "a2a" });
    adapter.changes = { afterSequence: 1, nextSequence: 2, items: [normal], taskEvents: [], inbound: [] };
    adapter.prewarmResult = ok({ channel: "a2a", warmed: false, checkedAt: NOW, expiresAt: "2026-08-22T10:05:00.000Z" });
    await reconciler().reconcileOnce();
    expect(adapter.decisions.at(-1)).toMatchObject({ messageId: "normal-unwarmed", state: "held_pacing", availableAt: "2026-08-22T10:00:15.000Z", transformTrace: expect.arrayContaining(["prewarm:unwarmed"]) });

    const failed = message({ messageId: "normal-failed", sequence: 3, channel: "api-server" });
    adapter.changes = { afterSequence: 2, nextSequence: 3, items: [failed], taskEvents: [], inbound: [] };
    adapter.prewarmResult = fail("E302", "down");
    await reconciler().reconcileOnce();
    expect(adapter.decisions.at(-1)).toMatchObject({ messageId: "normal-failed", state: "held_pacing", availableAt: "2026-08-22T10:00:15.000Z", transformTrace: expect.arrayContaining(["prewarm:failed"]) });

    const urgent = message({ messageId: "urgent", sequence: 4, priority: "urgent", channel: "a2a" });
    adapter.changes = { afterSequence: 3, nextSequence: 4, items: [urgent], taskEvents: [], inbound: [] };
    adapter.deliveryResult = ok({ messageId: "urgent", attemptId: "attempt-1", accepted: true, deduped: false, state: "delivered", providerMessageId: "urgent-provider", finishedAt: NOW });
    await reconciler().reconcileOnce();
    expect(adapter.deliveries.at(-1)?.messageId).toBe("urgent");
  });

  it("updates both lanes on delivered and schedules retry congestion with exponential backoff", async () => {
    await reconciler().reconcileOnce();
    expect(store.getPacingLane("channel:weixin")?.lastSentAt).toBe(NOW);
    expect(store.getPacingLane("chat:weixin:chat-1")?.lastSentAt).toBe(NOW);

    const retry = message({ messageId: "retry", sequence: 2 });
    adapter.changes = { afterSequence: 1, nextSequence: 2, items: [retry], taskEvents: [], inbound: [] };
    adapter.deliveryResult = ok({ messageId: "retry", attemptId: "attempt-1", accepted: true, deduped: false, state: "retry_wait", providerMessageId: null, finishedAt: NOW, error: "429 Retry-After: 60" });
    await reconciler("2026-08-22T10:00:30.000Z").reconcileOnce();
    expect(store.messageView("retry")).toMatchObject({ state: "retry_wait", availableAt: "2026-08-22T10:00:45.000Z", attemptCount: 1 });
    expect(store.getPacingLane("channel:weixin")?.ratePerMin).toBe(1);
  });

  it("does not retry delivery_unknown and replays ready after transport loss before a later delivery", async () => {
    adapter.deliveryResult = ok({ messageId: "m1", attemptId: "attempt-1", accepted: true, deduped: false, state: "delivery_unknown", providerMessageId: null, finishedAt: NOW });
    await reconciler().reconcileOnce();
    await reconciler().reconcileOnce();
    expect(adapter.deliveries).toHaveLength(1);

    const fresh = message({ messageId: "fresh", sequence: 2 });
    adapter.changes = { afterSequence: 1, nextSequence: 2, items: [fresh], taskEvents: [], inbound: [] };
    adapter.deliveryResult = fail("E302", "transport lost");
    await expect(reconciler().reconcileOnce()).rejects.toThrow(/delivery failed: transport lost/);
    expect(store.pendingDecision("fresh")?.state).toBe("ready");
    adapter.deliveryResult = ok({ messageId: "fresh", attemptId: "attempt-1", accepted: true, deduped: false, state: "delivered", providerMessageId: "p2", finishedAt: NOW });
    await reconciler().reconcileOnce();
    expect(adapter.decisions.filter((decision) => decision.messageId === "fresh" && decision.state === "ready")).toHaveLength(2);
    expect(adapter.deliveries.filter((delivery) => delivery.messageId === "fresh")).toHaveLength(2);
  });

  it("handles only one main candidate per cycle", async () => {
    adapter.changes = batch([message({ messageId: "m1", sequence: 1 }), message({ messageId: "m2", sequence: 2 })]);
    adapter.changes.nextSequence = 2;
    await reconciler().reconcileOnce();
    expect(adapter.decisions.filter((decision) => decision.state !== "absorbed")).toHaveLength(1);
  });
});

describe("MessageGatewayService", () => {
  let tmp: string;
  let store: MessagePolicyStore;
  let adapter: FakeMessagingAdapter;
  beforeEach(() => { tmp = makeTempDir(); store = new MessagePolicyStore(gatewayDbFile(tmp)); adapter = new FakeMessagingAdapter(); });
  afterEach(() => { store.close(); rmTempDir(tmp); });

  it("installs policy, runs immediately without overlap, exposes status, and stops idempotently", async () => {
    let scheduled: (() => void) | undefined;
    const clear = vi.fn();
    const service = new MessageGatewayService({
      adapter, instance: INSTANCE, store, config: DEFAULT_MESSAGE_POLICY, clock: () => new Date(NOW),
      scheduler: { setInterval: (fn) => { scheduled = fn; return 1; }, clearInterval: clear }, randomUUID: () => "attempt-1",
    });
    await service.start();
    expect(adapter.policies).toHaveLength(1);
    expect(adapter.decisions).toHaveLength(1);
    scheduled?.(); scheduled?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const status = await service.status();
    expect(status).toMatchObject({ running: true, inFlight: false, bridgeConnected: true, policyVersion: DEFAULT_MESSAGE_POLICY.version, counts: { delivered: 1 } });
    service.stop(); service.stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
