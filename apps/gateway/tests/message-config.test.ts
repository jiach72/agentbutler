import { describe, expect, it } from "vitest";
import {
  createPolicySnapshot,
  DEFAULT_MESSAGE_POLICY,
  validateMessagePolicy,
} from "../src/message/config";
import type { MessagePolicyConfig } from "../src/message/types";

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    );
  }

  return value;
}

describe("message policy configuration", () => {
  it("keeps the Weixin terminal interval at or above 45 seconds", () => {
    expect(DEFAULT_MESSAGE_POLICY.channels.weixin.nativeMinIntervalSec).toBe(45);
    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        channels: {
          ...DEFAULT_MESSAGE_POLICY.channels,
          weixin: {
            ...DEFAULT_MESSAGE_POLICY.channels.weixin,
            nativeMinIntervalSec: 44,
          },
        },
      }),
    ).toThrow(/45/);
  });

  it("rejects a deserialized inline response other than allow", () => {
    const deserialized: unknown = JSON.parse(JSON.stringify(DEFAULT_MESSAGE_POLICY));
    (deserialized as { inlineResponse: string }).inlineResponse = "deny";

    expect(() => validateMessagePolicy(deserialized as MessagePolicyConfig)).toThrow(/inlineResponse.*allow/);
  });

  it("creates the same hash for a different recursive key insertion order", () => {
    const a = createPolicySnapshot(DEFAULT_MESSAGE_POLICY);
    const reordered = reverseObjectKeys(DEFAULT_MESSAGE_POLICY) as MessagePolicyConfig;
    const b = createPolicySnapshot(reordered);

    expect(Object.keys(reordered)).not.toEqual(Object.keys(DEFAULT_MESSAGE_POLICY));
    expect(Object.keys(reordered.channels.weixin)).not.toEqual(Object.keys(DEFAULT_MESSAGE_POLICY.channels.weixin));
    expect(a.sha256).toBe(b.sha256);
    expect(a.payload.inlineResponse).toBe("allow");
  });

  it("detaches the installed snapshot payload from later caller mutations", () => {
    const mutable = structuredClone(DEFAULT_MESSAGE_POLICY);
    const snapshot = createPolicySnapshot(mutable);

    mutable.channels.weixin.initialRatePerMin = 999;

    expect((snapshot.payload.channels as MessagePolicyConfig["channels"]).weixin.initialRatePerMin).toBe(
      DEFAULT_MESSAGE_POLICY.channels.weixin.initialRatePerMin,
    );
  });

  it("rejects non-positive or non-integer maxAttempts", () => {
    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        delivery: { ...DEFAULT_MESSAGE_POLICY.delivery, maxAttempts: 0 },
      }),
    ).toThrow(/delivery\.maxAttempts.*at least 1/);

    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        delivery: { ...DEFAULT_MESSAGE_POLICY.delivery, maxAttempts: 2.5 },
      }),
    ).toThrow(/delivery\.maxAttempts.*integer/);
  });

  it("rejects retryMaxSec less than retryBaseSec", () => {
    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        delivery: { ...DEFAULT_MESSAGE_POLICY.delivery, retryBaseSec: 30, retryMaxSec: 10 },
      }),
    ).toThrow(/delivery\.retryMaxSec.*greater than or equal to delivery\.retryBaseSec/);
  });

  it("rejects non-positive digest maxItems or maxChars", () => {
    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        digest: { ...DEFAULT_MESSAGE_POLICY.digest, maxItems: 0 },
      }),
    ).toThrow(/digest\.maxItems.*at least 1/);

    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        digest: { ...DEFAULT_MESSAGE_POLICY.digest, maxChars: 0 },
      }),
    ).toThrow(/digest\.maxChars.*at least 1/);
  });
});
