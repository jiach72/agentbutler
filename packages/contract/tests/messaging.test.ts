import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  MESSAGE_KINDS,
  OUTBOX_STATES,
  TASK_EVENT_KINDS,
  TRANSPORT_CLASSES,
  isOutboxState,
  type MessageDecision,
} from "../src/messaging.js";

describe("messaging contract v1", () => {
  it("exports stable Bridge protocol literals", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(TRANSPORT_CLASSES).toEqual(["queued-push", "inline-response"]);
    expect(MESSAGE_KINDS).toContain("final");
    expect(MESSAGE_KINDS).toContain("failure");
    expect(TASK_EVENT_KINDS).toEqual(["started", "progress", "completing", "done", "failed"]);
  });

  it("recognizes every durable state and rejects unknown values", () => {
    for (const state of OUTBOX_STATES) expect(isOutboxState(state)).toBe(true);
    expect(isOutboxState("pending")).toBe(false);
    expect(isOutboxState(null)).toBe(false);
  });

  it("requires a stable decision id", () => {
    const decision: MessageDecision = {
      decisionId: "decision:m1:p1:abc",
      messageId: "m1",
      expectedContentSha256: "before",
      state: "held_pacing",
      availableAt: "2026-08-22T10:00:30.000Z",
      optimizedContent: "digest",
      transformTrace: ["aggregate-progress"],
      policyVersion: "p1",
      reason: "paced",
    };
    expect(decision.decisionId).toBe("decision:m1:p1:abc");
  });
});
