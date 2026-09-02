/**
 * butler-watch HTTP 控制通道（Task 10 前置）：node:http 原生实现。
 *
 * 端点契约（同时提供给 ui/web 代理使用，严格一致；全部 JSON 响应）：
 * - GET  /healthz                    → { ok: true }
 * - GET  /api/runbooks               → { runbooks: Array<{ id, label, description,
 *                                      breakerTripped, lastRun?: { at, success } }> }
 * - POST /api/runbooks/:id/execute   → body { instanceId? }（缺省取首个 Serving 实例）
 *                                      202 { started: true }；未知 id → 404 { error }；
 *                                      熔断跳闸 → 409 { error: "circuit-breaker-tripped" }；
 *                                      无可用实例 → 503 { error }
 * - POST /api/inspect/run            → 202 { started: true }；巡检在飞 →
 *                                      409 { error: "inspection-in-flight" }
 * - GET  /api/inspect/status         → { lastAt, nextAt, intervalMin, inFlight,
 *                                      criticalProbe?: { intervalMin, slaMin,
 *                                      lastStartedAt, lastCompletedAt, nextAt,
 *                                      deadlineAt, lastDurationMs, lastStatus,
 *                                      lastWithinSla, overdue, inFlight,
 *                                      runCount, missedTicks } }
 * - GET  /api/host/metrics           → HostMetricsSnapshot（机器 CPU/内存/磁盘/GPU
 *                                      + 各 agent 进程 CPU/RSS + 60 点环形缓冲；
 *                                      结构见 host-metrics.ts）。服务未接线 → 503
 * - GET  /api/connections            → 当前 Hermes/OpenClaw 实例的实时连接视图；
 * - POST /api/connections/check      → 手动探测（body { instanceId? }）；
 * - POST /api/connections/:id/connect|disconnect → 连接/断开指定实例；
 * - POST /api/upgrade/run            → body { instanceId?, targetVersion, channel? }：
 *                                      202 { started: true, jobId, instanceId }；
 *                                      targetVersion 缺失/空/非字符串 →
 *                                      400 { error: "missing-target-version" }；
 *                                      升级在飞 → 409 { error: "upgrade-in-flight" }；
 *                                      无 Serving 实例 → 503 { error: "no-servicing-instance" }
 * - GET  /api/upgrade/status         → { job: UpgradeJobView | null }
 * - GET  /api/upgrade/versions       → { reachable, source?, versions, checkedAt, attempts }
 *                                     （版本源全败不 5xx，逐源诊断仍返回）
 * - POST /api/snapshots/:id/rollback → body { instanceId? }（:id 数值行 id）：
 *                                      200 { job: { jobId, kind: "rollback", steps } }；
 *                                      非数值 id → 400 { error: "invalid-snapshot-id" }；
 *                                      快照不存在/不可回滚 → 404 { error: "snapshot-not-found" }；
 *                                      无可用实例 → 503 { error: "no-servicing-instance" }
 * - GET  /api/gateway/stats          → 200 { stats: RateLimitPanelView }
 *                                      （{ overall, totalEvents, last24h, matched[],
 *                                         suggestions[] }，结构见 gateway-stats.ts）
 * - GET  /api/gateway/patches        → 200 { patches: PatchPanelView[] }
 *                                      （登记表 + schema + applied 状态）
 * - POST /api/gateway/patches/:id/apply 与 /reapply
 *                                    → body { params?: Record<string, number>,
 *                                             instanceId? }（:id URL 解码）：
 *                                      200 { status: "ok", result, targetPath, params }；
 *                                      params 值非 number → 400 { error: "invalid-params",
 *                                        detail }；
 *                                      未知补丁 → 404 { error: "unknown-patch" }；
 *                                      参数越界 → 400 { error: "invalid-params", detail }；
 *                                      漂移/前置缺失 → 409 { error: "patch-conflict",
 *                                        detail }；
 *                                      无可用实例 → 503 { error: "no-instance" }
 * - POST /api/gateway/patches/:id/detect
 *                                    → body { instanceId? }：200 { report: DriftReport }；
 *                                      未知补丁 → 404 { error: "unknown-patch" }；
 *                                      无可用实例 → 503 { error: "no-instance" }
 * - GET  /api/skills                 → query { instanceId?, keyword?, limit? }；
 *                                      200 SkillsMemoryView；limit 非正整数 → 400；
 *                                      服务未接线 → 503
 * - GET  /api/logs/analyze       → query { instanceId? }；200 { issues, scannedSources,
 *                                      scannedLines, analyzedAt }；服务未接线 → 503
 * - POST /api/logs/fix             → body { action, confirmed, instanceId? }：
 *                                      202 { started: true }；confirmed 非 true → 400；
 *                                      未知 action → 400；熔断跳闸 → 409；无实例 → 503
 * - GET  /api/memory                 → query { instanceId? }；200 { instance, memory }；
 *                                      服务未接线 → 503
 * M6 写路由仅在 `m6WritesEnabled=true` 时注册语义；V1 默认以 404 隐藏：
 * - POST /api/memory/archive         → body { instanceId?, olderThan?, keepMonths?,
 *                                      dryRun?, entryIds? }；200 { ok, report }；
 *                                      E002 → 400；E403 → 409；服务未接线 → 503
 * - POST /api/memory/restore         → body { instanceId?, entryIds?, olderThan? }；
 *                                      200 { ok, report }；错误映射同上
 * - POST /api/memory/rebuild-index → body { instanceId? }；200 { ok, report }；
 * - POST /api/memory/purge           → body { instanceId?, confirmed?, kind?,
 *                                      entryIds?, archivedBefore? }；confirmed 非 true
 *                                      → 400；错误映射同上
 * - POST /api/memory/export        → body { instanceId?, passphrase }；200 application/octet-stream
 *      （AES-256-GCM 加密 .abmem；口令不足 8 位 → 400）
 * - POST /api/memory/self-check    → body { instanceId? }；200 { ok, instanceId, result }；
 *                                      无实例/未接线 → 503
 * - GET  /api/diagnostics/report → 200 text/markdown（脱敏诊断报告附件）；未接线 → 503
 * - GET  /api/prompt-optimization/targets → 200 { targets: PromptTargetView[] }；
 *                                      服务未接线 → 503（M5 切片 1/2）
 * - GET  /api/prompt-optimization/active/:targetId → 200 PromptActiveView；
 *                                      未知目标 → 404；服务未接线 → 503
 * - GET  /api/prompt-optimization/candidates → 200 { candidates: PromptCandidateView[] }；
 *      query { targetId? }；服务未接线 → 503
 * - POST /api/prompt-optimization/candidates → body { targetId, content, baseSha256,
 *      source?, description? }；201 { candidate }；400/404 按错误映射
 * - GET  /api/prompt-optimization/candidates/:id → 200 { candidate }；404
 * - GET  /api/prompt-optimization/candidates/:id/report → 200
 *      { candidate, report: PromptEvaluationReportView | null }；404
 * - POST /api/prompt-optimization/candidates/:id/evaluate → body
 *      { cases?, datasetPath?, datasetHash?, datasetSchemaVersion?, modelParams?, seed? }；
 *      201 { report }；400/404 按错误映射
 *
 * 请求体解析上限 16KB（超出 413；非法 JSON 400）。监听 127.0.0.1:7533
 * （BUTLER_WATCH_HOST / BUTLER_WATCH_PORT 可覆盖，config.ts 读入）。依赖全部
 * 注入（scheduler / runbooks 元信息 / executeRunbook / upgrade 升级服务 /
 * gateway 网关面板服务 / promptOptimization 提示词 Registry），测试经回环真实端口验证。
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { CONTROL_API_SCHEMA_VERSION, CONTRACT_VERSION } from "@butler/contract";
import type {
  EvolutionExpandInput,
  EvolutionPreflightInput,
  EvolutionPromoteInput,
  EvolutionResultInput,
  EvolutionService,
} from "./evolution.js";
import type { ExternalEvolutionService } from "./external-evolution.js";
import type { GatewayPanelService } from "./gateway-stats.js";
import type { SkillsMemoryService } from "./skills.js";
import type { SkillAssetService } from "./skill-assets.js";
import type { UpgradeService } from "./upgrade.js";
import type { ButlerSelfService } from "./self-upgrade.js";
import type { PromptOptimizationService } from "./prompt-optimization.js";
import type { LogAnalyzeView } from "./log-analyzer.js";
import type { EvolutionInsightsService, InsightRange } from "./evolution-insights.js";
import type { EvolutionAnalyticsService } from "./evolution-analytics.js";
import type { BackupService } from "./backup.js";
import type { SecurityService } from "./invariants.js";
import type { ButlerRuntimeInfo } from "./runtime.js";
import { MarkdownFileError, type MarkdownFileService } from "./markdown-files.js";
import { toUserFacingError, type LlmCredentialService, type LlmProtocol } from "@butler/core";
import { createDiagnosticZip } from "./diagnostics.js";
import type { DiagnosticSummary } from "./diagnostics.js";
import { classifyRuntimeState } from "./runtime-diagnosis.js";
import type { HostMetricsService } from "./host-metrics.js";

/** 记忆按需自检（memory-probe 单阶段）的结论。 */
export interface MemorySelfCheckResult {
  id: string;
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
}

/** 记忆自检端点结果（接线层判定，HTTP 层映射状态码）。 */
export type MemorySelfCheckOutcome =
  | { ok: true; instanceId: string; result: MemorySelfCheckResult }
  | { ok: false; code: "no-servicing-instance" | "memory-probe-unavailable"; error: string };

/** 请求体解析上限（字节）。 */
export const HTTP_BODY_LIMIT_BYTES = 16 * 1024;
export const WATCH_SERVICE_VERSION = `watch@1.0.0-beta.22+${CONTRACT_VERSION}`;

/** runbook 执行结果（由接线层判定，HTTP 层只做状态码映射）。 */
export type RunbookExecuteOutcome =
  | { status: "started"; instanceId: string }
  | { status: "unknown-runbook" }
  | { status: "circuit-breaker-tripped" }
  | { status: "no-servicing-instance" };

export type RecoveryActionRisk = "low" | "medium" | "high";
export interface RecoveryActionView {
  id: string;
  label: string;
  description: string;
  risk: RecoveryActionRisk;
  impact: string;
  estimatedSeconds: number;
  requiresConfirmation: boolean;
  available: boolean;
  unavailableReason?: string;
  unavailableFix?: string;
}

/** 一条发现的证据。让用户自己判断严不严重，而不是被一句结论吓到。 */
export interface RecoveryEvidence {
  /** 最近一次出现的时间；日志没写时间戳时为 null（视为无法证明是"当前"问题）。 */
  lastSeenAt: string | null;
  /** 出现次数。 */
  occurrences: number;
  /** 证据来自哪个日志文件。 */
  source: string | null;
  /** 问题类别，如 rate-limit / oom。 */
  kind: string;
  /** 距离最近一次出现过去了多久（人话，如「2 小时前」）。 */
  lastSeenLabel: string | null;
  /** 是否为最近 24 小时内仍在发生的问题。 */
  recent: boolean;
}

export interface RecoveryFinding {
  id: string;
  title: string;
  detail: string;
  severity: "error" | "warn";
  evidence: RecoveryEvidence;
  suggestedAction: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
}

export interface RecoveryDiagnosisView {
  incidentId: string;
  severity: "ok" | "warn" | "error";
  stateCode: string;
  summary: string;
  safeToRetry: boolean;
  /**
   * 根因。只有探针真的失败时才命名——那时候我们确实知道哪里坏了。
   * 探针全绿时这里是 null，改看 primaryFinding。
   */
  rootCause: string | null;
  /** 当前最值得关注的一条发现（可能来自日志，也可能是"没有发现"）。 */
  primaryFinding: RecoveryFinding | null;
  /** 最近 24 小时内仍在发生的发现，按严重度与频次排序。 */
  findings: RecoveryFinding[];
  /** 24 小时以外、仅作参考的历史问题数量。 */
  historicalFindingCount: number;
  probes: Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }>;
  recommendedActions: RecoveryActionView[];
  checkedAt: string;
}

export interface RecoveryJobView {
  jobId: string;
  actionId: string;
  label: string;
  instanceId: string | null;
  status: "running" | "done" | "failed" | "unknown";
  progress: number;
  detail: string;
  startedAt: string;
  finishedAt: string | null;
}

const recoveryJobs = new Map<string, RecoveryJobView>();
const recoveryJobTimers = new Map<string, ReturnType<typeof setInterval>>();
const recoveryCompletionTimers = new Map<string, ReturnType<typeof setInterval>>();

