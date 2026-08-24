/**
 * M7 诊断报告（Task 18.4）：一键生成脱敏 Markdown 报告。
 *
 * 内容与 PRD M7 原型对齐：环境信息、最近巡检快照、日志问题与错误指纹聚类
 * （近 7 天，归一化模板，剔除原始样本）、配置摘要（密钥值不读不写）、进化台账摘要。
 *
 * 脱敏纪律：不读取密钥内容；不包含聊天正文或原始日志样本；路径中的用户名
 * 替换为 "~"；每行截断到 240 字符。报告仅供排障与导出，不包含可复现密钥的字段。
 */
import type { Core } from "@butler/core";
import type { FingerprintAggregatedPayload, InspectionCompletedPayload } from "@butler/core";
import type { LogAnalyzeView } from "./log-analyzer.js";
import type { SecurityService } from "./invariants.js";
import type { GatewayPanelService } from "./gateway-stats.js";
import type { EvolutionService } from "./evolution.js";

/** 管家自身版本视图（与 watch.ts butler.version() 返回一致）。 */
export interface ButlerVersionView {
  version: string;
  source: string;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  changelog?: Array<{ hash: string; subject: string; at: string }>;
  checkedAt: string;
}

export interface DiagnosticReportDeps {
  core: Pick<Core, "store" | "instances">;
  butler: { version(): ButlerVersionView };
  analyzeLogs(instanceId?: string): LogAnalyzeView;
  security: SecurityService;
  gateway: GatewayPanelService;
  evolution?: EvolutionService;
  now?: () => number;
}

