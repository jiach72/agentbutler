import { describe, expect, it } from "vitest";

import {
  channelActionError,
  channelKindLabel,
  channelToggleAck,
  channelToggleWarnings,
  loginStateCopy,
  relayModeCopy,
} from "./helpers.js";

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

describe("channelToggleWarnings", () => {
  it("正常重启无警示", () => {
    expect(channelToggleWarnings({ restarting: true })).toEqual([]);
    expect(channelToggleWarnings(channelToggleAck(null))).toEqual([]);
  });
  it("Bridge 附带 warning 原样透出", () => {
    expect(channelToggleWarnings({ restarting: true, warning: "该通道被环境变量强制启用" })).toEqual([
      "该通道被环境变量强制启用",
    ]);
  });
  it("restarting=false 提示手动重启", () => {
    expect(channelToggleWarnings({ restarting: false })).toEqual([
      "已保存，但未触发通道重启，需要手动重启本机 AI 后生效",
    ]);
  });
  it("warning 与 restarting=false 同时存在时都展示", () => {
    expect(channelToggleWarnings({ restarting: false, warning: "说明" })).toHaveLength(2);
  });
  it("空字符串 warning 不展示", () => {
    expect(channelToggleWarnings({ restarting: true, warning: "" })).toEqual([]);
  });
});

describe("channelActionError", () => {
  it("优先取响应体 error/detail", () => {
    expect(channelActionError(502, { error: "代理不可达" })).toBe("代理不可达");
    expect(channelActionError(503, { detail: "会话不存在" })).toBe("会话不存在");
  });
  it("body 只有 code（E302/E303）时按状态码给通用文案", () => {
    expect(channelActionError(503, { code: "E302" })).toBe("操作失败（HTTP 503），请稍后重试");
  });
  it("status=0 表示请求未送达", () => {
    expect(channelActionError(0, null)).toBe("请求未送达，请确认管家服务正在运行");
  });
});
