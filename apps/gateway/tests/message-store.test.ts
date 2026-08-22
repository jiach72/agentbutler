import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageDecision, OutboxChangeBatch } from "@butler/contract";
import { DEFAULT_MESSAGE_POLICY } from "../src/message/config";
import { MessagePolicyStore } from "../src/message/store";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const BATCH: OutboxChangeBatch = {
  afterSequence: 0,
  nextSequence: 4,
  items: [
    {
      messageId: "m1",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      runId: "run-1",
      inboundMessageId: "inbound-1",
      messageKind: "final",
      transport: "queued-push",
      priority: "normal",
      content: "done",
      contentSha256: "content-sha-1",
      metadata: {},
      capturedAt: "2026-08-22T10:00:00.000Z",
      sequence: 1,
      state: "captured",
      availableAt: null,
      attemptCount: 0,
      providerMessageId: null,
      deliveredAt: null,
      lastError: null,
      transformTrace: [],
    },
  ],
  taskEvents: [
    {
      runId: "run-1",
      sequence: 2,
      sessionId: "session-1",
      kind: "progress",
      summary: "finished work",
      occurredAt: "2026-08-22T10:00:02.000Z",
    },
    {
      runId: "run-1",
      sequence: 1,
      sessionId: "session-1",
      kind: "started",
      occurredAt: "2026-08-22T10:00:01.000Z",
    },
  ],
  inbound: [
    {
      inboundMessageId: "inbound-1",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      runId: "run-1",
      content: "status",
      receivedAt: "2026-08-22T09:59:59.000Z",
    },
  ],
};

const DECISION: MessageDecision = {
  decisionId: "decision-1",
  messageId: "m1",
  expectedContentSha256: "content-sha-1",
  state: "ready",
  transformTrace: ["policy:ready"],
  policyVersion: "message-policy-v1",
  reason: "ready for delivery",
};

describe("MessagePolicyStore", () => {
  let tmp: string;
  let dbFile: string;

  beforeEach(() => {
    tmp = makeTempDir();
    dbFile = gatewayDbFile(tmp);
  });

  afterEach(() => {
    rmTempDir(tmp);
  });

  it("ingests a Bridge batch and advances cursor atomically", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH);
    store.ingestBatch(BATCH);
    expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence);
    expect(store.counts()).toMatchObject({ captured: 1 });
    expect(store.taskView("run-1")?.events).toHaveLength(2);
    expect(store.taskView("run-1")?.events.map((event) => event.sequence)).toEqual([1, 2]);
    store.close();

    const reopened = new MessagePolicyStore(dbFile);
    expect(reopened.cursor("hermes-main")).toBe(BATCH.nextSequence);
    expect(reopened.messageView("m1")?.messageId).toBe("m1");
    reopened.close();
  });

  it("returns locally scheduled held messages when their release time is due", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH);
    store.updateRemoteView({
      ...BATCH.items[0],
      state: "held_pacing",
      availableAt: "2026-08-22T10:00:30.000Z",
    });
    expect(store.listPolicyCandidates("2026-08-22T10:00:29.999Z")).toEqual([]);
    expect(store.listPolicyCandidates("2026-08-22T10:00:30.000Z")[0]?.messageId).toBe("m1");
    store.close();
  });

  it("rejects a skipped Bridge cursor before it writes a partial projection", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH);
    const skipped = {
      ...BATCH,
      afterSequence: 0,
      nextSequence: 5,
      items: [{ ...BATCH.items[0], messageId: "m2", sequence: 5 }],
      taskEvents: [],
      inbound: [],
    };

    expect(() => store.ingestBatch(skipped)).toThrow(/cursor mismatch/);
    expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence);
    expect(store.messageView("m2")).toBeUndefined();
    store.close();
  });

  it("persists policy, DND, pacing, and prewarm support state", () => {
    const store = new MessagePolicyStore(dbFile);
    const policy = store.savePolicy(DEFAULT_MESSAGE_POLICY);
    store.upsertDndRule({
      ruleId: "dnd-1",
      scope: "channel",
      scopeKey: "weixin",
      timeZone: "Asia/Shanghai",
      startMinute: 1320,
      endMinute: 420,
      pausedUntil: null,
      enabled: true,
      source: "user",
    });
    store.savePacingLane({
      laneKey: "weixin:chat-1",
      channel: "weixin",
      chatId: "chat-1",
      ratePerMin: 2,
      successCount: 3,
      cooldownUntil: null,
      lastSentAt: "2026-08-22T10:00:00.000Z",
      lastCongestionReason: null,
    });
    store.savePrewarm({
      channel: "weixin",
      warmed: true,
      checkedAt: "2026-08-22T10:00:00.000Z",
      expiresAt: "2026-08-22T10:05:00.000Z",
      detail: "token valid",
    });
    store.close();

    const reopened = new MessagePolicyStore(dbFile);
    expect(reopened.loadPolicy()).toEqual(policy);
    expect(reopened.resolveDndRules()).toMatchObject([{ ruleId: "dnd-1", scopeKey: "weixin" }]);
    expect(reopened.getPacingLane("weixin:chat-1")).toMatchObject({ ratePerMin: 2, successCount: 3 });
    expect(reopened.getPrewarm("weixin")).toMatchObject({ warmed: true, detail: "token valid" });
    reopened.close();
  });

  it("replays the exact staged decision after restart and clears it only after a matching response", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH);
    store.stageDecision("m1", DECISION);
    expect(store.pendingDecision("m1")).toEqual(DECISION);
    store.close();

    const reopened = new MessagePolicyStore(dbFile);
    expect(reopened.pendingDecision("m1")).toEqual(DECISION);
    const remoteReady = { ...BATCH.items[0], state: "ready" as const };
    reopened.updateRemoteView(remoteReady, "another-decision");
    expect(reopened.pendingDecision("m1")).toEqual(DECISION);
    reopened.clearPendingDecision("m1");
    expect(reopened.pendingDecision("m1")).toBeUndefined();
    reopened.stageDecision("m1", DECISION);
    reopened.updateRemoteView(remoteReady, DECISION.decisionId);
    expect(reopened.pendingDecision("m1")).toBeUndefined();
    expect(reopened.messageView("m1")?.decisionId).toBe(DECISION.decisionId);
    reopened.close();
  });
});
