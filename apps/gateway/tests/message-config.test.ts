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
  it("keeps the Weixin terminal interval at or above 30 seconds", () => {
    expect(DEFAULT_MESSAGE_POLICY.channels.weixin.nativeMinIntervalSec).toBe(30);
    expect(() =>
      validateMessagePolicy({
        ...DEFAULT_MESSAGE_POLICY,
        channels: {
          ...DEFAULT_MESSAGE_POLICY.channels,
          weixin: {
            ...DEFAULT_MESSAGE_POLICY.channels.weixin,
            nativeMinIntervalSec: 29,
          },
        },
      }),
    ).toThrow(/30/);
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
});
