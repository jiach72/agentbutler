/**
 * 首页结论推导：把聚合数据翻译成「先结论」的问题清单、英雄区文案与统计口径。
 * 纯函数无副作用；所有用户可见文案为产品资产，改动需同步 PRODUCT.md。
 */
import { formatRelative } from "../../lib/format.js";
import { instanceLabel } from "./helpers.js";
import type { AlertsPayload, DashboardPayload, HeroView, IssueView } from "./types.js";

/** 消息通知卡片的统计口径。 */
export interface MessageStats {
  messageStatusKnown: boolean;
  messageConnected: boolean;
  failedAlertCount: number;
  undeliveredCriticalCount: number;
  deliveredCriticalCount: number;
  pendingMessageAlerts: number;
}

export interface Conclusions {
  issues: IssueView[];
  hero: HeroView;
  attentionCount: number;
  hasError: boolean;
  hasWarn: boolean;
  healthyInspectionCount: number;
  downInstanceCount: number;
  degradedInstanceCount: number;
  messageStats: MessageStats;
}

function buildIssues(dashboard: DashboardPayload | null): IssueView[] {
  const list: IssueView[] = [];
  const instances = dashboard?.instances ?? [];
  const latestInspections = dashboard?.latestInspections ?? [];
  const fingerprints = dashboard?.fingerprints ?? [];
  const inspectStatus = dashboard?.inspectStatus ?? null;

  if (dashboard === null) {
    list.push({
      id: "reading",
      tone: "idle",
      title: "正在读取管家状态",
      detail: "首次加载中；如果一直没更新，可以点击下方「立即检查」再试一次。",
    });
    return list;
  }

  if (inspectStatus === null) {
    list.push({
      id: "unknown-inspect",
      tone: "idle",
      title: "还没有读取到管家状态",
      detail: "暂时无法判断本机服务是否正常，建议先点击「立即检查」。",
    });
  } else if (!inspectStatus.reachable) {
    list.push({
      id: "watch-offline",
      tone: "warn",
      title: "管家服务暂时连不上",
      detail: "已看到部分旧数据，但暂时无法开始新的检查。请稍等管家恢复后再试。",
    });
  }

  for (const inspection of latestInspections) {
    const failed = inspection.checks.filter((check) => check.status === "fail").length;
    const warned = inspection.checks.filter((check) => check.status === "warn").length;
    if (inspection.overall === "down") {
      list.push({
        id: `down-${inspection.instanceId}`,
        tone: "error",
        title: `实例（${instanceLabel(inspection.instanceId)}）存在异常`,
        detail: `${failed} 项检查不通过${warned > 0 ? `，另有 ${warned} 项提醒` : ""}；可能是进程未运行或服务暂时连不上。`,
      });
    } else if (inspection.overall === "degraded") {
      list.push({
        id: `degraded-${inspection.instanceId}`,
        tone: "warn",
        title: `实例（${instanceLabel(inspection.instanceId)}）需要留意`,
        detail: `${warned} 项检查提醒${failed > 0 ? `，${failed} 项不通过` : ""}；不影响使用时可以先观察。`,
      });
    }
  }

  for (const fp of fingerprints) {
    list.push({
      id: `fingerprint-${fp.signature}`,
      tone: "error",
      title: `最近出现 ${fp.count} 次相同问题`,
      detail: `最近一次在 ${formatRelative(fp.lastSeen)}；可以在「高级详情」里查看错误内容。`,
    });
  }

  if (list.length === 0 && latestInspections.length > 0 && instances.length > 0) {
    list.push({
      id: "all-ok",
      tone: "ok",
      title: "一切正常",
      detail: `管家刚检查过 ${latestInspections.length} 个实例，没有发现需要处理的事。`,
    });
  } else if (list.length === 0 && instances.length === 0 && inspectStatus?.reachable === true) {
    list.push({
      id: "no-instance",
      tone: "idle",
      title: "暂未发现可管理的实例",
      detail: "可能尚未接入实例，或者管家还没有完成一次检查。",
    });
  } else if (list.length === 0) {
    list.push({
      id: "no-result",
      tone: "idle",
      title: "还没有检查结果",
      detail: "管家还没完成第一次检查，点击「立即检查」开始。",
    });
  }
  return list;
}

export function buildConclusions(
  dashboard: DashboardPayload | null,
  alerts: AlertsPayload | null,
): Conclusions {
  const issues = buildIssues(dashboard);
  const instances = dashboard?.instances ?? [];
  const latestInspections = dashboard?.latestInspections ?? [];

  const attentionCount = issues.filter(
    (item) => item.tone === "error" || item.tone === "warn",
  ).length;
  const hasError = issues.some((item) => item.tone === "error");
  const hasWarn = issues.some((item) => item.tone === "warn");
  const healthyInspectionCount = latestInspections.filter(
    (item) => item.overall === "healthy",
  ).length;
  const downInstanceCount = latestInspections.filter(
    (item) => item.overall === "down",
  ).length;
  const degradedInstanceCount = latestInspections.filter(
    (item) => item.overall === "degraded",
  ).length;

  const alertCounts = alerts?.counts ?? {};
  const alertItems = alerts?.items ?? [];
  const failedAlertCount = alertCounts["failed"] ?? 0;
  const undeliveredCriticalCount = alertItems.filter(
    (item) => item.severity === "critical" && item.status !== "delivered",
  ).length;
  const deliveredCriticalCount = alertItems.filter(
    (item) => item.severity === "critical" && item.status === "delivered",
  ).length;
  const messageBridge = dashboard?.messageStatus?.status?.bridge ?? null;
  const messageConnected =
    dashboard?.messageStatus?.reachable === true &&
    messageBridge?.connected === true &&
    messageBridge.attached === true &&
    messageBridge.outboxWritable === true;
  const messageStats: MessageStats = {
    messageStatusKnown: dashboard?.messageStatus !== undefined,
    messageConnected,
    failedAlertCount,
    undeliveredCriticalCount,
    deliveredCriticalCount,
    pendingMessageAlerts: undeliveredCriticalCount + failedAlertCount,
  };

  let hero: HeroView;
  if (dashboard === null) {
    hero = {
      tone: "idle",
      title: "正在确认管家状态",
      copy: "正在读取本机服务的运行情况，请稍等。",
    };
  } else if (hasError) {
    hero = {
      tone: "error",
      title: `有 ${attentionCount} 件事需要你处理`,
      copy: "管家发现问题了，下面按重要程度排好，照着点就行。",
    };
  } else if (hasWarn) {
    hero = {
      tone: "warn",
      title: `有 ${attentionCount} 件事需要留意`,
      copy: "这些不影响正常使用，有空的时候看一眼就行。",
    };
  } else {
    const okIssue = issues.find((item) => item.tone === "ok");
    if (okIssue !== undefined) hero = { tone: "ok", title: "一切正常", copy: okIssue.detail };
    else if (instances.length === 0)
      hero = {
        tone: "idle",
        title: "暂未发现实例",
        copy: "管家还没有发现可管理的实例，可能是尚未接入。",
      };
    else
      hero = {
        tone: "idle",
        title: "还没有检查结果",
        copy: "点击「立即检查」，管家会开始确认本机服务是否正常。",
      };
  }

  return {
    issues,
    hero,
    attentionCount,
    hasError,
    hasWarn,
    healthyInspectionCount,
    downInstanceCount,
    degradedInstanceCount,
    messageStats,
  };
}
