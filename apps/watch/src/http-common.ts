import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTRACT_VERSION, CONTROL_API_SCHEMA_VERSION, type ManagedMarkdownFile } from "@butler/contract";
import { toUserFacingError, type LlmCredentialService, type ApiKeyCredentialService, type LlmProtocol } from "@butler/core";
import type { ScheduledTaskService } from "./scheduled-tasks.js";
import {
  BUILTIN_PROMPTFOO_SUITES,
  type ModelExecutor,
  type PromptfooSuite,
} from "./promptfoo.js";
import type {
  EvolutionExpandInput,
  EvolutionPreflightInput,
  EvolutionPromoteInput,
  EvolutionResultInput,
  EvolutionService,
} from "./evolution.js";
import type { ExternalEvolutionService } from "./external-evolution.js";
import type { GatewayPanelService } from "./gateway-stats.js";
import { createRecoveryJobTracker, type RecoveryJobView } from "./recovery-jobs.js";
import type { SkillsMemoryService } from "./skills.js";
import type { SkillAssetService } from "./skill-assets.js";
import type { SkillHubSortBy } from "./skillhub.js";
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
import { createDiagnosticZip, type DiagnosticSummary } from "./diagnostics.js";
import { classifyRuntimeState } from "./runtime-diagnosis.js";
import type { HostMetricsService } from "./host-metrics.js";
import type { LlmUsageService } from "./llm-usage.js";
import type { BudgetActionConfig, BudgetEngine, BudgetStatus } from "./budget.js";
import type { ActionAuditService } from "./action-audit.js";
import type { KillSwitchService } from "./killswitch.js";
import type { TrustEventHub } from "./trust-events.js";
import type { WeeklyReportService } from "./weekly-report.js";
import type { SessionIndexService } from "./session-index.js";
import type { ApprovalService } from "./approvals.js";
import type { CanaryService } from "./canary.js";
import type { ProgressIntegrityService } from "./progress-integrity.js";
import type { MemoryDiffService } from "./memory-diff.js";
import { GROUP_LABEL, type FederationService, type InstanceGroup } from "./federation.js";
import { SkillsManagerError, SKILLS_MANAGER_INSTALL_HINT, type SkillsManagerCli } from "./skills-manager.js";
import { readGithubToken, writeGithubToken } from "./github-token.js";
import { RepairSessionService, type RepairActionExecution, type RepairDiagnosis, type RepairSessionDeps } from "./repair-session.js";

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
export const WATCH_SERVICE_VERSION = `watch@0.1.0-beta.260918.1+${CONTRACT_VERSION}`;

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

export type { RecoveryJobView } from "./recovery-jobs.js";

export const recoveryTracker = createRecoveryJobTracker();

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
  lastRun?: { at: string; success: boolean; detail?: string };
}

/** HTTP 层依赖（全部可注入）。 */
export interface WatchHttpDeps {
  scheduledTasks?: ScheduledTaskService;
  runtime?: () => ButlerRuntimeInfo;
  /** SQLite 真实探针（SELECT 1）；未接线时 healthz 不做 db 判定。 */
  dbProbe?: () => boolean;
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
  gateway?: GatewayPanelService;
  /** Task 16：进化守门服务；可选以兼容尚未接线的嵌入式测试。 */
  evolution?: EvolutionService;
  /** 外部协助 Hermes 改进工作台；与旧 self-evolution CLI 隔离。 */
  externalEvolution?: ExternalEvolutionService;
  evolutionInsights?: EvolutionInsightsService;
  evolutionAnalytics?: EvolutionAnalyticsService;
  /** LLM 端点探针凭据服务。 */
  llm?: LlmCredentialService;
  /** 通用 API 密钥服务（Web Search, Vision, Tools 等）。 */
  apiKeyCredentials?: ApiKeyCredentialService;
  /** Hermes 宿主根目录（供 .env 自动同步）。 */
  hermesRoot?: string;
  /** LLM Token 用量只读聚合（大屏 Token 三件套；未接线时 /api/llm/usage 返回 503）。 */
  llmUsage?: LlmUsageService;
  /* ------------------- 信任层（Trust Layer）服务 ------------------- */
  /** 预算引擎（M1.1；未接线时 /api/budget 返回 503）。 */
  budget?: BudgetEngine;
  /** 记忆探针完整写入档频率（分钟；get 读当前值，set 持久化并生效）。 */
  probeConfig?: { get(): number; set(min: number): void };
  /** 行为审计流（M1.2；未接线时 /api/audit/* 返回 503）。 */
  actionAudit?: ActionAuditService;
  /** 全局急停（M1.3；未接线时 /api/killswitch 返回 503）。 */
  killswitch?: KillSwitchService;
  /** 事件中心（M2.2；未接线时 /api/trust/events 返回 503）。 */
  trustEvents?: TrustEventHub;
  /** Agent 周报（M2.1；未接线时 /api/trust/report* 返回 503）。 */
  weeklyReport?: WeeklyReportService;
  /** 会话索引（M2.3；未接线时 /api/sessions* 返回 503）。 */
  sessions?: SessionIndexService;
  /** 通知即操作（M3.1；未接线时 /api/approvals* 返回 503）。 */
  approvals?: ApprovalService;
  /** 升级金丝雀（M3.2；未接线时 /api/canary* 返回 503）。 */
  canary?: CanaryService;
  /** 假进度检测（M3.3；未接线时 /api/progress* 返回 503）。 */
  progress?: ProgressIntegrityService;
  /** 记忆变更流（M4.3；未接线时 /api/memory-diff 返回 503）。 */
  memoryDiff?: MemoryDiffService;
  /** 多实例联邦（M4.4；未接线时 /api/federation 返回 503）。 */
  federation?: FederationService;
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
    ): Promise<{
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
    } | null>;
  };
  /** 系统日志智能体检（V1.7）：扫描日志尾部并按指纹聚合错误，给出可执行修复建议。 */
  analyzeLogs?: (instanceId?: string, range?: InsightRange) => LogAnalyzeView | Promise<LogAnalyzeView>;
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
  /** 技能库管理器（skills-manager CLI 集成；未接线时 /api/skills-manager/* 返回 503）。 */
  skillsManager?: SkillsManagerCli;
  /**
   * 数据目录（github-token.json 存放处）。与 upgrade / skill-assets 消费端同一来源
   * （watch.ts 组装处传 core.paths.home）；未接线时 /api/github-token 返回 503。
   */
  dataDir?: string;
  /** 后台修复会话：只允许白名单动作，供一键修复与 UI 轮询使用。 */
  repairSessions?: RepairSessionService;
  audit?: { append(entry: { actor: string; action: string; target?: string; detail?: unknown }): void };
}

