import React from "react";
import { readFileSync } from "node:fs";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ChannelGrid } from "../src/pages/gateway/ChannelGrid.js";
import { RuntimeDetails } from "../src/pages/dashboard/DashboardPage.js";
import { StatusRail } from "../src/pages/dashboard/StatusRail.js";

describe("首页与消息页的产品级布局", () => {
  it("状态带只渲染四项，并给消息提供直达入口", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(StatusRail, {
          attentionCount: 1,
          hasError: false,
          hasWarn: true,
          healthyInspectionCount: 1,
          instanceCount: 1,
          downInstanceCount: 0,
          degradedInstanceCount: 0,
          inspectStatus: null,
          messageStats: {
            messageStatusKnown: true,
            messageConnected: true,
            failedAlertCount: 0,
            undeliveredCriticalCount: 0,
            deliveredCriticalCount: 0,
            pendingMessageAlerts: 0,
            relayEnabled: true,
          },
          runtimeDetailsOpen: false,
          onOpenRuntimeDetails: () => undefined,
          onOpenIssues: () => undefined,
        }),
      ),
    );

    expect((html.match(/dashboard-status-item/g) ?? [])).toHaveLength(4);
    expect(html).toContain('href="/gateway"');
    expect((html.match(/aria-controls="runtime-details"/g) ?? [])).toHaveLength(2);
    expect((html.match(/aria-expanded="false"/g) ?? [])).toHaveLength(2);
  });

  it("运行详情默认关闭", () => {
    const html = renderToStaticMarkup(
      React.createElement(RuntimeDetails, { open: false, onOpenChange: () => undefined }, "运行内容"),
    );

    expect(html).toContain('id="runtime-details"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("通道目录没有外层卡片，且始终带响应式网格容器", () => {
    const html = renderToStaticMarkup(
      React.createElement(App, null, React.createElement(ChannelGrid, { onReconnect: () => undefined })),
    );

    expect(html).toContain('class="channel-directory"');
    expect(html).toContain('class="channel-grid"');
    expect(html).toContain('id="channel-grid-heading"');
  });

  it("随手吩咐管家卡片提供即时通讯、本地知识库、定时任务与记忆便签直达入口", () => {
    const src = readFileSync(new URL("../src/pages/dashboard/DashboardPage.tsx", import.meta.url), "utf8");
    expect(src).toContain('to="/gateway?tab=im"');
    expect(src).toContain("即时通讯");
    expect(src).toContain('to="/knowledge"');
    expect(src).toContain("本地知识库");
    expect(src).toContain('to="/tasks"');
    expect(src).toContain("定时任务");
    expect(src).toContain('to="/skills"');
    expect(src).toContain("记忆便签");
  });
});
