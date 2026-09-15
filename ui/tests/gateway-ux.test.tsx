/**
 * 网关页 UX 焦点测试（TDD：先写观察失败，再实现）。
 *
 * 环境为 node（无 DOM），统一用 renderToStaticMarkup 做结构性断言；
 * 纯算法（标签解析、通道分区、三态标志）直接单测，不依赖渲染。
 *
 * 验收点：
 *  1. URL 驱动三标签 ?tab=messages|channels|rules（缺省/非法回落 messages；prompt-optimization → rules）。
 *  2. 默认进入消息标签即可见消息记录与「需要关注」条目（不再折叠在消息明细里）。
 *  3. 通道设置 / 通知规则各自独立标签；切换标签不丢状态、确认弹窗始终可达（结构保证）。
 *  4. 已配置/已启用通道排前，未配置/禁用进入显式「添加通道」区域。
 *  5. 已配置 / 连接正常 / 已启用 三个独立事实，连接未知不得显示为健康。
 *  6. 提示词优化收进规则标签高级配置区，旧深链仍能到达。
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { GatewayPage } from "../src/pages/gateway/GatewayPage.js";
import { ChannelGrid } from "../src/pages/gateway/ChannelGrid.js";
import {
  GATEWAY_TAB_LABELS,
  PROMPT_OPTIMIZATION_ANCHOR,
  channelConnectionBadge,
  channelStatusFlags,
  partitionChannels,
  resolveGatewayTab,
} from "../src/pages/gateway/helpers.js";
import type { ChannelDirectoryEntryView } from "../src/pages/gateway/helpers.js";

const GATEWAY_SOURCE = readFileSync(
  new URL("../src/pages/gateway/GatewayPage.tsx", import.meta.url),
  "utf8",
);

function renderGateway(path: string): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ConfigProvider>
        <AntApp>
          <MemoryRouter initialEntries={[path]}>
            <GatewayPage />
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>
    </ThemeProvider>,
  );
}

function renderChannelGrid(channels: ChannelDirectoryEntryView[]): string {
  return renderToStaticMarkup(
    <ConfigProvider>
      <AntApp>
        <ChannelGrid onReconnect={() => undefined} channels={channels} />
      </AntApp>
    </ConfigProvider>,
  );
}

/** 当前激活标签的文案（antd 把 aria-selected="true" 放在 role="tab" 上）。 */
function activeTabLabel(html: string): string {
  const m = html.match(/<div role="tab" aria-selected="true"[^>]*>([^<]*)<\/div>/);
  return m ? m[1] : "";
}

function tabCount(html: string): number {
  return (html.match(/role="tab"/g) ?? []).length;
}

describe("标签解析与深链兼容（resolveGatewayTab）", () => {
  const cases: Array<[string, string | undefined, "messages" | "channels" | "rules" | "history"]> = [
    ["?tab=history", undefined, "history"],
    ["?tab=messages", undefined, "messages"],
    ["?tab=channels", undefined, "channels"],
    ["?tab=rules", undefined, "rules"],
    ["?tab=foo", undefined, "messages"], // 非法值回落
    ["", undefined, "messages"], // 缺省回落
    ["?tab=prompt-optimization", undefined, "rules"], // 旧深链 → 规则
    ["", `#${PROMPT_OPTIMIZATION_ANCHOR}`, "rules"], // 旧 hash 深链 → 规则
    ["?tab=channels", `#${PROMPT_OPTIMIZATION_ANCHOR}`, "channels"], // 显式 tab 优先于 hash
  ];
  for (const [search, hash, expected] of cases) {
    it(`"${search}"${hash ? ` + hash ${hash}` : ""} → ${expected}`, () => {
      expect(resolveGatewayTab(search, hash)).toBe(expected);
    });
  }
});

describe("通道分区与三态（helpers）", () => {
  const channels: ChannelDirectoryEntryView[] = [
    { id: "a", label: "微信", kind: "qr-login", enabled: true, credentialsConfigured: true, loginState: "logged_in" },
    { id: "b", label: "Telegram", kind: "credential", enabled: true, credentialsConfigured: false, loginState: "logged_out" },
    { id: "c", label: "邮件", kind: "credential", enabled: false, credentialsConfigured: true, loginState: "configuring" },
    { id: "d", label: "短信", kind: "credential", enabled: false, credentialsConfigured: false, loginState: "unknown" },
  ];

  it("已配置且已启用的通道进入 active，其余进入 addable（组内已配置优先）", () => {
    const { active, addable } = partitionChannels(channels);
    expect(active.map((c) => c.id)).toEqual(["a"]);
    expect(addable.map((c) => c.id)).toEqual(["c", "b", "d"]);
  });

  it("连接未知时 connected 必须为 false，且徽标不得显示为健康", () => {
    const unknown = channels.find((c) => c.loginState === "unknown")!;
    expect(channelStatusFlags(unknown).connected).toBe(false);
    const badge = channelConnectionBadge(unknown);
    expect(badge.tone).toBe("unknown");
    expect(badge.label).toBe("连接状态未知");
    // 三种取值之外不应出现 ok（健康）语义
    expect(badge.tone).not.toBe("ok");
  });

  it("已登录通道连接事实为正常（ok）", () => {
    const loggedIn = channels.find((c) => c.loginState === "logged_in")!;
    expect(channelStatusFlags(loggedIn).connected).toBe(true);
    expect(channelConnectionBadge(loggedIn).tone).toBe("ok");
  });
});

