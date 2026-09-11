/**
 * 状态总览条：把日常判断收进四项市场风统计卡（StatStrip），并直达消息、待办或运行详情。
 * 数值/副注/动作的判定逻辑与旧版完全一致，仅展示层迁移。
 */
import { Button } from "antd";
import { Link } from "react-router-dom";
import {
  ClusterOutlined,
  ExclamationCircleOutlined,
  NotificationOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { formatRelative } from "../../lib/format.js";
import type { MessageStats } from "./conclusions.js";
import type { InspectStatusView } from "./types.js";

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
  runtimeDetailsOpen: boolean;
  onOpenRuntimeDetails: () => void;
  onOpenIssues: () => void;
}

type RailTone = "ok" | "warn" | "error" | "idle";

const TONE_TO_STAT: Record<RailTone, StatStripItem["tone"]> = {
  ok: "ok",
  warn: "warn",
  error: "error",
  idle: undefined,
};

const RAIL_ICONS = {
  watch: SafetyCertificateOutlined,
  gateway: NotificationOutlined,
  attention: ExclamationCircleOutlined,
  assistant: ClusterOutlined,
} as const;

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
  runtimeDetailsOpen,
  onOpenRuntimeDetails,
  onOpenIssues,
}: StatusRailProps) {
  const assistantTone: RailTone =
    downInstanceCount > 0
      ? "error"
      : degradedInstanceCount > 0
        ? "warn"
        : healthyInspectionCount > 0
          ? "ok"
          : "idle";

  const items: Array<{
    id: keyof typeof RAIL_ICONS;
    tone: RailTone;
    label: string;
    value: string;
    detail: string;
    action?: React.ReactNode;
  }> = [
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
      action: (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          aria-controls="runtime-details"
          aria-expanded={runtimeDetailsOpen}
          onClick={onOpenRuntimeDetails}
        >
          查看运行详情
        </Button>
      ),
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
              : !messageStats.relayEnabled
                ? "原通道直发中：消息由本机 AI 直接发送"
                : "消息接管通道正常",
      action: (
        <Link to="/gateway">
          <Button type="link" size="small" style={{ paddingInline: 0 }}>
            查看消息
          </Button>
        </Link>
      ),
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
      action:
        attentionCount > 0 ? (
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onOpenIssues}>
            查看待办
          </Button>
        ) : undefined,
    },
    {
      id: "assistant",
      tone: assistantTone,
      label: "受管实例",
      value: `${healthyInspectionCount}/${instanceCount} 正常`,
      detail:
        downInstanceCount > 0
          ? `${downInstanceCount} 个出问题了`
          : degradedInstanceCount > 0
            ? `${degradedInstanceCount} 个需要留意`
            : instanceCount === 0
              ? "尚未发现可管理的实例"
              : "运行正常",
      action: (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0, alignSelf: "flex-start" }}
          aria-controls="runtime-details"
          aria-expanded={runtimeDetailsOpen}
          onClick={onOpenRuntimeDetails}
        >
          查看运行详情
        </Button>
      ),
    },
  ];

  return (
    <StatStrip
      items={items.map((item) => ({
        key: item.id,
        className: "dashboard-status-item",
        icon: RAIL_ICONS[item.id],
        label: item.label,
        value: item.value,
        tone: TONE_TO_STAT[item.tone],
        sub: item.detail,
        action: item.action,
      }))}
    />
  );
}