function startRecoveryJob(actionId: string, label: string, estimatedSeconds: number, instanceId?: string, holdForVerification = false): RecoveryJobView {
  const jobId = `recovery-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const job: RecoveryJobView = {
    jobId,
    actionId,
    label,
    instanceId: instanceId ?? null,
    status: "running",
    progress: 8,
    detail: "已确认，正在准备执行",
    startedAt,
    finishedAt: null,
  };
  recoveryJobs.set(jobId, job);
  const duration = Math.max(5, estimatedSeconds) * 1000;
  const tickMs = 1000;
  const timer = setInterval(() => {
    const current = recoveryJobs.get(jobId);
    if (!current || current.status !== "running") return;
    const elapsed = Date.now() - Date.parse(current.startedAt);
    const progress = Math.min(92, Math.max(current.progress, 8 + Math.round((elapsed / duration) * 84)));
    current.progress = progress;
    current.detail = progress >= 90 ? "正在进行最后复验" : "正在执行修复步骤";
    if (elapsed >= duration && !holdForVerification) {
      current.progress = 100;
      current.status = "done";
      current.detail = "修复步骤已完成，等待复验结果";
      current.finishedAt = new Date().toISOString();
      clearInterval(timer);
      recoveryJobTimers.delete(jobId);
    }
    if (elapsed >= duration + 30_000 && holdForVerification) {
      current.progress = 95;
      current.status = "unknown";
      current.detail = "执行时间已到，但 Watch 尚未返回最终复验结果";
      current.finishedAt = new Date().toISOString();
      clearInterval(timer);
      recoveryJobTimers.delete(jobId);
      const completionTimer = recoveryCompletionTimers.get(jobId);
      if (completionTimer) clearInterval(completionTimer);
      recoveryCompletionTimers.delete(jobId);
    }
  }, tickMs);
  recoveryJobTimers.set(jobId, timer);
  return job;
}

function finishRecoveryJob(jobId: string, status: "done" | "failed" | "unknown", detail: string): void {
  const job = recoveryJobs.get(jobId);
  if (!job) return;
  job.status = status;
  job.progress = status === "done" ? 100 : Math.min(job.progress, 95);
  job.detail = detail;
  job.finishedAt = new Date().toISOString();
  const timer = recoveryJobTimers.get(jobId);
  if (timer) clearInterval(timer);
  recoveryJobTimers.delete(jobId);
  const completionTimer = recoveryCompletionTimers.get(jobId);
  if (completionTimer) clearInterval(completionTimer);
  recoveryCompletionTimers.delete(jobId);
}

function monitorRunbookJob(jobId: string, deps: WatchHttpDeps, runbookId: string, before: string | null): void {
  const timer = setInterval(() => {
    const current = recoveryJobs.get(jobId);
    if (!current || current.status !== "running") return;
    const lastRun = deps.runbooks().find((item) => item.id === runbookId)?.lastRun;
    if (lastRun && lastRun.at !== before) {
      finishRecoveryJob(
        jobId,
        lastRun.success ? "done" : "failed",
        lastRun.success
          ? "Runbook 已完成并通过复验"
          : "Runbook 未完成：请打开连接诊断，确认 control 能力、实例运行环境和快照步骤；修复前置问题后再重试。",
      );
    }
  }, 1000);
  recoveryCompletionTimers.set(jobId, timer);
}

/** 人工解除 runbook 熔断的结果（HTTP 层只做状态码映射）。 */
export type RunbookResetOutcome =
  | { status: "reset"; keys: string[] }
  | { status: "unknown-runbook" }
  | { status: "not-tripped" };

/** GET /api/runbooks 的单条 runbook 元信息。 */
export interface RunbookSummary {
  id: string;
  label: string;
  description: string;
  /** 执行影响范围（面向小白用户；无则空串）。 */
  impact: string;
  /** 执行步骤预览（label 列表）。 */
  steps: string[];
  breakerTripped: boolean;
  lastRun?: { at: string; success: boolean };
}

/** HTTP 层依赖（全部可注入）。 */
export interface WatchHttpDeps {
  runtime?: () => ButlerRuntimeInfo;
  scheduler: {
    /** 立即巡检入口（在飞返回 false → 409）。 */
    runNow(): boolean;
    status(): {
      lastAt: string | null;
      nextAt: string | null;
      intervalMin: number;
      inFlight: boolean;
      criticalProbe?: {
        intervalMin: number;
        slaMin: number;
        lastStartedAt: string | null;
        lastCompletedAt: string | null;
        nextAt: string | null;
        deadlineAt: string | null;
        lastDurationMs: number | null;
        lastStatus: "pass" | "warn" | "fail" | "skipped" | null;
        lastWithinSla: boolean | null;
        overdue: boolean;
        inFlight: boolean;
        runCount: number;
        missedTicks: number;
      };
    };
  };
  /** Hermes/OpenClaw 连接管理（可选，旧嵌入式测试未接线时返回 503）。 */
  connections?: {
    status(): { checkedAt: string; connections: Array<Record<string, unknown>> };
    check(instanceId?: string): Promise<
      | { status: "checked"; connection: Record<string, unknown> }
      | { status: "no-instance" }
      | { status: "failed"; connection: Record<string, unknown> }
    >;
    connect(instanceId?: string): Promise<
      | { status: "connected" | "disconnected"; connection: Record<string, unknown> }
      | { status: "no-instance" }
      | { status: "failed"; connection: Record<string, unknown> }
    >;
    disconnect(instanceId?: string): Promise<
      | { status: "connected" | "disconnected"; connection: Record<string, unknown> }
      | { status: "no-instance" }
      | { status: "failed"; connection: Record<string, unknown> }
    >;
  };
  /** OpenClaw 状态探测：安装由用户在宿主手动完成，管家只读状态。 */
  openclawInstall?: {
    status(): Record<string, unknown>;
  };
  /** runbook 元信息列表（含熔断态与最近执行）。 */
  runbooks(): RunbookSummary[];
  /** 执行判定（实例解析 + 熔断检查 + 异步启动），HTTP 层按 outcome 映射状态码。 */
  executeRunbook(id: string, instanceId?: string): Promise<RunbookExecuteOutcome>;
  /** 人工解除 runbook 熔断；接线层负责审计，HTTP 层只做状态码映射。 */
  resetRunbookBreaker?(id: string, instanceId?: string): Promise<RunbookResetOutcome>;
  /** Task 13：升级服务（发起/状态/版本列表/快照回滚），HTTP 层只做状态码映射。 */
  upgrade: UpgradeService;
  /** Task 15：网关限流统计与补丁参数面板服务，HTTP 层只做状态码映射。 */
  gateway: GatewayPanelService;
  /** Task 16：进化守门服务；可选以兼容尚未接线的嵌入式测试。 */
  evolution?: EvolutionService;
  /** 外部协助 Hermes 改进工作台；与旧 self-evolution CLI 隔离。 */
  externalEvolution?: ExternalEvolutionService;
  evolutionInsights?: EvolutionInsightsService;
  evolutionAnalytics?: EvolutionAnalyticsService;
  llm?: LlmCredentialService;
  /** Task 17：技能与记忆只读列表服务；可选以兼容尚未接线的嵌入式测试。 */
  skills?: SkillsMemoryService;
  /** 技能资产中心：使用统计、生命周期、趋势与隔离安装。 */
  skillAssets?: SkillAssetService;
  /** M6 P1/P2 写操作开关；V1 默认关闭并以 404 隐藏写路由。 */
  m6WritesEnabled?: boolean;
  /** Task 6/17：按需记忆写入召回自检（只跑 memory-probe 单阶段）。 */
  memorySelfCheck?: (instanceId?: string) => Promise<MemorySelfCheckOutcome>;
  /** M7：脱敏诊断报告生成器（一键生成 Markdown）。 */
  renderDiagnostics?: () => Promise<string>;
  diagnosticSummary?: () => Promise<DiagnosticSummary>;
  /** 系统日志：列表 + 尾部读取（观察面；路径只读）。 */
  logs?: {
    listSources(instanceId?: string): Array<{
      id: string;
      path: string;
      format: string;
      modifiedAt: string | null;
      sizeBytes: number;
    }>;
    readTail(
      sourceId: string,
      instanceId?: string,
      limit?: number,
      before?: number | null,
    ): {
      sourceId: string;
      path: string;
      format: string;
      lines: string[];
      truncated: boolean;
      limit: number;
      totalLines: number;
      /** 本页第一行起始 byte offset；下一页「更早」游标；journald 源为 null。 */
      pageStart: number | null;
      hasOlder: boolean;
      hasNewer: boolean;
      error?: string;
    } | null;
  };
  /** 系统日志智能体检（V1.7）：扫描日志尾部并按指纹聚合错误，给出可执行修复建议。 */
  analyzeLogs?: (instanceId?: string, range?: InsightRange) => LogAnalyzeView;
  /** 管家自身版本信息（源码仓库 tag / 提交 / 分支）。 */
  butler?: {
    version(): {
      version: string;
      source: string;
      branch: string | null;
      commit: string | null;
      tag: string | null;
      repository: string | null;
      repositoryConfigured?: boolean;
      repositorySource?: "git-origin" | "configured-default";
      changelog?: Array<{ hash: string; subject: string; at: string }>;
      checkedAt: string;
    };
  };
  /** 管家自身版本管理（V1.7）：状态 / 一键升级 / 回滚 / 更新偏好。 */
  butlerSelf?: ButlerSelfService;
  /** M5 切片 1/2：提示词 Registry、候选与评估服务；可选以兼容尚未接线的测试。 */
  promptOptimization?: PromptOptimizationService;
  /** Task 18：备份服务（列表/手动备份/还原）。 */
  backup?: BackupService;
  /** Task 18：安全基线（配置不变式 + 密钥权限）。 */
  security?: SecurityService;
  /** 核心 Markdown 文件管理。 */
  markdownFiles?: MarkdownFileService;
  /** 主机与 agent 进程指标服务（可选；未接线时 /api/host/metrics 返回 503）。 */
  hostMetrics?: HostMetricsService;
}

export interface WatchHttpOptions {
  host?: string;
  port?: number;
  /**
   * 凭据写入是独立于监听地址的部署策略。
   * 未显式提供时保留旧的回环默认值，避免测试/嵌入式调用意外放开公网写入。
   */
  credentialWritesAllowed?: boolean;
}

export interface WatchHttp {
  /** 开始监听（幂等）。 */
  start(): Promise<{ host: string; port: number }>;
  /** 停止监听并断开存量连接（幂等）。 */
  close(): void;
  /** 当前监听地址（未监听为 null）。 */
  address(): { host: string; port: number } | null;
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendMarkdown(
  res: import("node:http").ServerResponse,
  filename: string,
  markdown: string,
): void {
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(markdown),
    "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
  });
  res.end(markdown);
}
function sendBytes(
  res: import("node:http").ServerResponse,
  filename: string,
  data: Uint8Array,
): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": data.byteLength,
    "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
  });
  res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

function sendZip(
  res: import("node:http").ServerResponse,
  filename: string,
  data: Uint8Array,
): void {
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": data.byteLength,
    "content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
  });
  res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}



function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recoveryActionCatalog(deps: WatchHttpDeps, instanceId?: string): RecoveryActionView[] {
  const hasRunbook = (id: string) => deps.runbooks().some((runbook) => runbook.id === id);
  const hasGatewayPatch = deps.gateway !== undefined;
  const connectionSnapshot = deps.connections?.status();
  const connection = connectionSnapshot?.connections.find((item) => item["instanceId"] === instanceId) ??
    connectionSnapshot?.connections[0];
  const capabilities = isRecord(connection?.["capabilities"]) ? connection["capabilities"] as Record<string, unknown> : {};
  const capability = (name: string): string | undefined => typeof capabilities[name] === "string" ? capabilities[name] as string : undefined;
  const controlCapability = capability("control");
  const messagingCapability = capability("messaging");
  const connected = connection?.["connected"] === true || connection?.["connectionState"] === "connected";
  const controlUnavailableReason = connection === undefined
    ? "未发现可控制的 Hermes 实例"
    : controlCapability !== "ok"
      ? `Hermes 控制能力不可用${typeof connection["lastError"] === "string" && connection["lastError"] !== "" ? `：${connection["lastError"]}` : "，请先重新探测并确认运行环境提供 control 能力"}`
      : undefined;
  const messagingUnavailableReason = connection === undefined
    ? "未发现可检查的 Hermes 实例"
    : connected
      ? "当前消息通道已连接，无需重连"
      : messagingCapability !== "ok"
        ? `消息通道能力未通过探针（当前：${messagingCapability ?? "未知"}）`
        : controlCapability !== "ok"
          ? controlUnavailableReason
          : undefined;
  return [
    {
      id: "refresh-probe",
      label: "重新探测并刷新状态",
      description: "重新检查进程、记忆、消息通道和模型连接，不会中断服务。",
      risk: "low",
      impact: "只读检查",
      estimatedSeconds: 10,
      requiresConfirmation: false,
      available: true,
    },
    {
      id: "rebuild-memory-index",
      label: "重建记忆索引",
      description: "修复全文索引异常，保留原始记忆内容。",
      risk: "low",
      impact: "记忆搜索可能短暂变慢",
      estimatedSeconds: 30,
      requiresConfirmation: true,
      available: deps.skills !== undefined && deps.m6WritesEnabled === true,
      ...(deps.skills === undefined || deps.m6WritesEnabled !== true
        ? { unavailableReason: "记忆写操作未启用" }
        : {}),
    },
    {
      id: "reconnect-channel",
      label: "重新连接消息通道",
      description: "仅重建消息通道连接，不重启 Hermes 实例。",
      risk: "medium",
      impact: "消息可能短暂延迟",
      estimatedSeconds: 20,
      requiresConfirmation: true,
      available: deps.connections !== undefined && messagingUnavailableReason === undefined,
      ...(deps.connections === undefined
        ? { unavailableReason: "连接管理服务未接线", unavailableFix: "检查 Watch 连接管理服务配置" }
        : messagingUnavailableReason !== undefined
          ? {
              unavailableReason: messagingUnavailableReason,
              unavailableFix: connected
                ? "无需操作；如状态异常请先执行重新探测"
                : controlUnavailableReason !== undefined
                  ? "在 Hermes 所在环境运行可控的 Watch，或切换到可控制实例"
                  : "先执行重新探测并确认消息通道能力",
            }
          : {}),
    },
    {
      id: "apply-throttle-patch",
      label: "调整网关发送节流参数",
      description: "根据最近限流指纹，把发送间隔调整到补丁允许的安全范围，并保留可回滚审计记录。",
      risk: "medium",
      impact: "消息发送会按新的节流参数排队",
      estimatedSeconds: 15,
      requiresConfirmation: true,
      available: hasGatewayPatch,
      ...(!hasGatewayPatch ? { unavailableReason: "网关补丁服务未接线", unavailableFix: "检查 Watch 与网关服务的连接后重新诊断" } : {}),
    },
    {
      id: "cleanup-gateway",
      label: "清理孤儿消息网关",
      description: "清理已失效的 Gateway 状态并重新复验消息链路。",
      risk: "medium",
      impact: "消息网关会短暂重载",
      estimatedSeconds: 25,
      requiresConfirmation: true,
      available: hasRunbook("rb-cleanup-gateway"),
      ...(!hasRunbook("rb-cleanup-gateway") ? { unavailableReason: "清理 Runbook 未注册" } : {}),
    },
    {
      id: "restart-instance",
      label: "重启 AI 实例",
      description: "在快照保护下重启实例，作为最后一级恢复手段。",
      risk: "high",
      impact: "AI 服务中断约 30-90 秒",
      estimatedSeconds: 90,
      requiresConfirmation: true,
      available: hasRunbook("rb-restart") && controlUnavailableReason === undefined,
      ...(!hasRunbook("rb-restart")
        ? { unavailableReason: "重启 Runbook 未注册", unavailableFix: "重新加载 Watch 内置 Runbook" }
        : controlUnavailableReason !== undefined
          ? { unavailableReason: controlUnavailableReason, unavailableFix: "在 Hermes 所在环境运行可控的 Watch，并确认 venv 入口和实例运行时可见" }
          : {}),
    },
  ];
}

async function diagnoseRecovery(deps: WatchHttpDeps, instanceId?: string): Promise<RecoveryDiagnosisView> {
  const probes: RecoveryDiagnosisView["probes"] = [];
  const connection = deps.connections?.status().connections.find((item) => item["instanceId"] === instanceId) ??
    deps.connections?.status().connections[0];
  probes.push({
    id: "watch",
    label: "管家控制通道",
    status: "pass",
    detail: "Watch HTTP 已响应",
  });
  probes.push({
    id: "connection",
    label: "Hermes 消息连接",
    status: connection === undefined ? "warn" : connection["connected"] === true ? "pass" : "fail",
    detail: connection === undefined
      ? "暂未发现可检查实例"
      : typeof connection["lastError"] === "string" && connection["lastError"] !== ""
        ? connection["lastError"]
        : connection["connected"] === true ? "消息通道正常" : "消息通道未连接",
  });
  const logView = deps.analyzeLogs?.(instanceId);
  const { findings, historicalCount } = buildRecoveryFindings(logView?.issues ?? []);
  probes.push({
    id: "logs",
    label: "最近错误日志",
    status: findings.length === 0 ? "pass" : "warn",
    detail:
      findings.length === 0
        ? historicalCount > 0
          ? `最近一天没有新问题；更早的日志里有 ${historicalCount} 类历史提醒`
          : "最近日志未发现已知错误"
        : `最近一天发现 ${findings.length} 类仍在发生的问题`,
  });
  const scheduler = deps.scheduler.status();
  probes.push({
    id: "inspection",
    label: "巡检调度",
    status: scheduler.inFlight ? "warn" : scheduler.criticalProbe?.lastStatus === "fail" ? "fail" : "pass",
    detail: scheduler.inFlight ? "巡检正在执行" : scheduler.criticalProbe?.lastStatus === "fail" ? "关键探针最近一次失败" : "巡检调度正常",
  });

  const failed = probes.filter((probe) => probe.status === "fail");
  const severity: RecoveryDiagnosisView["severity"] =
    failed.length > 0 ? "error" : probes.some((probe) => probe.status === "warn") ? "warn" : "ok";

  // 只有探针真的失败，我们才敢说"根因是 X"。
  // 探针全绿时把日志里的问题叫"根因"，会让用户在一切正常时白紧张，甚至真去点那个
  // 会中断服务 30-90 秒的重启按钮。这时候它只是"发现"，不是"根因"。
  const rootCause = failed[0]?.detail ?? null;
  const primaryFinding = findings[0] ?? null;
  const runtime = classifyRuntimeState(
    probes.map((probe) => ({ id: probe.id, status: probe.status, detail: probe.detail })),
    findings.map((finding) => ({
      source: finding.evidence.source ?? "logs",
      message: finding.detail,
      lastSeenAt: finding.evidence.lastSeenAt,
      occurrences: finding.evidence.occurrences,
    })),
  );

  const actions = recoveryActionCatalog(deps, instanceId);
  return {
    incidentId: `incident-${randomUUID()}`,
    severity,
    stateCode: runtime.stateCode,
    summary: runtime.summary,
    safeToRetry: runtime.safeToRetry,
    rootCause,
    primaryFinding,
    findings,
    historicalFindingCount: historicalCount,
    probes,
    // 保留所有动作卡片：不可执行动作也必须展示原因和解决方案，避免用户点击后才发现 409。
    recommendedActions: actions,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * "正在发生"的时间窗：超过这个时长的日志问题归入历史，不参与当前结论。
 * 默认 24 小时，可用 BUTLER_RECENT_FINDING_HOURS 调整（1–720）。
 */
function recentFindingWindowMs(): number {
  const raw = Number(process.env["BUTLER_RECENT_FINDING_HOURS"]);
  if (!Number.isFinite(raw)) return 24 * 60 * 60 * 1000;
  return Math.min(Math.max(raw, 1), 720) * 60 * 60 * 1000;
}

/** 把时间差说成人话；给不出准确时间就如实说"时间不明确"。 */
function relativeLabel(from: Date, to: Date): string {
  const diffMs = to.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 把日志问题分成"最近仍在发生"与"历史遗留"两类，并为每条附上证据。
 *
 * 关键规则：解析不出最近出现时间的问题，不算作"当前仍在发生"。
 * 宁可少报，也不要拿三周前的一次 OOM 吓唬今天的用户的。
 */
function buildRecoveryFindings(
  issues: ReadonlyArray<{
    id: string;
    kind: string;
    severity: "error" | "warn";
    title: string;
    detail: string;
    count: number;
    sources: string[];
    lastSeenAt?: string | null;
    suggestedAction: "rb-restart" | "rb-reconnect" | null;
    actionLabel: string | null;
  }>,
): { findings: RecoveryFinding[]; historicalCount: number } {
  const now = new Date();
  const cutoff = now.getTime() - recentFindingWindowMs();
  const findings: RecoveryFinding[] = [];
  let historicalCount = 0;

  for (const issue of issues) {
    const lastSeenMs = parseTimestamp(issue.lastSeenAt);
    const recent = lastSeenMs !== null && lastSeenMs >= cutoff;
    const evidence: RecoveryEvidence = {
      lastSeenAt: issue.lastSeenAt ?? null,
      occurrences: issue.count,
      source: issue.sources[0] ?? null,
      kind: issue.kind,
      lastSeenLabel: lastSeenMs === null ? null : relativeLabel(new Date(lastSeenMs), now),
      recent,
    };
    if (!recent) {
      historicalCount += 1;
      continue;
    }
    findings.push({
      id: issue.id,
      title: issue.title,
      detail: issue.detail,
      severity: issue.severity,
      evidence,
      suggestedAction: issue.suggestedAction,
      actionLabel: issue.actionLabel,
    });
  }

  // 严重度优先，其次看出现次数；错误排在提醒前面。
  findings.sort((a, b) => {
    const rank = (item: RecoveryFinding) => (item.severity === "error" ? 0 : 1);
    return rank(a) - rank(b) || b.evidence.occurrences - a.evidence.occurrences;
  });

  return { findings, historicalCount };
}

/** 读取请求体（≤16KB；空体 → {}；非法 JSON → 400；超限 → 413）。 */
async function readJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  limitBytes = HTTP_BODY_LIMIT_BYTES,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) {
      sendJson(res, 413, { error: "payload-too-large" });
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "invalid-json-body" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid-json-body" });
    return null;
  }
}

function markdownErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof MarkdownFileError) {
    return { status: error.status, body: { error: error.code, detail: error.userHint, nextStep: error.nextStep } };
  }
  const classified = toUserFacingError(error, { detail: "核心文件操作失败。", nextStep: "确认实例目录和文件权限后重试。" });
  return { status: 500, body: { error: "markdown-write-failed", detail: classified.detail, nextStep: classified.nextStep, errorId: classified.errorId } };
}

function publicMarkdownFile(file: import("@butler/contract").ManagedMarkdownFile): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (key !== "absolutePath") safe[key] = value;
  }
  return safe;
}

/** 组装并启动 HTTP 控制通道。 */
export function startWatchHttp(deps: WatchHttpDeps, options: WatchHttpOptions = {}): WatchHttp {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7533;
  const loopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const credentialWritesAllowed = options.credentialWritesAllowed ?? loopbackHost;

  const server: Server = createServer((req, res) => {
    void handle(deps, req, res, { credentialWritesAllowed });
  });
  // 长连接（keep-alive）不阻碍关闭：close() 时统一断开。
  server.keepAliveTimeout = 5_000;

  let listening: { host: string; port: number } | null = null;
  let startPromise: Promise<{ host: string; port: number }> | undefined;

  const http: WatchHttp = {
    start(): Promise<{ host: string; port: number }> {
      if (startPromise !== undefined) return startPromise;
      startPromise = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, host, () => {
          const addr = server.address();
          listening =
            addr !== null && typeof addr === "object"
              ? { host: addr.address, port: addr.port }
              : { host, port: requestedPort };
          resolve(listening);
        });
      });
      return startPromise;
    },
    close(): void {
      if (!server.listening) return;
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      listening = null;
    },
    address(): { host: string; port: number } | null {
      return listening;
    },
  };
  return http;
}

/* ------------------------- 请求安全基线 ------------------------- */

/** 会改变状态的请求方法；只有它们需要校验来源，读请求不受影响。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function isSameRequestOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") return false;
  try {
    return new URL(origin).host.toLowerCase() === new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 来源校验（CSRF 防线）。
 *
 * Watch 只监听回环，但回环挡不住浏览器：任意网页都能让用户的浏览器向
 * http://127.0.0.1:7533 发 POST。由于 Web 是服务端代理调用（不带 Origin），
 * 这里只拦截"带了非本机 Origin 的写请求"——那一定是别人页面里来的。
 */
function originAllowed(req: import("node:http").IncomingMessage): boolean {
  if (!STATE_CHANGING_METHODS.has(req.method ?? "")) return true;
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.trim() === "") return true; // 服务端代理 / curl
  if (isLoopbackOrigin(origin) || isSameRequestOrigin(origin, req.headers.host)) return true;
  const extra = (process.env["BUTLER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return extra.includes(origin);
}

/**
 * 内部错误响应：给一个可追溯的编号，不回传堆栈与路径。
 * 真实错误写进本地日志，用户排查时按编号对得上，攻击者拿不到目录结构。
 */
function internalErrorResponse(error: unknown): Record<string, string> {
  const classified = toUserFacingError(error);
  console.error(`[watch] 内部错误 ${classified.errorId}: ${error instanceof Error ? error.message : String(error)}`);
  return { error: "internal-error", code: classified.code, detail: classified.detail, nextStep: classified.nextStep, errorId: classified.errorId };
}

/** 路由分发。 */
async function handle(
  deps: WatchHttpDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  options: { credentialWritesAllowed: boolean } = { credentialWritesAllowed: true },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://butler-watch.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (!originAllowed(req)) {
    sendJson(res, 403, {
      error: "origin-not-allowed",
      detail: "这个请求来自不受信任的页面，管家已拒绝执行。",
    });
    return;
  }

  try {
    if (path === "/healthz") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, {
        ok: true,
        service: "watch",
        serviceVersion: WATCH_SERVICE_VERSION,
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
      });
    }

    if (path === "/api/runtime") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, deps.runtime?.() ?? { kind: "unknown", detail: "运行时信息不可用" });
    }

    if (path === "/api/backups") {
      if (deps.backup === undefined) return sendJson(res, 503, { error: "backup-unavailable" });
      if (method === "GET") {
        const kindParam = url.searchParams.get("kind")?.trim();
        const kind =
          kindParam === "full" || kindParam === "memory" || kindParam === "event"
            ? kindParam
            : undefined;
        return sendJson(res, 200, { items: deps.backup.list(kind), status: deps.backup.status() });
      }
      if (method === "POST") {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const kind = body["kind"];
        if (kind !== "full" && kind !== "memory" && kind !== "event") {
          return sendJson(res, 400, { error: "invalid-backup-kind" });
        }
        const label = typeof body["label"] === "string" ? body["label"].trim() : undefined;
        try {
          const backup = await deps.backup.run(kind, label || undefined);
          return sendJson(res, 201, { backup });
        } catch (error) {
          const classified = toUserFacingError(error, { detail: "备份没有完成，当前操作未继续。", nextStep: "确认备份目录可写后重试，或导出诊断报告。" });
          return sendJson(res, 500, { error: "backup-failed", code: classified.code, userHint: classified.detail, nextStep: classified.nextStep, errorId: classified.errorId });
        }
      }
      return sendJson(res, 405, { error: "method-not-allowed" });
    }
    const restoreMatch = /^\/api\/backups\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.backup === undefined) return sendJson(res, 503, { error: "backup-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const id = Number(restoreMatch[1]);
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: "invalid-backup-id" });
      }
      const outcome = await deps.backup.restore(id, body["confirmed"] === true);
      if (!outcome.ok) {
        if (outcome.error === "confirmation-required") {
          return sendJson(res, 400, {
            error: "confirmation-required",
            userHint: "还原会覆盖当前记忆/配置，必须先确认。",
          });
        }
        if (outcome.error === "backup-not-found" || outcome.error === "backup-manifest-corrupt") {
          return sendJson(res, 404, { error: outcome.error });
        }
        return sendJson(res, 400, { error: outcome.error });
      }
      return sendJson(res, 200, outcome);
    }

    if (path === "/api/security") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.security === undefined) return sendJson(res, 503, { error: "security-unavailable" });
      return sendJson(res, 200, await deps.security.status());
    }

    /* ---------------------- 核心 Markdown 文件管理 ---------------------- */
    if (path === "/api/markdown/files") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      try {
        const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
        return sendJson(res, 200, { instanceId: instanceId ?? null, files: deps.markdownFiles.list(instanceId).map(publicMarkdownFile) });
      } catch (error) {
        const mapped = markdownErrorResponse(error);
        return sendJson(res, mapped.status, mapped.body);
      }
    }
    const markdownFileMatch = /^\/api\/markdown\/files\/([^/]+)$/.exec(path);
    if (markdownFileMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      try {
        const fileId = decodeURIComponent(markdownFileMatch[1]);
        const result = deps.markdownFiles.read(fileId);
        return sendJson(res, 200, { file: publicMarkdownFile(result.file), content: result.content });
      } catch (error) {
        const mapped = markdownErrorResponse(error);
        return sendJson(res, mapped.status, mapped.body);
      }
    }
    const markdownPreviewMatch = /^\/api\/markdown\/files\/([^/]+)\/preview$/.exec(path);
    if (markdownPreviewMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      const body = await readJsonBody(req, res, 2 * 1024 * 1024); if (body === null) return;
      if (typeof body["content"] !== "string" || typeof body["baseSha256"] !== "string") return sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 content 和 baseSha256。", nextStep: "重新读取文件后再预览。" });
      try {
        const preview = deps.markdownFiles.preview(decodeURIComponent(markdownPreviewMatch[1]), body["content"], body["baseSha256"]);
        return sendJson(res, 200, { ...preview, file: publicMarkdownFile(preview.file) });
      } catch (error) {
        const mapped = markdownErrorResponse(error);
        return sendJson(res, mapped.status, mapped.body);
      }
    }
    const markdownApplyMatch = /^\/api\/markdown\/files\/([^/]+)\/apply$/.exec(path);
    if (markdownApplyMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      const body = await readJsonBody(req, res, 2 * 1024 * 1024); if (body === null) return;
      if (typeof body["content"] !== "string" || typeof body["baseSha256"] !== "string") return sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 content 和 baseSha256。", nextStep: "重新读取文件后再保存。" });
      try {
        const result = await deps.markdownFiles.apply(decodeURIComponent(markdownApplyMatch[1]), { content: body["content"], baseSha256: body["baseSha256"], confirmed: body["confirmed"] === true, note: typeof body["note"] === "string" ? body["note"] : undefined });
        return sendJson(res, 200, { file: publicMarkdownFile(result.file), revision: result.revision });
      } catch (error) {
        const mapped = markdownErrorResponse(error);
        return sendJson(res, mapped.status, mapped.body);
      }
    }
    const markdownRevisionsMatch = /^\/api\/markdown\/files\/([^/]+)\/revisions$/.exec(path);
    if (markdownRevisionsMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      try { return sendJson(res, 200, { revisions: deps.markdownFiles.revisions(decodeURIComponent(markdownRevisionsMatch[1])) }); }
      catch (error) { const mapped = markdownErrorResponse(error); return sendJson(res, mapped.status, mapped.body); }
    }
    const markdownBackupMatch = /^\/api\/markdown\/files\/([^/]+)\/backup$/.exec(path);
    if (markdownBackupMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      const body = await readJsonBody(req, res); if (body === null) return;
      try { return sendJson(res, 201, { revision: deps.markdownFiles.backup(decodeURIComponent(markdownBackupMatch[1]), typeof body["note"] === "string" ? body["note"] : undefined) }); }
      catch (error) { const mapped = markdownErrorResponse(error); return sendJson(res, mapped.status, mapped.body); }
    }
    const markdownRestoreMatch = /^\/api\/markdown\/files\/([^/]+)\/revisions\/([^/]+)\/restore$/.exec(path);
    if (markdownRestoreMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      const body = await readJsonBody(req, res); if (body === null) return;
      if (typeof body["baseSha256"] !== "string") return sendJson(res, 400, { error: "invalid-markdown-input", detail: "需要提供 baseSha256。", nextStep: "重新读取文件后再恢复。" });
      try {
        const result = await deps.markdownFiles.restore(decodeURIComponent(markdownRestoreMatch[1]), decodeURIComponent(markdownRestoreMatch[2]), body["confirmed"] === true, body["baseSha256"]);
        return sendJson(res, 200, { file: publicMarkdownFile(result.file), revision: result.revision });
      } catch (error) { const mapped = markdownErrorResponse(error); return sendJson(res, mapped.status, mapped.body); }
    }
    const markdownDownloadMatch = /^\/api\/markdown\/files\/([^/]+)\/download$/.exec(path);
    if (markdownDownloadMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.markdownFiles === undefined) return sendJson(res, 503, { error: "markdown-unavailable", nextStep: "请同步部署 Watch 服务后重试。" });
      try {
        const result = deps.markdownFiles.download(decodeURIComponent(markdownDownloadMatch[1]));
        return sendMarkdown(res, result.filename, result.content);
      } catch (error) { const mapped = markdownErrorResponse(error); return sendJson(res, mapped.status, mapped.body); }
    }

        if (path === "/api/runbooks") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { runbooks: deps.runbooks() });
    }

    const executeMatch = /^\/api\/runbooks\/([^/]+)\/execute$/.exec(path);
    if (executeMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      const id = decodeURIComponent(executeMatch[1]!);
      // 后端强制确认：UI 的弹窗只是礼貌，真正的安全边界在这里。
      // 否则任何网页都能直接 POST 这个端点重启实例、kill 进程。
      if (body["confirmed"] !== true) {
        return sendJson(res, 400, {
          error: "confirmation-required",
          detail: "执行修复动作前需要用户确认，请带上 confirmed: true 重试。",
        });
      }
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.executeRunbook(id, instanceId);
      if (outcome.status === "started") return sendJson(res, 202, { started: true });
      if (outcome.status === "unknown-runbook") {
        return sendJson(res, 404, { error: `unknown-runbook: ${id}` });
      }
      if (outcome.status === "circuit-breaker-tripped") {
        return sendJson(res, 409, { error: "circuit-breaker-tripped" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    const resetMatch = /^\/api\/runbooks\/([^/]+)\/reset$/.exec(path);
    if (resetMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const id = decodeURIComponent(resetMatch[1]!);
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      if (deps.resetRunbookBreaker === undefined) {
        return sendJson(res, 503, { error: "breaker-reset-unavailable" });
      }
      const outcome = await deps.resetRunbookBreaker(id, instanceId);
      if (outcome.status === "reset") return sendJson(res, 200, outcome);
      if (outcome.status === "unknown-runbook") {
        return sendJson(res, 404, { error: `unknown-runbook: ${id}` });
      }
      return sendJson(res, 409, { error: "circuit-breaker-not-tripped" });
    }

    if (path === "/api/inspect/run") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const started = deps.scheduler.runNow(); // 只触发一次，复用结果映射状态码
      return sendJson(
        res,
        started ? 202 : 409,
        started ? { started: true } : { error: "inspection-in-flight" },
      );
    }

    if (path === "/api/inspect/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, deps.scheduler.status());
    }

    // 主机与 agent 进程指标（就绪度「Agent 主机状态」卡）；服务未接线 → 503。
    if (path === "/api/host/metrics") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.hostMetrics === undefined) {
        return sendJson(res, 503, { error: "host-metrics-unavailable" });
      }
      return sendJson(res, 200, await deps.hostMetrics.snapshot());
    }

    if (path === "/api/recovery/diagnose") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId = typeof body["instanceId"] === "string" && body["instanceId"].trim() !== ""
        ? body["instanceId"].trim()
        : undefined;
      return sendJson(res, 200, await diagnoseRecovery(deps, instanceId));
    }

    const recoveryActionMatch = /^\/api\/recovery\/actions\/([^/]+)\/execute$/.exec(path);
    if (recoveryActionMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const actionId = decodeURIComponent(recoveryActionMatch[1]!);
      const instanceId = typeof body["instanceId"] === "string" && body["instanceId"].trim() !== ""
        ? body["instanceId"].trim()
        : undefined;
      const action = recoveryActionCatalog(deps, instanceId).find((item) => item.id === actionId);
      if (action === undefined) return sendJson(res, 404, { error: "recovery-action-not-found" });
      if (!action.available) return sendJson(res, 409, { error: "recovery-action-unavailable", detail: action.unavailableReason });
      if (action.requiresConfirmation && body["confirmed"] !== true) {
        return sendJson(res, 400, { error: "confirmation-required", action });
      }
      const job = startRecoveryJob(actionId, action.label, action.estimatedSeconds, instanceId, actionId === "cleanup-gateway" || actionId === "restart-instance");
      const jobId = job.jobId;
      if (actionId === "refresh-probe") {
        const started = deps.scheduler.runNow();
        if (!started) {
          finishRecoveryJob(jobId, "failed", "巡检已在执行中");
          return sendJson(res, 409, { error: "inspection-in-flight" });
        }
        return sendJson(res, 202, { jobId, actionId, status: "running" });
      }
      if (actionId === "rebuild-memory-index") {
        if (deps.skills === undefined || deps.m6WritesEnabled !== true) {
          finishRecoveryJob(jobId, "failed", "记忆写操作未启用");
          return sendJson(res, 409, { error: "memory-write-disabled", jobId });
        }
        const result = await deps.skills.rebuildIndex(instanceId === undefined ? {} : { instanceId });
        if (!result.ok) finishRecoveryJob(jobId, "failed", result.error ?? "重建索引失败");
        else finishRecoveryJob(jobId, "done", "记忆索引重建完成");
        return sendJson(res, result.ok ? 200 : 409, result.ok ? { jobId, actionId, status: "done", verification: result.report } : { error: result.error ?? "rebuild-index-failed", jobId });
      }
      if (actionId === "reconnect-channel") {
        if (deps.connections === undefined) {
          finishRecoveryJob(jobId, "failed", "连接管理服务未接线");
          return sendJson(res, 503, { error: "connections-unavailable", jobId });
        }
        const result = await deps.connections.connect(instanceId);
        if (result.status === "failed") finishRecoveryJob(jobId, "failed", "消息通道重连失败");
        else if (result.status === "connected" || result.status === "disconnected") finishRecoveryJob(jobId, "done", "消息通道状态已更新");
        return sendJson(res, result.status === "no-instance" ? 404 : result.status === "failed" ? 409 : 202, {
          jobId,
          actionId,
          status: result.status,
          ...("connection" in result ? { verification: result.connection } : {}),
        });
      }
      if (actionId === "apply-throttle-patch") {
        if (deps.gateway === undefined) {
          finishRecoveryJob(jobId, "failed", "网关补丁服务未接线");
          return sendJson(res, 503, { error: "gateway-unavailable", jobId });
        }
        const stats = await deps.gateway.stats();
        const suggestion = stats.suggestions[0];
        if (!suggestion) {
          finishRecoveryJob(jobId, "done", "当前没有需要调整的节流参数");
          return sendJson(res, 200, { jobId, actionId, status: "done", detail: "当前没有需要调整的节流参数" });
        }
        const patchView = (await deps.gateway.patches()).find((patch) => patch.id === suggestion.patchId);
        if (patchView?.observed !== null && patchView?.observed !== undefined && patchView.applied === null) {
          const detail = "已检测到同等的手工补丁，但 Butler 尚未纳管，不能直接覆盖。请先在网关补丁页核对差异并选择纳管或手工调整。";
          finishRecoveryJob(jobId, "failed", detail);
          return sendJson(res, 409, {
            error: "patch-observed",
            detail,
            current: patchView.observed.params,
            targetPath: patchView.observed.targetPath,
            nextAction: "open-gateway-patches",
            jobId,
          });
        }
        const applied = await deps.gateway.applyPatch({ patchId: suggestion.patchId, params: { [suggestion.param]: suggestion.suggested }, instanceId });
        if (applied.status !== "ok") {
          finishRecoveryJob(jobId, "failed", "代码补丁应用失败");
          return sendJson(res, 409, { error: "patch-apply-failed", detail: applied.status, jobId });
        }
        finishRecoveryJob(jobId, "done", "网关节流补丁已应用");
        return sendJson(res, 200, { jobId, actionId, status: "done", verification: applied });
      }
      const runbookId = actionId === "cleanup-gateway" ? "rb-cleanup-gateway" : "rb-restart";
      const beforeRunAt = deps.runbooks().find((item) => item.id === runbookId)?.lastRun?.at ?? null;
      const outcome = await deps.executeRunbook(runbookId, instanceId);
      if (outcome.status === "started") {
        monitorRunbookJob(jobId, deps, runbookId, beforeRunAt);
        return sendJson(res, 202, { jobId, actionId, status: "running", instanceId: outcome.instanceId });
      }
      finishRecoveryJob(jobId, "failed", outcome.status === "circuit-breaker-tripped" ? "保护机制暂时阻止了执行" : "没有可用的 Hermes 实例");
      if (outcome.status === "unknown-runbook") return sendJson(res, 404, { error: "runbook-not-found" });
      if (outcome.status === "circuit-breaker-tripped") return sendJson(res, 409, { error: "circuit-breaker-tripped" });
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    const recoveryJobMatch = /^\/api\/recovery\/jobs\/([^/]+)$/.exec(path);
    if (recoveryJobMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const job = recoveryJobs.get(decodeURIComponent(recoveryJobMatch[1]!));
      if (!job) return sendJson(res, 404, { error: "recovery-job-not-found" });
      return sendJson(res, 200, job);
    }

    if (path === "/api/connections") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.connections === undefined) return sendJson(res, 503, { error: "connections-unavailable" });
      return sendJson(res, 200, deps.connections.status());
    }

    if (path === "/api/connections/check") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.connections === undefined) return sendJson(res, 503, { error: "connections-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId = typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
      const outcome = await deps.connections.check(instanceId);
      if (outcome.status === "no-instance") return sendJson(res, 404, { error: "no-instance" });
      return sendJson(res, 200, outcome);
    }

    const connectionAction = /^\/api\/connections\/([^/]+)\/(connect|disconnect)$/.exec(path);
    if (connectionAction !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.connections === undefined) return sendJson(res, 503, { error: "connections-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId = decodeURIComponent(connectionAction[1]!);
      const action = connectionAction[2] === "connect" ? deps.connections.connect : deps.connections.disconnect;
      const outcome = await action(instanceId);
      if (outcome.status === "no-instance") return sendJson(res, 404, { error: "no-instance" });
      return sendJson(res, outcome.status === "failed" ? 409 : 200, outcome);
    }

    if (path === "/api/openclaw/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.openclawInstall === undefined) return sendJson(res, 503, { error: "openclaw-install-unavailable" });
      return sendJson(res, 200, deps.openclawInstall.status());
    }

    if (path === "/api/skills") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const keyword = url.searchParams.get("keyword")?.trim() || undefined;
      const limitRaw = url.searchParams.get("limit");
      let limit: number | undefined;
      if (limitRaw !== null) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit <= 0) {
          return sendJson(res, 400, { error: "invalid-limit" });
        }
      }
      const status = await deps.skills.status({
          ...(instanceId === undefined ? {} : { instanceId }),
          ...(keyword === undefined ? {} : { keyword }),
          ...(limit === undefined ? {} : { limit }),
        });
      if (deps.skillAssets !== undefined) {
        const usage = await deps.skillAssets.usage(180, "day");
        const byName = new Map(usage.skills.map((item) => [item.name, item]));
        status.skills.items = status.skills.items.map((item) => {
          const observed = byName.get(item.name);
          return observed === undefined ? item : { ...item, usage: observed.calls, lastUsedAt: observed.lastUsedAt, successRate: observed.successRate, avgDurationMs: observed.avgDurationMs, usageCoverage: usage.coverage };
        });
      }
      return sendJson(res, 200, status);
    }

    if (path === "/api/skills/usage") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      const range = Number(url.searchParams.get("range")?.replace(/d$/, "") ?? "180");
      const requestedGranularity = url.searchParams.get("granularity");
      const granularity = requestedGranularity === "week" || requestedGranularity === "month" ? requestedGranularity : "day";
      return sendJson(res, 200, await deps.skillAssets.usage([30, 90, 180].includes(range) ? range : 180, granularity));
    }

    const skillLifecycle = /^\/api\/skills\/([^/]+)\/(archive|restore|purge)$/.exec(path);
    if (skillLifecycle !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      const body = await readJsonBody(req, res); if (body === null) return;
      const name = decodeURIComponent(skillLifecycle[1]!); const action = skillLifecycle[2]!;
      const result = action === "archive" ? await deps.skillAssets.archive(name, typeof body["thresholdDays"] === "number" ? body["thresholdDays"] : 90) : action === "restore" ? await deps.skillAssets.restore(name) : await deps.skillAssets.purge(name, body["confirmed"] === true);
      return sendJson(res, result.ok === true ? 200 : 409, result);
    }

    if (path === "/api/skills/github-trends") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      return sendJson(res, 200, await deps.skillAssets.githubTrends({ filter: url.searchParams.get("filter") ?? undefined, sort: url.searchParams.get("sort") ?? undefined }));
    }
    if (path === "/api/skills/github-trends/refresh") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      return sendJson(res, 200, await deps.skillAssets.refreshGithubTrends());
    }
    if (path === "/api/skills/recommendations") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      return sendJson(res, 200, await deps.skillAssets.recommendations());
    }
    const stageMatch = /^\/api\/skills\/recommendations\/([^/]+)\/stage$/.exec(path);
    if (stageMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      const result = await deps.skillAssets.stageRecommendation(decodeURIComponent(stageMatch[1]!));
      return sendJson(res, result.ok === true ? 200 : 409, result);
    }
    const installMatch = /^\/api\/skills\/staged\/([^/]+)\/install$/.exec(path);
    if (installMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skillAssets === undefined) return sendJson(res, 503, { error: "skill-assets-unavailable" });
      const body = await readJsonBody(req, res); if (body === null) return;
      const result = await deps.skillAssets.installStaged(decodeURIComponent(installMatch[1]!), body["confirmed"] === true);
      return sendJson(res, result.ok === true ? 200 : 409, result);
    }

    if (path === "/api/butler/version") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butler === undefined) return sendJson(res, 503, { error: "butler-unavailable" });
      return sendJson(res, 200, deps.butler.version());
    }

    if (path === "/api/butler/self") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      if (deps.butlerSelf.refresh !== undefined) await deps.butlerSelf.refresh();
      return sendJson(res, 200, deps.butlerSelf.status());
    }

    if (path === "/api/butler/self/upgrade") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const target = typeof body["target"] === "string" && body["target"].trim() !== ""
        ? body["target"].trim()
        : undefined;
      const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const outcome = await deps.butlerSelf.startUpgrade({
        ...(target === undefined ? {} : { target }),
        ...(channel === undefined ? {} : { channel }),
        confirmed: body["confirmed"] === true,
        trigger: "manual",
      });
      if (outcome.status === "started") {
        return sendJson(res, 202, { started: true, jobId: outcome.jobId, snapshotId: outcome.snapshotId });
      }
      if (outcome.status === "confirmation-required") {
        return sendJson(res, 400, { error: "confirmation-required", userHint: "升级前会备份并重启服务，必须先确认。" });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "backup-failed") {
        return sendJson(res, 500, {
          error: "backup-failed",
          userHint: "升级前全量备份失败，已取消升级。请检查备份目录和数据库状态后重试。",
        });
      }
      if (outcome.status === "invalid-target" || outcome.status === "no-target") {
        return sendJson(res, 400, { error: outcome.status, userHint: "没有找到可用的目标版本。" });
      }
      return sendJson(res, 503, { error: "no-repo", userHint: "源码目录还不是 Git 仓库，暂时不能自我升级。" });
    }

    if (path === "/api/butler/self/rollback") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const snapshotId = typeof body["snapshotId"] === "string" ? body["snapshotId"] : "";
      const outcome = deps.butlerSelf.rollback({
        snapshotId,
        confirmed: body["confirmed"] === true,
      });
      if (outcome.status === "started") {
        return sendJson(res, 202, { started: true, jobId: outcome.jobId });
      }
      if (outcome.status === "confirmation-required") {
        return sendJson(res, 400, { error: "confirmation-required", userHint: "回滚会重建并重启服务，必须先确认。" });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "snapshot-not-found") {
        return sendJson(res, 404, { error: "snapshot-not-found" });
      }
      return sendJson(res, 503, { error: "no-repo" });
    }

    if (path === "/api/butler/self/prefs") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.butlerSelf === undefined) {
        return sendJson(res, 503, { error: "butler-self-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const channel = body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const locked = typeof body["locked"] === "boolean" ? body["locked"] : undefined;
      return sendJson(res, 200, deps.butlerSelf.updatePrefs({
        ...(channel === undefined ? {} : { channel }),
        ...(locked === undefined ? {} : { locked }),
      }));
    }

    if (path === "/api/logs/analyze") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.analyzeLogs === undefined)
        return sendJson(res, 503, { error: "log-analyzer-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      return sendJson(res, 200, deps.analyzeLogs(instanceId));
    }

    if (path === "/api/logs/fix") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      if (body["confirmed"] !== true) {
        return sendJson(res, 400, {
          error: "confirmation-required",
          userHint: "修复会重启或重连服务，必须先确认影响范围。",
        });
      }
      const action = body["action"];
      if (action !== "rb-restart" && action !== "rb-reconnect") {
        return sendJson(res, 400, { error: "unknown-action" });
      }
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const actionLabel = action === "rb-reconnect" ? "重新连接消息通道" : "重启 AI 实例";
      const job = startRecoveryJob(action, actionLabel, action === "rb-reconnect" ? 20 : 90, instanceId, true);
      const beforeRunAt = deps.runbooks().find((item) => item.id === action)?.lastRun?.at ?? null;
      const outcome = await deps.executeRunbook(action, instanceId);
      if (outcome.status === "started") {
        monitorRunbookJob(job.jobId, deps, action, beforeRunAt);
        return sendJson(res, 202, { started: true, jobId: job.jobId, status: "running" });
      }
      finishRecoveryJob(job.jobId, "failed", outcome.status === "circuit-breaker-tripped" ? "保护机制暂时阻止了执行" : "没有可用的 Hermes 实例");
      if (outcome.status === "unknown-runbook") {
        return sendJson(res, 404, { error: `unknown-runbook: ${action}` });
      }
      if (outcome.status === "circuit-breaker-tripped") {
        return sendJson(res, 409, { error: "circuit-breaker-tripped" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    const logFixJobMatch = /^\/api\/logs\/fix\/([^/]+)$/.exec(path);
    if (logFixJobMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const job = recoveryJobs.get(decodeURIComponent(logFixJobMatch[1]!));
      if (!job) return sendJson(res, 404, { error: "log-fix-job-not-found" });
      return sendJson(res, 200, job);
    }

    if (path === "/api/logs" || path.startsWith("/api/logs/")) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.logs === undefined) return sendJson(res, 503, { error: "logs-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      if (path === "/api/logs") {
        return sendJson(res, 200, {
          sources: deps.logs.listSources(instanceId),
          instanceId: instanceId ?? null,
        });
      }
      const sourceId = decodeURIComponent(path.slice("/api/logs/".length));
      if (sourceId === "") return sendJson(res, 400, { error: "invalid-source-id" });
      const limitRaw = url.searchParams.get("limit");
      let limit = 200;
      if (limitRaw !== null) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit <= 0 || limit > 2_000) {
          return sendJson(res, 400, { error: "invalid-limit" });
        }
      }
      const beforeRaw = url.searchParams.get("before");
      let before: number | null = null;
      if (beforeRaw !== null && beforeRaw !== "") {
        before = Number(beforeRaw);
        if (!Number.isInteger(before) || before < 0) {
          return sendJson(res, 400, { error: "invalid-before" });
        }
      }
      const view = deps.logs.readTail(sourceId, instanceId, limit, before);
      if (view === null) return sendJson(res, 404, { error: "log-source-not-found" });
      return sendJson(res, 200, view);
    }

    if (path === "/api/memory") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const view = await deps.skills.status({
        ...(instanceId === undefined ? {} : { instanceId }),
        limit: 20,
      });
      return sendJson(res, 200, { instance: view.instance, memory: view.memory });
    }

    if (
      path === "/api/memory/archive" ||
      path === "/api/memory/restore" ||
      path === "/api/memory/purge"
    ) {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const entryIds = isStringArray(body["entryIds"]) ? body["entryIds"] : undefined;
      const olderThan =
        typeof body["olderThan"] === "string" && body["olderThan"] !== ""
          ? body["olderThan"]
          : undefined;
      const query = instanceId === undefined ? {} : { instanceId };
      let result;
      if (path === "/api/memory/archive") {
        const dryRun = body["dryRun"] === true;
        const keepMonths =
          typeof body["keepMonths"] === "number" && Number.isFinite(body["keepMonths"])
            ? body["keepMonths"]
            : undefined;
        result = await deps.skills.archiveCold(query, {
          dryRun,
          ...(olderThan === undefined ? {} : { olderThan }),
          ...(keepMonths === undefined ? {} : { keepMonths }),
          ...(entryIds === undefined ? {} : { entryIds }),
        });
      } else if (path === "/api/memory/restore") {
        result = await deps.skills.restoreCold(query, {
          ...(entryIds === undefined ? {} : { entryIds }),
          ...(olderThan === undefined ? {} : { olderThan }),
        });
      } else {
        const confirmed = body["confirmed"] === true;
        const kind = body["kind"] === "probes" ? "probes" : body["kind"] === "archived" ? "archived" : undefined;
        const archivedBefore =
          typeof body["archivedBefore"] === "string" && body["archivedBefore"] !== ""
            ? body["archivedBefore"]
            : undefined;
        result = await deps.skills.purge(query, {
          confirmed,
          ...(kind === undefined ? {} : { kind }),
          ...(entryIds === undefined ? {} : { entryIds }),
          ...(archivedBefore === undefined ? {} : { archivedBefore }),
        });
      }
      if (result.ok) {
        return sendJson(res, 200, {
          ok: true,
          instanceId: result.instanceId,
          report: result.report,
        });
      }
      const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
      return sendJson(res, status, {
        error: result.error ?? "memory-action-failed",
        userHint: result.userHint,
      });
    }

    if (path === "/api/memory/rebuild-index") {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const query = instanceId === undefined ? {} : { instanceId };
      const result = await deps.skills.rebuildIndex(query);
      if (result.ok) {
        return sendJson(res, 200, {
          ok: true,
          instanceId: result.instanceId,
          report: result.report,
        });
      }
      const status = result.code === "E002" ? 400 : result.code === "E403" ? 409 : 500;
      return sendJson(res, status, {
        error: result.error ?? "memory-rebuild-index-failed",
        userHint: result.userHint,
      });
    }

    if (path === "/api/memory/export") {
      if (deps.m6WritesEnabled !== true) return sendJson(res, 404, { error: "not-found" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.skills === undefined) return sendJson(res, 503, { error: "skills-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const passphrase = typeof body["passphrase"] === "string" ? body["passphrase"] : "";
      const result = await deps.skills.exportEncrypted(
        instanceId === undefined ? {} : { instanceId },
        passphrase,
      );
      if (!result.ok) {
        const status =
          result.code === "passphrase-too-short" ||
          result.code === "memory-store-not-found" ||
          result.code === "E002"
            ? 400
            : 500;
        return sendJson(res, status, {
          error: result.error ?? "memory-export-failed",
          userHint: result.userHint,
        });
      }
      return sendBytes(res, result.filename ?? "butler-memory-export.abmem", result.data ?? new Uint8Array());
    }

    if (path === "/api/memory/self-check") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.memorySelfCheck === undefined) {
        return sendJson(res, 503, { error: "memory-self-check-unavailable" });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.memorySelfCheck(instanceId);
      if (!outcome.ok) {
        return sendJson(res, 503, { error: outcome.error ?? outcome.code });
      }
      return sendJson(res, 200, {
        ok: true,
        instanceId: outcome.instanceId,
        result: outcome.result,
      });
    }

        if (path === "/api/upgrade/run") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const targetVersion = body["targetVersion"];
      if (typeof targetVersion !== "string" || targetVersion.trim() === "") {
        return sendJson(res, 400, { error: "missing-target-version" });
      }
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const channel =
        body["channel"] === "beta" ? "beta" : body["channel"] === "stable" ? "stable" : undefined;
      const outcome = await deps.upgrade.startUpgrade({ instanceId, targetVersion, channel });
      if (outcome.status === "started") {
        return sendJson(res, 202, {
          started: true,
          jobId: outcome.jobId,
          instanceId: outcome.instanceId,
        });
      }
      if (outcome.status === "upgrade-in-flight") {
        return sendJson(res, 409, { error: "upgrade-in-flight" });
      }
      if (outcome.status === "missing-target-version") {
        return sendJson(res, 400, { error: "missing-target-version" });
      }
      if (outcome.status === "backup-failed") {
        return sendJson(res, 503, { error: "upgrade-prebackup-failed", detail: outcome.error });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/upgrade/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { job: deps.upgrade.status() });
    }

    if (path === "/api/upgrade/versions") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const result = await deps.upgrade.listVersions();
      return sendJson(res, 200, result);
    }

    if (path === "/api/upgrade/compatibility") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body["targetVersion"] !== "string" || body["targetVersion"].trim() === "") return sendJson(res, 400, { error: "missing-target-version" });
      return sendJson(res, 200, deps.upgrade.compatibility({ targetVersion: body["targetVersion"], instanceId: typeof body["instanceId"] === "string" ? body["instanceId"] : undefined }));
    }

    if (path === "/api/prompt-optimization/targets") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      return sendJson(res, 200, { targets: deps.promptOptimization.listTargets() });
    }

    const promptActiveMatch = /^\/api\/prompt-optimization\/active\/([^/]+)$/.exec(path);
    if (promptActiveMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      const active = deps.promptOptimization.getActive(decodeURIComponent(promptActiveMatch[1]!));
      if (active === null) return sendJson(res, 404, { error: "prompt-target-not-found" });
      return sendJson(res, 200, active);
    }

    if (path === "/api/prompt-optimization/candidates") {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method === "GET") {
        const targetId = url.searchParams.get("targetId")?.trim() || undefined;
        return sendJson(res, 200, {
          candidates: deps.promptOptimization.listCandidates(targetId),
        });
      }
      if (method === "POST") {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const outcome = deps.promptOptimization.createCandidate(body);
        if (outcome.status === "error") {
          const status = outcome.error === "target-not-found" ? 404 : 400;
          return sendJson(res, status, outcome);
        }
        return sendJson(res, 201, { candidate: outcome.candidate });
      }
      return sendJson(res, 405, { error: "method-not-allowed" });
    }

    const promptEvaluateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/evaluate$/.exec(
      path,
    );
    if (promptEvaluateMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const candidateId = decodeURIComponent(promptEvaluateMatch[1]!);
      const outcome = await deps.promptOptimization.evaluateCandidate({
        ...body,
        candidateId,
      });
      if (outcome.status === "error") {
        const status = outcome.error === "candidate-not-found" ? 404 : 400;
        return sendJson(res, status, outcome);
      }
      return sendJson(res, 201, { report: outcome.report });
    }

    const promptPromoteMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/promote$/.exec(
      path,
    );
    if (promptPromoteMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const candidateId = decodeURIComponent(promptPromoteMatch[1]!);
      const outcome = deps.promptOptimization.promoteCandidate({ ...body, candidateId });
      if (outcome.status === "error") {
        const notFound = new Set([
          "candidate-not-found",
          "target-not-found",
          "evaluation-not-found",
        ]);
        const conflict = new Set([
          "confirmation-required",
          "evaluation-stale",
          "promotion-not-allowed",
          "source-changed",
          "candidate-tampered",
        ]);
        const status = notFound.has(outcome.error)
          ? 404
          : conflict.has(outcome.error)
            ? 409
            : outcome.error === "write-failed"
              ? 500
              : 400;
        return sendJson(res, status, outcome);
      }
      return sendJson(res, 200, outcome);
    }

    const promptCandidateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)$/.exec(path);
    if (promptCandidateMatch !== null) {
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const candidate = deps.promptOptimization.getCandidate(
        decodeURIComponent(promptCandidateMatch[1]!),
      );
      if (candidate === null) return sendJson(res, 404, { error: "prompt-candidate-not-found" });
      return sendJson(res, 200, { candidate });
    }

    const promptCandidateReportMatch =
      /^\/api\/prompt-optimization\/candidates\/([^/]+)\/report$/.exec(path);
    if (promptCandidateReportMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.promptOptimization === undefined) {
        return sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      }
      const outcome = deps.promptOptimization.getCandidateReport(
        decodeURIComponent(promptCandidateReportMatch[1]!),
      );
      if (outcome === null) return sendJson(res, 404, { error: "prompt-candidate-not-found" });
      return sendJson(res, 200, outcome);
    }

    const rollbackMatch = /^\/api\/snapshots\/([^/]+)\/rollback$/.exec(path);
    if (rollbackMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const idRaw = decodeURIComponent(rollbackMatch[1]!);
      if (!/^\d+$/.test(idRaw)) return sendJson(res, 400, { error: "invalid-snapshot-id" });
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;
      const outcome = await deps.upgrade.rollbackSnapshot(Number(idRaw), instanceId);
      if (outcome.status === "ok") return sendJson(res, 200, { job: outcome.job });
      if (outcome.status === "snapshot-not-found") {
        return sendJson(res, 404, { error: "snapshot-not-found" });
      }
      return sendJson(res, 503, { error: "no-servicing-instance" });
    }

    if (path === "/api/gateway/stats") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { stats: await deps.gateway.stats() });
    }

    if (path === "/api/gateway/patches") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { patches: await deps.gateway.patches() });
    }

    const patchPreviewMatch = /^\/api\/gateway\/patches\/([^/]+)\/preview$/.exec(path);
    if (patchPreviewMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const rawParams = body["params"];
      const params = rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? Object.fromEntries(Object.entries(rawParams as Record<string, unknown>).filter(([, value]) => typeof value === "number")) as Record<string, number>
        : undefined;
      const outcome = await deps.gateway.previewPatch({
        patchId: decodeURIComponent(patchPreviewMatch[1]!),
        params,
        instanceId: typeof body["instanceId"] === "string" ? body["instanceId"] : undefined,
      });
      if (outcome.status === "ok") return sendJson(res, 200, { preview: outcome.preview });
      if (outcome.status === "unknown-patch") return sendJson(res, 404, { error: "unknown-patch" });
      return sendJson(res, 503, { error: "no-instance" });
    }

    const patchActionMatch = /^\/api\/gateway\/patches\/([^/]+)\/(apply|reapply|detect)$/.exec(
      path,
    );
    if (patchActionMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 400/413
      const id = decodeURIComponent(patchActionMatch[1]!);
      const action = patchActionMatch[2]!;
      const instanceId =
        typeof body["instanceId"] === "string" && body["instanceId"] !== ""
          ? body["instanceId"]
          : undefined;

      if (action === "detect") {
        const outcome = await deps.gateway.detectPatch({ patchId: id, instanceId });
        if (outcome.status === "ok") return sendJson(res, 200, { report: outcome.report });
        if (outcome.status === "unknown-patch")
          return sendJson(res, 404, { error: "unknown-patch" });
        return sendJson(res, 503, { error: "no-instance" });
      }

      // apply / reapply：params 必须是对象且值全为有限数值（其余交由服务层校验界限）
      const rawParams = body["params"];
      let params: Record<string, number> | undefined;
      if (rawParams !== undefined) {
        if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
          return sendJson(res, 400, {
            error: "invalid-params",
            detail: "params 必须是对象（参数名 → 数值）",
          });
        }
        for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return sendJson(res, 400, {
              error: "invalid-params",
              detail: `参数 params.${key} 必须是数值`,
            });
          }
        }
        params = rawParams as Record<string, number>;
      }

      const outcome =
        action === "apply"
          ? await deps.gateway.applyPatch({ patchId: id, params, instanceId })
          : await deps.gateway.reapplyPatch({ patchId: id, params, instanceId });
      if (outcome.status === "ok") {
        return sendJson(res, 200, {
          status: "ok",
          result: outcome.result,
          targetPath: outcome.targetPath,
          params: outcome.params,
        });
      }
      if (outcome.status === "unknown-patch") return sendJson(res, 404, { error: "unknown-patch" });
      if (outcome.status === "invalid-params") {
        return sendJson(res, 400, { error: "invalid-params", detail: outcome.error });
      }
      if (outcome.status === "patch-conflict") {
        return sendJson(res, 409, { error: "patch-conflict", detail: outcome.error });
      }
      if (outcome.status === "config-blocked") {
        return sendJson(res, 409, { error: "config-invariants-blocked", detail: outcome.error });
      }
      return sendJson(res, 503, { error: "no-instance" });
    }

    if (path === "/api/evolution/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      return sendJson(res, 200, {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        ...deps.evolution.status(),
      });
    }

    if (["/api/evolution/overview", "/api/evolution/metrics", "/api/evolution/failures", "/api/evolution/datasets", "/api/evolution/action-items"].includes(path)) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolutionAnalytics === undefined) return sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const rawRange = url.searchParams.get("range") ?? "7d";
      if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") return sendJson(res, 400, { error: "invalid-range" });
      if (path === "/api/evolution/overview") return sendJson(res, 200, await deps.evolutionAnalytics.overview(instanceId, rawRange));
      if (path === "/api/evolution/metrics") return sendJson(res, 200, await deps.evolutionAnalytics.metrics(instanceId, rawRange));
      if (path === "/api/evolution/failures") return sendJson(res, 200, await deps.evolutionAnalytics.failures(instanceId, rawRange));
      if (path === "/api/evolution/datasets") return sendJson(res, 200, await deps.evolutionAnalytics.datasets(instanceId));
      return sendJson(res, 200, await deps.evolutionAnalytics.actionItems(instanceId));
    }

    const evolutionActionRecheck = /^\/api\/evolution\/action-items\/([^/]+)\/recheck$/.exec(path);
    if (evolutionActionRecheck !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolutionAnalytics === undefined) return sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      const result = await deps.evolutionAnalytics.recheck(decodeURIComponent(evolutionActionRecheck[1]!));
      return sendJson(res, "error" in result ? 404 : 200, result);
    }

    if (path === "/api/evolution/analyze") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolutionAnalytics === undefined) return sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") return sendJson(res, 400, { error: "invalid-instanceId" });
      const rawRange = body["range"] ?? "7d";
      if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") return sendJson(res, 400, { error: "invalid-range" });
      return sendJson(res, 200, await deps.evolutionAnalytics.analyze(typeof body["instanceId"] === "string" ? body["instanceId"] : undefined, rawRange));
    }

    if (path === "/api/evolution/insights") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolutionInsights === undefined) return sendJson(res, 503, { error: "evolution-insights-unavailable" });
      const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
      const rawRange = url.searchParams.get("range") ?? "7d";
      if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") return sendJson(res, 400, { error: "invalid-range" });
      return sendJson(res, 200, await deps.evolutionInsights.analyze(instanceId, rawRange));
    }
    const directionAction = /^\/api\/evolution\/directions\/([^/]+)\/(summarize|confirm|start)$/.exec(path);
    if (directionAction !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolutionInsights === undefined) return sendJson(res, 503, { error: "evolution-insights-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const id = decodeURIComponent(directionAction[1]!);
      const action = directionAction[2]!;
      if (action === "summarize") {
        if (body["profileId"] !== undefined && typeof body["profileId"] !== "string") return sendJson(res, 400, { error: "invalid-profileId" });
        const result = await deps.evolutionInsights.summarize(id, typeof body["profileId"] === "string" ? body["profileId"] : undefined);
        return sendJson(res, "error" in result ? 404 : 200, result);
      }
      if (action === "confirm") {
        if (body["targetRef"] !== undefined && typeof body["targetRef"] !== "string") return sendJson(res, 400, { error: "invalid-target-ref" });
        const result = deps.evolutionInsights.confirm(id, typeof body["targetRef"] === "string" ? body["targetRef"] : undefined);
        return sendJson(res, "error" in result ? 409 : 200, result);
      }
      if (body["mode"] !== "hermes" && body["mode"] !== "manual") return sendJson(res, 400, { error: "invalid-execution-mode" });
      const result = await deps.evolutionInsights.start(id, {
        mode: body["mode"],
        ...(typeof body["targetRef"] === "string" ? { targetRef: body["targetRef"] } : {}),
        ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}),
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
      });
      return sendJson(res, "error" in result ? 409 : 200, result);
    }

    if (path === "/api/evolution/targets") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.externalEvolution === undefined) return sendJson(res, 503, { error: "external-evolution-unavailable" });
      return sendJson(res, 200, { targets: await deps.externalEvolution.targets() });
    }
    if (path === "/api/evolution/proposals") {
      if (deps.externalEvolution === undefined) return sendJson(res, 503, { error: "external-evolution-unavailable" });
      if (method === "GET") return sendJson(res, 200, { proposals: deps.externalEvolution.list() });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body["targetRef"] !== "string" || typeof body["problem"] !== "string") return sendJson(res, 400, { error: "invalid-proposal" });
      const result = await deps.externalEvolution.create({ targetRef: body["targetRef"], problem: body["problem"], ...(Array.isArray(body["evidence"]) ? { evidence: body["evidence"].filter((item): item is string => typeof item === "string") } : {}), ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}) });
      return sendJson(res, "error" in result ? 400 : 201, result);
    }
    const proposalMatch = /^\/api\/evolution\/proposals\/([^/]+)$/.exec(path);
    if (proposalMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.externalEvolution === undefined) return sendJson(res, 503, { error: "external-evolution-unavailable" });
      const proposal = deps.externalEvolution.get(decodeURIComponent(proposalMatch[1]!));
      return proposal === null ? sendJson(res, 404, { error: "proposal-not-found" }) : sendJson(res, 200, proposal);
    }
    const validateMatch = /^\/api\/evolution\/proposals\/([^/]+)\/validate$/.exec(path);
    if (validateMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.externalEvolution === undefined) return sendJson(res, 503, { error: "external-evolution-unavailable" });
      const result = await deps.externalEvolution.validate(decodeURIComponent(validateMatch[1]!));
      return sendJson(res, "error" in result ? 404 : 200, result);
    }
    const applyMatch = /^\/api\/evolution\/proposals\/([^/]+)\/apply$/.exec(path);
    if (applyMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.externalEvolution === undefined) return sendJson(res, 503, { error: "external-evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const result = await deps.externalEvolution.apply(decodeURIComponent(applyMatch[1]!), body["confirmed"] === true);
      return sendJson(res, "error" in result ? 409 : 200, result);
    }

    if (path === "/api/llm/profiles") {
      if (deps.llm === undefined) return sendJson(res, 503, { error: "llm-manager-unavailable" });
      if (method === "GET") return sendJson(res, 200, { profiles: deps.llm.listProfiles() });
      if (!options.credentialWritesAllowed) return sendJson(res, 403, { error: "credential-writes-require-loopback" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const protocol = body["protocol"];
      if (typeof body["provider"] !== "string" || typeof body["endpoint"] !== "string" || body["endpoint"].trim() === "" || typeof body["model"] !== "string" || body["model"].trim() === "" || typeof body["apiKey"] !== "string" || body["apiKey"] === "" || !["openai-compatible", "anthropic", "gemini"].includes(String(protocol))) {
        return sendJson(res, 400, { error: "invalid-llm-profile" });
      }
      try {
        const profile = await deps.llm.createProfile({
          profileId: randomUUID(), provider: body["provider"].trim(), protocol: protocol as LlmProtocol,
          endpoint: body["endpoint"].trim(), model: body["model"].trim(), apiKey: body["apiKey"],
          ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
        });
        return sendJson(res, 201, { profile });
      } catch (error) {
        const code = error instanceof Error ? error.message : "llm-profile-create-failed";
        return sendJson(res, code === "secret-vault-unavailable" ? 503 : code === "profile-not-found" ? 404 : 409, { error: code });
      }
    }

    if (path === "/api/llm/bindings") {
      if (deps.llm === undefined) return sendJson(res, 503, { error: "llm-manager-unavailable" });
      if (method === "GET") return sendJson(res, 200, { bindings: deps.llm.listBindings() });
      if (!options.credentialWritesAllowed) return sendJson(res, 403, { error: "credential-writes-require-loopback" });
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body["profileId"] !== "string" || !["instance", "framework", "skill", "plugin", "evolution"].includes(String(body["scope"]))) return sendJson(res, 400, { error: "invalid-llm-binding" });
      try {
        const binding = deps.llm.addBinding({ bindingId: randomUUID(), scope: body["scope"] as "instance" | "framework" | "skill" | "plugin" | "evolution", profileId: body["profileId"], ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}), ...(typeof body["frameworkId"] === "string" ? { frameworkId: body["frameworkId"] } : {}), ...(typeof body["targetRef"] === "string" ? { targetRef: body["targetRef"] } : {}) });
        return sendJson(res, 201, { binding });
      } catch (error) {
        const code = error instanceof Error ? error.message : "llm-binding-conflict";
        const status = code === "profile-not-found" ? 404 : ["binding-target-required", "binding-instance-required", "binding-framework-required"].includes(code) ? 400 : 409;
        return sendJson(res, status, { error: code });
      }
    }

    if (path === "/api/llm/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return deps.llm === undefined ? sendJson(res, 503, { error: "llm-manager-unavailable" }) : sendJson(res, 200, deps.llm.status());
    }

    const llmProfileAction = /^\/api\/llm\/profiles\/([^/]+)\/(rotate|probe|disable)$/.exec(path);
    if (llmProfileAction !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (!options.credentialWritesAllowed) return sendJson(res, 403, { error: "credential-writes-require-loopback" });
      if (deps.llm === undefined) return sendJson(res, 503, { error: "llm-manager-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const profileId = decodeURIComponent(llmProfileAction[1]!);
      try {
        if (llmProfileAction[2] === "rotate") {
          if (typeof body["apiKey"] !== "string" || body["apiKey"] === "") return sendJson(res, 400, { error: "invalid-api-key" });
          return sendJson(res, 200, { profile: await deps.llm.rotateProfile(profileId, body["apiKey"]) });
        }
        if (llmProfileAction[2] === "probe") return sendJson(res, 200, { probe: await deps.llm.probeProfile(profileId) });
        return sendJson(res, 200, { profile: deps.llm.disableProfile(profileId) });
      } catch (error) {
        const code = error instanceof Error ? error.message : "llm-profile-action-failed";
        return sendJson(res, code === "profile-not-found" || code === "profile-version-not-found" ? 404 : code === "secret-vault-unavailable" ? 503 : 409, { error: code });
      }
    }

    const llmBindingMatch = /^\/api\/llm\/bindings\/([^/]+)$/.exec(path);
    if (llmBindingMatch !== null) {
      if (method !== "DELETE") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.llm === undefined) return sendJson(res, 503, { error: "llm-manager-unavailable" });
      if (!options.credentialWritesAllowed) return sendJson(res, 403, { error: "credential-writes-require-loopback" });
      return deps.llm.deleteBinding(decodeURIComponent(llmBindingMatch[1]!)) ? sendJson(res, 204, null) : sendJson(res, 404, { error: "llm-binding-not-found" });
    }

    if (path === "/api/llm/discovered") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.llm === undefined || typeof deps.llm.discover !== "function") return sendJson(res, 503, { error: "llm-discovery-unavailable" });
      return sendJson(res, 200, { configs: await deps.llm.discover() });
    }
    const discoveredImport = /^\/api\/llm\/discovered\/([^/]+)\/import$/.exec(path);
    if (discoveredImport !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (!options.credentialWritesAllowed) return sendJson(res, 403, { error: "credential-writes-require-loopback" });
      if (deps.llm === undefined || typeof deps.llm.importDiscovered !== "function") return sendJson(res, 503, { error: "llm-discovery-unavailable" });
      try { return sendJson(res, 201, { profile: await deps.llm.importDiscovered(decodeURIComponent(discoveredImport[1]!)) }); }
      catch (error) {
        const code = error instanceof Error ? error.message : "llm-discovery-import-failed";
        return sendJson(res, code === "discovered-config-not-found" ? 404 : code === "secret-vault-unavailable" ? 503 : 409, { error: code });
      }
    }

    if (path === "/api/evolution/diagnose") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") {
        return sendJson(res, 400, { error: "invalid-instanceId" });
      }
      const analyzed = deps.analyzeLogs?.(typeof body["instanceId"] === "string" ? body["instanceId"] : undefined);
      return sendJson(res, 200, deps.evolution.diagnose(analyzed));
    }

    if (path === "/api/evolution/runs") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (body["targetType"] !== "skill" && body["targetType"] !== "prompt" && body["targetType"] !== "config") {
        return sendJson(res, 400, { error: "invalid-target-type" });
      }
      if (typeof body["targetRef"] !== "string" || body["targetRef"].trim() === "") {
        return sendJson(res, 400, { error: "invalid-target-ref" });
      }
      if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") return sendJson(res, 400, { error: "invalid-instanceId" });
      if (body["profileId"] !== undefined && typeof body["profileId"] !== "string") return sendJson(res, 400, { error: "invalid-profileId" });
      if (body["endpoint"] !== undefined && typeof body["endpoint"] !== "string") return sendJson(res, 400, { error: "invalid-endpoint" });
      if (body["datasetPath"] !== undefined && typeof body["datasetPath"] !== "string") return sendJson(res, 400, { error: "invalid-dataset-path" });
      if (body["holdoutCount"] !== undefined && (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0)) return sendJson(res, 400, { error: "invalid-holdout-count" });
      if (body["iterations"] !== undefined && (!Number.isInteger(body["iterations"]) || (body["iterations"] as number) < 1 || (body["iterations"] as number) > 100)) return sendJson(res, 400, { error: "invalid-iterations" });
      if (body["dryRun"] !== undefined && typeof body["dryRun"] !== "boolean") return sendJson(res, 400, { error: "invalid-dry-run" });
      const run = await deps.evolution.createRun({
        targetType: body["targetType"],
        targetRef: body["targetRef"],
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
        ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}),
        ...(typeof body["endpoint"] === "string" ? { endpoint: body["endpoint"] } : {}),
        ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
        ...(typeof body["holdoutCount"] === "number" ? { holdoutCount: body["holdoutCount"] } : {}),
        ...(typeof body["iterations"] === "number" ? { iterations: body["iterations"] } : {}),
        ...(typeof body["dryRun"] === "boolean" ? { dryRun: body["dryRun"] } : {}),
      });
      return sendJson(res, run.status === "ready" ? 201 : 409, run);
    }

    const evolutionRunMatch = /^\/api\/evolution\/runs\/([^/]+)$/.exec(path);
    if (evolutionRunMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const run = await deps.evolution.getRun(decodeURIComponent(evolutionRunMatch[1]!));
      return run === null ? sendJson(res, 404, { error: "run-not-found" }) : sendJson(res, 200, run);
    }

    const evolutionStartMatch = /^\/api\/evolution\/runs\/([^/]+)\/start$/.exec(path);
    if (evolutionStartMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const outcome = await deps.evolution.startRun(decodeURIComponent(evolutionStartMatch[1]!));
      if ("error" in outcome) return sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return sendJson(res, 202, outcome);
    }

    if (path === "/api/evolution/preflight") {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
        return sendJson(res, 400, { error: "invalid-holdout-count" });
      }
      if (body["dependencies"] !== undefined && !isStringArray(body["dependencies"])) {
        return sendJson(res, 400, { error: "invalid-dependencies" });
      }
      if (body["config"] !== undefined && !isRecord(body["config"])) {
        return sendJson(res, 400, { error: "invalid-config" });
      }
      if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
        return sendJson(res, 400, { error: "invalid-errors" });
      }
      if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
        return sendJson(res, 400, { error: "invalid-fixes" });
      }
      for (const field of ["instanceId", "endpoint", "datasetPath", "rootCause"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return sendJson(res, 400, { error: `invalid-${field}` });
        }
      }
      const input: EvolutionPreflightInput = {
        holdoutCount: body["holdoutCount"] as number,
        ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
        ...(isStringArray(body["dependencies"]) ? { dependencies: body["dependencies"] } : {}),
        ...(typeof body["endpoint"] === "string" ? { endpoint: body["endpoint"] } : {}),
        ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
        ...(isRecord(body["config"]) ? { config: body["config"] } : {}),
        ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
        ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
        ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
      };
      return sendJson(res, 200, await deps.evolution.preflight(input));
    }

    const evolutionEvaluateMatch = /^\/api\/evolution\/runs\/([^/]+)\/evaluate$/.exec(path);
    if (evolutionEvaluateMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const runId = decodeURIComponent(evolutionEvaluateMatch[1]!);
      const outcome = await deps.evolution.evaluateRun(runId);
      if (outcome.status === "error") return sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return sendJson(res, 200, outcome);
    }

    const evolutionExpandMatch = /^\/api\/evolution\/runs\/([^/]+)\/expand$/.exec(path);
    if (evolutionExpandMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
        return sendJson(res, 400, { error: "invalid-holdout-count" });
      }
      if (
        body["targetCount"] !== undefined &&
        (!Number.isInteger(body["targetCount"]) || (body["targetCount"] as number) < 1)
      ) {
        return sendJson(res, 400, { error: "invalid-target-count" });
      }
      if (body["datasetPath"] !== undefined && typeof body["datasetPath"] !== "string") {
        return sendJson(res, 400, { error: "invalid-dataset-path" });
      }
      if (body["seedExamples"] !== undefined && !Array.isArray(body["seedExamples"])) {
        return sendJson(res, 400, { error: "invalid-seed-examples" });
      }
      const runId = decodeURIComponent(evolutionExpandMatch[1]!);
      const input: EvolutionExpandInput = {
        runId,
        holdoutCount: body["holdoutCount"] as number,
        ...(typeof body["targetCount"] === "number" ? { targetCount: body["targetCount"] } : {}),
        ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
        ...(Array.isArray(body["seedExamples"]) ? { seedExamples: body["seedExamples"] } : {}),
      };
      const outcome = await deps.evolution.expandDataset(input);
      if (outcome.error === "run-not-found") return sendJson(res, 404, outcome);
      if (outcome.status === "error") return sendJson(res, 400, outcome);
      return sendJson(res, 200, outcome);
    }

    const evolutionResultMatch = /^\/api\/evolution\/runs\/([^/]+)\/result$/.exec(path);
    if (evolutionResultMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (
        typeof body["baselineMetric"] !== "number" ||
        !Number.isFinite(body["baselineMetric"]) ||
        typeof body["candidateMetric"] !== "number" ||
        !Number.isFinite(body["candidateMetric"]) ||
        typeof body["significant"] !== "boolean"
      ) {
        return sendJson(res, 400, { error: "invalid-result" });
      }
      if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
        return sendJson(res, 400, { error: "invalid-errors" });
      }
      if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
        return sendJson(res, 400, { error: "invalid-fixes" });
      }
      if (body["rootCause"] !== undefined && typeof body["rootCause"] !== "string") {
        return sendJson(res, 400, { error: "invalid-rootCause" });
      }
      for (const field of ["targetPath", "candidatePath"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return sendJson(res, 400, { error: `invalid-${field}` });
        }
      }
      const input: EvolutionResultInput = {
        runId: decodeURIComponent(evolutionResultMatch[1]!),
        baselineMetric: body["baselineMetric"],
        candidateMetric: body["candidateMetric"],
        significant: body["significant"],
        ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
        ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
        ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
        ...(typeof body["targetPath"] === "string" ? { targetPath: body["targetPath"] } : {}),
        ...(typeof body["candidatePath"] === "string"
          ? { candidatePath: body["candidatePath"] }
          : {}),
      };
      const outcome = await deps.evolution.recordResult(input);
      if (outcome.error === "run-not-found") return sendJson(res, 404, outcome);
      if (outcome.error === "run-not-ready") return sendJson(res, 409, outcome);
      if (outcome.status === "error") return sendJson(res, 400, outcome);
      return sendJson(res, 200, outcome);
    }

    const evolutionPromoteMatch = /^\/api\/evolution\/runs\/([^/]+)\/promote$/.exec(path);
    if (evolutionPromoteMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body["token"] !== "string" || body["token"] === "") {
        return sendJson(res, 400, { error: "invalid-token" });
      }
      for (const field of ["targetPath", "candidatePath"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return sendJson(res, 400, { error: `invalid-${field}` });
        }
      }
      const input: EvolutionPromoteInput = {
        runId: decodeURIComponent(evolutionPromoteMatch[1]!),
        token: body["token"],
        ...(typeof body["targetPath"] === "string" ? { targetPath: body["targetPath"] } : {}),
        ...(typeof body["candidatePath"] === "string"
          ? { candidatePath: body["candidatePath"] }
          : {}),
      };
      const outcome = await deps.evolution.promoteRun(input);
      if (outcome.status === "error") {
        const notFound = new Set(["run-not-found", "authority-not-found"]);
        const conflict = new Set([
          "authority-used",
          "path-not-allowed",
          "target-changed",
          "candidate-tampered",
        ]);
        const status = notFound.has(outcome.error)
          ? 404
          : conflict.has(outcome.error)
            ? 409
            : outcome.error === "write-failed"
              ? 500
              : 400;
        return sendJson(res, status, outcome);
      }
      return sendJson(res, 200, outcome);
    }

    const evolutionCancelMatch = /^\/api\/evolution\/runs\/([^/]+)\/cancel$/.exec(path);
    if (evolutionCancelMatch !== null) {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined) return sendJson(res, 503, { error: "evolution-unavailable" });
      const outcome = await deps.evolution.cancelRun(decodeURIComponent(evolutionCancelMatch[1]!));
      if ("error" in outcome) return sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return sendJson(res, 200, outcome);
    }

    if (path === "/api/diagnostics/report") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.renderDiagnostics === undefined)
        return sendJson(res, 503, { error: "diagnostics-unavailable" });
      const markdown = await deps.renderDiagnostics();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      if (url.searchParams.get("format") === "zip") {
        return sendZip(res, `agent-butler-diagnostic-${stamp}.zip`, createDiagnosticZip(markdown));
      }
      return sendMarkdown(res, `agent-butler-diagnostic-${stamp}.md`, markdown);
    }

    if (path === "/api/diagnostics/summary") {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.diagnosticSummary === undefined) return sendJson(res, 503, { error: "diagnostics-unavailable" });
      return sendJson(res, 200, await deps.diagnosticSummary());
    }

        const evolutionExportMatch = /^\/api\/evolution\/ledger\/([^/]+)\/export$/.exec(path);
    if (evolutionExportMatch !== null) {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      if (deps.evolution === undefined)
        return sendJson(res, 503, { error: "evolution-unavailable" });
      const exported = deps.evolution.exportLedger(decodeURIComponent(evolutionExportMatch[1]!));
      if (exported === null) return sendJson(res, 404, { error: "ledger-not-found" });
      return sendMarkdown(res, exported.filename, exported.markdown);
    }

    return sendJson(res, 404, { error: "not-found" });
  } catch (error) {
    sendJson(res, 500, internalErrorResponse(error));
  }
}
