/**
 * /approvals 列表页「快捷处理」的行内决策（批准 / 拒绝 / 追认 / 存疑）。
 *
 * 反馈口径与通知中心完全同源——这里不重复分类逻辑，只声明「这一单是从列表页
 * 下发的」，让审计能区分来源；同时给回归测试一个不依赖 DOM 的入口
 * （UI 测试环境是 node，点不到表格里的按钮）。
 */
import {
  APPROVAL_CHANNEL_PANEL,
  runApprovalDecision,
  type ApprovalDecision,
  type ApprovalDecisionDeps,
} from "../../lib/approval-decision.js";

/** 列表页行内决策的上报通道（与通知中心的 panel-notification 区分）。 */
export const INLINE_DECIDE_CHANNEL = APPROVAL_CHANNEL_PANEL;

export type { ApprovalDecision } from "../../lib/approval-decision.js";

/** 列表页行内决策：走共享执行器，只是把通道钉成 panel。 */
export async function runInlineDecision(
  deps: Omit<ApprovalDecisionDeps, "channel">,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  await runApprovalDecision({ ...deps, channel: INLINE_DECIDE_CHANNEL }, approvalId, decision);
}
