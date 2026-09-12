/**
 * 顶部通知中心（规范 03 §3.8）。
 *
 * 【本轮规格变更（评审 P1-8）】原规格是「预览列表只显示通知标题」，
 * 但那让 warn 与 critical 无法区分、看不见「同类已合并 3 次」、也看不到失败原因，
 * 点击还只标记已读不跳转 —— 通知中心退化成「标题预览器」。
 * 新规格：每条给出严重度 + 相对时间 + 标题 + 正文摘要（+ 合并次数 / 失败原因），
 * 点击即标记已读并跳到对应页面；同时列表与徽标必须用同一份过滤结果计数。
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationPreviewList, notificationTarget } from "../src/components/NotificationCenter.js";
import { countUnread, visibleForPreference } from "../src/hooks/useNotifications.js";
import type { NotificationItem } from "../src/hooks/useNotifications.js";

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
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
    ...overrides,
  };
}

describe("顶部通知中心", () => {
  it("每条通知给出严重度徽标、相对时间与正文摘要，并保留未读标记", () => {
    const html = renderToStaticMarkup(
      React.createElement(NotificationPreviewList, { items: [item()], onRead: () => undefined }),
    );

    expect(html).toContain("消息网关需要重新连接");
    expect(html).toContain('aria-label="未读"');
    // critical 必须能一眼看出是「紧急」，而不是和提醒长得一样
    expect(html).toContain("紧急");
    // 正文摘要：只说标题时用户无法判断要不要点进去
    expect(html).toContain("Bridge 已断开连接");
    // 内部字段不外泄
    expect(html).not.toContain("gateway</");
  });

  it("合并次数与发送失败原因要显式写出来", () => {
    const html = renderToStaticMarkup(
      React.createElement(NotificationPreviewList, {
        items: [item({ mergedCount: 3, status: "failed", lastError: "连接超时" })],
        onRead: () => undefined,
      }),
    );

    expect(html).toContain("同类已合并 3 次");
    expect(html).toContain("连接超时");
  });

  it("徽标数与列表条目数同源：按偏好收窄后一起收敛", () => {
    const items = [
      item({ id: 1, severity: "warn" }),
      item({ id: 2, severity: "critical" }),
      item({ id: 3, severity: "info" }),
    ].filter((entry) => entry.severity === "warn" || entry.severity === "critical");

    // 默认「提醒及以上」：warn + critical 都可见，未读 2 条
    const wide = items.filter((entry) => visibleForPreference(entry, "warn"));
    expect(wide).toHaveLength(2);
    expect(countUnread(wide)).toBe(2);

    // 收窄到「仅紧急」：列表只剩 1 条，计数也必须跟着变 1（原来会停在 2）
    const narrow = items.filter((entry) => visibleForPreference(entry, "critical"));
    expect(narrow).toHaveLength(1);
    expect(countUnread(narrow)).toBe(1);

    // 已读条目不进计数
    const read = [{ ...items[0], readAt: "2026-09-03T01:00:00.000Z" }];
    expect(countUnread(read)).toBe(0);
  });

  it("点击可跳转：按通知类型映射到对应页面，未知类型回落到事件中心", () => {
    expect(notificationTarget(item({ kind: "message-failed", source: "gateway" })).to).toBe("/gateway");
    expect(notificationTarget(item({ kind: "budget-threshold", source: "cost" })).to).toBe("/cost");
    expect(notificationTarget(item({ kind: "runbook-failed", source: "watch" })).to).toBe("/troubleshoot");
    expect(notificationTarget(item({ kind: "approval-pending", source: "watch" })).to).toBe("/approvals");
    expect(notificationTarget(item({ kind: "memory-write", source: "watch" })).to).toBe("/memory-diff");
    // 映射不到时必须有一个确定的落点，不能让用户点了没反应
    expect(notificationTarget(item({ kind: "something-new", source: "unknown" })).to).toBe("/events");
  });
});
