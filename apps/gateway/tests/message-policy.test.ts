import { describe, expect, it } from "vitest";
import type { OutboxMessageView, TaskEvent } from "@butler/contract";

import { DEFAULT_MESSAGE_POLICY } from "../src/message/config";
import { buildProgressDigest } from "../src/message/digest";
import { evaluateDnd } from "../src/message/dnd";
import { evaluatePacing, recordPacingCongestion, recordPacingSuccess } from "../src/message/pacing";
import { decideOutboundPolicy } from "../src/message/policy";
import type { DndRule, PacingLane } from "../src/message/store";

const NOW = "2026-08-22T10:00:00.000Z";

function message(overrides: Partial<OutboxMessageView> = {}): OutboxMessageView {
  return {
    messageId: "m1",
    instanceId: "hermes-main",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "chat-1",
    sessionId: "session-1",
    runId: "run-1",
    messageKind: "task-progress",
    transport: "queued-push",
    priority: "normal",
    content: "working",
    contentSha256: "hash-1",
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

function rule(overrides: Partial<DndRule> = {}): DndRule {
  return {
    ruleId: "rule-1",
    scope: "global",
    scopeKey: null,
    timeZone: "UTC",
    startMinute: null,
    endMinute: null,
    pausedUntil: null,
    enabled: true,
    source: "test",
    updatedAt: NOW,
    ...overrides,
  };
}

function lane(channel: string, chatId: string | null, ratePerMin = 60): PacingLane {
  return {
    laneKey: `${channel}:${chatId ?? "global"}`,
    channel,
    chatId,
    ratePerMin,
    successCount: 0,
    cooldownUntil: null,
    lastSentAt: null,
    lastCongestionReason: null,
    updatedAt: NOW,
  };
}

function events(): TaskEvent[] {
  return [
    { runId: "run-1", sequence: 3, sessionId: "session-1", kind: "progress", summary: "正在验证长文本", occurredAt: NOW },
    { runId: "run-1", sequence: 1, sessionId: "session-1", kind: "started", summary: "开始执行", occurredAt: NOW },
    { runId: "run-1", sequence: 2, sessionId: "session-1", kind: "progress", summary: "已完成抓取", occurredAt: NOW },
    { runId: "run-1", sequence: 2, sessionId: "session-1", kind: "progress", summary: "重复事件", occurredAt: NOW },
  ];
}

describe("message policy", () => {
  it("bypasses DND for failure but still holds when pacing is constrained", () => {
    const result = decideOutboundPolicy({
      message: message({ messageKind: "failure", priority: "urgent" }),
      taskEvents: [],
      dndRules: [rule({ pausedUntil: "2026-08-22T12:00:00.000Z" })],
      channelLane: { ...lane("weixin", null, 1), lastSentAt: "2026-08-22T09:59:30.000Z" },
      chatLane: lane("weixin", "chat-1", 60),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(result.decision.state).toBe("held_pacing");
    expect(result.decision.transformTrace).toContain("dnd:bypass-failure");
  });

  it("makes solicited replies ready without DND or asynchronous pacing delay", () => {
    const result = decideOutboundPolicy({
      message: message({ metadata: { solicitedReply: true } }),
      taskEvents: [],
      dndRules: [rule({ pausedUntil: "2026-08-22T12:00:00.000Z" })],
      channelLane: { ...lane("weixin", null, 1), lastSentAt: "2026-08-22T09:59:30.000Z" },
      chatLane: lane("weixin", "chat-1", 1),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(result.decision.state).toBe("ready");
    expect(result.decision.transformTrace).toEqual(
      expect.arrayContaining(["dnd:bypass-solicited-reply", "pacing:bypass-solicited-reply"]),
    );
  });

  it("lets a session scope decide even when its inactive rule overrides active lower scopes", () => {
    const activeSession = evaluateDnd({
      message: message(),
      rules: [
        rule({ ruleId: "global", pausedUntil: null }),
        rule({ ruleId: "session", scope: "session", scopeKey: "weixin:chat-1", pausedUntil: "2026-08-22T12:00:00.000Z" }),
      ],
      now: NOW,
    });
    const inactiveSession = evaluateDnd({
      message: message(),
      rules: [
        rule({ ruleId: "global", pausedUntil: "2026-08-22T12:00:00.000Z" }),
        rule({ ruleId: "session", scope: "session", scopeKey: "weixin:chat-1", startMinute: 1, endMinute: 2 }),
      ],
      now: NOW,
    });

    expect(activeSession.held).toBe(true);
    expect(inactiveSession.held).toBe(false);
  });

  it("evaluates ordinary and cross-midnight IANA windows", () => {
    const ordinary = evaluateDnd({
      message: message(),
      rules: [rule({ timeZone: "Asia/Shanghai", startMinute: 17 * 60 + 30, endMinute: 19 * 60 })],
      now: "2026-08-22T10:00:00.000Z",
    });
    const crossMidnight = evaluateDnd({
      message: message(),
      rules: [rule({ timeZone: "Asia/Shanghai", startMinute: 22 * 60, endMinute: 6 * 60 })],
      now: "2026-08-22T15:30:00.000Z",
    });

    expect(ordinary.held).toBe(true);
    expect(crossMidnight.held).toBe(true);
  });

  it("uses both pacing lanes, keeps Weixin at 45 seconds, and does not floor API Server", () => {
    const weixin = evaluatePacing({
      message: message(),
      channelLane: { ...lane("weixin", null, 2), lastSentAt: "2026-08-22T10:00:00.000Z" },
      chatLane: { ...lane("weixin", "chat-1", 60), lastSentAt: "2026-08-22T09:59:45.000Z" },
      policy: DEFAULT_MESSAGE_POLICY.channels.weixin,
      now: "2026-08-22T10:00:01.000Z",
    });
    const api = evaluatePacing({
      message: message({ channel: "api-server" }),
      channelLane: { ...lane("api-server", null, 600), lastSentAt: "2026-08-22T10:00:00.000Z" },
      chatLane: lane("api-server", "chat-1", 600),
      policy: DEFAULT_MESSAGE_POLICY.channels["api-server"],
      now: "2026-08-22T10:00:01.000Z",
    });
    const chatBound = evaluatePacing({
      message: message(),
      channelLane: lane("weixin", null, 60),
      chatLane: { ...lane("weixin", "chat-1", 1), lastSentAt: NOW },
      policy: DEFAULT_MESSAGE_POLICY.channels.weixin,
      now: "2026-08-22T10:00:30.000Z",
    });

    expect(weixin.availableAt).toBe("2026-08-22T10:00:45.000Z");
    expect(api.held).toBe(false);
    expect(chatBound.availableAt).toBe("2026-08-22T10:01:00.000Z");
  });

  it("performs additive increase and congestion decrease with the later cooldown", () => {
    const success = recordPacingSuccess({ ...lane("weixin", null, 2), successCount: 3 }, DEFAULT_MESSAGE_POLICY.channels.weixin, NOW);
    const congestion = recordPacingCongestion({
      lane: lane("weixin", null, 2),
      policy: DEFAULT_MESSAGE_POLICY.channels.weixin,
      now: NOW,
      retryAfterSec: 45,
      reason: "429",
    });

    expect(success).toMatchObject({ ratePerMin: 2, successCount: 0, lastSentAt: NOW });
    expect(congestion).toMatchObject({ ratePerMin: 1, successCount: 0, cooldownUntil: "2026-08-22T10:01:00.000Z" });
  });

  it("never shortens an existing later congestion cooldown", () => {
    const congestion = recordPacingCongestion({
      lane: { ...lane("weixin", null, 2), cooldownUntil: "2026-08-22T10:05:00.000Z" },
      policy: DEFAULT_MESSAGE_POLICY.channels.weixin,
      now: NOW,
      retryAfterSec: 45,
      reason: "429",
    });

    expect(congestion.cooldownUntil).toBe("2026-08-22T10:05:00.000Z");
  });

  it("builds a deterministic deduplicated UTF-16-bounded progress digest", () => {
    const complete = buildProgressDigest({
      holder: message({ messageId: "holder", sequence: 1 }),
      incoming: message({ messageId: "incoming", sequence: 2 }),
      events: events(),
      config: DEFAULT_MESSAGE_POLICY.digest,
    });
    const result = buildProgressDigest({
      holder: message({ messageId: "holder", sequence: 1 }),
      incoming: message({ messageId: "incoming", sequence: 2 }),
      events: events(),
      config: { ...DEFAULT_MESSAGE_POLICY.digest, maxItems: 2, maxChars: 22 },
    });

    expect(result.accepted).toBe(true);
    expect(result.absorbIncoming).toBe(true);
    expect(complete.content).toEqual(expect.stringContaining("任务 run-1"));
    expect(complete.content).toEqual(expect.stringContaining("进行中：正在验证长文本"));
    expect(result.content?.length).toBeLessThanOrEqual(22);
    expect(result.content).toContain("…");
    expect(result.transformTrace).toEqual(expect.arrayContaining(["digest:events-deduped", "digest:truncated", "digest:duplicate-absorbed"]));
  });

  it("absorbs pending progress for a final response but declines unrelated runs", () => {
    const final = buildProgressDigest({
      holder: message({ messageId: "progress-1", messageKind: "task-progress" }),
      incoming: message({ messageId: "final-1", messageKind: "final" }),
      events: events(),
      config: DEFAULT_MESSAGE_POLICY.digest,
    });
    const unrelated = buildProgressDigest({
      holder: message({ messageId: "other", runId: "run-other" }),
      incoming: message(),
      events: events(),
      config: DEFAULT_MESSAGE_POLICY.digest,
    });

    expect(final.absorbHolder).toBe(true);
    expect(final.transformTrace).toContain("digest:final-absorbed");
    expect(unrelated.accepted).toBe(false);
  });

  it("absorbs ordinary progress instead of scheduling a user-visible delivery", () => {
    const result = decideOutboundPolicy({
      message: message(),
      taskEvents: events(),
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(result.decision).toMatchObject({ messageId: "m1", state: "absorbed" });
    expect(result.decision.availableAt).toBeUndefined();
    expect(result.decision.transformTrace).toContain("progress:background-only");
  });

  it("absorbs later progress without updating or pacing an earlier holder", () => {
    const result = decideOutboundPolicy({
      message: message({ messageId: "later", sequence: 2, capturedAt: "2026-08-22T10:00:30.000Z" }),
      holder: message({ messageId: "holder", sequence: 1, state: "held_pacing", availableAt: "2026-08-22T10:02:00.000Z" }),
      taskEvents: events(),
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: "2026-08-22T10:00:30.000Z",
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(result.decision).toMatchObject({ messageId: "later", state: "absorbed" });
    expect(result.companionDecisions).toEqual([]);
  });

  it("does not absorb or update a terminal progress holder", () => {
    const result = decideOutboundPolicy({
      message: message({ messageId: "final", messageKind: "final" }),
      holder: message({ messageId: "done-progress", state: "delivered", deliveredAt: NOW }),
      taskEvents: events(),
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(result.companionDecisions).toEqual([]);
  });

  it("returns deterministic DND wake times and carries them into held decisions", () => {
    const paused = evaluateDnd({
      message: message(),
      rules: [rule({ pausedUntil: "2026-08-22T12:00:30.000Z" })],
      now: NOW,
    });
    const crossMidnight = evaluateDnd({
      message: message(),
      rules: [rule({ timeZone: "Asia/Shanghai", startMinute: 22 * 60, endMinute: 6 * 60 })],
      now: "2026-08-22T15:30:00.000Z",
    });
    const decision = decideOutboundPolicy({
      message: message({ messageKind: "final" }),
      taskEvents: events(),
      dndRules: [rule({ pausedUntil: "2026-08-22T12:00:30.000Z" })],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(paused.availableAt).toBe("2026-08-22T12:00:30.000Z");
    expect(crossMidnight.availableAt).toBe("2026-08-22T22:00:00.000Z");
    expect(decision.decision).toMatchObject({ state: "held_dnd", availableAt: "2026-08-22T12:00:30.000Z" });
  });

  it("rejects inline responses and keeps helper-only aggregation out of Bridge decisions", () => {
    const inline = decideOutboundPolicy({
      message: message({ transport: "inline-response" }),
      taskEvents: [],
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });
    const final = decideOutboundPolicy({
      message: message({ messageId: "final", messageKind: "final" }),
      holder: message({ messageId: "progress", messageKind: "task-progress" }),
      taskEvents: events(),
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    });

    expect(inline.decision.state).toBe("policy_error");
    expect(Object.keys(final)).toEqual(["decision", "companionDecisions"]);
    expect(final.companionDecisions[0]).toMatchObject({ messageId: "progress", state: "absorbed" });
  });

  it("hashes decisions canonically and changes the ID for meaningful payload changes", () => {
    const common = {
      taskEvents: [],
      dndRules: [],
      channelLane: lane("weixin", null),
      chatLane: lane("weixin", "chat-1"),
      now: NOW,
      config: DEFAULT_MESSAGE_POLICY,
    };
    const first = decideOutboundPolicy({ ...common, message: message({ metadata: { a: 1, b: { x: true } } }) });
    const reordered = decideOutboundPolicy({ ...common, message: message({ metadata: { b: { x: true }, a: 1 } }) });
    const changed = decideOutboundPolicy({ ...common, message: message({ contentSha256: "hash-2" }) });

    expect(first.decision.decisionId).toBe(reordered.decision.decisionId);
    expect(first.decision.decisionId).not.toBe(changed.decision.decisionId);
  });
});
