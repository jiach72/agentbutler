import fs from "node:fs";
import path from "node:path";
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

  // 生产事故回归（2026-09-12）：DDL 的 CREATE INDEX 引用迁移列时，老库上
  // CREATE TABLE IF NOT EXISTS 不补列 → 建索引先于 ALTER 抛「no such column」，
  // 消息运行时启动失败进降级。此用例用旧 schema 预建库锁定迁移顺序。
  it("旧库迁移：inbound_projection 无 received_at 时自动补列并补索引", () => {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(
      "CREATE TABLE inbound_projection (inbound_message_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
    );
    legacy.close();

    const store = new MessagePolicyStore(dbFile); // 构造不得抛 no such column
    store.ingestBatch(BATCH); // 迁移后写入（含 received_at）
    store.close();

    const check = new DatabaseSync(dbFile);
    const columns = check.prepare("PRAGMA table_info(inbound_projection)").all() as Array<
      Record<string, unknown>
    >;
    expect(columns.some((column) => column["name"] === "received_at")).toBe(true);
    const indexes = check.prepare("PRAGMA index_list(inbound_projection)").all() as Array<
      Record<string, unknown>
    >;
    expect(
      indexes.some((index) => index["name"] === "idx_inbound_projection_received_at"),
    ).toBe(true);
    check.close();
  });

  it("隐私红线：入站投影只落元数据，不保存消息正文", () => {    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH);
    store.close();

    const raw = new DatabaseSync(dbFile);
    const rows = raw
      .prepare("SELECT inbound_message_id, payload_json, received_at FROM inbound_projection")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]!["payload_json"])) as Record<string, unknown>;
    expect(payload["content"]).toBeUndefined();
    expect(payload["contentSha256"]).toMatch(/^[0-9a-f]{64}$/);
    // 元数据字段保留（channel/session/run 等动作元数据）。
    expect(payload["channel"]).toBe("weixin");
    expect(payload["sessionId"]).toBe("session-1");
    expect(rows[0]!["received_at"]).toBe("2026-08-22T09:59:59.000Z");
    raw.close();
  });

  it("保留期清理：删除长期无活动的非终态滞留行与过期入站投影", () => {
    const store = new MessagePolicyStore(dbFile);
    store.ingestBatch(BATCH); // captured 行 + inbound 投影
    const staleCutoff = "2026-09-20T00:00:00.000Z"; // 晚于批次时间 → 全部命中
    const result = store.pruneProjectionHistory(
      "2026-09-20T00:00:00.000Z",
      staleCutoff,
    );
    expect(result.stale).toBe(1);
    expect(result.inbound).toBe(1);
    expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence); // cursor 不受清理影响
    store.close();

    const raw = new DatabaseSync(dbFile);
    const remaining = raw.prepare("SELECT COUNT(*) AS n FROM message_projection").get() as {
      n: number;
    };
    const inboundLeft = raw.prepare("SELECT COUNT(*) AS n FROM inbound_projection").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
    expect(inboundLeft.n).toBe(0);
    raw.close();
  });

  it("accepts empty-text inbound records without blocking the ordered batch", () => {
    const store = new MessagePolicyStore(dbFile);
    const batch: OutboxChangeBatch = {
      afterSequence: 0,
      nextSequence: 2,
      items: [{ ...BATCH.items[0], sequence: 1 }],
      taskEvents: [],
      inbound: [{ ...BATCH.inbound[0], content: "", receivedAt: "2026-08-22T10:00:00.000Z" }],
    };

    expect(() => store.ingestBatch(batch)).not.toThrow();
    expect(store.cursor("hermes-main")).toBe(2);
    expect(store.messageView("m1")?.state).toBe("captured");
    store.close();
  });

  it("accepts Bridge JSON with explicit null optional routing fields", () => {
    const store = new MessagePolicyStore(dbFile);
    const bridgeJsonBatch = {
      ...BATCH,
      items: [
        {
          ...BATCH.items[0],
          accountId: null,
          threadId: null,
          runId: null,
          inboundMessageId: null,
          replyTo: null,
        },
      ],
      inbound: [
        {
          ...BATCH.inbound[0],
          threadId: null,
          userId: null,
          sessionId: null,
          runId: null,
        },
      ],
    } as unknown as OutboxChangeBatch;

    store.ingestBatch(bridgeJsonBatch);
    expect(store.cursor("hermes-main")).toBe(BATCH.nextSequence);
    expect(store.messageView("m1")?.messageId).toBe("m1");
    store.close();
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

  it("absorbs queued progress backlog idempotently without touching final or failure messages", () => {
    const store = new MessagePolicyStore(dbFile);
    const progressStates = ["held_pacing", "ready", "retry_wait"] as const;
    const items = [
      ...progressStates.map((state, index) => ({
        ...BATCH.items[0],
        messageId: `progress-${state}`,
        messageKind: "task-progress" as const,
        state,
        sequence: index + 1,
        availableAt: state === "retry_wait" ? "2026-08-22T10:01:00.000Z" : null,
        lastError: state === "retry_wait" ? "429 rate limited" : null,
      })),
      {
        ...BATCH.items[0],
        messageId: "final-kept",
        messageKind: "final" as const,
        state: "ready" as const,
        sequence: 4,
      },
      {
        ...BATCH.items[0],
        messageId: "failure-kept",
        messageKind: "failure" as const,
        state: "retry_wait" as const,
        sequence: 5,
      },
    ];
    store.ingestBatch({ afterSequence: 0, nextSequence: items.length, items, taskEvents: [], inbound: [] }, "hermes-main");

    expect(store.absorbPendingProgress("2026-08-22T10:00:10.000Z")).toBe(3);
    expect(store.counts()).toMatchObject({ absorbed: 3, ready: 1, retry_wait: 1 });
    expect(store.messageView("final-kept")?.state).toBe("ready");
    expect(store.messageView("failure-kept")?.state).toBe("retry_wait");
    expect(store.absorbPendingProgress("2026-08-22T10:00:11.000Z")).toBe(0);
    store.close();
  });

  it("prunes only terminal message history older than the retention cutoff", () => {
    const store = new MessagePolicyStore(dbFile);
    const oldDelivered = { ...BATCH.items[0], messageId: "old-delivered", state: "delivered" as const };
    const oldRetry = { ...BATCH.items[0], messageId: "old-retry", state: "retry_wait" as const, availableAt: "2026-08-01T00:00:00.000Z" };
    const freshDelivered = { ...BATCH.items[0], messageId: "fresh-delivered", state: "delivered" as const };
    store.ingestBatch({
      afterSequence: 0,
      nextSequence: 3,
      items: [oldDelivered, oldRetry, freshDelivered].map((item, index) => ({ ...item, sequence: index + 1 })),
      taskEvents: [],
      inbound: [],
    });
    const seed = new DatabaseSync(dbFile);
    seed.prepare("UPDATE message_projection SET updated_at = ? WHERE message_id IN (?, ?)").run("2026-08-01T00:00:00.000Z", "old-delivered", "old-retry");
    seed.close();

    const removed = store.pruneMessageHistory("2026-08-08T00:00:00.000Z");

    expect(removed).toBe(1);
    expect(store.messageView("old-delivered")).toBeUndefined();
    expect(store.messageView("old-retry")?.state).toBe("retry_wait");
    expect(store.messageView("fresh-delivered")?.state).toBe("delivered");
    store.close();
  });

  it("aggregates terminal delivery outcomes by local day and fills empty days", () => {
    const store = new MessagePolicyStore(dbFile);
    const items = [
      { ...BATCH.items[0], messageId: "history-delivered", state: "delivered" as const },
      { ...BATCH.items[0], messageId: "history-failed", state: "dead_letter" as const },
      { ...BATCH.items[0], messageId: "history-uncertain", state: "delivery_unknown" as const },
    ];
    store.ingestBatch({
      afterSequence: 0,
      nextSequence: 3,
      items: items.map((item, index) => ({ ...item, sequence: index + 1 })),
      taskEvents: [],
      inbound: [],
    });
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const today = new Date(now);
    const yesterday = new Date(now.getTime() - 86_400_000);
    const stamp = (value: Date) => value.toISOString();
    const seed = new DatabaseSync(dbFile);
    seed
      .prepare("UPDATE message_outcome_history SET occurred_at = ? WHERE message_id = ?")
      .run(stamp(today), "history-delivered");
    seed
      .prepare("UPDATE message_outcome_history SET occurred_at = ? WHERE message_id = ?")
      .run(stamp(today), "history-failed");
    seed
      .prepare("UPDATE message_outcome_history SET occurred_at = ? WHERE message_id = ?")
      .run(stamp(yesterday), "history-uncertain");
    seed.close();

    const history = store.dailyOutcomeHistory(3, now);

    expect(history).toHaveLength(3);
    expect(history.reduce((total, row) => total + row.delivered, 0)).toBe(1);
    expect(history.reduce((total, row) => total + row.failed, 0)).toBe(1);
    expect(history.reduce((total, row) => total + row.uncertain, 0)).toBe(1);
    expect(history.filter((row) => row.delivered + row.failed + row.uncertain === 0)).toHaveLength(1);
    store.close();
  });

  it("aggregates terminal outcomes per channel with success rate", () => {
    const store = new MessagePolicyStore(dbFile);
    const items = [
      { ...BATCH.items[0], messageId: "metrics-wx-ok", state: "delivered" as const },
      { ...BATCH.items[0], messageId: "metrics-wx-bad", state: "dead_letter" as const },
      { ...BATCH.items[0], messageId: "metrics-tg-ok", state: "delivered" as const, channel: "telegram" },
    ];
    store.ingestBatch({
      afterSequence: 0,
      nextSequence: 3,
      items: items.map((item, index) => ({ ...item, sequence: index + 1 })),
      taskEvents: [],
      inbound: [],
    });

    const metrics = store.channelMetrics(7);

    expect(metrics.channels).toHaveLength(2);
    const weixin = metrics.channels.find((row) => row.channel === "weixin");
    const telegram = metrics.channels.find((row) => row.channel === "telegram");
    expect(weixin).toMatchObject({ delivered: 1, failed: 1, uncertain: 0, total: 2, successRate: 0.5 });
    expect(telegram).toMatchObject({ delivered: 1, failed: 0, uncertain: 0, total: 1, successRate: 1 });
    expect(metrics.latency.samples).toBe(3);
    expect(metrics.latency.p50Ms).not.toBeNull();
    expect(metrics.retries).toBe(0);
    // 总量大的通道排在前面，便于面板直接看到问题通道
    expect(metrics.channels[0].channel).toBe("weixin");
    expect(metrics.daily.every((row) => row.delivered + row.failed + row.uncertain > 0)).toBe(true);
    store.close();
  });

  it("keeps long-term delivery history after the short-term projection is pruned", () => {
    const store = new MessagePolicyStore(dbFile);
    const now = new Date();
    const occurredAt = new Date(now.getTime() - 25 * 86_400_000).toISOString();
    const delivered = {
      ...BATCH.items[0],
      messageId: "long-term-delivered",
      state: "delivered" as const,
      deliveredAt: occurredAt,
    };
    store.ingestBatch({
      afterSequence: 0,
      nextSequence: 1,
      items: [{ ...delivered, sequence: 1 }],
      taskEvents: [],
      inbound: [],
    });
    const seed = new DatabaseSync(dbFile);
    seed
      .prepare("UPDATE message_projection SET updated_at = ? WHERE message_id = ?")
      .run(occurredAt, delivered.messageId);
    seed.close();

    expect(store.pruneMessageHistory(new Date(now.getTime() - 7 * 86_400_000).toISOString())).toBe(1);
    expect(store.messageView(delivered.messageId)).toBeUndefined();

    const history = store.dailyOutcomeHistory(30, now);
    // dailyOutcomeHistory 按本地日期聚合，不能把 UTC 日期字符串当作桶键。
    expect(history.some((row) => row.delivered === 1)).toBe(true);
    expect(history.reduce((total, row) => total + row.delivered, 0)).toBe(1);

    // 通道在送达结果落库时冗余归档：投影被清理后，30 天通道指标仍归因到
    // weixin，不会把正常渠道误报成"未知通道"。
    const metrics = store.channelMetrics(30, now);
    expect(metrics.channels.find((row) => row.channel === "weixin")).toMatchObject({
      delivered: 1,
      total: 1,
    });
    expect(metrics.channels.find((row) => row.channel === "unknown")).toBeUndefined();
    store.close();
  });

  it("backfills archived channels from live projections when upgrading a legacy database", () => {
    // 模拟 channel 列上线前的旧库：送达历史不带通道，投影仍在。
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(`
      CREATE TABLE message_projection (
        message_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        bridge_sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        available_at TEXT,
        content_sha256 TEXT NOT NULL,
        decision_id TEXT,
        pending_decision_json TEXT,
        last_policy_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE message_outcome_history (
        message_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'uncertain')),
        occurred_at TEXT NOT NULL
      );
    `);
    const payload = JSON.stringify({ ...BATCH.items[0], state: "delivered" });
    legacy
      .prepare(
        `INSERT INTO message_projection (
           message_id, instance_id, bridge_sequence, payload_json, state, available_at,
           content_sha256, decision_id, pending_decision_json, last_policy_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "hermes-main",
        1,
        payload,
        "delivered",
        null,
        "sha",
        null,
        null,
        null,
        "2026-09-01T00:00:00.000Z",
      );
    legacy
      .prepare("INSERT INTO message_outcome_history (message_id, outcome, occurred_at) VALUES (?, ?, ?)")
      .run("legacy-1", "delivered", "2026-09-01T00:00:00.000Z");
    legacy.close();

    // 打开旧库触发补列迁移：存量行从仍在的投影回填通道。
    const store = new MessagePolicyStore(dbFile);
    const check = new DatabaseSync(dbFile);
    const row = check
      .prepare("SELECT channel FROM message_outcome_history WHERE message_id = ?")
      .get("legacy-1") as Record<string, unknown>;
    expect(String(row["channel"])).toBe("weixin");
    check.close();
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
      store.ingestBatch({ ...BATCH, items: [{ ...BATCH.items[0], accountId: 42 as never }] }),
    ).toThrow(/accountId/);
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
      CREATE TRIGGER abort_bridge_cursor
      BEFORE INSERT ON bridge_cursors
      BEGIN
        SELECT RAISE(ABORT, 'forced cursor rollback');
      END;
    `);
    db.close();

    expect(() => store.ingestBatch(BATCH)).toThrow(/forced cursor rollback/);
    expect(store.cursor("hermes-main")).toBe(0);
    expect(store.messageView("m1")).toBeUndefined();
    expect(store.taskView("run-1")).toBeUndefined();
    const verificationDb = new DatabaseSync(dbFile);
    expect(verificationDb.prepare("SELECT COUNT(*) AS count FROM inbound_projection").get()).toMatchObject({ count: 0 });
    expect(verificationDb.prepare("SELECT COUNT(*) AS count FROM task_events_projection").get()).toMatchObject({ count: 0 });
    verificationDb.close();
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