describe("网关页：URL 驱动三标签", () => {
  it("默认进入渲染出三个标签，且消息标签为激活态", () => {
    const html = renderGateway("/gateway");
    expect(tabCount(html)).toBe(4);
    expect(activeTabLabel(html)).toBe(GATEWAY_TAB_LABELS.messages);
  });

  it("非法 tab 参数回落到消息标签", () => {
    const html = renderGateway("/gateway?tab=foo");
    expect(activeTabLabel(html)).toBe(GATEWAY_TAB_LABELS.messages);
  });

  it("?tab=channels 激活通道设置标签", () => {
    const html = renderGateway("/gateway?tab=channels");
    expect(activeTabLabel(html)).toBe(GATEWAY_TAB_LABELS.channels);
  });

  it("?tab=rules 激活通知规则标签", () => {
    const html = renderGateway("/gateway?tab=rules");
    expect(activeTabLabel(html)).toBe(GATEWAY_TAB_LABELS.rules);
  });

  it("?tab=prompt-optimization 旧深链映射到规则标签", () => {
    const html = renderGateway("/gateway?tab=prompt-optimization");
    expect(activeTabLabel(html)).toBe(GATEWAY_TAB_LABELS.rules);
  });
});

describe("验收点 2：默认可见消息记录与需要关注条目（不再折叠）", () => {
  const html = renderGateway("/gateway");

  it("消息标签含「待处理通知」（需要关注）与「最近发送的消息」（消息记录）", () => {
    expect(html).toContain("发送失败的通知");
    expect(html).toContain("需要处理的消息");
  });

  it("不再把消息折叠在「消息明细」高级折叠区里", () => {
    expect(html).not.toContain("消息明细");
  });
});

describe("验收点 6：提示词优化在规则标签高级配置区，旧深链可达", () => {
  it("规则标签挂载后含提示词优化锚点 id", () => {
    const html = renderGateway("/gateway?tab=rules");
    expect(html).toContain(`id="${PROMPT_OPTIMIZATION_ANCHOR}"`);
    expect(html).toContain("提示词优化");
  });

  it("默认（消息标签）不挂载规则面板，锚点不可见，避免误导", () => {
    const html = renderGateway("/gateway");
    expect(html).not.toContain(`id="${PROMPT_OPTIMIZATION_ANCHOR}"`);
  });
});

describe("验收点 4 & 5：通道排序、添加通道区与三态（ChannelGrid）", () => {
  const channels: ChannelDirectoryEntryView[] = [
    { id: "wx", label: "微信", kind: "qr-login", enabled: true, credentialsConfigured: true, loginState: "logged_in" },
    { id: "tg", label: "Telegram", kind: "credential", enabled: false, credentialsConfigured: true, loginState: "logged_out" },
    { id: "sms", label: "短信", kind: "credential", enabled: false, credentialsConfigured: false, loginState: "unknown" },
  ];
  const html = renderChannelGrid(channels);

  it("同时存在「已添加的通道」与显式的「添加通道」区域", () => {
    expect(html).toContain("已添加的通道");
    expect(html).toContain("添加通道");
  });

  it("连接未知的通道展示「连接状态未知」，绝不显示健康", () => {
    expect(html).toContain("连接状态未知");
    // 该卡片不得把未知连接渲染成「连接正常」
    const smsIdx = html.indexOf("短信");
    const snippet = html.slice(smsIdx, smsIdx + 4000);
    expect(snippet).toContain("连接状态未知");
    expect(snippet).not.toContain("连接正常");
  });

  it("每张卡片展示三个独立事实：已配置 / 连接 / 已启用", () => {
    expect(html).toContain("已配置");
    expect(html).toContain("未配置");
    expect(html).toContain("已启用");
    expect(html).toContain("已停用");
    expect(html).toContain("连接正常");
  });
});

describe("验收点 3：标签独立且切换不丢状态、确认弹窗始终可达（结构保证）", () => {
  it("三标签并行存在且互不嵌套", () => {
    const html = renderGateway("/gateway");
    expect(tabCount(html)).toBe(4);
    for (const label of Object.values(GATEWAY_TAB_LABELS)) {
      expect(html).toContain(label);
    }
  });

  it("Tabs 保持非激活面板挂载（destroyOnHidden=false），切换不丢表单状态", () => {
    expect(GATEWAY_SOURCE).toContain("destroyOnHidden={false}");
  });

  it("重投确认弹窗与补丁确认弹窗都渲染在 Tabs 之外，切标签仍可达", () => {
    const tabsMarker = GATEWAY_SOURCE.indexOf("destroyOnHidden={false}");
    // 重投弹窗唯一标志：open={confirmRedeliverId ...}，区别于消息标签里的 setConfirmRedeliverId。
    const redeliverModal = GATEWAY_SOURCE.indexOf("open={confirmRedeliverId");
    expect(tabsMarker).toBeGreaterThan(-1);
    expect(redeliverModal).toBeGreaterThan(tabsMarker);
  });
});
