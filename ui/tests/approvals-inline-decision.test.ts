/**
 * 审批列表页（/approvals「快捷处理」）行内决策的回归闸。
 *
 * 缺陷来源：通知中心改成「业务竞态静默」之后，列表页那份分支没跟着改，仍在
 * 每条失败都弹 `message.warning`（「该审批单已被处理或已升级」/「操作失败（HTTP xxx）」）
 * ——客户截图里左上角那一摞 toast 就是从这儿来的。现在列表页与通知中心共用
 * lib/approval-decision，这组用例把「静默 + 仍刷新」钉在列表页这一侧。
 *
 * UI 测试环境是 node、没有 DOM，点不到表格里的按钮，故断言打在页面实际调用的
 * 那个入口（pages/approvals/decision.ts 的 runInlineDecision）上：它发什么请求、
 * 弹几条提示、有没有触发刷新，与页面运行时完全一致。
 */
import { describe, expect, it } from "vitest";
import { runInlineDecision, INLINE_DECIDE_CHANNEL } from "../src/pages/approvals/decision.js";
import {
  APPROVAL_CHANNEL_NOTIFICATION,
  decisionFeedback,
  type ApprovalDecision,
  type DecisionResult,
} from "../src/lib/approval-decision.js";

/** 跑一次列表页行内决策，记录它产生的全部副作用。 */
async function runInline(
  status: DecisionResult,
  decision: ApprovalDecision = "approve",
  approvalId = "ap-1",
) {
  const toasts: string[] = [];
  const settled: ApprovalDecision[] = [];
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  await runInlineDecision(
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
    },
    approvalId,
    decision,
  );
  return { toasts, settled, requestedUrl, requestedBody };
}

describe("审批列表页：行内快捷决策", () => {
  /** 业务竞态：单子已被处理/已升级/已超时，不是故障，必须静默。 */
  const settledStatuses = [409, 410, 404];

  it("已处理 / 已升级 / 已超时的单子不弹提示，但仍然刷新（陈旧行才会消失）", async () => {
    for (const status of settledStatuses) {
      for (const decision of ["approve", "deny"] as ApprovalDecision[]) {
        const run = await runInline({ ok: false, status }, decision);
        expect(run.toasts, `HTTP ${status} 不该弹提示`).toHaveLength(0);
        // 静默不等于什么都不做：刷新照旧，否则这一行会一直停在「待处理」
        expect(run.settled).toEqual([decision]);
      }
    }
  });

  it("旧实现弹的「该审批单已被处理或已升级」不再出现", async () => {
    const run = await runInline({ ok: false, status: 409 });
    expect(run.toasts.join(" ")).not.toContain("已被处理");
    expect(run.toasts.join(" ")).not.toContain("操作失败");
  });

  it("成功给一条成功提示并刷新，批准与拒绝文案不同", async () => {
    const approved = await runInline({ ok: true, status: 200 }, "approve");
    expect(approved.toasts).toEqual(["已批准本次操作"]);
    expect(approved.settled).toEqual(["approve"]);

    const denied = await runInline({ ok: true, status: 200 }, "deny");
    expect(denied.toasts).toEqual(["已拒绝本次操作"]);
    expect(denied.settled).toEqual(["deny"]);
  });

  it("真的没生效时才出声：网络中断与 5xx 各一条错误提示，且说清「没生效」", async () => {
    const offline = await runInline({ ok: false, status: 0 });
    expect(offline.toasts).toEqual(["没连上管家服务，这次操作没生效，请稍后重试"]);
    expect(offline.settled).toEqual(["approve"]);

    const broken = await runInline({ ok: false, status: 503 });
    expect(broken.toasts).toHaveLength(1);
    expect(broken.toasts[0]).toContain("503");
    expect(broken.toasts[0]).toContain("没生效");
    expect(broken.settled).toEqual(["approve"]);
  });

  it("一次决策最多一条提示：任何状态都不会叠加", async () => {
    for (const status of [200, 0, 400, 404, 409, 410, 500, 503]) {
      const run = await runInline({ ok: status < 400 && status !== 0, status });
      expect(run.toasts.length, `HTTP ${status}`).toBeLessThanOrEqual(1);
      expect(run.settled).toHaveLength(1);
    }
  });

  it("请求打在 /decide 上、通道是列表页自己的 panel（与通知中心区分）", async () => {
    const run = await runInline({ ok: true, status: 200 }, "approve", "ap 1");
    expect(run.requestedUrl).toBe("/api/approvals/ap%201/decide");
    expect(run.requestedBody["decision"]).toBe("approve");
    expect(run.requestedBody["actor"]).toBe("panel-user");
    expect(run.requestedBody["channel"]).toBe(INLINE_DECIDE_CHANNEL);
    expect(run.requestedBody["channel"]).toBe("panel");
    expect(run.requestedBody["channel"]).not.toBe(APPROVAL_CHANNEL_NOTIFICATION);
  });

  it("与通知中心同源：同一结果在两处的提示条数完全一致", async () => {
    for (const status of [200, 0, 400, 404, 409, 410, 500, 503]) {
      for (const decision of ["approve", "deny"] as ApprovalDecision[]) {
        const result: DecisionResult = { ok: status >= 200 && status < 300, status };
        const expected = decisionFeedback(decision, result) === null ? 0 : 1;
        const run = await runInline(result, decision);
        expect(run.toasts.length, `HTTP ${status} / ${decision}`).toBe(expected);
      }
    }
  });
});
