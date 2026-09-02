/**
 * 管家首页展示辅助：事件前缀、标签映射与徽标语义 tone 映射。
 * 徽标只输出 tone + 文案，渲染统一交给 <StatusBadge>。
 */
import type { SemanticTone } from "../../components/StatusBadge.js";
import type { InspectionView, InspectStatusView } from "./types.js";

/** 事件流节流刷新间隔（收到相关事件后最多每 5s 拉一次聚合端点）。 */
export const REFRESH_THROTTLE_MS = 5000;

/** 触发首页刷新的事件类型前缀（与 Task 10 数据面相关的事件族）。 */
export const REFRESH_EVENT_PREFIXES = [
  "inspection-",
  "runbook-",
  "fingerprint-",
  "message-",
  "alert-",
  "gateway-",
  "delivery-",
  "dnd-",
  "patch-",
];

/** 常见检查项的通俗名称；未知检查项仍展示原始 id，不编造。 */
export const CHECK_LABELS: Record<string, string> = {
  process: "进程是否在运行",
  liveness: "服务是否能响应",
  dashboard: "官方管理页是否能连接",
  memory: "记忆读写是否正常",
  channel: "消息通道是否正常",
  model: "模型服务是否可连接",
  "process-alive": "服务进程是否在运行",
  "api-connectivity": "服务是否能连接",
  "memory-probe": "记忆读写是否正常",
  "channel-probe": "消息通道是否正常",
  "llm-probe": "模型服务是否可连接",
  "stall-write": "数据是否还在正常写入",
  "resource-watermark": "资源水位是否正常",
  "dashboard-signal": "管理页信号是否正常",
};

export function instanceLabel(instanceId: string): string {
  if (instanceId === "hermes-main") return "Hermes 主实例";
  if (instanceId === "") return "主实例";
  return instanceId;
}

export function instanceRuntimeLabel(runtime: string): string {
  if (runtime === "process") return "本机运行";
  if (runtime === "docker") return "Docker 容器";
  return runtime || "—";
}

export function frameworkLabel(frameworkId: string): string {
  if (frameworkId === "hermes") return "Hermes";
  if (frameworkId === "openclaw") return "OpenClaw";
  return frameworkId || "未知框架";
}

export function connectionStateLabel(state: string): string {
  if (state === "connected") return "已连接";
  if (state === "disconnected") return "已断开";
  if (state === "checking") return "检查中";
  if (state === "error") return "操作失败";
  return "待确认";
}

/** 实例状态色点：运行绿 / 崩溃红 / 停止灰 / 其他黄。 */
export function stateDotClass(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("crash")) return "down";
  if (["serving", "running", "active"].includes(s)) return "up";
  if (["stopped", "stopped.", "removed", "idle"].includes(s)) return "idle";
  return "warn";
}

/** 实例状态的大白话。 */
export function instanceStateLabel(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("crash")) return "异常（可能已崩溃）";
  if (["serving", "running", "active"].includes(s)) return "运行正常";
  if (["stopped", "stopped.", "removed", "idle"].includes(s)) return "已停止";
  return state || "未知";
}

export interface ToneBadge {
  tone: SemanticTone;
  label: string;
}

/** 整体检查结果：正常绿 / 提醒黄 / 异常红 / 等待灰。 */
export function overallBadge(overall: string | null): ToneBadge {
  switch (overall) {
    case "healthy":
      return { tone: "ok", label: "正常" };
    case "degraded":
      return { tone: "warn", label: "需要留意" };
    case "down":
      return { tone: "error", label: "异常" };
    default:
      return { tone: "muted", label: "等待检查" };
  }
}

/** 检查项状态徽标：通过绿 / 提醒黄 / 异常红 / 跳过灰。 */
export function checkBadge(status: string): ToneBadge {
  switch (status) {
    case "pass":
      return { tone: "ok", label: "正常" };
    case "warn":
      return { tone: "warn", label: "需要留意" };
    case "fail":
      return { tone: "error", label: "异常" };
    case "skipped":
      return { tone: "muted", label: "已跳过" };
    default:
      return { tone: "muted", label: status };
  }
}