const FINGERPRINT_WINDOW_DAYS = 7;
const TOP_FINGERPRINTS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 脱敏：用户名路径替换为 ~，压缩空白，截断长度。 */
function redact(value: string, max = 240): string {
  return value
    .replace(/\/home\/[^/\s:，。]+/g, "~")
    .replace(/C:\\Users\\[^\\\s:，。]+/gi, "~")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** 组装诊断 Markdown（异步：配置摘要与网关参数需要读服务）。 */
export async function renderDiagnosticReport(deps: DiagnosticReportDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  const lines: string[] = [];
  lines.push("# Agent Butler 诊断报告", "");
  lines.push(`生成时间：${formatTime(new Date(now()).toISOString())}`, "");

  /* 1. 环境信息 */
  const version = deps.butler.version();
  const instances = deps.core.instances.listInstances();
  lines.push("## 1. 环境信息", "");
  lines.push(`- 管家版本：${version.version}`);
  lines.push(`- 源码位置：${redact(version.source, 160)}`);
  lines.push(`- 分支/提交：${version.branch ?? "无"} @ ${version.commit ?? "无"}`);
  lines.push(`- 运行环境：Node ${process.version} · ${process.platform} ${process.arch}`);
  lines.push(`- 被管实例：${instances.length} 个`);
  for (const instance of instances) {
    lines.push(`  - ${instance.instanceId} · ${instance.state} · ${instance.version ?? "版本未知"} · ${redact(instance.rootPath, 160)}`);
  }
  lines.push("");

  /* 2. 最近巡检快照（每实例最新一条；events 新在前） */
  const inspectionEvents = deps.core.store.listEvents({
    type: "inspection-completed",
    limit: 300,
  });
  const latestByInstance = new Map<string, (typeof inspectionEvents)[number]>();
  for (const event of inspectionEvents) {
    const payload = event.payload as Partial<InspectionCompletedPayload> | null;
    if (payload === null || typeof payload !== "object" || payload.instanceId === undefined) continue;
    if (!latestByInstance.has(payload.instanceId)) latestByInstance.set(payload.instanceId, event);
  }
  lines.push("## 2. 最近巡检", "");
  if (latestByInstance.size === 0) {
    lines.push("还没有巡检记录；点击首页「立即检查」后会自动生成。", "");
  }
  for (const [instanceId, event] of latestByInstance) {
    const payload = event.payload as Partial<InspectionCompletedPayload>;
    lines.push(`- ${instanceId} · ${payload.overall ?? "未知"} · 置信度 ${payload.confidence ?? "-"} · ${formatTime(event.ts)}`);
    for (const check of payload.checks ?? []) {
      lines.push(`  - ${check.id} · ${check.status}${check.detail !== undefined ? ` · ${redact(check.detail, 120)}` : ""}`);
    }
  }
  lines.push("");

  /* 3. 日志问题与错误指纹聚类（近 7 天；不含原始样本与聊天正文） */
  const logView = deps.analyzeLogs();
  lines.push("## 3. 日志问题与错误指纹", "");
  lines.push(`日志扫描：${logView.scannedSources} 个来源 · ${logView.scannedLines} 行 · ${formatTime(logView.analyzedAt)}`, "");
  if (logView.issues.length === 0) {
    lines.push("扫描窗口内没有聚合到需要处理的问题。", "");
  }
  for (const issue of logView.issues) {
    const action = issue.actionLabel !== null ? `（可一键修复：${issue.actionLabel}）` : "";
    lines.push(`- [${issue.severity === "error" ? "错误" : "提醒"}] ${issue.title} · ${issue.count} 次${action} · ${redact(issue.detail, 160)}`);
  }
  lines.push("");

  const cutoffMs = now() - FINGERPRINT_WINDOW_DAYS * DAY_MS;
  const fingerprintEvents = deps.core.store.listEvents({
    type: "fingerprint-aggregated",
    limit: 500,
  });
  const groups = new Map<string, { template: string; count: number; lastAt: string }>();
  for (const event of fingerprintEvents) {
    const payload = event.payload as Partial<FingerprintAggregatedPayload> | null;
    if (payload === null || typeof payload !== "object") continue;
    const windowStart = typeof payload.windowStart === "string" ? Date.parse(payload.windowStart) : Number.NaN;
    if (!Number.isFinite(windowStart) || windowStart < cutoffMs) continue;
    const signature = typeof payload.signature === "string" ? payload.signature : "(unknown)";
    const template = typeof payload.template === "string" ? payload.template : "(未知模板)";
    const count = typeof payload.count === "number" ? payload.count : 0;
    const previous = groups.get(signature);
    groups.set(signature, {
      template,
      count: (previous?.count ?? 0) + count,
      lastAt: event.ts > (previous?.lastAt ?? "") ? event.ts : previous?.lastAt ?? event.ts,
    });
  }
  const topFingerprints = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_FINGERPRINTS);
  if (topFingerprints.length > 0) {
    lines.push(`近 7 天错误指纹聚类（${topFingerprints.length} 类 · 合计 ${topFingerprints.reduce((sum, item) => sum + item.count, 0)} 次）：`, "");
    for (const item of topFingerprints) {
      lines.push(`- ${redact(item.template, 180)} · ${item.count} 次 · 最后出现 ${formatTime(item.lastAt)}`);
    }
    lines.push("");
  }

  /* 4. 配置摘要（密钥已剔除） */
  const security = await deps.security.status();
  const [gatewayStats, patches] = await Promise.all([deps.gateway.stats(), deps.gateway.patches()]);
  lines.push("## 4. 配置摘要（不含密钥）", "");
  lines.push(`配置规则核验：${security.invariants.length} 条`);
  for (const invariant of security.invariants) {
    const label = invariant.status === "pass" ? "通过" : invariant.status === "fail" ? "未通过" : invariant.status === "warn" ? "需留意" : "未核验";
    lines.push(`- [${label}] ${invariant.title}：${redact(invariant.detail, 160)}`);
  }
  lines.push(`密钥文件：${security.totalSecretFiles} 个 · 权限${security.insecureSecretFiles === 0 ? "全部正常" : `有 ${security.insecureSecretFiles} 个需处理`}`);
  for (const secret of security.secrets) {
    lines.push(`  - ${secret.rel} · ${secret.mode} · ${secret.secure ? "权限正常" : "权限过宽"}`);
  }
  lines.push(`消息网关：${gatewayStats.overall === "ok" ? "正常" : gatewayStats.overall === "warn" ? "需留意" : "受限"} · 近 24 小时限流事件 ${gatewayStats.last24h} 条 · 累计 ${gatewayStats.totalEvents} 条`);
  for (const patch of patches) {
    const params = patch.applied?.params ?? patch.observed?.params ?? Object.fromEntries(
      Object.entries(patch.params).map(([key, meta]) => [key, meta.default]),
    );
    const paramText = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    lines.push(`- 补丁「${patch.title}」：${paramText === "" ? "无参数" : paramText}`);
  }
  lines.push("");

  /* 5. 进化实验台账摘要 */
  const ledger = deps.evolution?.status().ledger ?? [];
  lines.push("## 5. 进化实验台账", "");
  if (ledger.length === 0) {
    lines.push("暂无进化实验记录。", "");
  }
  for (const entry of ledger.slice(-20).reverse()) {
    const metric = entry.baselineMetric !== undefined && entry.candidateMetric !== undefined ? ` · ${entry.baselineMetric} → ${entry.candidateMetric}` : "";
    lines.push(`- ${entry.runId} · ${entry.status} · holdout ${entry.holdoutCount} 条${metric} · ${redact(entry.conclusion, 120)}`);
  }
  lines.push("");

  lines.push("---", "");
  lines.push("本报告仅包含脱敏信息（不含密钥、聊天正文与原始日志样本）；完整日志请在「首页 → 系统日志」查看。");
  return lines.join("\n");
}
