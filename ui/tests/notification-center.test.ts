import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationTitleList } from "../src/components/NotificationCenter.js";
import type { NotificationItem } from "../src/hooks/useNotifications.js";

describe("顶部通知中心", () => {
  it("预览列表只显示通知标题，保留未读状态和已读动作", () => {
    const item: NotificationItem = {
      id: 1,
      kind: "service",
      title: "消息网关需要重新连接",
      body: "Bridge 已断开连接，请检查本机服务与网络状态。",
      severity: "critical",
      source: "gateway",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      readAt: null,
      status: "pending",
    };

    const html = renderToStaticMarkup(
      React.createElement(NotificationTitleList, { items: [item], onRead: () => undefined }),
    );

    expect(html).toContain(item.title);
    expect(html).toContain('aria-label="未读"');
    expect(html).not.toContain(item.body);
    expect(html).not.toContain(item.source);
    expect(html).not.toContain("紧急");
  });
});