/** 同类错误状态标签：新出现红、已知灰、其他灰（与待办区 fingerprintIssue 口径一致）。 */
export function fingerprintBadge(status: string): ToneBadge {
  if (status === "open") return { tone: "error", label: "待处理" };
  if (status === "known") return { tone: "muted", label: "已知问题" };
  return { tone: "muted", label: status };
}

/** 关键记忆探针状态：区分探针本身异常与 SLA 逾期。 */
export function criticalProbeBadge(
  probe: InspectStatusView["criticalProbe"],
): ToneBadge {
  if (probe === undefined) return { tone: "muted", label: "未接入" };
  if (probe.overdue) return { tone: "error", label: "已逾期" };
  if (probe.lastStatus === "fail") return { tone: "error", label: "异常" };
  if (probe.lastStatus === "warn") return { tone: "warn", label: "需要留意" };
  if (probe.lastStatus === "skipped") return { tone: "muted", label: "无可检查对象" };
  if (probe.lastStatus === "pass") return { tone: "ok", label: "正常" };
  return { tone: "muted", label: "等待检查" };
}

/** 连接/诊断探针的快速结论：正常 / 异常 / 需留意。 */
export function quickProbeBadge(status: string): ToneBadge {
  if (status === "pass") return { tone: "ok", label: "正常" };
  if (status === "fail") return { tone: "error", label: "异常" };
  return { tone: "warn", label: "需留意" };
}

export function formatDuration(ms: number | null): string {
  return ms === null ? "—" : `${ms}ms`;
}

/** 秒 → 人性化运行时长："3 天 4 小时" / "5 小时 30 分钟" / "25 分钟"；无效值占位。 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${Math.floor(seconds)} 秒`;
}

/** used/total 占用百分比（0~100 封顶取整）；任一值无效返回 null。 */
export function usedPercentOf(used: number | null, total: number | null): number | null {
  if (
    used === null ||
    total === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** 实例短名（多实例 Tabs 标签）：取框架前缀（hermes-main → hermes）；空 id 回退「主实例」。 */
export function instanceShortName(instanceId: string): string {
  if (instanceId === "") return "主实例";
  const index = instanceId.indexOf("-");
  return index > 0 ? instanceId.slice(0, index) : instanceId;
}

/**
 * 巡检最近耗时：优先关键记忆探针 lastDurationMs；
 * 缺省回退最近一次巡检各 check（可计时部分）均值；两者都缺返回 null。
 */
export function recentInspectionDurationMs(
  inspectStatus: InspectStatusView | null,
  latestInspections: InspectionView[],
): number | null {
  const probeMs = inspectStatus?.criticalProbe?.lastDurationMs ?? null;
  if (probeMs !== null) return probeMs;
  const latest = latestInspections[0];
  if (latest === undefined) return null;
  const durations = latest.checks
    .map((check) => check.durationMs)
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length);
}

/** detail 摘要：字符串截断，对象 JSON 化后截断。 */
export function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined || detail === "") return "—";
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 同类错误模板 sample 前 80 字符。 */
export function formatSample(sample: string | null): string {
  if (sample === null || sample === "") return "—";
  return sample.length > 80 ? `${sample.slice(0, 80)}…` : sample;
}

/** 重复问题 → 求助提示词（用户可复制发给智能体，或经管家直接转发）。 */
export function buildAgentHelpPrompt(fp: {
  signature: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastSample: string | null;
  instance?: string;
}): string {
  return [
    "管家（Butler）在巡检中发现一个反复出现的问题，请帮我定位并处理：",
    `- 问题样本：${fp.lastSample ?? "（无样本，见错误签名）"}`,
    `- 错误签名：${fp.signature}`,
    `- 累计出现：${fp.count} 次`,
    `- 最近一次：${fp.lastSeen}（首次：${fp.firstSeen}）`,
    `- 所在实例：${fp.instance ?? "未知"}`,
    "请检查相关日志与配置，找出根本原因；如果可以直接修复请处理，否则告诉我具体的修复步骤。",
  ].join("\n");
}
