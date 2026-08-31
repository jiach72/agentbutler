/**
 * 管家首页共享类型：/api 载荷视图与页面结论模型，
 * 供 dashboard/ 目录下编排层与各子组件统一引用。
 */

export interface InstanceView {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  version: string | null;
  confidence: number;
}

export interface InspectionCheckView {
  id: string;
  status: string;
  detail: unknown;
  durationMs: number | null;
}

export interface InspectionView {
  instanceId: string;
  ts: string;
  overall: string | null;
  confidence: number | null;
  checks: InspectionCheckView[];
}

export interface FingerprintView {
  signature: string;
  count: number;
  status: string;
  firstSeen: string;
  lastSeen: string;
  lastSample: string | null;
  instance?: string;
}

export interface RunbookView {
  id: string;
  label: string;
  description?: string;
  impact?: string;
  steps?: string[];
  breakerTripped?: boolean;
  lastRun?: { at: string; success: boolean } | null;
}

export interface RunbooksPayload {
  reachable: boolean;
  runbooks?: RunbookView[];
}

export interface RecoveryActionView {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  impact: string;
  estimatedSeconds: number;
  requiresConfirmation: boolean;
  available: boolean;
  unavailableReason?: string;
  unavailableFix?: string;
}

/** 一条发现的证据，让用户自己判断严不严重。 */
export interface RecoveryEvidenceView {
  lastSeenAt: string | null;
  occurrences: number;
  source: string | null;
  kind: string;
  lastSeenLabel: string | null;
  recent: boolean;
}

export interface RecoveryFindingView {
  id: string;
  title: string;
  detail: string;
  severity: "error" | "warn";
  evidence: RecoveryEvidenceView;
  suggestedAction: string | null;
  actionLabel: string | null;
}

export interface RecoveryDiagnosisView {
  incidentId: string;
  severity: "ok" | "warn" | "error";
  stateCode?: string;
  summary?: string;
  safeToRetry?: boolean;
  /** 只有探针真的失败时才有值；否则为 null。 */
  rootCause: string | null;
  primaryFinding: RecoveryFindingView | null;
  findings: RecoveryFindingView[];
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

export interface InspectStatusView {
  reachable: boolean;
  lastAt?: string | null;
  nextAt?: string | null;
  intervalMin?: number | null;
  inFlight?: boolean;
  criticalProbe?: {
    intervalMin: number;
    slaMin: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    nextAt: string | null;
    deadlineAt: string | null;
    lastDurationMs: number | null;
    lastStatus: string | null;
    lastWithinSla: boolean | null;
    overdue: boolean;
    inFlight: boolean;
    runCount: number;
    missedTicks: number;
  };
}

export interface DashboardPayload {
  instances?: InstanceView[];
  latestInspections?: InspectionView[];
  fingerprints?: FingerprintView[];
  inspectStatus?: InspectStatusView;
  messageStatus?: MessageStatusPayload;
}

export interface DeliveryHistoryDay {
  date: string;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface DeliveryHistoryPayload {
  reachable: boolean;
  days: number;
  retentionDays: number;
  items: DeliveryHistoryDay[];
}

export interface InspectionHistoryDay {
  date: string;
  count: number;
  avgDurationMs: number | null;
  errorCount: number;
}

export interface InspectionHistoryPayload {
  days: number;
  items: InspectionHistoryDay[];
  degraded?: string[];
}

export interface MessageStatusPayload {
  reachable: boolean;
  status?: {
    bridge: {
      connected: boolean;
      running: boolean;
      attached: boolean;
      outboxWritable: boolean;
    };
    counts?: Record<string, number>;
  } | null;
}

export interface ConnectionCheckView {
  id: string;
  label: string;
  status: string;
  detail: string;
  durationMs: number | null;
}

export interface ConnectionView {
  instanceId: string;
  frameworkId: string;
  displayName: string;
  state: string;
  connectionState: "connected" | "disconnected" | "checking" | "error" | "unknown" | string;
  connected: boolean;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  effectiveLevel: number | null;
  capabilities: Record<string, string>;
  checks: ConnectionCheckView[];
  anomalies: string[];
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  lastAction: string | null;
  latencyMs: number | null;
  lastError: string | null;
}

export interface ConnectionsPayload {
  reachable: boolean;
  checkedAt?: string;
  connections?: ConnectionView[];
}

/** Butler 受管任务的加密模型配置状态；不等同于 Hermes 原生运行模型。 */
export interface LlmStatusView {
  vault: { available: boolean };
  profiles: number;
  activeProfiles: number;
  bindings: number;
  activeBindings: number;
  ready: boolean;
  blocked: Array<{ profileId: string; status: string; detail: string }>;
}

/** 只读发现的 Hermes 原生模型配置，来源为 Hermes 的 config.yaml 或 .env。 */
export interface DiscoveredLlmConfigView {
  id: string;
  source: string;
  provider: string;
  protocol: string;
  endpoint: string;
  model: string;
  maskedKey: string;
}

export interface DiscoveredLlmPayload {
  configs: DiscoveredLlmConfigView[];
}

export interface OpenClawStatusView {
  installed: boolean;
  version: string | null;
  rootPath: string | null;
  detail: string;
  busy: boolean;
  runtime?: {
    kind?: string;
    distro?: string | null;
    user?: string | null;
    detail?: string;
  };
  target?: {
    dataRoot?: string;
    npmGlobalRoot?: string | null;
  };
  job?: OpenClawInstallJobView | null;
}

export interface OpenClawInstallStepView {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed" | "cancelled" | string;
  detail?: string;
}

export interface OpenClawInstallJobView {
  jobId: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | string;
  progress: number;
  currentStep: string | null;
  steps: OpenClawInstallStepView[];
  logTail: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AlertsPayload {
  reachable: boolean;
  counts?: Record<string, number>;
  items?: Array<{ severity?: string; status?: string; title?: string }>;
}

export interface LogSourceView {
  id: string;
  path: string;
  format: string;
  modifiedAt: string | null;
  sizeBytes: number;
}

export interface LogTailView {
  sourceId: string;
  path: string;
  format: string;
  lines: string[];
  truncated: boolean;
  limit: number;
  totalLines: number;
  pageStart: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  error?: string;
}

export interface LogIssueView {
  id: string;
  kind: string;
  severity: "error" | "warn";
  title: string;
  detail: string;
  count: number;
  sources: string[];
  examples: string[];
  suggestedAction: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
}

export interface LogAnalyzeView {
  reachable?: boolean;
  issues?: LogIssueView[];
  scannedSources?: number;
  scannedLines?: number;
  analyzedAt?: string | null;
}

/** 首页待办：用大白话说明“哪里需要注意”，并尽量给出下一步。 */
export interface IssueView {
  id: string;
  tone: "ok" | "warn" | "error" | "idle";
  title: string;
  detail: string;
  /** 首页问题卡的下一步。没有下一步时不渲染操作，避免“正常”状态也像待办。 */
  action?: {
    label: string;
    to?: string;
  };
  runbook?: RunbookView;
}

export interface StatusCardView {
  id: string;
  tone: "ok" | "warn" | "error" | "idle";
  label: string;
  value: string;
  detail: string;
  trend?: {
    values: number[];
    label: string;
    tone?: "accent" | "ok" | "warn" | "error";
  };
  action?: { label: string; kind: "link" | "detail"; to?: string };
}

/** 英雄区一句话结论。 */
export interface HeroView {
  tone: "ok" | "warn" | "error" | "idle";
  title: string;
  copy: string;
}
