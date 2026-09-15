/**
 * 审批单状态/来源的展示辅助（列表页与详情页共用，保持口径一致）。
 *
 * 高危动作有两类确认路径，语义必须分流（与 watch 侧 isAuditApproval 同源）：
 * - gate（事前放行）：执行器落地前请求放行，批准/拒绝阻塞执行，超时按拒绝拦截；
 * - audit（事后确认）：从 Hermes 已执行日志自动发现（detail.origin=auto-detect），
 *   动作已发生，按钮只是表态——「追认 / 存疑」，超时自动关闭而非拦截。
 */
import type { SemanticTone } from "../../components/StatusBadge.js";

/** audit（事后确认）来源标记：与 apps/watch/src/approvals.ts 的 AUDIT_ORIGIN 对齐。 */
export const AUDIT_ORIGIN = "auto-detect";

/** 判断审批单是否来自自动侦测（事后确认路径）；detail 非对象时视为 gate。 */
export function isAuditApproval(item: { detail: unknown }): boolean {
  if (typeof item.detail !== "object" || item.detail === null) return false;
  return (item.detail as Record<string, unknown>)["origin"] === AUDIT_ORIGIN;
}

/** 状态 → 品牌语义 tone（antd 预设色名与品牌信号色不是同一值，统一走 StatusBadge）。 */
export const approvalStatusTone = (status: string): SemanticTone => {
  const tone: Record<string, SemanticTone> = {
    pending: "warn",
    approved: "ok",
    denied: "error",
    expired: "error",
  };
  return tone[status] ?? "unknown";
};

/**
 * 状态文案按来源分流：
 * pending=待处理；approved=已批准/已追认；denied=已拒绝/已标记存疑；
 * expired=超时拦截/超时未确认。
 */
export function approvalStatusLabel(status: string, isAudit: boolean): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "approved":
      return isAudit ? "已追认" : "已批准";
    case "denied":
      return isAudit ? "已标记存疑" : "已拒绝";
    case "expired":
      return isAudit ? "超时未确认" : "超时拦截";
    default:
      return status;
  }
}
