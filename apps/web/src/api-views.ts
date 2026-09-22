/**
 * Web API 视图类型（从 server.ts 抽出；ENG-01 路由拆解的类型层）。
 * 保持与原 server.ts 导出同名，供 routes/ 与测试继续从 server.js 导入。
 */
import type { CapabilityReport, InboundHistoryEntry, JobStep } from "@butler/contract";

export interface InstanceApiView {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  capability: CapabilityReport | null;
  createdAt: string;
  updatedAt: string;
}

/** /api/dashboard 返回的单个巡检检查项视图（来自 inspection-completed 事件 payload.checks）。 */
export interface InspectionCheckView {
  id: string;
  status: string;
  detail: unknown;
  durationMs: number | null;
}

/** /api/dashboard 返回的单实例最新巡检视图。 */
export interface LatestInspectionView {
  instanceId: string;
  ts: string;
  overall: string | null;
  confidence: number | null;
  checks: InspectionCheckView[];
}

/** watch /api/upgrade/status 返回的升级 Job 视图（五步流水线的当前状态，Task 13.3）。 */
export interface UpgradeJobView {
  jobId: string;
  instanceId: string;
  targetVersion: string;
  channel?: string;
  trigger?: string;
  status: "running" | "done" | "failed";
  rolledBack?: boolean;
  snapshotId?: string;
  steps: JobStep[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** /api/versions 返回的版本源视图（reachable=false 表示版本源不可用）。 */
export interface AvailableVersionsView {
  reachable: boolean;
  source?: string;
  versions: Array<{ version: string; channel?: string }>;
  checkedAt?: string;
  attempts?: Array<{ id: string; url: string | null; status: string; error?: string; durationMs: number }>;
}

/** /api/versions 返回的快照历史视图（snapshots 表行摘要）。 */
export interface SnapshotApiView {
  id: number;
  instance: string;
  label: string | null;
  createdAt: string;
  status: string;
}

/** /api/versions 一次聚合载荷（db 不可达时附 degraded 标记）。 */
export interface VersionsApiView {
  instances: Array<{ instanceId: string; state: string; runtime: string; version: string | null }>;
  upgradeJob: UpgradeJobView | null;
  availableVersions: AvailableVersionsView;
  snapshots: SnapshotApiView[];
  watchReachable: boolean;
  degraded?: string[];
}

/** watch /api/gateway/stats 返回的限流统计视图（Task 15.2，指纹画像的聚合口径）。 */
export interface GatewayStatsView {
  overall: string;
  totalEvents: number;
  last24h: number;
  matched: Array<{
    signature: string;
    template: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    status: string;
  }>;
  suggestions: Array<{
    patchId: string;
    param: string;
    current: number;
    suggested: number;
    level: "warn" | "critical";
    reason: string;
  }>;
}

/** watch /api/gateway/patches 返回的 Hermes 形态补丁视图（Task 15.2）。 */
export interface GatewayPatchView {
  id: string;
  title: string;
  description: string;
  target: string;
  requires?: string[];
  params: Record<string, { default: number; min?: number; max?: number; integer?: boolean }>;
  applied: null | { params: Record<string, number>; appliedAt: string; targetPath: string };
  observed?: null | { params: Record<string, number>; checkedAt: string; targetPath: string };
}

export const MESSAGE_OUTBOX_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "absorbed",
  "policy_error",
  "dead_letter",
  "cancelled",
] as const;

export interface MessageBridgeView {
  connected: boolean;
  running: boolean;
  inFlight: boolean;
  attached: boolean;
  outboxWritable: boolean;
  protocolVersion: number | null;
  bridgeVersion: string | null;
  instanceId: string | null;
  policyVersion: string | null;
  policyHash: string | null;
  remotePolicyVersion: string | null;
  channels: Record<string, string>;
  channelDetails?: Record<string, { status: string; unavailableReason: string | null; unavailableFix: string | null; retryable: boolean; loginState?: string; account?: string | null }>;
  coverage: Record<string, string>;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  /** 任务执行汇总（旧 Bridge 无此字段时缺省）：failed = 执行失败的 run 数。 */
  runs?: { total: number; failed: number; active: number };
}

export interface MessageStatusView {
  bridge: MessageBridgeView;
  counts: Record<string, number>;
  /** 消息链路一键接管开关视图（旧 gateway 无此字段时缺省）。 */
  relay?: { enabled: boolean; pending: boolean; updatedAt: string | null };
}

export interface MessageItemView {
  messageId: string;
  instanceId: string;
  adapterId: string;
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  runId?: string | null;
  inboundMessageId?: string | null;
  messageKind: string;
  transport: string;
  priority: string;
  content: string;
  contentSha256: string;
  replyTo?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
  sequence: number;
  state: string;
  availableAt: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  transformTrace: string[];
  decisionId: string | null;
  lastPolicyError: string | null;
  updatedAt: string;
}

export interface MessageListView {
  counts: Record<string, number>;
  items: MessageItemView[];
}

export interface MessageOverviewApiView {
  reachable: boolean;
  status: MessageStatusView | null;
  messages: MessageListView;
  degraded: string[];
}

export interface MessageOptimizationHistoryView {
  reachable: boolean;
  items: InboundHistoryEntry[];
}

export interface DeliveryHistoryDayView {
  date: string;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface DeliveryHistoryView {
  reachable: boolean;
  days: number;
  retentionDays: number;
  items: DeliveryHistoryDayView[];
}

export interface MessageTaskView {
  runId: string;
  sessionId: string;
  state: string;
  lastEventSequence: number;
  updatedAt: string;
  events: Array<{
    runId: string;
    sequence: number;
    sessionId: string;
    kind: string;
    summary?: string;
    etaSec?: number;
    occurredAt: string;
  }>;
}

export interface EvolutionLedgerView {
  runId: string;
  updatedAt: string;
  instanceId: string | null;
  status: string;
  holdoutCount: number;
  baselineMetric?: number;
  candidateMetric?: number;
  delta?: number;
  conclusion: string;
  disposition: string;
}

export interface EvolutionApiView {
  watchReachable: boolean;
  connectionStatus:
    | "ready"
    | "watch-unreachable"
    | "watch-route-missing"
    | "watch-schema-mismatch"
    | "watch-version-mismatch";
  detail: string | null;
  schemaVersion: string | null;
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: EvolutionLedgerView[];
  hermes: {
    status: "ready" | "unavailable" | "unknown";
    root: string | null;
    detail: string;
  };
  endpointHealth: {
    status: "pass" | "fail" | "unknown";
    category: string;
    detail: string;
    checkedAt: string | null;
  };
  blocked: Array<{ category: string; detail: string; affectedRuns: string[] }>;
  tasks: unknown[];
  history: unknown[];
}

/** M5 切片 1/2：提示词 Registry 与候选评估视图（不与消息热路径共享状态）。 */
export interface PromptOptimizationGateApiView {
  status: string;
  detail: string;
  checkedAt: string;
}

export interface PromptOptimizationTargetApiView {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: string;
  editableSections: string[];
  protectedClauseCount: number;
  protectedSha256: string;
  reloadMode: string;
  activeVersion: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
  gate: PromptOptimizationGateApiView;
}

export interface PromptOptimizationApiView {
  watchReachable: boolean;
  targets: PromptOptimizationTargetApiView[];
}

export type SkillsInventoryMode = "driver" | "directory-fallback" | "unavailable";
export type AssetRiskStatus = "unscanned" | "clear" | "blocked";

export interface DirectoryInventoryView {
  roots: string[];
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillsApiView {
  watchReachable: boolean;
  instance: null | {
    instanceId: string;
    frameworkId: string;
    state: string;
    version: string | null;
  };
  skills: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    total: number;
    items: Array<{
      ref: { name: string; version?: string; source?: string };
      name: string;
      version: string;
      source: string;
      enabled: boolean;
      category?: string;
      description?: string;
      usage?: number;
      lastUsedAt?: string | null;
      successRate?: number | null;
      avgDurationMs?: number | null;
      usageCoverage?: { from: string | null; to: string | null; days: number; source: string; complete: boolean };
      riskStatus?: AssetRiskStatus;
      riskDetail?: string;
    }>;
    directory: DirectoryInventoryView;
    notice: string;
  };
  plugins: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    total: number;
    items: Array<{
      ref: { name: string; version?: string; source?: string };
      name: string;
      version: string;
      source: string;
      enabled: boolean;
      category?: string;
      description?: string;
      riskStatus?: AssetRiskStatus;
      riskDetail?: string;
    }>;
    directory: DirectoryInventoryView;
    notice: string;
  };
  memory: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    /** watch 检测到的记忆后端（hermes|hindsight|mem0；env 声明 > 目录标记 > 默认）。 */
    backend: { id: string; backend?: string; source: string; detail: string };
    stats: null | {
      totalEntries: number;
      byMonth: Array<{ month: string; count: number }>;
      coldCandidates: number;
      lastWriteAt: string | null;
      archivedEntries: number;
      probeEntries: number;
    };
    health: null | {
      score: number;
      checkedAt: string;
      signals: Array<{ id: string; label: string; status: string; detail: string }>;
      suggestions: Array<{
        id: string;
        kind: string;
        title: string;
        detail: string;
        action?: string;
      }>;
    };
    preview: Array<{
      entryId: string;
      writtenAt: string;
      content: string;
      channel?: string;
      sessionId?: string;
      sizeBytes?: number;
      cold?: boolean;
    }>;
    previewLimit: number;
    writeActivity: { status: string; detail: string };
    directory: DirectoryInventoryView;
    notice: string;
  };
}

