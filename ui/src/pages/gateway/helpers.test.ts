import { describe, expect, it } from "vitest";

import { channelKindLabel, loginStateCopy, relayModeCopy } from "./helpers.js";

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

describe("channel copy helpers", () => {
  it("登录态文案", () => {
    expect(loginStateCopy("logged_in")).toBe("已登录");
    expect(loginStateCopy("logged_out")).toBe("未登录");
    expect(loginStateCopy("configuring")).toBe("待配置");
    expect(loginStateCopy("unknown")).toBe("未知");
  });
  it("类型文案", () => {
    expect(channelKindLabel("qr-login")).toBe("扫码登录");
    expect(channelKindLabel("credential")).toBe("凭据接入");
  });
});
