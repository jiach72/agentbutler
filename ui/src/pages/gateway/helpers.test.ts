import { describe, expect, it } from "vitest";

import { relayModeCopy } from "./helpers.js";

describe("relayModeCopy", () => {
  it("接管中", () => {
    expect(relayModeCopy({ enabled: true, pending: false, updatedAt: null }).title).toBe("消息接管中");
  });
  it("原通道直发中", () => {
    expect(relayModeCopy({ enabled: false, pending: false, updatedAt: null }).title).toBe("原通道直发中");
  });
  it("待生效", () => {
    expect(relayModeCopy({ enabled: false, pending: true, updatedAt: null }).title).toBe("原通道直发中（待生效）");
  });
});
