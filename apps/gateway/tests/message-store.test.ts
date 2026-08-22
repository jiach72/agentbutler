import { DatabaseSync } from "node:sqlite";
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

function messageBatch(instanceId: string, messageId: string): OutboxChangeBatch {
  return {
    afterSequence: 0,
    nextSequence: 1,
    items: [{ ...BATCH.items[0], instanceId, messageId, sequence: 1 }],
    taskEvents: [],
    inbound: [],
  };
}

function eventOnlyBatch(runId: string): OutboxChangeBatch {
  return {
    afterSequence: 0,
    nextSequence: 1,
    items: [],
    taskEvents: [
      {
        runId,
        sequence: 1,
        sessionId: `${runId}-session`,
        kind: "started",
        occurredAt: "2026-08-22T10:00:00.000Z",
      },
    ],
    inbound: [],
  };
}

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

  it("accepts an explicit instance for first and multi-instance event-only batches", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(eventOnlyBatch("run-first"), "hermes-main");
    store.ingestBatch(eventOnlyBatch("run-second"), "hermes-secondary");

    expect(store.cursor("hermes-main")).toBe(1);
    expect(store.cursor("hermes-secondary")).toBe(1);
    expect(store.taskView("run-first")?.events).toHaveLength(1);
    expect(() => store.ingestBatch(messageBatch("hermes-main", "m2"), "not-hermes-main")).toThrow(/does not match/);
    store.close();
  });

  it("returns every enabled DND rule so policy evaluation owns time-window semantics", () => {
    const store = new MessagePolicyStore(dbFile);
    store.upsertDndRule({
      ruleId: "expired-pause",
      scope: "global",
      scopeKey: null,
      timeZone: "Asia/Shanghai",
      startMinute: null,
      endMinute: null,
      pausedUntil: "2000-01-01T00:00:00.000Z",
      enabled: true,
      source: "user",
    });

    expect(store.resolveDndRules()).toMatchObject([{ ruleId: "expired-pause" }]);
    store.close();
  });

  it("rejects malformed Bridge and support-state records before persistence", () => {
    const store = new MessagePolicyStore(dbFile);
    expect(() =>
      store.ingestBatch({ ...BATCH, items: [{ ...BATCH.items[0], state: "not-a-state" as never }] }),
    ).toThrow(/state/);
    expect(() =>
      store.ingestBatch({ ...BATCH, taskEvents: [{ ...BATCH.taskEvents[0], sequence: -1 }] }),
    ).toThrow(/sequence/);
    expect(() =>
      store.ingestBatch({ ...BATCH, inbound: [{ ...BATCH.inbound[0], receivedAt: "not-a-timestamp" }] }),
    ).toThrow(/receivedAt/);
    expect(() =>
      store.upsertDndRule({
        ruleId: "bad-zone",
        scope: "global",
        scopeKey: null,
        timeZone: "not/a-zone",
        startMinute: null,
        endMinute: null,
        pausedUntil: null,
        enabled: true,
        source: "user",
      }),
    ).toThrow(/timeZone/);
    expect(() =>
      store.savePacingLane({
        laneKey: "bad-lane",
        channel: "weixin",
        chatId: null,
        ratePerMin: -1,
        successCount: 0,
        cooldownUntil: null,
        lastSentAt: null,
        lastCongestionReason: null,
      }),
    ).toThrow(/ratePerMin/);
    expect(() =>
      store.savePrewarm({
        channel: "weixin",
        warmed: true,
        checkedAt: "2026-08-22T10:00:00.000Z",
        expiresAt: "2026-08-22T09:59:59.000Z",
        detail: null,
      }),
    ).toThrow(/expiresAt/);
    expect(store.counts().captured).toBe(0);
    store.close();
  });

  it("rolls back every projection write when a later SQLite write aborts", () => {
    const store = new MessagePolicyStore(dbFile);
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TRIGGER abort_inbound_projection
      BEFORE INSERT ON inbound_projection
      BEGIN
        SELECT RAISE(ABORT, 'forced inbound rollback');
      END;
    `);
    db.close();

    expect(() => store.ingestBatch(BATCH)).toThrow(/forced inbound rollback/);
    expect(store.cursor("hermes-main")).toBe(0);
    expect(store.messageView("m1")).toBeUndefined();
    expect(store.taskView("run-1")).toBeUndefined();
    store.close();
  });

  it("orders equal Bridge sequences stably across instances", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(messageBatch("z-instance", "z-message"));
    store.ingestBatch(messageBatch("a-instance", "a-message"));

    expect(store.listPolicyCandidates().map((message) => message.messageId)).toEqual(["a-message", "z-message"]);
    store.close();
  });
});