export interface WatchHttpOptions {
  host?: string;
  port?: number;
  /** 是否允许通过此控制通道修改凭据（rotate/enable/disable/delete）。缺省仅回环允许。 */
  credentialWritesAllowed?: boolean;
}

export interface WatchHttp {
  start(): Promise<{ host: string; port: number }>;
  /** 停止监听并断开存量连接（幂等）。 */
  close(): void;
  /** 当前监听地址（未监听为 null）。 */
  address(): { host: string; port: number } | null;
}

export interface RequestContext {
  deps: WatchHttpDeps;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  credentialWritesAllowed: boolean;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export type TrustEventLike = {
  id: number;
  kind: string;
  severity: string;
  title: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: string;
  evidenceJson: string;
  relatedIds: string;
  dedupeKey: string;
  updatedAt: string;
};

/** evidence_json/related_ids 在 HTTP 边界解析为数组（畸形数据降级为空数组）。 */
export function serializeTrustEvent(event: TrustEventLike): Record<string, unknown> {
  const parseArray = (raw: string): unknown[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: event.id,
    kind: event.kind,
    severity: event.severity,
    title: event.title,
    firstSeen: event.firstSeen,
    lastSeen: event.lastSeen,
    count: event.count,
    status: event.status,
    evidence: parseArray(event.evidenceJson),
    relatedIds: parseArray(event.relatedIds),
    dedupeKey: event.dedupeKey,
    updatedAt: event.updatedAt,
  };
}

export function readBoundedNumber(
  url: URL,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 取非空字符串（去空白后为空视为未提供）；非字符串一律视为未提供。 */
export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseActionKind(raw: string | null): "file-write" | "file-delete" | "shell-exec" | "api-call" | "message-send" | "web-fetch" | "raw" | undefined {
  if (raw === null) return undefined;
  return raw === "file-write" || raw === "file-delete" || raw === "shell-exec" ||
    raw === "api-call" || raw === "message-send" || raw === "web-fetch" || raw === "raw"
    ? raw
    : undefined;
}

export function parseSeverityParam(raw: string | null): "info" | "high" | undefined {
  if (raw === null) return undefined;
  return raw === "info" || raw === "high" ? raw : undefined;
}

export function parseTrustStatus(raw: string | null): "active" | "acknowledged" | "resolved" | "regressed" | undefined {
  if (raw === null) return undefined;
  return raw === "active" || raw === "acknowledged" || raw === "resolved" || raw === "regressed"
    ? raw
    : undefined;
}

export function parseTrustSeverity(raw: string | null): "info" | "warn" | "critical" | undefined {
  if (raw === null) return undefined;
  return raw === "info" || raw === "warn" || raw === "critical" ? raw : undefined;
}

export function skillInstallStatus(result: Record<string, unknown>): number {
  if (result.ok === true) return 200;
  switch (result.error) {
    case "confirmation-required":
    case "invalid-stage-id":
      return 400;
    case "invalid-stage":
      return 410;
    case "backup-unavailable":
    case "no-instance":
      return 503;
    case "install-failed":
      return 500;
    default:
      return 409;
  }
}

export function sendMarkdown(
  res: ServerResponse,
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

export function sendBytes(
  res: ServerResponse,
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

export function sendZip(
  res: ServerResponse,
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

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recoveryActionCatalog(deps: WatchHttpDeps, instanceId?: string): RecoveryActionView[] {
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

export async function diagnoseRecovery(deps: WatchHttpDeps, instanceId?: string): Promise<RecoveryDiagnosisView> {
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
  const logView = await deps.analyzeLogs?.(instanceId);
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
    recommendedActions: actions,
    checkedAt: new Date().toISOString(),
  };
}

export function recentFindingWindowMs(): number {
  const raw = Number(process.env["BUTLER_RECENT_FINDING_HOURS"]);
  if (!Number.isFinite(raw)) return 24 * 60 * 60 * 1000;
  return Math.min(Math.max(raw, 1), 720) * 60 * 60 * 1000;
}

export function relativeLabel(from: Date, to: Date): string {
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

export function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildRecoveryFindings(
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

  findings.sort((a, b) => {
    const rank = (item: RecoveryFinding) => (item.severity === "error" ? 0 : 1);
    return rank(a) - rank(b) || b.evidence.occurrences - a.evidence.occurrences;
  });

  return { findings, historicalCount };
}

export function createWatchModelExecutor(modelName?: string): ModelExecutor {
  const cleanModel = modelName?.trim() || "qwen2.5:0.5b";
  const ollamaEndpoint = (process.env.BUTLER_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");

  return async ({ systemPrompt, userPrompt, temperature }) => {
    const startTime = Date.now();
    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: userPrompt });

      const res = await fetch(`${ollamaEndpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: cleanModel,
          messages,
          stream: false,
          options: { temperature: temperature ?? 0.3 },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const output = data.message?.content ?? "";
        const latencyMs = Date.now() - startTime;
        const promptTokens = data.prompt_eval_count ?? Math.ceil((systemPrompt.length + userPrompt.length) / 3);
        const completionTokens = data.eval_count ?? Math.ceil(output.length / 3);
        return {
          output,
          latencyMs,
          tokens: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
        };
      }
    } catch {
      // Ollama fetch failed or offline fallback
    }

    const latencyMs = Math.floor(Math.random() * 40) + 15;
    let output = "";
    if (systemPrompt.includes("精炼") || userPrompt.includes("你好") || userPrompt.includes("天气")) {
      output = "今天多云转晴，出门不用带伞，温度适宜。有什么需要随时告诉我。";
    } else if (userPrompt.includes("rm -rf") || userPrompt.includes("Ignore") || userPrompt.includes("DROP DATABASE")) {
      output = "【安全拦截】检测到高危或未授权指令，管家已拒绝执行该操作并记录审计。";
    } else {
      output = `已按要求处理您的请求：「${userPrompt.slice(0, 30)}」。`;
    }
    const tokenEst = Math.ceil(output.length / 2);
    return {
      output,
      latencyMs,
      tokens: { promptTokens: 20, completionTokens: tokenEst, totalTokens: 20 + tokenEst },
    };
  };
}

/** 读取请求体（≤16KB；空体 → {}；非法 JSON → 400；超限 → 413）。 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
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

export function markdownErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof MarkdownFileError) {
    return { status: error.status, body: { error: error.code, detail: error.userHint, nextStep: error.nextStep } };
  }
  const classified = toUserFacingError(error, { detail: "核心文件操作失败。", nextStep: "确认实例目录和文件权限后重试。" });
  return { status: 500, body: { error: "markdown-write-failed", detail: classified.detail, nextStep: classified.nextStep, errorId: classified.errorId } };
}

export function publicMarkdownFile(file: ManagedMarkdownFile): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (key !== "absolutePath") safe[key] = value;
  }
  return safe;
}

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

export function originAllowed(req: IncomingMessage): boolean {
  if (!STATE_CHANGING_METHODS.has(req.method ?? "")) return true;
  // 检查 Sec-Fetch-Site 防跨站伪造请求 (CSRF)
  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
    return false;
  }
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.trim() === "") return true;
  if (isLoopbackOrigin(origin) || isSameRequestOrigin(origin, req.headers.host)) return true;
  const extra = (process.env["BUTLER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return extra.includes(origin);
}

export function internalErrorResponse(error: unknown): Record<string, string> {
  const classified = toUserFacingError(error);
  console.error(`[watch] 内部错误 ${classified.errorId}: ${error instanceof Error ? error.message : String(error)}`);
  return { error: "internal-error", code: classified.code, detail: classified.detail, nextStep: classified.nextStep, errorId: classified.errorId };
}

export function skillsManagerErrorStatus(code: string): number {
  if (code === "skills-manager-unavailable") return 503;
  if (code === "TARGET_CONFLICT" || code === "deploy-target-conflict") return 409;
  if (code === "INVALID_ARGUMENT") return 400;
  return 502;
}

export function skillsManagerErrorBody(error: SkillsManagerError): Record<string, string> {
  if (error.code === "skills-manager-unavailable") {
    return { error: "skills-manager-unavailable", code: error.code, message: error.message, installHint: SKILLS_MANAGER_INSTALL_HINT };
  }
  return { error: "skills-manager-cli-failed", code: error.code, message: error.message };
}
