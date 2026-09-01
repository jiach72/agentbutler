import { describe, expect, it } from "vitest";

import { createPolicySnapshot, DEFAULT_MESSAGE_POLICY, validateMessagePolicy } from "../src/message/config.js";

describe("relayMode policy support", () => {
  it("默认策略为 takeover", () => {
    expect(DEFAULT_MESSAGE_POLICY.relayMode).toBe("takeover");
  });

  it("快照 payload 携带 relayMode", () => {
    const snapshot = createPolicySnapshot({ ...DEFAULT_MESSAGE_POLICY, relayMode: "passthrough" });
    expect(snapshot.payload["relayMode"]).toBe("passthrough");
  });

  it("非法 relayMode 被拒绝", () => {
    expect(() =>
      validateMessagePolicy({ ...DEFAULT_MESSAGE_POLICY, relayMode: "off" as never }),
    ).toThrow(/relayMode/);
  });
});
