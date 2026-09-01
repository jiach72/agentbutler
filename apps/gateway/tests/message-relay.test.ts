import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPolicySnapshot, DEFAULT_MESSAGE_POLICY, validateMessagePolicy } from "../src/message/config.js";
import { MessagePolicyStore } from "../src/message/store.js";

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

describe("relay_control store", () => {
  it("缺省为接管且无待生效标记", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-"));
    const store = new MessagePolicyStore(path.join(dir, "messages.sqlite"));
    try {
      expect(store.getRelayControl()).toEqual({ enabled: true, pending: false, updatedAt: null });
    } finally {
      store.close();
    }
  });

  it("写入后可读回并跨实例持久", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "butler-relay-"));
    const file = path.join(dir, "messages.sqlite");
    const first = new MessagePolicyStore(file);
    first.setRelayControl(false, true, "2026-09-01T00:00:00.000Z");
    first.close();
    const second = new MessagePolicyStore(file);
    try {
      expect(second.getRelayControl()).toEqual({
        enabled: false,
        pending: true,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    } finally {
      second.close();
    }
  });
});
