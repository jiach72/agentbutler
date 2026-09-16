/**
 * 审批行内决策的反馈分类与执行器（顶部通知中心与审批列表页共用同一套口径）。
 *
 * 为什么要放进 lib：两个入口此前各自写了一份分支。通知中心改成「业务竞态静默」
 * 之后，/approvals 列表页仍在每条失败弹 `message.warning`——客户截图里左上角
 * 那一摞 toast 的真正来源就是它。放在共享模块里，两处只能同源，不会再各改一半。
 *
 * 三分支的来源（客户截图缺陷）：
 * - 成功 → 一条成功提示；
 * - 传输层失败（status=0 网络/超时、5xx 后端故障）→ 一条错误提示，说清「没生效」：
 *   不出声会让用户以为点到了，其实什么都没发生；
 * - 业务竞态（409 already-settled / 410 expired / 404）→ **静默**：单子已被别人
 *   处理完，不是故障，靠刷新把陈旧条目收走即可。
 */

/** 一次决策的下达方向。 */
export type ApprovalDecision = "approve" | "deny";

/** 决策结果回包（与 lib/api 的 PostResult 同形，这里只取要用的两个字段）。 */
export interface DecisionResult {
  ok: boolean;
  status: number;
}

/** 一次决策最多给一条反馈；返回 null 表示「静默处理」（不弹任何提示）。 */
export type DecisionFeedback = { level: "success" | "error"; text: string } | null;

/** 决策上报通道：列表页与通知中心分别统计，审计里能区分来源。 */
export const APPROVAL_CHANNEL_PANEL = "panel";
export const APPROVAL_CHANNEL_NOTIFICATION = "panel-notification";

/** 决策超时：放行/拒绝会触发 watch 侧落地，比普通查询宽。 */
const DECIDE_TIMEOUT_MS = 30_000;

/**
 * 决策结果 → 用户反馈分类（纯函数，供回归测试直接钉住）。
 * 一次决策最多产生一条反馈：成功一条、失败一条、业务竞态零条。
 */
export function decisionFeedback(
  decision: ApprovalDecision,
  result: DecisionResult,
  options?: { isAudit?: boolean; blockFingerprint?: boolean; trustFingerprint?: boolean },
): DecisionFeedback {
  if (result.ok) {
    if (decision === "approve") {
      if (options?.trustFingerprint) return { level: "success", text: "已确认已知，并设为信任免核验" };
      if (options?.isAudit) return { level: "success", text: "已确认已知该异动" };
      return { level: "success", text: "已批准本次操作" };
    } else {
      if (options?.blockFingerprint) return { level: "success", text: "已标记存疑并拉黑阻断该动作指纹" };
      if (options?.isAudit) return { level: "success", text: "已将该异动标记存疑" };
      return { level: "success", text: "已拒绝本次操作" };
    }
  }
  if (result.status === 0) {
    return { level: "error", text: "没连上管家服务，这次操作没生效，请稍后重试" };
  }
  if (result.status >= 500) {
    return { level: "error", text: `管家服务异常（${result.status}），这次操作没生效，请稍后重试` };
  }
  return null;
}

/** 执行决策所需的能力，全部注入：UI 测试环境是 node，没有 DOM 也没有真实网络。 */
export interface ApprovalDecisionDeps {
  postJson: (url: string, body: unknown, timeoutMs: number) => Promise<DecisionResult>;
  onToast: (level: "success" | "error", text: string) => void;
  onSettled?: (decision: ApprovalDecision) => void;
  /** 上报通道，默认列表页（panel）；通知中心显式传 panel-notification。 */
  channel?: string;
}

/**
 * 执行决策并给出反馈/触发刷新。
 *
 * 无论成败都调用 `onSettled`：成功让该条归档消失，竞态/失败让面板与真实状态对齐，
 * 不能干等下一次轮询把旧条目带回来。
 */
export async function runApprovalDecision(
  deps: ApprovalDecisionDeps,
  approvalId: string,
  decision: ApprovalDecision,
  options?: {
    isAudit?: boolean;
    blockFingerprint?: boolean;
    trustFingerprint?: boolean;
    reason?: string;
  },
): Promise<void> {
  const result = await deps.postJson(
    `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      decision,
      actor: "panel-user",
      channel: deps.channel ?? APPROVAL_CHANNEL_PANEL,
      blockFingerprint: options?.blockFingerprint === true,
      trustFingerprint: options?.trustFingerprint === true,
      ...(options?.reason ? { reason: options.reason } : {}),
    },
    DECIDE_TIMEOUT_MS,
  );
  const feedback = decisionFeedback(decision, result, options);
  if (feedback !== null) deps.onToast(feedback.level, feedback.text);
  deps.onSettled?.(decision);
}
