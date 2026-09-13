/**
 * 消息明细面板（MessageInspector）状态过滤 chips 与详情管理动作的结构断言。
 *
 * 环境：node（无 DOM），沿用 gateway-ux 的 renderToStaticMarkup 结构性断言。
 *
 * 背景（BugFix：漏消息状态不可见）：
 *  1. chips 原来只有 captured / held_dnd / ready / delivered / dead_letter，
 *     缺 delivery_unknown（结果未知）与 cancelled（已取消）——历史消息里
 *     这两态各有一批（微信平台事故产生），用户在面板上完全看不到，误以为漏消息。
 *  2. delivery_unknown 不是终态，Bridge requeue 只接受 dead_letter，
 *     详情面板给出「结果未知 + 通道恢复后核实」的提示，不提供重投按钮（防重复发送）。
 *  3. cancelled 是策略主动放弃的终态（被新回复/新任务取代），非故障，
 *     徽标走中性 unknown tone（时钟图标），不带错误暗示。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App as AntApp, ConfigProvider } from "antd";
import { MessageInspector, MESSAGE_CHIP_STATES } from "../src/pages/gateway/MessageInspector.js";
import { statusTone } from "../src/pages/gateway/helpers.js";
import type { MessageBridgeView, MessageItemView } from "../src/pages/gateway/helpers.js";

const bridge: MessageBridgeView = {
  connected: true,
  running: true,
  inFlight: false,
  attached: true,
  outboxWritable: true,
  protocolVersion: 1,
  bridgeVersion: "test",
  instanceId: "hermes-test",
  policyVersion: "test",
  remotePolicyVersion: "test",
  channels: {},
  coverage: {},
  startedAt: null,
  lastCycleAt: null,
  lastError: null,
};

/** 最小可用消息投影：只有 chips/详情断言真正消费的字段。 */
const message = (overrides: Partial<MessageItemView> = {}): MessageItemView => ({
  messageId: "m-1",
  instanceId: "hermes-test",
  adapterId: "hermes",
  channel: "weixin",
  chatId: "chat-1",
  sessionId: "session-1",
  runId: null,
  inboundMessageId: null,
  messageKind: "final",
  transport: "queued-push",
  priority: "normal",
  content: "内容",
  metadata: {},
  capturedAt: "2026-02-22T08:00:00.000Z",
  sequence: 1,
  state: "delivered",
  availableAt: null,
  attemptCount: 1,
  providerMessageId: null,
  deliveredAt: "2026-02-22T08:00:01.000Z",
  lastError: null,
  transformTrace: [],
  lastPolicyError: null,
  updatedAt: "2026-02-22T08:00:01.000Z",
  ...overrides,
});

function renderInspector(overrides: {
  items?: MessageItemView[];
  selected?: MessageItemView | null;
}): string {
  const items = overrides.items ?? [];
  const selected =
    overrides.selected === undefined ? (items[0] ?? null) : overrides.selected;
  return renderToStaticMarkup(
    <ConfigProvider>
      <AntApp>
        <MessageInspector
          messageBridge={bridge}
          coverageEntries={[]}
          messageCounts={{ delivery_unknown: 53, cancelled: 24 }}
          messageItems={items}
          messagesReachable
          selectedMessage={selected}
          onSelectMessage={() => undefined}
          taskData={null}
          taskLoading={false}
          onRedeliver={() => undefined}
          onExpedite={() => undefined}
        />
      </AntApp>
    </ConfigProvider>,
  );
}

describe("状态计数 chips 覆盖 delivery_unknown 与 cancelled", () => {
  it("导出的 chips 状态清单包含两态，且仍保留原有五态", () => {
    expect([...MESSAGE_CHIP_STATES]).toEqual([
      "captured",
      "held_dnd",
      "ready",
      "delivered",
      "delivery_unknown",
      "dead_letter",
      "cancelled",
    ]);
  });

  it("渲染结果包含「结果未知」与「已取消」chip（计数 53 / 24 来自 overview）", () => {
    const html = renderInspector({ items: [] });
    expect(html).toContain("结果未知");
    expect(html).toContain("已取消");
    expect(html).toContain("53");
    expect(html).toContain("24");
  });

  it("chip 文案沿用 MESSAGE_STATE_LABELS 既有翻译，不另起用词", () => {
    expect(statusTone("delivery_unknown").label).toBe("结果未知");
    expect(statusTone("cancelled").label).toBe("已取消");
  });
});

describe("delivery_unknown 详情：提示但不提供重投动作", () => {
  const unknown = message({ messageId: "m-unknown", state: "delivery_unknown" });

  it("展示结果未知提示与「勿重复发送」边界说明", () => {
    const html = renderInspector({ items: [unknown], selected: unknown });
    expect(html).toContain("这条消息的发送结果未知");
    expect(html).toContain("请勿重复发送");
  });

  it("不渲染死信重投按钮（requeue 只接受 dead_letter）", () => {
    const html = renderInspector({ items: [unknown], selected: unknown });
    expect(html).not.toContain("重新投递");
  });
});

describe("dead_letter 详情保持既有重投入口不回归", () => {
  const dead = message({ messageId: "m-dead", state: "dead_letter", lastError: "provider 500" });

  it("死信详情仍然提供「重新投递」", () => {
    const html = renderInspector({ items: [dead], selected: dead });
    expect(html).toContain("重新投递");
  });
});

describe("cancelled 徽标走中性语义，不带错误暗示", () => {
  const cancelled = message({ messageId: "m-cancelled", state: "cancelled" });

  it("statusTone(cancelled) 是 unknown tone + 已取消文案", () => {
    const badge = statusTone("cancelled");
    expect(badge.tone).toBe("unknown");
    expect(badge.label).toBe("已取消");
  });

  it("cancelled 消息详情渲染中性徽标（data-tone=unknown），无错误徽标", () => {
    const html = renderInspector({ items: [cancelled], selected: cancelled });
    expect(html).toContain('data-tone="unknown"');
    expect(html).not.toContain('data-tone="error"');
  });
});
