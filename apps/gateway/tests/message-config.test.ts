import { describe, expect, it } from "vitest";
import {
  createPolicySnapshot,
  DEFAULT_MESSAGE_POLICY,
  validateMessagePolicy,
} from "../src/message/config";

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

  it("creates the same hash for semantically identical key order", () => {
    const a = createPolicySnapshot(DEFAULT_MESSAGE_POLICY);
    const b = createPolicySnapshot(JSON.parse(JSON.stringify(DEFAULT_MESSAGE_POLICY)));
    expect(a.sha256).toBe(b.sha256);
    expect(a.payload.inlineResponse).toBe("allow");
  });
});
