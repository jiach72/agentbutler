/**
 * 状态总览条：管家服务 / 消息通知 / 待处理 / AI 助手 四张卡片。
 */
import { Link } from "react-router-dom";
import { formatRelative } from "../../lib/format.js";
import type { MessageStats } from "./conclusions.js";
import type { InspectStatusView, StatusCardView } from "./types.js";

interface StatusRailProps {
  attentionCount: number;
  hasError: boolean;
  hasWarn: boolean;
  healthyInspectionCount: number;
  instanceCount: number;
  downInstanceCount: number;
  degradedInstanceCount: number;
  inspectStatus: InspectStatusView | null;
  messageStats: MessageStats;
  onOpenAdvanced: () => void;
}

export function StatusRail({
  attentionCount,
  hasError,
  hasWarn,
  healthyInspectionCount,
  instanceCount,
  downInstanceCount,
  degradedInstanceCount,
  inspectStatus,
  messageStats,
  onOpenAdvanced,
}: StatusRailProps) {
  const assistantTone: StatusCardView["tone"] =
    downInstanceCount > 0
      ? "error"
      : degradedInstanceCount > 0
        ? "warn"
        : healthyInspectionCount > 0
          ? "ok"
          : "idle";

  const cards: StatusCardView[] = [
    {
      id: "watch",
      tone: inspectStatus === null ? "idle" : inspectStatus.reachable ? "ok" : "warn",
      label: "管家服务",
      value: inspectStatus === null ? "读取中" : inspectStatus.reachable ? "在线" : "离线",
      detail:
        inspectStatus === null
          ? "正在读取本机状态"
          : inspectStatus.reachable
            ? `上次检查 ${formatRelative(inspectStatus.lastAt)}`
            : "暂时连不上，稍后会自动重试",
    },
    {
      id: "gateway",
      tone: !messageStats.messageStatusKnown
        ? "idle"
        : messageStats.messageConnected
          ? messageStats.pendingMessageAlerts > 0 || messageStats.deliveredCriticalCount > 0
            ? "warn"
            : "ok"
          : "error",
      label: "消息通知",
      value: !messageStats.messageStatusKnown ? "读取中" : messageStats.messageConnected ? "在线" : "离线",
      detail: !messageStats.messageStatusKnown
        ? "正在读取消息接管状态"
        : !messageStats.messageConnected
          ? "消息接管暂时未连接，提醒会保留在面板"
          : messageStats.undeliveredCriticalCount > 0
            ? `有 ${messageStats.undeliveredCriticalCount} 条紧急提醒没送到`
            : messageStats.failedAlertCount > 0
              ? `${messageStats.failedAlertCount} 条提醒发送失败`
              : messageStats.deliveredCriticalCount > 0
                ? `有 ${messageStats.deliveredCriticalCount} 条紧急提醒已送到`
                : "消息接管通道正常",
      action:
        !messageStats.messageStatusKnown
          ? undefined
          : !messageStats.messageConnected || messageStats.pendingMessageAlerts > 0
            ? { label: "去处理", kind: "link", to: "/gateway" }
            : messageStats.deliveredCriticalCount > 0
              ? { label: "去看看", kind: "link", to: "/gateway" }
              : undefined,
    },
    {
      id: "attention",
      tone: hasError ? "error" : hasWarn ? "warn" : "ok",
      label: "待处理",
      value: `${attentionCount} 项`,
      detail: hasError
        ? "有需要立即处理的问题"
        : hasWarn
          ? "有需要留意的事"
          : "暂无待办",
      action: attentionCount > 0 ? { label: "查看详情", kind: "detail" } : undefined,
    },
    {
      id: "assistant",
      tone: assistantTone,
      label: "AI 助手",
      value: `${healthyInspectionCount}/${instanceCount} 正常`,
      detail:
        downInstanceCount > 0
          ? `${downInstanceCount} 个出问题了`
          : degradedInstanceCount > 0
            ? `${degradedInstanceCount} 个需要留意`
            : instanceCount === 0
              ? "尚未发现可管理的助手"
              : "运行正常",
    },
  ];

  return (
    <div className="manager-status-rail" role="status" aria-label="当前状态总览">
      {cards.map((card) => (
        <article className={`manager-status-card is-${card.tone}`} key={card.id}>
          <div className="manager-status-head">
            <span className={`manager-status-dot is-${card.tone}`} aria-hidden="true" />
            <span className="manager-status-label">{card.label}</span>
          </div>
          <strong className="manager-status-value">{card.value}</strong>
          <p className="manager-status-detail">{card.detail}</p>
          {card.action !== undefined &&
            (card.action.kind === "link" ? (
              <Link className="manager-status-action" to={card.action.to ?? "/gateway"}>
                {card.action.label} →
              </Link>
            ) : (
              <button type="button" className="manager-status-action" onClick={onOpenAdvanced}>
                {card.action.label} →
              </button>
            ))}
        </article>
      ))}
    </div>
  );
}
