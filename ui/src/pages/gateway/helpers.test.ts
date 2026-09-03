import { describe, expect, it } from "vitest";

import {
  channelActionError,
  channelKindLabel,
  channelToggleAck,
  channelToggleWarnings,
  deriveRecoveryState,
  filterHistoryByDay,
  historyDayOptions,
  historySummaryLine,
  loginStateCopy,
  relayModeCopy,
} from "./helpers.js";
import type { AlertsView, MessageBridgeView, MessageOverviewPayload, RecoveryStateInput } from "./helpers.js";

const messageData = (overrides: Partial<MessageOverviewPayload> = {}): MessageOverviewPayload => ({
  reachable: true,
  status: null,
  messages: { counts: {}, items: [] },
  degraded: [],
  ...overrides,
});

const messageBridge = (overrides: Partial<MessageBridgeView> = {}): MessageBridgeView => ({
  connected: true,
  running: true,
  inFlight: false,
  attached: true,
  outboxWritable: true,
  protocolVersion: null,
  bridgeVersion: null,
  instanceId: null,
  policyVersion: null,
  remotePolicyVersion: null,
  channels: {},
  coverage: {},
  startedAt: null,
  lastCycleAt: null,
  lastError: null,
  ...overrides,
});

const alerts = (reachable: boolean): AlertsView => ({ reachable, counts: {}, degradedChannels: [], items: [] });
const recoveryInput = (overrides: Partial<RecoveryStateInput> = {}): RecoveryStateInput => ({
  messageData: null,
  messageBridge: null,
  watchReachable: undefined,
  alerts: null,
  loadError: false,
  ...overrides,
});

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

describe("deriveRecoveryState", () => {
  it("Bridge 未就绪时优先提示重新连接", () => {
    const state = deriveRecoveryState(recoveryInput({ messageBridge: messageBridge({ connected: false }) }));

    expect(state).toMatchObject({ reason: "bridge", severity: "critical", action: "reconnect" });
  });

  it("消息数据不可达时提供刷新操作", () => {
    const state = deriveRecoveryState(recoveryInput({ messageData: messageData({ reachable: false }) }));

    expect(state).toMatchObject({ reason: "messages", severity: "critical", action: "refresh" });
  });

  it("管家和通知服务不可达时按既定优先级归因", () => {
    expect(deriveRecoveryState(recoveryInput({ watchReachable: false }))?.reason).toBe("watch");
    expect(deriveRecoveryState(recoveryInput({ alerts: alerts(false) }))?.reason).toBe("alerts");
  });

  it("记录不完整和刷新失败会提示刷新", () => {
    expect(deriveRecoveryState(recoveryInput({ messageData: messageData({ degraded: ["outbox"] }) }))).toMatchObject({
      reason: "records",
      action: "refresh",
    });
    expect(deriveRecoveryState(recoveryInput({ loadError: true }))).toMatchObject({ reason: "refresh", action: "refresh" });
  });

  it("多故障只展示一个根因，其他问题放入降级明细", () => {
    const state = deriveRecoveryState(recoveryInput({
      messageBridge: messageBridge({ attached: false }),
      messageData: messageData({ reachable: false }),
      watchReachable: false,
      alerts: alerts(false),
      loadError: true,
    }));

    expect(state?.reason).toBe("bridge");
    expect(state?.details.map((detail) => detail.reason)).toEqual(["messages", "watch", "alerts", "refresh"]);
  });
});

describe("对照历史日期分组与摘要", () => {
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const items = [
    { inbound: { receivedAt: iso(0) } },
    { inbound: { receivedAt: iso(-3_600_000) } },
    { inbound: { receivedAt: iso(-86_400_000) } },
    { inbound: { receivedAt: "not-a-date" } },
  ];

  it("historyDayOptions 按天聚合并把最近一天标为今天", () => {
    const options = historyDayOptions(items);
    expect(options[0].label.startsWith("今天")).toBe(true);
    expect(options[0].count).toBe(2);
    expect(options[1].label.startsWith("昨天")).toBe(true);
    expect(options.reduce((sum, o) => sum + o.count, 0)).toBe(3);
  });

  it("filterHistoryByDay 只保留所选日期，null 表示全部", () => {
    const day = historyDayOptions(items)[0]?.key ?? null;
    expect(filterHistoryByDay(items, day)).toHaveLength(2);
    expect(filterHistoryByDay(items, null)).toHaveLength(4);
  });

  it("historySummaryLine 取首个非空行并截断", () => {
    expect(historySummaryLine("\n  第二行内容\n第三行")).toBe("第二行内容");
    expect(historySummaryLine("x".repeat(80))).toHaveLength(65);
    expect(historySummaryLine("")).toBe("（图片或语音消息，没有文字）");
  });
});
