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
import {
  APPROVAL_CHANNEL_NOTIFICATION,
  decisionFeedback,
  runApprovalDecision,
  type ApprovalDecision,
} from "../src/lib/approval-decision.js";
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

/**
 * 行内「批准 / 拒绝」的决策反馈（客户截图两个缺陷的回归闸）：
 * - 截图 1：已被处理的单子每条都弹提示，左上角堆成一摞 → 业务竞态必须静默；
 * - 截图 2：决策后该条通知不消失 → 无论成败都要触发刷新。
 *
 * 这两条此前零覆盖（UI 测试环境是 node，无 DOM，点不了按钮），故把分支抽成
 * 纯函数 + 注入式执行器，在这里直接钉住。
 */
describe("通知中心：行内审批决策的反馈与刷新", () => {
  it("业务竞态（409 已处理 / 410 已超时 / 404）不弹任何提示，消除左上角 toast 堆叠", () => {
    for (const status of [409, 410, 404, 400]) {
      expect(decisionFeedback("approve", { ok: false, status })).toBeNull();
    }
  });

  it("成功只给一条成功提示，批准/拒绝文案不同", () => {
    expect(decisionFeedback("approve", { ok: true, status: 200 })).toEqual({
      level: "success",
      text: "已批准本次操作",
    });
    expect(decisionFeedback("deny", { ok: true, status: 200 })).toEqual({
      level: "success",
      text: "已拒绝本次操作",
    });
  });

  it("传输层失败必须出声：网络中断与 5xx 各一条错误提示，且说清「没生效」", () => {
    const offline = decisionFeedback("approve", { ok: false, status: 0 });
    expect(offline).toEqual({
      level: "error",
      text: "没连上管家服务，这次操作没生效，请稍后重试",
    });
    const broken = decisionFeedback("approve", { ok: false, status: 503 });
    expect(broken?.level).toBe("error");
    expect(broken?.text).toContain("503");
    expect(broken?.text).toContain("没生效");
  });

  /** 记录一次决策产生的全部副作用（URL、上报体、提示、刷新）。 */
  async function run(status: { ok: boolean; status: number }, decision: ApprovalDecision = "approve") {
    const toasts: string[] = [];
    const settled: ApprovalDecision[] = [];
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    await runApprovalDecision(
      {
        postJson: async (url, body) => {
          requestedUrl = url;
          requestedBody = body as Record<string, unknown>;
          return status;
        },
        onToast: (_level, text) => {
          toasts.push(text);
        },
        onSettled: (value) => {
          settled.push(value);
        },
        channel: APPROVAL_CHANNEL_NOTIFICATION,
      },
      "ap-1",
      decision,
    );
    return { toasts, settled, requestedUrl, requestedBody };
  }

  it("决策后必定触发刷新：成功让该条归档消失，竞态也让面板与真实状态对齐", async () => {
    const ok = await run({ ok: true, status: 200 });
    expect(ok.settled).toEqual(["approve"]);
    expect(ok.toasts).toHaveLength(1);
    expect(ok.requestedUrl).toBe("/api/approvals/ap-1/decide");
    // 通道必须是通知中心自己的，与列表页（panel）在审计里分得开
    expect(ok.requestedBody["channel"]).toBe(APPROVAL_CHANNEL_NOTIFICATION);
    expect(ok.requestedBody["decision"]).toBe("approve");

    // 已被处理：不弹提示，但刷新照旧（该条才会从面板消失）
    const stale = await run({ ok: false, status: 409 }, "deny");
    expect(stale.toasts).toHaveLength(0);
    expect(stale.settled).toEqual(["deny"]);
  });

  it("一次决策最多一条提示：传输层失败也只弹一次，不会叠加", async () => {
    const offline = await run({ ok: false, status: 0 });
    expect(offline.toasts).toHaveLength(1);
    expect(offline.settled).toEqual(["approve"]);
  });
});
