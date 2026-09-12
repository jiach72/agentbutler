/**
 * SQLite 状态存储（node:sqlite DatabaseSync，WAL 模式）。
 *
 * 十三张表：
 * - events       内核事件流（总线事件持久化，供回放与指纹引擎消费）
 * - fingerprints 错误指纹聚合（签名唯一，计数与状态）
 * - jobs         长操作 Job 登记（idempotency_key 唯一，支持幂等复用）
 * - snapshots    快照登记（scope 与标签）
 * - audit        追加式审计日志（只增不改）
 * - instances    实例生命周期记录（图 2 状态机持久层）
 * - tail_positions   日志尾随位点（LogTailer 断点续读，at-least-once）
 * - fingerprint_windows 指纹锚定式突发窗口（升级趋势判定与面板展示）
 * - prompt_targets    M5 提示词优化登记目标（只存元数据，正文在 prompts/）
 * - prompt_versions   prompt 内容寻址快照登记
 * - prompt_candidates M5 候选版本登记（正文在 prompts/，只存 hash/状态）
 * - prompt_evaluations M5 baseline/holdout 成对评估报告登记（正文在 prompts/）
 * - prompt_evaluation_cases  M5 评估用例登记（raw JSON 保留给报告/复盘）
 *
 * 数据库文件不存在时自动建目录建表；所有列均为 SQLite 原生类型，
 * JSON 字段以 *_json 命名并在读写时序列化/反序列化。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { JobStep } from "@butler/contract";

export type EventSeverity = "info" | "warn" | "error";

export interface StoredEvent {
  id: number;
  ts: string;
  type: string;
  severity: EventSeverity;
  source: string;
  payload: unknown;
}

export interface EventInput {
  type: string;
  severity?: EventSeverity;
  source?: string;
  payload?: unknown;
}

export interface FingerprintRow {
  id: number;
  signature: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: string;
  lastSample: string | null;
  /** 错误指纹归属实例（影响组件）；旧数据/未知来源为空串。 */
  instance: string;
}

export interface JobRow {
  jobId: string;
  kind: string;
  instance: string;
  status: string;
  idempotencyKey: string | null;
  steps: JobStep[];
  createdAt: string;
  updatedAt: string;
}

export interface JobInput {
  jobId: string;
  kind: string;
  instance?: string;
  status?: string;
  idempotencyKey?: string;
  steps?: JobStep[];
}

export interface SnapshotRow {
  id: number;
  instance: string;
  scope: unknown;
  label: string | null;
  createdAt: string;
  status: string;
}

export interface BackupRow {
  id: number;
  kind: "full" | "memory" | "event";
  label: string | null;
  target: string;
  path: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export interface BackupInput {
  kind: "full" | "memory" | "event";
  label?: string;
  target: string;
  path: string;
  sizeBytes?: number;
  status?: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
}

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  detail?: unknown;
}

/** fingerprint_windows 表行：单个签名的锚定式突发窗口（升级趋势判定与面板展示）。 */
export interface FingerprintWindowRow {
  id: number;
  signature: string;
  startedAt: string;
  endedAt: string | null;
  count: number;
}

export interface FingerprintWindowInput {
  signature: string;
  startedAt: string;
  endedAt?: string | null;
  count: number;
}

/** instances 表的原始行（lifecycle.ts 负责 InstanceRecord ↔ Row 映射）。 */
export interface InstanceRow {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  capabilityJson: string | null;
  detailJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** M5 提示词优化：登记目标的格式与重载方式。 */
export type PromptFormat = "markdown" | "plain" | "yaml-template";
export type PromptReloadMode = "next-run" | "service-restart-required";

/** 提示词保护段：只登记文本与元数据，内容正文不写入 SQLite。 */
export interface PromptProtectedClause {
  id: string;
  label: string;
  text: string;
}

/** prompt_targets 表行：服务端登记的提示词优化目标。 */
export interface PromptTargetRow {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: PromptFormat;
  editableSections: string[];
  protectedClauses: PromptProtectedClause[];
  protectedSha256: string;
  reloadMode: PromptReloadMode;
  activeVersion: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
}

/** prompt_versions 表行：内容寻址快照登记，正文位于 BUTLER_HOME/prompts/。 */
export interface PromptVersionRow {
  id: number;
  targetId: string;
  version: string;
  sourcePath: string;
  contentSha256: string;
  snapshotPath: string;
  kind: "baseline" | "version";
  createdAt: string;
}

export interface PromptVersionInput {
  targetId: string;
  version: string;
  sourcePath: string;
  contentSha256: string;
  snapshotPath: string;
  kind?: "baseline" | "version";
}

/** prompt_candidates 表行：候选提示词版本（正文在 BUTLER_HOME/prompts/ 内容寻址文件）。 */
export type PromptCandidateStatus =
  | "pending-evaluation"
  | "approval-pending"
  | "rejected-static"
  | "rejected-quality"
  | "kept-baseline"
  | "promoted";

export interface PromptCandidateInput {
  candidateId: string;
  targetId: string;
  contentSha256: string;
  baseSha256: string;
  snapshotPath: string;
  source: "manual" | "generator";
  description: string;
  status: PromptCandidateStatus;
  gateErrors?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptCandidateRow extends PromptCandidateInput {
  gateErrors: string[];
  createdAt: string;
  updatedAt: string;
}

/** prompt_evaluations 表行：一次 baseline/holdout 成对评估的摘要与报告元数据。 */
export interface PromptEvaluationInput {
  evaluationId: string;
  candidateId: string;
  targetId: string;
  status: string;
  tier: "insufficient" | "exploratory" | "formal";
  holdoutCount: number;
  datasetPath: string;
  datasetHash: string;
  baselineSha256: string;
  candidateSha256: string;
  casesPath: string;
  reportPath: string;
  metrics?: unknown;
  confidence?: unknown;
  failures?: unknown;
}

export interface PromptEvaluationRow extends PromptEvaluationInput {
  metrics: unknown;
  confidence: unknown;
  failures: unknown;
  createdAt: string;
}

/** prompt_evaluation_cases 表行：单条成对评估用例的原始 JSON。 */
export interface PromptEvaluationCaseInput {
  evaluationId: string;
  caseId: string;
  raw: unknown;
}

export interface PromptEvaluationCaseRow extends PromptEvaluationCaseInput {
  id: number;
}

export type LlmProtocol = "openai-compatible" | "anthropic" | "gemini";
export type LlmProfileStatus = "active" | "disabled" | "unsupported";
export type LlmVersionStatus = "active" | "disabled" | "pending";
export type LlmBindingScope = "instance" | "framework" | "skill" | "plugin" | "evolution";

export interface LlmProfileRow {
  profileId: string;
  instanceId: string | null;
  provider: string;
  protocol: LlmProtocol;
  endpoint: string;
  model: string;
  status: LlmProfileStatus;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProfileInput {
  profileId: string;
  instanceId?: string;
  provider: string;
  protocol: LlmProtocol;
  endpoint: string;
  model: string;
  status?: LlmProfileStatus;
  currentVersion?: number;
}

export interface LlmProfileVersionRow {
  id: number;
  profileId: string;
  version: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  status: LlmVersionStatus;
  probeStatus: "pass" | "fail" | "unknown";
  probeCategory: string;
  probeDetail: string;
  probedAt: string | null;
  createdAt: string;
}

export interface LlmProfileVersionInput {
  profileId: string;
  version: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  status?: LlmVersionStatus;
  probeStatus?: "pass" | "fail" | "unknown";
  probeCategory?: string;
  probeDetail?: string;
  probedAt?: string | null;
}

export interface LlmBindingRow {
  bindingId: string;
  scope: LlmBindingScope;
  instanceId: string | null;
  frameworkId: string | null;
  targetRef: string | null;
  profileId: string;
  createdAt: string;
}

export interface LlmBindingInput {
  bindingId: string;
  scope: LlmBindingScope;
  instanceId?: string;
  frameworkId?: string;
  targetRef?: string;
  profileId: string;
}

export type EvolutionObservationKind = "session" | "tool";
export type EvolutionObservationOutcome = "success" | "failure" | "unknown";

export interface EvolutionObservationRow {
  observationId: string;
  instanceId: string;
  sessionId: string | null;
  runId: string | null;
  kind: EvolutionObservationKind;
  name: string | null;
  outcome: EvolutionObservationOutcome;
  failureCategory: string | null;
  durationMs: number | null;
  occurredAt: string;
  source: "structured" | "logs";
  detail: unknown;
  contentHash: string;
}

export interface EvolutionDailyMetricRow {
  instanceId: string;
  date: string;
  snapshot: unknown;
  createdAt: string;
}

export interface EvolutionSampleRow {
  sampleId: string;
  instanceId: string;
  dataset: string;
  outcome: "positive" | "negative";
  label: string;
  contentHash: string;
  datasetVersion: string;
  synthetic: boolean;
  source: string;
  createdAt: string;
}

export type EvolutionActionStatus = "open" | "checking" | "resolved" | "ignored";

export interface EvolutionActionItemRow {
  actionId: string;
  instanceId: string;
  category: string;
  title: string;
  impact: "blocking" | "high" | "medium" | "low";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  relatedRuns: string[];
  evidence: string;
  nextAction: string;
  status: EvolutionActionStatus;
  resolvedAt: string | null;
  updatedAt: string;
}

/* ------------------------- 信任层数据模型（Trust Layer） ------------------------- */

/** 预算核算状态（每月一行；spent_usd 由 Watch 预算引擎周期回写）。 */
export interface BudgetStateRow {
  month: string;
  budgetUsd: number;
  spentUsd: number;
  /** 触线后执行的动作：none | alert(80%) | budget-exhausted(100%)。 */
  action: string;
  /** 已发送通知的阈值标记（["80%","100%"]），用于防重复告警。 */
  notified: string[];
  updatedAt: string;
}

/** 全局急停日志：一次 engage → release 完整生命周期一行。 */
export interface KillswitchLogRow {
  id: number;
  engagedAt: string;
  releasedAt: string | null;
  /** 触发来源：panel | api | budget-engine | unknown。 */
  trigger: string;
  /** engage 前自动全量快照的备份 id（BackupRow.id），快照失败为 null。 */
  snapshotId: number | null;
  actor: string;
  detailJson: string | null;
}

/** 行为审计流单条动作（不含 prompt/对话正文，见隐私红线）。 */
export interface ActionEventRow {
  id: number;
  ts: string;
  kind: "file-write" | "file-delete" | "shell-exec" | "api-call" | "message-send" | "web-fetch" | "raw";
  /** 高危动作（删除/外发/危险命令）为 high，其余 info。 */
  severity: "info" | "high";
  /** 结构化目标：文件路径 / 命令首段 / URL / 通道名，截断到 200 字符。 */
  target: string;
  detailJson: string;
  sessionId: string | null;
  /** 解析器版本；raw = 降级原始日志模式。 */
  parserVersion: string;
}

/** 事件中心统一事件对象（M2.2；与 bus 透传用的 events 表是两回事）。 */
export interface TrustEventRow {
  id: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: "active" | "acknowledged" | "resolved" | "regressed";
  evidenceJson: string;
  relatedIds: string;
  /** 去重键：同 key 复发合并计数；resolved 后复发自动转 regressed。 */
  dedupeKey: string;
  updatedAt: string;
}

/** M2.1 Agent 周报存档行（周 key 幂等；markdown 原文 + 组装数据快照）。 */
export interface ReportHistoryRow {
  id: number;
  /** 周一日期（YYYY-MM-DD，本地时区），唯一键。 */
  weekStart: string;
  weekEnd: string;
  status: "generated" | "sent" | "send-failed";
  markdown: string;
  /** 组装数据 JSON 快照（/report 详情页复用，避免重新查询历史数据）。 */
  dataJson: string;
  sentAt: string | null;
  createdAt: string;
}

/** M2.3 会话索引行（Hermes 会话元数据 + butler 动作聚合，不含对话正文）。 */
export interface SessionIndexRow {
  sessionId: string;
  /** 实例标识（多实例部署时区分来源；未知为空串）。 */
  instance: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  taskType: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
  costUsd: number | null;
  /** 结束态：ok / error / running / unknown（Hermes 未提供时 unknown，不臆测）。 */
  outcome: string;
  /** 异常标记（JSON 数组，元素见 SessionAnomaly）。 */
  anomalyFlagsJson: string;
  /** 会话内动作计数（来自 action_events 关联）。 */
  actionCount: number;
  highRiskCount: number;
  lastActionAt: string | null;
  updatedAt: string;
}

/**
 * 通知即操作（M3.1）的操作审批单：高危动作 → 推送带按钮卡片 → 用户批准/拒绝。
 * 状态机：pending → approved | denied | expired（超时默认拒绝，不可回到 pending）。
 * action_id 唯一：同一动作事件只允许一张审批单（幂等，防重复打扰）。
 */
export interface ActionApprovalRow {
  id: string;
  /** 关联 action_events 主键（字符串化，便于跨库/跨实例引用）。 */
  actionId: string;
  /** 动作指纹（kind|target）：用于「同一动作 24h 内第 3 次请求 → 升级」的计数口径。 */
  fingerprint: string;
  instance: string;
  sessionId: string | null;
  /** 动作类型（file-delete / shell-exec / message-send 等）。 */
  kind: string;
  /** 面向人的短标题（脱敏后）。 */
  title: string;
  /** 结构化摘要 JSON（脱敏，绝不存对话正文）。 */
  detailJson: string;
  /** pending | approved | denied | expired。 */
  status: string;
  /** 应答通道：panel | telegram | serverchan | bark | smtp | null（未应答）。 */
  channel: string | null;
  /** 同一动作在升级窗口内的第几次请求（首版即 1）。 */
  attempts: number;
  /** 是否已升级为「需 Web 端确认」（内联按钮不再放行，强制回面板）。 */
  escalateRequired: boolean;
  /** 超时时刻（到期未应答 → 默认拒绝）。 */
  expiresAt: string;
  respondedAt: string | null;
  /** 应答者（通道侧身份或面板操作者）。 */
  actor: string | null;
  /** 拒绝原因 / 超时说明。 */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 假进度检测（M3.3 progress_claims） ---------------- */

/** 进度声明核实结论。unverifiable = 观测能力不足（显式「无法验证」），非「未通过」。 */
export type ProgressVerdict = "verified" | "suspect" | "unverifiable";

export interface ProgressClaimRow {
  id: number;
  sessionId: string;
  ts: string;
  /** 声明的完成百分比；只声明「已完成」而无数字时为 null。 */
  claimedPct: number | null;
  /** 脱敏后的声明原文片段（不含对话正文）。 */
  claimText: string;
  /** 该声明窗口内实际产生副作用的动作数。 */
  sideEffectCount: number;
  /** 副作用动作类型 JSON 数组。 */
  sideEffectKindsJson: string;
  verdict: ProgressVerdict;
  reason: string | null;
  createdAt: string;
}

/* ---------------------- 升级金丝雀（M3.2 canary_runs） ---------------------- */

export type CanaryPolicy = "aggressive" | "standard" | "conservative";
export type CanaryStatus =
  | "planned"
  | "running"
  | "passed"
  | "blocked"
  | "skipped"
  | "unverified"
  | "observing"
  | "completed"
  | "rolled-back";

/** 三指标基线/影子快照（全部为区间实测值，缺失字段为 null 而非 0）。 */
export interface CanaryMetrics {
  /** 成功率：0-1。 */
  successRate: number | null;
  /** 平均 token 消耗。 */
  avgTokens: number | null;
  /** 平均耗时毫秒。 */
  avgDurationMs: number | null;
  /** 采样任务数。 */
  sampleSize: number;
  /** error 级指纹签名集合（用于「无新增」判定）。 */
  errorFingerprints: string[];
  /** 输出相似度（0-1）；无法计算时为 null，不臆造。 */
  outputSimilarity: number | null;
}

/** 准入判据差异报告：逐指标给出实测值与是否通过。 */
export interface CanaryVerdict {
  pass: boolean;
  checks: Array<{
    id: "success-rate" | "token" | "new-error-fingerprints";
    label: string;
    baseline: number | null;
    shadow: number | null;
    /** 允许的变化幅度（百分比或绝对值，按指标语义）。 */
    tolerance: string;
    pass: boolean;
    detail: string;
  }>;
  /** 未参与判定的指标（相似度等）与原因——显式声明，不冒名顶替。 */
  notEvaluated: string[];
}

export interface CanaryRunRow {
  id: string;
  instance: string;
  fromVersion: string | null;
  targetVersion: string;
  policy: CanaryPolicy;
  status: CanaryStatus;
  sampleRegular: number;
  sampleFailed: number;
  /** 抽样任务标识 JSON 数组（来自真实会话索引，非编造）。 */
  taskIdsJson: string;
  baselineJson: string | null;
  shadowJson: string | null;
  verdictJson: string | null;
  /** 观察窗截止时刻；status=observing 时有效。 */
  observationUntil: string | null;
  /** 实际切换（生效）时刻；回归判定以它为起点。 */
  switchedAt: string | null;
  /** 自动回滚所用的快照登记行。 */
  rollbackSnapshotId: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}


const DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  source TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);

CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL UNIQUE,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  last_sample TEXT,
  instance TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  instance TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  idempotency_key TEXT UNIQUE,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  label TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT,
  target TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target);

CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL,
  state TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'unknown',
  root_path TEXT NOT NULL DEFAULT '',
  version TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  capability_json TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tail_positions (
  source_id TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprint_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_windows_signature ON fingerprint_windows(signature);

CREATE TABLE IF NOT EXISTS prompt_targets (
  target_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  framework_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  format TEXT NOT NULL,
  editable_sections_json TEXT NOT NULL DEFAULT '[]',
  protected_clauses_json TEXT NOT NULL DEFAULT '[]',
  protected_sha256 TEXT NOT NULL,
  reload_mode TEXT NOT NULL DEFAULT 'next-run',
  active_version TEXT NOT NULL,
  active_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  version TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'baseline',
  created_at TEXT NOT NULL,
  UNIQUE(target_id, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_target ON prompt_versions(target_id);

CREATE TABLE IF NOT EXISTS prompt_candidates (
  candidate_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  base_sha256 TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending-evaluation',
  gate_errors_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_candidates_target ON prompt_candidates(target_id);
CREATE INDEX IF NOT EXISTS idx_prompt_candidates_status ON prompt_candidates(status);

CREATE TABLE IF NOT EXISTS prompt_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tier TEXT NOT NULL,
  holdout_count INTEGER NOT NULL,
  dataset_path TEXT NOT NULL DEFAULT '',
  dataset_hash TEXT NOT NULL DEFAULT '',
  baseline_sha256 TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  cases_path TEXT NOT NULL,
  report_path TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  confidence_json TEXT NOT NULL DEFAULT 'null',
  failures_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_evaluations_candidate ON prompt_evaluations(candidate_id);
CREATE INDEX IF NOT EXISTS idx_prompt_evaluations_target ON prompt_evaluations(target_id);

CREATE TABLE IF NOT EXISTS prompt_evaluation_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(evaluation_id, case_id)
);
CREATE INDEX IF NOT EXISTS idx_prompt_eval_cases_eval ON prompt_evaluation_cases(evaluation_id);

CREATE TABLE IF NOT EXISTS llm_profiles (
  profile_id TEXT PRIMARY KEY,
  instance_id TEXT,
  provider TEXT NOT NULL,
  protocol TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled',
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_profiles_instance ON llm_profiles(instance_id);

CREATE TABLE IF NOT EXISTS llm_profile_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  probe_status TEXT NOT NULL DEFAULT 'unknown',
  probe_category TEXT NOT NULL DEFAULT 'unknown',
  probe_detail TEXT NOT NULL DEFAULT '',
  probed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, version)
);
CREATE INDEX IF NOT EXISTS idx_llm_profile_versions_profile ON llm_profile_versions(profile_id, version DESC);

CREATE TABLE IF NOT EXISTS llm_bindings (
  binding_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  instance_id TEXT,
  framework_id TEXT,
  target_ref TEXT,
  profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_bindings_exact ON llm_bindings(scope, COALESCE(instance_id, ''), COALESCE(framework_id, ''), COALESCE(target_ref, ''));
CREATE INDEX IF NOT EXISTS idx_llm_bindings_profile ON llm_bindings(profile_id);

CREATE TABLE IF NOT EXISTS evolution_observations (
  observation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  outcome TEXT NOT NULL,
  failure_category TEXT,
  duration_ms REAL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_obs_instance_time ON evolution_observations(instance_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_evolution_obs_kind_outcome ON evolution_observations(kind, outcome);

CREATE TABLE IF NOT EXISTS evolution_daily_metrics (
  instance_id TEXT NOT NULL,
  date TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY(instance_id, date)
);

CREATE TABLE IF NOT EXISTS evolution_samples (
  sample_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  outcome TEXT NOT NULL,
  label TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  dataset_version TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_samples_dataset ON evolution_samples(instance_id, dataset, outcome);

CREATE TABLE IF NOT EXISTS evolution_action_items (
  action_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  related_runs_json TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_actions_identity ON evolution_action_items(instance_id, category, title);

CREATE TABLE IF NOT EXISTS budget_state (
  month TEXT PRIMARY KEY,
  budget_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'none',
  notified_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS killswitch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engaged_at TEXT NOT NULL,
  released_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'unknown',
  snapshot_id INTEGER,
  actor TEXT NOT NULL DEFAULT 'panel',
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  target TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  parser_version TEXT NOT NULL DEFAULT 'v1'
);
CREATE INDEX IF NOT EXISTS idx_action_events_ts ON action_events(ts);
CREATE INDEX IF NOT EXISTS idx_action_events_kind_ts ON action_events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_action_events_severity ON action_events(severity, ts);

CREATE TABLE IF NOT EXISTS trust_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  related_ids TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trust_events_status ON trust_events(status, last_seen);
CREATE INDEX IF NOT EXISTS idx_trust_events_severity ON trust_events(severity, last_seen);

CREATE TABLE IF NOT EXISTS report_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  week_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  markdown TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_history_created ON report_history(created_at);

CREATE TABLE IF NOT EXISTS session_index (
  session_id TEXT PRIMARY KEY,
  instance TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  model TEXT,
  task_type TEXT,
  token_in INTEGER,
  token_out INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'unknown',
  anomaly_flags TEXT NOT NULL DEFAULT '[]',
  action_count INTEGER NOT NULL DEFAULT 0,
  high_risk_count INTEGER NOT NULL DEFAULT 0,
  last_action_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_index_started ON session_index(started_at);
CREATE INDEX IF NOT EXISTS idx_session_index_outcome ON session_index(outcome, started_at);

CREATE TABLE IF NOT EXISTS action_approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  instance TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  escalate_required INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  actor TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_approvals_action ON action_approvals(action_id);
CREATE INDEX IF NOT EXISTS idx_action_approvals_status ON action_approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_action_approvals_created ON action_approvals(created_at);
CREATE INDEX IF NOT EXISTS idx_action_approvals_fingerprint ON action_approvals(fingerprint, created_at);

CREATE TABLE IF NOT EXISTS canary_runs (
  id TEXT PRIMARY KEY,
  instance TEXT NOT NULL DEFAULT '',
  from_version TEXT,
  target_version TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'planned',
  sample_regular INTEGER NOT NULL DEFAULT 0,
  sample_failed INTEGER NOT NULL DEFAULT 0,
  task_ids TEXT NOT NULL DEFAULT '[]',
  baseline_json TEXT,
  shadow_json TEXT,
  verdict_json TEXT,
  observation_until TEXT,
  switched_at TEXT,
  rollback_snapshot_id INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canary_runs_created ON canary_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_canary_runs_status ON canary_runs(status, observation_until);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  claimed_pct INTEGER,
  claim_text TEXT NOT NULL,
  side_effect_count INTEGER NOT NULL DEFAULT 0,
  side_effect_kinds TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL DEFAULT 'unverifiable',
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_claims_unique ON progress_claims(session_id, ts, claim_text);
CREATE INDEX IF NOT EXISTS idx_progress_claims_session ON progress_claims(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_progress_claims_verdict ON progress_claims(verdict, ts);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class SqliteStore {
  readonly dbFile: string;
  private db: DatabaseSync;
  private closed = false;
  /** 预编译语句缓存：同一 SQL 文本只编译一次（node:sqlite 每次都重新 prepare）。 */
  private readonly statements = new Map<string, StatementSync>();

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode=WAL;");
    // 跨进程/跨容器共享同一 db 文件（web 直读、watch 写），并发写锁冲突时等待而非立即抛 SQLITE_BUSY。
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(DDL);
    // 老库兼容：fingerprints.instance 列（错误指纹归属实例/影响组件）。
    const fpColumns = this.prepare("PRAGMA table_info(fingerprints)").all() as Array<{
      name?: unknown;
    }>;
    if (!fpColumns.some((column) => String(column["name"] ?? "") === "instance")) {
      this.db.exec("ALTER TABLE fingerprints ADD COLUMN instance TEXT NOT NULL DEFAULT ''");
    }
    // 老库兼容：action_approvals.fingerprint 列（M3.1 升级计数口径）。
    const approvalColumns = this.prepare("PRAGMA table_info(action_approvals)").all() as Array<{
      name?: unknown;
    }>;
    if (
      approvalColumns.length > 0 &&
      !approvalColumns.some((column) => String(column["name"] ?? "") === "fingerprint")
    ) {
      this.db.exec("ALTER TABLE action_approvals ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_action_approvals_fingerprint ON action_approvals(fingerprint, created_at)",
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  /** 健康检查真实探针：确认连接未关闭且能执行最简查询（而非固定返回 ok）。 */
  ping(): boolean {
    if (this.closed) return false;
    try {
      this.prepare("SELECT 1 AS ok").get();
      return true;
    } catch {
      return false;
    }
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /* --------------------------------- events --------------------------------- */

  insertEvent(input: EventInput): StoredEvent {
    const ts = nowIso();
    const severity = input.severity ?? "info";
    const source = input.source ?? "";
    const payloadJson = JSON.stringify(input.payload ?? null);
    const result = this.prepare(
        "INSERT INTO events (ts, type, severity, source, payload_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ts, input.type, severity, source, payloadJson);
    return {
      id: Number(result.lastInsertRowid),
      ts,
      type: input.type,
      severity,
      source,
      payload: input.payload ?? null,
    };
  }

  listEvents(filter: { type?: string; limit?: number; afterId?: number } = {}): StoredEvent[] {
    const limit = filter.limit ?? 100;
    const afterId = filter.afterId;
    if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) {
      throw new Error("events afterId must be a non-negative integer");
    }
    const rows = this.prepare(
        "SELECT * FROM events WHERE type = COALESCE(?, type) AND id > COALESCE(?, 0) ORDER BY id DESC LIMIT ?",
      )
      .all(filter.type ?? null, afterId ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      type: String(r["type"]),
      severity: String(r["severity"]) as EventSeverity,
      source: String(r["source"]),
      payload: fromJson<unknown>(r["payload_json"] as string | null, null),
    }));
  }

  /** Removes events older than the cutoff（ISO 时间戳）；供保留期清理低频调用。 */
  pruneEvents(cutoff: string): number {
    if (typeof cutoff !== "string" || Number.isNaN(Date.parse(cutoff))) {
      throw new Error("events cutoff must be a valid timestamp");
    }
    const result = this.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  /** Removes audit rows older than the cutoff（ISO 时间戳）；供保留期清理低频调用。 */
  pruneAudit(cutoff: string): number {
    if (typeof cutoff !== "string" || Number.isNaN(Date.parse(cutoff))) {
      throw new Error("audit cutoff must be a valid timestamp");
    }
    const result = this.prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  /**
   * Aggregates inspection-completed events in SQLite. The caller supplies the
   * UTC lower bound for the local-calendar window; JSON1 computes per-check
   * duration averages before averaging across inspections.
   */
  dailyInspectionMetrics(since: string): Array<{
    date: string;
    count: number;
    avgDurationMs: number | null;
    errorCount: number;
  }> {
    if (typeof since !== "string" || Number.isNaN(Date.parse(since))) {
      throw new Error("inspection metrics since must be a valid timestamp");
    }
    const rows = this.prepare(
        `WITH inspection_rows AS (
           SELECT
             date(e.ts, 'localtime') AS day,
             CASE
               WHEN typeof(json_extract(e.payload_json, '$.overall')) = 'text'
                AND json_extract(e.payload_json, '$.overall') NOT IN ('ok', 'healthy')
               THEN 1 ELSE 0
             END AS is_error,
             (
               SELECT AVG(
                 CASE
                   WHEN typeof(json_extract(check_item.value, '$.durationMs')) IN ('integer', 'real')
                   THEN CAST(json_extract(check_item.value, '$.durationMs') AS REAL)
                   ELSE NULL
                 END
               )
               FROM json_each(e.payload_json, '$.checks') AS check_item
             ) AS duration_ms
           FROM events AS e
           WHERE e.type = 'inspection-completed' AND e.ts >= ?
         )
         SELECT
           day,
           COUNT(*) AS count,
           ROUND(AVG(duration_ms)) AS avg_duration_ms,
           SUM(is_error) AS error_count
         FROM inspection_rows
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(since) as Record<string, unknown>[];
    return rows.map((row) => ({
      date: String(row["day"]),
      count: Number(row["count"]),
      avgDurationMs: row["avg_duration_ms"] === null ? null : Number(row["avg_duration_ms"]),
      errorCount: Number(row["error_count"]),
    }));
  }

  /* ------------------------------ fingerprints ------------------------------ */

  upsertFingerprint(signature: string, sample?: string, instanceId?: string): FingerprintRow {
    const ts = nowIso();
    this.prepare(
        `INSERT INTO fingerprints (signature, first_seen, last_seen, count, status, last_sample, instance)
         VALUES (?, ?, ?, 1, 'open', ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           last_seen = excluded.last_seen,
           count = fingerprints.count + 1,
           last_sample = COALESCE(excluded.last_sample, fingerprints.last_sample),
           instance = CASE WHEN excluded.instance <> '' THEN excluded.instance ELSE fingerprints.instance END`,
      )
      .run(signature, ts, ts, sample ?? null, instanceId ?? "");
    const row = this.prepare("SELECT * FROM fingerprints WHERE signature = ?")
      .get(signature) as Record<string, unknown>;
    return this.mapFingerprint(row);
  }

  listFingerprints(limit = 100, since?: string): FingerprintRow[] {
    const rows = this.prepare(
        "SELECT * FROM fingerprints WHERE (? IS NULL OR last_seen >= ?) ORDER BY last_seen DESC LIMIT ?",
      )
      .all(since ?? null, since ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapFingerprint(r));
  }

  findFingerprint(signature: string): FingerprintRow | undefined {
    const row = this.prepare("SELECT * FROM fingerprints WHERE signature = ?").get(signature) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapFingerprint(row);
  }

  updateFingerprintStatus(signature: string, status: string): boolean {
    const result = this.prepare("UPDATE fingerprints SET status = ? WHERE signature = ?")
      .run(status, signature);
    return result.changes > 0;
  }

  private mapFingerprint(r: Record<string, unknown>): FingerprintRow {
    return {
      id: Number(r["id"]),
      signature: String(r["signature"]),
      firstSeen: String(r["first_seen"]),
      lastSeen: String(r["last_seen"]),
      count: Number(r["count"]),
      status: String(r["status"]),
      lastSample: (r["last_sample"] as string | null) ?? null,
      instance: String(r["instance"] ?? ""),
    };
  }

  /* ---------------------------------- jobs ---------------------------------- */

  insertJob(input: JobInput): JobRow {
    const ts = nowIso();
    const status = input.status ?? deriveJobStatus(input.steps ?? []);
    this.prepare(
        `INSERT INTO jobs (job_id, kind, instance, status, idempotency_key, steps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           steps_json = excluded.steps_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.jobId,
        input.kind,
        input.instance ?? "",
        status,
        input.idempotencyKey ?? null,
        JSON.stringify(input.steps ?? []),
        ts,
        ts,
      );
    const row = this.findJobById(input.jobId);
    if (row === undefined) {
      throw new Error(`job ${input.jobId} disappeared right after upsert`);
    }
    return row;
  }

  updateJob(jobId: string, patch: { status?: string; steps?: JobStep[] }): boolean {
    const ts = nowIso();
    if (patch.steps !== undefined) {
      const result = this.prepare(
          "UPDATE jobs SET status = COALESCE(?, status), steps_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(patch.status ?? null, JSON.stringify(patch.steps), ts, jobId);
      return result.changes > 0;
    }
    const result = this.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?")
      .run(patch.status ?? "running", ts, jobId);
    return result.changes > 0;
  }

  findJobById(jobId: string): JobRow | undefined {
    const row = this.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  findJobByIdempotencyKey(key: string): JobRow | undefined {
    const row = this.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  listJobs(filter: { instance?: string; status?: string } = {}): JobRow[] {
    const rows = this.prepare(
        "SELECT * FROM jobs WHERE instance = COALESCE(?, instance) AND status = COALESCE(?, status) ORDER BY created_at DESC",
      )
      .all(filter.instance ?? null, filter.status ?? null) as Record<string, unknown>[];
    return rows.map((r) => this.mapJob(r));
  }

  private mapJob(r: Record<string, unknown>): JobRow {
    return {
      jobId: String(r["job_id"]),
      kind: String(r["kind"]),
      instance: String(r["instance"]),
      status: String(r["status"]),
      idempotencyKey: (r["idempotency_key"] as string | null) ?? null,
      steps: fromJson<JobStep[]>(r["steps_json"] as string | null, []),
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  /* -------------------------------- snapshots ------------------------------- */

  insertSnapshot(input: {
    instance: string;
    scope: unknown;
    label?: string;
    status?: string;
  }): SnapshotRow {
    const ts = nowIso();
    const result = this.prepare(
        "INSERT INTO snapshots (instance, scope_json, label, created_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.instance, toJson(input.scope), input.label ?? null, ts, input.status ?? "ok");
    return {
      id: Number(result.lastInsertRowid),
      instance: input.instance,
      scope: input.scope,
      label: input.label ?? null,
      createdAt: ts,
      status: input.status ?? "ok",
    };
  }

  listSnapshots(instance?: string): SnapshotRow[] {
    const rows = this.prepare("SELECT * FROM snapshots WHERE instance = COALESCE(?, instance) ORDER BY id DESC")
      .all(instance ?? null) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      instance: String(r["instance"]),
      scope: fromJson<unknown>(r["scope_json"] as string | null, null),
      label: (r["label"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
      status: String(r["status"]),
    }));
  }

  updateSnapshotStatus(id: number, status: string): boolean {
    const result = this.prepare("UPDATE snapshots SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }


  /* --------------------------------- backups --------------------------------- */

  insertBackup(input: BackupInput): BackupRow {
    const ts = nowIso();
    const result = this.prepare(
        "INSERT INTO backups (kind, label, target, path, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.kind,
        input.label ?? null,
        input.target,
        input.path,
        input.sizeBytes ?? 0,
        input.status ?? "ok",
        ts,
      );
    return {
      id: Number(result.lastInsertRowid),
      kind: input.kind,
      label: input.label ?? null,
      target: input.target,
      path: input.path,
      sizeBytes: input.sizeBytes ?? 0,
      status: input.status ?? "ok",
      createdAt: ts,
    };
  }

  listBackups(kind?: string): BackupRow[] {
    const rows = this.prepare("SELECT * FROM backups WHERE kind = COALESCE(?, kind) ORDER BY id DESC")
      .all(kind ?? null) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      kind: String(r["kind"]) as BackupRow["kind"],
      label: (r["label"] as string | null) ?? null,
      target: String(r["target"]),
      path: String(r["path"]),
      sizeBytes: Number(r["size_bytes"]),
      status: String(r["status"]),
      createdAt: String(r["created_at"]),
    }));
  }

  getBackup(id: number): BackupRow | undefined {
    const row = this.prepare("SELECT * FROM backups WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return {
      id: Number(row["id"]),
      kind: String(row["kind"]) as BackupRow["kind"],
      label: (row["label"] as string | null) ?? null,
      target: String(row["target"]),
      path: String(row["path"]),
      sizeBytes: Number(row["size_bytes"]),
      status: String(row["status"]),
      createdAt: String(row["created_at"]),
    };
  }

  updateBackupStatus(id: number, status: string): boolean {
    const result = this.prepare("UPDATE backups SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }

  /* ---------------------------------- audit --------------------------------- */

  appendAudit(input: AuditInput): AuditRow {
    const ts = nowIso();
    const target = input.target ?? "";
    const detailJson = input.detail === undefined ? null : JSON.stringify(input.detail);
    const result = this.prepare("INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)")
      .run(ts, input.actor, input.action, target, detailJson);
    return {
      id: Number(result.lastInsertRowid),
      ts,
      actor: input.actor,
      action: input.action,
      target,
      detail: input.detail ?? null,
    };
  }

  listAudit(filter: { action?: string; target?: string; limit?: number } = {}): AuditRow[] {
    const limit = filter.limit ?? 100;
    const rows = this.prepare(
        "SELECT * FROM audit WHERE action = COALESCE(?, action) AND target = COALESCE(?, target) ORDER BY id DESC LIMIT ?",
      )
      .all(filter.action ?? null, filter.target ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      actor: String(r["actor"]),
      action: String(r["action"]),
      target: String(r["target"]),
      detail: fromJson<unknown>(r["detail_json"] as string | null, null),
    }));
  }

  /* --------------------------- prompt optimization -------------------------- */

  savePromptTarget(row: PromptTargetRow): void {
    this.prepare(
        `INSERT INTO prompt_targets (target_id, instance_id, framework_id, source_path, format,
                                     editable_sections_json, protected_clauses_json, protected_sha256,
                                     reload_mode, active_version, active_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET
           instance_id = excluded.instance_id,
           framework_id = excluded.framework_id,
           source_path = excluded.source_path,
           format = excluded.format,
           editable_sections_json = excluded.editable_sections_json,
           protected_clauses_json = excluded.protected_clauses_json,
           protected_sha256 = excluded.protected_sha256,
           reload_mode = excluded.reload_mode,
           active_version = excluded.active_version,
           active_sha256 = excluded.active_sha256,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.targetId,
        row.instanceId,
        row.frameworkId,
        row.sourcePath,
        row.format,
        toJson(row.editableSections),
        toJson(row.protectedClauses),
        row.protectedSha256,
        row.reloadMode,
        row.activeVersion,
        row.activeSha256,
        row.createdAt,
        row.updatedAt,
      );
  }

  getPromptTarget(targetId: string): PromptTargetRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_targets WHERE target_id = ?")
      .get(targetId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptTarget(row);
  }

  listPromptTargets(): PromptTargetRow[] {
    const rows = this.prepare("SELECT * FROM prompt_targets ORDER BY target_id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.mapPromptTarget(row));
  }

  insertPromptVersion(input: PromptVersionInput): PromptVersionRow {
    this.prepare(
        `INSERT INTO prompt_versions (target_id, version, source_path, content_sha256,
                                      snapshot_path, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id, version) DO UPDATE SET
           source_path = excluded.source_path,
           content_sha256 = excluded.content_sha256,
           snapshot_path = excluded.snapshot_path,
           kind = excluded.kind`,
      )
      .run(
        input.targetId,
        input.version,
        input.sourcePath,
        input.contentSha256,
        input.snapshotPath,
        input.kind ?? "baseline",
        nowIso(),
      );
    const row = this.getPromptVersion(input.targetId, input.version);
    if (row === undefined)
      throw new Error(`prompt version ${input.targetId}:${input.version} missing after upsert`);
    return row;
  }

  getPromptVersion(targetId: string, version: string): PromptVersionRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_versions WHERE target_id = ? AND version = ?")
      .get(targetId, version) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptVersion(row);
  }

  listPromptVersions(targetId: string): PromptVersionRow[] {
    const rows = this.prepare("SELECT * FROM prompt_versions WHERE target_id = ? ORDER BY id DESC")
      .all(targetId) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptVersion(row));
  }

  updatePromptTargetActive(targetId: string, version: string, sha256: string): boolean {
    const result = this.prepare(
        "UPDATE prompt_targets SET active_version = ?, active_sha256 = ?, updated_at = ? WHERE target_id = ?",
      )
      .run(version, sha256, nowIso(), targetId);
    return result.changes > 0;
  }

  /** 原子登记候选提升：版本、active 指针与候选状态在同一 SQLite 事务内更新。 */
  promotePromptCandidate(input: {
    candidateId: string;
    targetId: string;
    version: string;
    sourcePath: string;
    contentSha256: string;
    snapshotPath: string;
    updatedAt: string;
    audit: AuditInput;
  }): void {
    const candidate = this.getPromptCandidate(input.candidateId);
    if (candidate === undefined || candidate.targetId !== input.targetId) {
      throw new Error(`prompt candidate ${input.candidateId} is unavailable for promotion`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertPromptVersion({
        targetId: input.targetId,
        version: input.version,
        sourcePath: input.sourcePath,
        contentSha256: input.contentSha256,
        snapshotPath: input.snapshotPath,
        kind: "version",
      });
      if (!this.updatePromptTargetActive(input.targetId, input.version, input.contentSha256)) {
        throw new Error(`prompt target ${input.targetId} disappeared during promotion`);
      }
      this.savePromptCandidate({
        ...candidate,
        status: "promoted",
        updatedAt: input.updatedAt,
      });
      this.appendAudit(input.audit);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /* ---------------------------- M5 prompt candidates ---------------------------- */

  savePromptCandidate(input: PromptCandidateInput): PromptCandidateRow {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.prepare(
        `INSERT INTO prompt_candidates
           (candidate_id, target_id, content_sha256, base_sha256, snapshot_path, source,
            description, status, gate_errors_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET
           target_id = excluded.target_id,
           content_sha256 = excluded.content_sha256,
           base_sha256 = excluded.base_sha256,
           snapshot_path = excluded.snapshot_path,
           source = excluded.source,
           description = excluded.description,
           status = excluded.status,
           gate_errors_json = excluded.gate_errors_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.candidateId,
        input.targetId,
        input.contentSha256,
        input.baseSha256,
        input.snapshotPath,
        input.source,
        input.description,
        input.status,
        toJson(input.gateErrors ?? []),
        createdAt,
        updatedAt,
      );
    const row = this.getPromptCandidate(input.candidateId);
    if (row === undefined)
      throw new Error(`prompt candidate ${input.candidateId} missing after upsert`);
    return row;
  }

  getPromptCandidate(candidateId: string): PromptCandidateRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_candidates WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptCandidate(row);
  }

  listPromptCandidates(targetId?: string): PromptCandidateRow[] {
    const rows = this.prepare(
        "SELECT * FROM prompt_candidates WHERE target_id = COALESCE(?, target_id) ORDER BY updated_at DESC",
      )
      .all(targetId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptCandidate(row));
  }

  /* --------------------------- M5 prompt evaluations --------------------------- */

  savePromptEvaluation(input: PromptEvaluationInput): PromptEvaluationRow {
    this.prepare(
        `INSERT INTO prompt_evaluations
           (evaluation_id, candidate_id, target_id, status, tier, holdout_count,
            dataset_path, dataset_hash, baseline_sha256, candidate_sha256, cases_path,
            report_path, metrics_json, confidence_json, failures_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(evaluation_id) DO UPDATE SET
           candidate_id = excluded.candidate_id,
           target_id = excluded.target_id,
           status = excluded.status,
           tier = excluded.tier,
           holdout_count = excluded.holdout_count,
           dataset_path = excluded.dataset_path,
           dataset_hash = excluded.dataset_hash,
           baseline_sha256 = excluded.baseline_sha256,
           candidate_sha256 = excluded.candidate_sha256,
           cases_path = excluded.cases_path,
           report_path = excluded.report_path,
           metrics_json = excluded.metrics_json,
           confidence_json = excluded.confidence_json,
           failures_json = excluded.failures_json`,
      )
      .run(
        input.evaluationId,
        input.candidateId,
        input.targetId,
        input.status,
        input.tier,
        input.holdoutCount,
        input.datasetPath,
        input.datasetHash,
        input.baselineSha256,
        input.candidateSha256,
        input.casesPath,
        input.reportPath,
        toJson(input.metrics ?? {}),
        toJson(input.confidence ?? null),
        toJson(input.failures ?? []),
        nowIso(),
      );
    const row = this.getPromptEvaluation(input.evaluationId);
    if (row === undefined)
      throw new Error(`prompt evaluation ${input.evaluationId} missing after upsert`);
    return row;
  }

  getPromptEvaluation(evaluationId: string): PromptEvaluationRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_evaluations WHERE evaluation_id = ?")
      .get(evaluationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  getLatestPromptEvaluation(candidateId: string): PromptEvaluationRow | undefined {
    const row = this.prepare(
        "SELECT * FROM prompt_evaluations WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  listPromptEvaluations(candidateId?: string): PromptEvaluationRow[] {
    const rows = this.prepare(
        "SELECT * FROM prompt_evaluations WHERE candidate_id = COALESCE(?, candidate_id) ORDER BY created_at DESC",
      )
      .all(candidateId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptEvaluation(row));
  }

  savePromptEvaluationCase(input: PromptEvaluationCaseInput): PromptEvaluationCaseRow {
    this.prepare(
        `INSERT INTO prompt_evaluation_cases (evaluation_id, case_id, raw_json)
         VALUES (?, ?, ?)
         ON CONFLICT(evaluation_id, case_id) DO UPDATE SET
           raw_json = excluded.raw_json`,
      )
      .run(input.evaluationId, input.caseId, toJson(input.raw));
    const row = this.getPromptEvaluationCase(input.evaluationId, input.caseId);
    if (row === undefined)
      throw new Error(
        `prompt evaluation case ${input.evaluationId}/${input.caseId} missing after upsert`,
      );
    return row;
  }

  savePromptEvaluationCases(input: { evaluationId: string; cases: unknown[] }): void {
    for (const [index, raw] of input.cases.entries()) {
      const record =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const caseId =
        typeof record["caseId"] === "string" && record["caseId"] !== ""
          ? record["caseId"]
          : `case-${index + 1}`;
      this.savePromptEvaluationCase({ evaluationId: input.evaluationId, caseId, raw });
    }
  }

  getPromptEvaluationCase(
    evaluationId: string,
    caseId: string,
  ): PromptEvaluationCaseRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_evaluation_cases WHERE evaluation_id = ? AND case_id = ?")
      .get(evaluationId, caseId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluationCase(row);
  }

  listPromptEvaluationCases(evaluationId?: string): PromptEvaluationCaseRow[] {
    const rows = this.prepare(
        "SELECT * FROM prompt_evaluation_cases WHERE evaluation_id = COALESCE(?, evaluation_id) ORDER BY id ASC",
      )
      .all(evaluationId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptEvaluationCase(row));
  }

  private mapPromptTarget(r: Record<string, unknown>): PromptTargetRow {
    return {
      targetId: String(r["target_id"]),
      instanceId: String(r["instance_id"]),
      frameworkId: String(r["framework_id"]),
      sourcePath: String(r["source_path"]),
      format: String(r["format"]) as PromptFormat,
      editableSections: fromJson<string[]>(r["editable_sections_json"] as string | null, []),
      protectedClauses: fromJson<PromptProtectedClause[]>(
        r["protected_clauses_json"] as string | null,
        [],
      ),
      protectedSha256: String(r["protected_sha256"]),
      reloadMode: String(r["reload_mode"]) as PromptReloadMode,
      activeVersion: String(r["active_version"]),
      activeSha256: String(r["active_sha256"]),
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  private mapPromptVersion(r: Record<string, unknown>): PromptVersionRow {
    return {
      id: Number(r["id"]),
      targetId: String(r["target_id"]),
      version: String(r["version"]),
      sourcePath: String(r["source_path"]),
      contentSha256: String(r["content_sha256"]),
      snapshotPath: String(r["snapshot_path"]),
      kind: String(r["kind"]) as "baseline" | "version",
      createdAt: String(r["created_at"]),
    };
  }

  private mapPromptCandidate(r: Record<string, unknown>): PromptCandidateRow {
    return {
      candidateId: String(r["candidate_id"]),
      targetId: String(r["target_id"]),
      contentSha256: String(r["content_sha256"]),
      baseSha256: String(r["base_sha256"]),
      snapshotPath: String(r["snapshot_path"]),
      source: String(r["source"]) as "manual" | "generator",
      description: String(r["description"]),
      status: String(r["status"]) as PromptCandidateStatus,
      gateErrors: fromJson<string[]>(r["gate_errors_json"] as string | null, []),
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  private mapPromptEvaluation(r: Record<string, unknown>): PromptEvaluationRow {
    return {
      evaluationId: String(r["evaluation_id"]),
      candidateId: String(r["candidate_id"]),
      targetId: String(r["target_id"]),
      status: String(r["status"]),
      tier: String(r["tier"]) as "insufficient" | "exploratory" | "formal",
      holdoutCount: Number(r["holdout_count"]),
      datasetPath: String(r["dataset_path"]),
      datasetHash: String(r["dataset_hash"]),
      baselineSha256: String(r["baseline_sha256"]),
      candidateSha256: String(r["candidate_sha256"]),
      casesPath: String(r["cases_path"]),
      reportPath: String(r["report_path"]),
      metrics: fromJson<unknown>(r["metrics_json"] as string | null, {}),
      confidence: fromJson<unknown>(r["confidence_json"] as string | null, null),
      failures: fromJson<unknown>(r["failures_json"] as string | null, []),
      createdAt: String(r["created_at"]),
    };
  }

  private mapPromptEvaluationCase(r: Record<string, unknown>): PromptEvaluationCaseRow {
    return {
      id: Number(r["id"]),
      evaluationId: String(r["evaluation_id"]),
      caseId: String(r["case_id"]),
      raw: fromJson<unknown>(r["raw_json"] as string | null, {}),
    };
  }

  /* ----------------------------- tail_positions ----------------------------- */

  /** 读取日志源的已提交字节位点；从未读过返回 undefined。 */
  getTailPosition(sourceId: string): number | undefined {
    const row = this.prepare("SELECT byte_offset FROM tail_positions WHERE source_id = ?")
      .get(sourceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Number(row["byte_offset"]);
  }

  /** 提交日志源位点（仅在调用方成功处理完一批行后由 LogTailer 调用）。 */
  setTailPosition(sourceId: string, byteOffset: number): void {
    this.prepare(
        `INSERT INTO tail_positions (source_id, byte_offset, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           updated_at = excluded.updated_at`,
      )
      .run(sourceId, byteOffset, nowIso());
  }

  /* --------------------------- fingerprint_windows -------------------------- */

  insertFingerprintWindow(input: FingerprintWindowInput): FingerprintWindowRow {
    const result = this.prepare(
        "INSERT INTO fingerprint_windows (signature, started_at, ended_at, count) VALUES (?, ?, ?, ?)",
      )
      .run(input.signature, input.startedAt, input.endedAt ?? null, input.count);
    return {
      id: Number(result.lastInsertRowid),
      signature: input.signature,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      count: input.count,
    };
  }

  listFingerprintWindows(
    filter: { signature?: string; limit?: number } = {},
  ): FingerprintWindowRow[] {
    const limit = filter.limit ?? 100;
    const rows = this.prepare(
        "SELECT * FROM fingerprint_windows WHERE signature = COALESCE(?, signature) ORDER BY id DESC LIMIT ?",
      )
      .all(filter.signature ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      signature: String(r["signature"]),
      startedAt: String(r["started_at"]),
      endedAt: (r["ended_at"] as string | null) ?? null,
      count: Number(r["count"]),
    }));
  }

  /* -------------------------------- instances ------------------------------- */

  saveInstance(row: InstanceRow): void {
    this.prepare(
        `INSERT INTO instances (instance_id, framework_id, state, runtime, root_path, version,
                                confidence, capability_json, detail_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           framework_id = excluded.framework_id,
           state = excluded.state,
           runtime = excluded.runtime,
           root_path = excluded.root_path,
           version = excluded.version,
           confidence = excluded.confidence,
           capability_json = excluded.capability_json,
           detail_json = excluded.detail_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.instanceId,
        row.frameworkId,
        row.state,
        row.runtime,
        row.rootPath,
        row.version,
        row.confidence,
        row.capabilityJson,
        row.detailJson,
        row.createdAt,
        row.updatedAt,
      );
  }

  getInstance(instanceId: string): InstanceRow | undefined {
    const row = this.prepare("SELECT * FROM instances WHERE instance_id = ?").get(instanceId) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapInstance(row);
  }

  listInstances(): InstanceRow[] {
    const rows = this.prepare("SELECT * FROM instances ORDER BY instance_id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.mapInstance(r));
  }

  insertLlmProfile(input: LlmProfileInput): LlmProfileRow {
    const ts = nowIso();
    this.prepare(`INSERT INTO llm_profiles (profile_id, instance_id, provider, protocol, endpoint, model, status, current_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.profileId, input.instanceId ?? null, input.provider, input.protocol, input.endpoint, input.model,
      input.status ?? "disabled", input.currentVersion ?? 0, ts, ts,
    );
    return this.getLlmProfile(input.profileId)!;
  }

  getLlmProfile(profileId: string): LlmProfileRow | undefined {
    const row = this.prepare("SELECT * FROM llm_profiles WHERE profile_id = ?").get(profileId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapLlmProfile(row);
  }

  listLlmProfiles(): LlmProfileRow[] {
    const rows = this.prepare("SELECT * FROM llm_profiles ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmProfile(row));
  }

  updateLlmProfile(profileId: string, patch: Partial<Pick<LlmProfileInput, "status" | "currentVersion" | "endpoint" | "model" | "provider" | "protocol" | "instanceId">>): LlmProfileRow | undefined {
    const current = this.getLlmProfile(profileId);
    if (!current) return undefined;
    this.prepare(`UPDATE llm_profiles SET instance_id = ?, provider = ?, protocol = ?, endpoint = ?, model = ?, status = ?, current_version = ?, updated_at = ? WHERE profile_id = ?`).run(
      patch.instanceId ?? current.instanceId, patch.provider ?? current.provider, patch.protocol ?? current.protocol,
      patch.endpoint ?? current.endpoint, patch.model ?? current.model, patch.status ?? current.status,
      patch.currentVersion ?? current.currentVersion, nowIso(), profileId,
    );
    return this.getLlmProfile(profileId);
  }

  insertLlmProfileVersion(input: LlmProfileVersionInput): LlmProfileVersionRow {
    const ts = nowIso();
    this.prepare(`INSERT INTO llm_profile_versions (profile_id, version, ciphertext, nonce, auth_tag, key_version, status, probe_status, probe_category, probe_detail, probed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.profileId, input.version, input.ciphertext, input.nonce, input.authTag, input.keyVersion,
      input.status ?? "pending", input.probeStatus ?? "unknown", input.probeCategory ?? "unknown",
      input.probeDetail ?? "", input.probedAt ?? null, ts,
    );
    return this.getLlmProfileVersion(input.profileId, input.version)!;
  }

  getLlmProfileVersion(profileId: string, version?: number): LlmProfileVersionRow | undefined {
    const row = version === undefined
      ? this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1").get(profileId)
      : this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? AND version = ?").get(profileId, version);
    return row === undefined ? undefined : this.mapLlmProfileVersion(row as Record<string, unknown>);
  }

  listLlmProfileVersions(profileId: string): LlmProfileVersionRow[] {
    const rows = this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? ORDER BY version DESC").all(profileId) as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmProfileVersion(row));
  }

  updateLlmProfileVersion(profileId: string, version: number, patch: Partial<Pick<LlmProfileVersionInput, "status" | "probeStatus" | "probeCategory" | "probeDetail" | "probedAt">>): LlmProfileVersionRow | undefined {
    const current = this.getLlmProfileVersion(profileId, version);
    if (!current) return undefined;
    this.prepare(`UPDATE llm_profile_versions SET status = ?, probe_status = ?, probe_category = ?, probe_detail = ?, probed_at = ? WHERE profile_id = ? AND version = ?`).run(
      patch.status ?? current.status, patch.probeStatus ?? current.probeStatus, patch.probeCategory ?? current.probeCategory,
      patch.probeDetail ?? current.probeDetail, patch.probedAt === undefined ? current.probedAt : patch.probedAt,
      profileId, version,
    );
    return this.getLlmProfileVersion(profileId, version);
  }

  insertLlmBinding(input: LlmBindingInput): LlmBindingRow {
    const ts = nowIso();
    this.prepare(`INSERT INTO llm_bindings (binding_id, scope, instance_id, framework_id, target_ref, profile_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.bindingId, input.scope, input.instanceId ?? null, input.frameworkId ?? null, input.targetRef ?? null, input.profileId, ts);
    return this.getLlmBinding(input.bindingId)!;
  }

  getLlmBinding(bindingId: string): LlmBindingRow | undefined {
    const row = this.prepare("SELECT * FROM llm_bindings WHERE binding_id = ?").get(bindingId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapLlmBinding(row);
  }

  listLlmBindings(filter: { profileId?: string; instanceId?: string } = {}): LlmBindingRow[] {
    const rows = this.prepare("SELECT * FROM llm_bindings WHERE (? IS NULL OR profile_id = ?) AND (? IS NULL OR instance_id = ?) ORDER BY created_at DESC").all(filter.profileId ?? null, filter.profileId ?? null, filter.instanceId ?? null, filter.instanceId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmBinding(row));
  }

  deleteLlmBinding(bindingId: string): boolean {
    return this.prepare("DELETE FROM llm_bindings WHERE binding_id = ?").run(bindingId).changes > 0;
  }

  saveEvolutionObservation(input: EvolutionObservationRow): void {
    this.prepare(`INSERT OR IGNORE INTO evolution_observations
      (observation_id, instance_id, session_id, run_id, kind, name, outcome, failure_category,
       duration_ms, occurred_at, source, detail_json, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.observationId, input.instanceId, input.sessionId, input.runId, input.kind, input.name,
      input.outcome, input.failureCategory, input.durationMs, input.occurredAt, input.source,
      toJson(input.detail), input.contentHash,
    );
  }

  listEvolutionObservations(filter: { instanceId?: string; since?: string; limit?: number } = {}): EvolutionObservationRow[] {
    const rows = this.prepare(`SELECT * FROM evolution_observations
      WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR occurred_at >= ?)
      ORDER BY occurred_at ASC LIMIT ?`).all(
      filter.instanceId ?? null, filter.instanceId ?? null, filter.since ?? null, filter.since ?? null,
      // 20k 已远超单用户 30 天回看窗口的量级；逐行 JSON.parse 同步跑在事件循环上，上限要收敛。
      filter.limit ?? 20_000,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      observationId: String(row["observation_id"]), instanceId: String(row["instance_id"]),
      sessionId: (row["session_id"] as string | null) ?? null, runId: (row["run_id"] as string | null) ?? null,
      kind: String(row["kind"]) as EvolutionObservationKind, name: (row["name"] as string | null) ?? null,
      outcome: String(row["outcome"]) as EvolutionObservationOutcome,
      failureCategory: (row["failure_category"] as string | null) ?? null,
      durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
      occurredAt: String(row["occurred_at"]), source: String(row["source"]) as "structured" | "logs",
      detail: fromJson<unknown>(row["detail_json"] as string | null, null), contentHash: String(row["content_hash"]),
    }));
  }

  upsertEvolutionDailyMetric(input: { instanceId: string; date: string; snapshot: unknown; createdAt?: string }): EvolutionDailyMetricRow {
    const createdAt = input.createdAt ?? nowIso();
    this.prepare(`INSERT INTO evolution_daily_metrics (instance_id, date, snapshot_json, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(instance_id, date) DO UPDATE SET snapshot_json = excluded.snapshot_json, created_at = excluded.created_at`).run(
      input.instanceId, input.date, toJson(input.snapshot), createdAt,
    );
    return { instanceId: input.instanceId, date: input.date, snapshot: input.snapshot, createdAt };
  }

  listEvolutionDailyMetrics(filter: { instanceId?: string; since?: string; limit?: number } = {}): EvolutionDailyMetricRow[] {
    const rows = this.prepare(`SELECT * FROM evolution_daily_metrics
      WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR date >= ?)
      ORDER BY date ASC LIMIT ?`).all(
      filter.instanceId ?? null, filter.instanceId ?? null, filter.since ?? null, filter.since ?? null,
      filter.limit ?? 365,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({ instanceId: String(row["instance_id"]), date: String(row["date"]), snapshot: fromJson(row["snapshot_json"] as string | null, {}), createdAt: String(row["created_at"]) }));
  }

  saveEvolutionSample(input: EvolutionSampleRow): void {
    this.prepare(`INSERT OR IGNORE INTO evolution_samples
      (sample_id, instance_id, dataset, outcome, label, content_hash, dataset_version, synthetic, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.sampleId, input.instanceId, input.dataset, input.outcome, input.label, input.contentHash,
      input.datasetVersion, input.synthetic ? 1 : 0, input.source, input.createdAt,
    );
  }

  listEvolutionSamples(filter: { instanceId?: string; dataset?: string; limit?: number } = {}): EvolutionSampleRow[] {
    const rows = this.prepare(`SELECT * FROM evolution_samples
      WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR dataset = ?)
      ORDER BY created_at DESC LIMIT ?`).all(
      filter.instanceId ?? null, filter.instanceId ?? null, filter.dataset ?? null, filter.dataset ?? null,
      filter.limit ?? 10_000,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({ sampleId: String(row["sample_id"]), instanceId: String(row["instance_id"]), dataset: String(row["dataset"]), outcome: String(row["outcome"]) as "positive" | "negative", label: String(row["label"]), contentHash: String(row["content_hash"]), datasetVersion: String(row["dataset_version"]), synthetic: Number(row["synthetic"]) === 1, source: String(row["source"]), createdAt: String(row["created_at"]) }));
  }

  upsertEvolutionActionItem(input: EvolutionActionItemRow): EvolutionActionItemRow {
    this.prepare(`INSERT INTO evolution_action_items
      (action_id, instance_id, category, title, impact, first_seen_at, last_seen_at, occurrences,
       related_runs_json, evidence, next_action, status, resolved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, category, title) DO UPDATE SET
       action_id = excluded.action_id, impact = excluded.impact, last_seen_at = excluded.last_seen_at,
       occurrences = excluded.occurrences, related_runs_json = excluded.related_runs_json,
       evidence = excluded.evidence, next_action = excluded.next_action,
       status = CASE WHEN evolution_action_items.status = 'resolved' THEN 'open' ELSE evolution_action_items.status END,
       resolved_at = CASE WHEN evolution_action_items.status = 'resolved' THEN NULL ELSE evolution_action_items.resolved_at END,
       updated_at = excluded.updated_at`).run(
      input.actionId, input.instanceId, input.category, input.title, input.impact, input.firstSeenAt,
      input.lastSeenAt, input.occurrences, toJson(input.relatedRuns), input.evidence, input.nextAction,
      input.status, input.resolvedAt, input.updatedAt,
    );
    return this.getEvolutionActionItem(input.actionId) ?? input;
  }

  getEvolutionActionItem(actionId: string): EvolutionActionItemRow | undefined {
    const row = this.prepare("SELECT * FROM evolution_action_items WHERE action_id = ?").get(actionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapEvolutionActionItem(row);
  }

  listEvolutionActionItems(filter: { instanceId?: string; status?: EvolutionActionStatus; limit?: number } = {}): EvolutionActionItemRow[] {
    const rows = this.prepare(`SELECT * FROM evolution_action_items
      WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR status = ?)
      ORDER BY CASE impact WHEN 'blocking' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT ?`).all(
      filter.instanceId ?? null, filter.instanceId ?? null, filter.status ?? null, filter.status ?? null,
      filter.limit ?? 100,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapEvolutionActionItem(row));
  }

  /**
   * evolution 遥测保留期清理：observations 是原始观察（量最大），按 180 天删除；
   * daily_metrics 是按日聚合快照，365 天足够回看。action_items 是待办清单、
   * samples 是策展数据集（content_hash 去重、量有界），两者不清理。
   */
  pruneEvolutionHistory(
    observationCutoff: string,
    dailyMetricCutoff: string,
  ): { observations: number; dailyMetrics: number } {
    const observations = Number(
      this.prepare("DELETE FROM evolution_observations WHERE occurred_at < ?")
        .run(observationCutoff).changes,
    );
    const dailyMetrics = Number(
      this.prepare("DELETE FROM evolution_daily_metrics WHERE date < ?").run(dailyMetricCutoff)
        .changes,
    );
    return { observations, dailyMetrics };
  }

  updateEvolutionActionItemStatus(actionId: string, status: EvolutionActionStatus, resolvedAt?: string | null): EvolutionActionItemRow | undefined {
    const current = this.getEvolutionActionItem(actionId);
    if (current === undefined) return undefined;
    const nextResolvedAt = status === "resolved" ? (resolvedAt ?? nowIso()) : null;
    this.prepare("UPDATE evolution_action_items SET status = ?, resolved_at = ?, updated_at = ? WHERE action_id = ?").run(status, nextResolvedAt, nowIso(), actionId);
    return this.getEvolutionActionItem(actionId);
  }

  private mapEvolutionActionItem(row: Record<string, unknown>): EvolutionActionItemRow {
    return {
      actionId: String(row["action_id"]), instanceId: String(row["instance_id"]), category: String(row["category"]),
      title: String(row["title"]), impact: String(row["impact"]) as EvolutionActionItemRow["impact"],
      firstSeenAt: String(row["first_seen_at"]), lastSeenAt: String(row["last_seen_at"]), occurrences: Number(row["occurrences"]),
      relatedRuns: fromJson<string[]>(row["related_runs_json"] as string | null, []), evidence: String(row["evidence"]),
      nextAction: String(row["next_action"]), status: String(row["status"]) as EvolutionActionStatus,
      resolvedAt: (row["resolved_at"] as string | null) ?? null, updatedAt: String(row["updated_at"]),
    };
  }

  /* ----------------------- 信任层（Trust Layer）存取 ----------------------- */

  getBudgetState(month: string): BudgetStateRow | undefined {
    const row = this.prepare("SELECT * FROM budget_state WHERE month = ?").get(month) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return {
      month: String(row["month"]),
      budgetUsd: Number(row["budget_usd"]),
      spentUsd: Number(row["spent_usd"]),
      action: String(row["action"]),
      notified: fromJson<string[]>(row["notified_json"] as string | null, []),
      updatedAt: String(row["updated_at"]),
    };
  }

  saveBudgetState(input: Omit<BudgetStateRow, "updatedAt">): BudgetStateRow {
    const updatedAt = nowIso();
    this.prepare(
      `INSERT INTO budget_state (month, budget_usd, spent_usd, action, notified_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET budget_usd = excluded.budget_usd, spent_usd = excluded.spent_usd,
         action = excluded.action, notified_json = excluded.notified_json, updated_at = excluded.updated_at`,
    ).run(input.month, input.budgetUsd, input.spentUsd, input.action, toJson(input.notified), updatedAt);
    return { ...input, updatedAt };
  }

  insertKillswitchLog(input: {
    engagedAt: string;
    trigger: string;
    snapshotId: number | null;
    actor: string;
    detail?: unknown;
  }): KillswitchLogRow {
    const result = this.prepare(
      "INSERT INTO killswitch_log (engaged_at, trigger, snapshot_id, actor, detail_json) VALUES (?, ?, ?, ?, ?)",
    ).run(input.engagedAt, input.trigger, input.snapshotId, input.actor, toJson(input.detail ?? null));
    return {
      id: Number(result.lastInsertRowid),
      engagedAt: input.engagedAt,
      releasedAt: null,
      trigger: input.trigger,
      snapshotId: input.snapshotId,
      actor: input.actor,
      detailJson: toJson(input.detail ?? null),
    };
  }

  latestKillswitchLog(): KillswitchLogRow | undefined {
    const row = this.prepare(
      "SELECT * FROM killswitch_log ORDER BY id DESC LIMIT 1",
    ).get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapKillswitchLog(row);
  }

  closeKillswitchLog(id: number, releasedAt: string): void {
    this.prepare("UPDATE killswitch_log SET released_at = ? WHERE id = ?").run(releasedAt, id);
  }

  listKillswitchLog(limit = 20): KillswitchLogRow[] {
    const rows = this.prepare(
      "SELECT * FROM killswitch_log ORDER BY id DESC LIMIT ?",
    ).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapKillswitchLog(row));
  }

  private mapKillswitchLog(row: Record<string, unknown>): KillswitchLogRow {
    return {
      id: Number(row["id"]),
      engagedAt: String(row["engaged_at"]),
      releasedAt: (row["released_at"] as string | null) ?? null,
      trigger: String(row["trigger"]),
      snapshotId: (row["snapshot_id"] as number | null) ?? null,
      actor: String(row["actor"]),
      detailJson: (row["detail_json"] as string | null) ?? null,
    };
  }

  insertActionEvent(input: {
    ts: string;
    kind: ActionEventRow["kind"];
    severity: ActionEventRow["severity"];
    target: string;
    detail?: unknown;
    sessionId?: string | null;
    parserVersion: string;
  }): ActionEventRow {
    const result = this.prepare(
      `INSERT INTO action_events (ts, kind, severity, target, detail_json, session_id, parser_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.ts,
      input.kind,
      input.severity,
      input.target,
      toJson(input.detail ?? {}),
      input.sessionId ?? null,
      input.parserVersion,
    );
    return {
      id: Number(result.lastInsertRowid),
      ts: input.ts,
      kind: input.kind,
      severity: input.severity,
      target: input.target,
      detailJson: toJson(input.detail ?? {}),
      sessionId: input.sessionId ?? null,
      parserVersion: input.parserVersion,
    };
  }

  listActionEvents(
    filter: {
      since?: string;
      until?: string;
      kind?: ActionEventRow["kind"];
      severity?: ActionEventRow["severity"];
      /** 只看指定会话的动作（假进度检测的「同会话副作用」核实用）。 */
      sessionId?: string;
      limit?: number;
    } = {},
  ): ActionEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_events
       WHERE (? IS NULL OR ts >= ?) AND (? IS NULL OR ts < ?)
         AND (? IS NULL OR kind = ?) AND (? IS NULL OR severity = ?)
         AND (? IS NULL OR session_id = ?)
       ORDER BY id DESC LIMIT ?`,
    ).all(
      filter.since ?? null,
      filter.since ?? null,
      filter.until ?? null,
      filter.until ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.severity ?? null,
      filter.severity ?? null,
      filter.sessionId ?? null,
      filter.sessionId ?? null,
      filter.limit ?? 200,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row["id"]),
      ts: String(row["ts"]),
      kind: String(row["kind"]) as ActionEventRow["kind"],
      severity: String(row["severity"]) as ActionEventRow["severity"],
      target: String(row["target"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      sessionId: (row["session_id"] as string | null) ?? null,
      parserVersion: String(row["parser_version"]),
    }));
  }

  /** 最近 since（ISO）之后的高危动作计数（急停遮罩 / 审计摘要用）。 */
  countActionEvents(since: string, severity?: ActionEventRow["severity"]): number {
    const row = this.prepare(
      "SELECT COUNT(*) AS n FROM action_events WHERE ts >= ? AND (? IS NULL OR severity = ?)",
    ).get(since, severity ?? null, severity ?? null) as { n: number | bigint };
    return Number(row.n);
  }

  /**
   * 按会话聚合动作（M2.3 会话索引用）：会话内动作数、高危数、最后动作时间与动作类型分布。
   * 只统计带 session_id 的行（无法归属的动作不属于任何会话，不强行归并）。
   */
  aggregateActionEventsBySession(since: string): Array<{
    sessionId: string;
    count: number;
    highRisk: number;
    lastAt: string;
    kinds: Record<string, number>;
  }> {
    const rows = this.prepare(
      `SELECT session_id, kind, severity, ts FROM action_events
       WHERE session_id IS NOT NULL AND session_id <> '' AND ts >= ?
       ORDER BY ts ASC`,
    ).all(since) as Array<Record<string, unknown>>;
    const bySession = new Map<string, { count: number; highRisk: number; lastAt: string; kinds: Record<string, number> }>();
    for (const row of rows) {
      const sessionId = String(row["session_id"]);
      const entry = bySession.get(sessionId) ?? { count: 0, highRisk: 0, lastAt: "", kinds: {} };
      entry.count += 1;
      if (String(row["severity"]) === "high") entry.highRisk += 1;
      const ts = String(row["ts"]);
      if (ts > entry.lastAt) entry.lastAt = ts;
      const kind = String(row["kind"]);
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + 1;
      bySession.set(sessionId, entry);
    }
    return Array.from(bySession.entries()).map(([sessionId, entry]) => ({
      sessionId,
      count: entry.count,
      highRisk: entry.highRisk,
      lastAt: entry.lastAt,
      kinds: entry.kinds,
    }));
  }

  pruneActionEvents(cutoff: string): number {
    const result = this.prepare("DELETE FROM action_events WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  /**
   * 事件中心 upsert：同 dedupeKey 合并计数（first_seen 保留最早值）。
   * 关键生命周期规则（M2.2 首版）：resolved 状态的事件同键复发 → status=regressed
   * 并重置为 active 语义；active/acknowledged 复发只累加 count 与 last_seen。
   */
  upsertTrustEvent(input: {
    kind: string;
    severity: TrustEventRow["severity"];
    title: string;
    evidence?: unknown[];
    relatedIds?: string[];
    dedupeKey: string;
    at: string;
  }): TrustEventRow {
    const existing = this.prepare("SELECT * FROM trust_events WHERE dedupe_key = ?").get(
      input.dedupeKey,
    ) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      const result = this.prepare(
        `INSERT INTO trust_events (kind, severity, title, first_seen, last_seen, count, status,
           evidence_json, related_ids, dedupe_key, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
      ).run(
        input.kind,
        input.severity,
        input.title,
        input.at,
        input.at,
        toJson(input.evidence ?? []),
        toJson(input.relatedIds ?? []),
        input.dedupeKey,
        input.at,
      );
      return this.getTrustEvent(Number(result.lastInsertRowid))!;
    }
    const status = String(existing["status"]);
    const nextStatus: TrustEventRow["status"] = status === "resolved" ? "regressed" : (status as TrustEventRow["status"]);
    this.prepare(
      `UPDATE trust_events SET last_seen = ?, count = count + 1, severity = ?, title = ?,
         status = ?, evidence_json = ?, related_ids = ?, updated_at = ?
       WHERE dedupe_key = ?`,
    ).run(
      input.at,
      input.severity,
      input.title,
      nextStatus,
      toJson(input.evidence ?? []),
      toJson(input.relatedIds ?? []),
      input.at,
      input.dedupeKey,
    );
    return this.getTrustEvent(Number(existing["id"]))!;
  }

  getTrustEvent(id: number): TrustEventRow | undefined {
    const row = this.prepare("SELECT * FROM trust_events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.mapTrustEvent(row);
  }

  listTrustEvents(
    filter: {
      status?: TrustEventRow["status"];
      severity?: TrustEventRow["severity"];
      /** 事件类型精确匹配（如 upgrade-regression-suspect）。 */
      kind?: string;
      /** 只取 last_seen 在该时刻之后的活跃事件（金丝雀观察窗回归判定用）。 */
      lastSeenSince?: string;
      limit?: number;
    } = {},
  ): TrustEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM trust_events
       WHERE (? IS NULL OR status = ?) AND (? IS NULL OR severity = ?)
         AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR last_seen >= ?)
       ORDER BY CASE status WHEN 'regressed' THEN 0 WHEN 'active' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END,
         CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen DESC
       LIMIT ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      filter.severity ?? null,
      filter.severity ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.lastSeenSince ?? null,
      filter.lastSeenSince ?? null,
      filter.limit ?? 100,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapTrustEvent(row));
  }

  updateTrustEventStatus(id: number, status: TrustEventRow["status"]): TrustEventRow | undefined {
    const current = this.getTrustEvent(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE trust_events SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      nowIso(),
      id,
    );
    return this.getTrustEvent(id);
  }

  pruneTrustEvents(cutoff: string): number {
    const result = this.prepare("DELETE FROM trust_events WHERE last_seen < ?").run(cutoff);
    return Number(result.changes);
  }

  /* ------------------------ M2.1 Agent 周报存档 ------------------------ */

  /** 周报 upsert：weekStart 唯一键幂等（重复生成覆盖同周记录）。 */
  upsertReport(input: {
    weekStart: string;
    weekEnd: string;
    status: ReportHistoryRow["status"];
    markdown: string;
    data: unknown;
    at: string;
  }): ReportHistoryRow {
    this.prepare(
      `INSERT INTO report_history (week_start, week_end, status, markdown, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         week_end = excluded.week_end, status = excluded.status, markdown = excluded.markdown,
         data_json = excluded.data_json, sent_at = NULL`,
    ).run(input.weekStart, input.weekEnd, input.status, input.markdown, toJson(input.data), input.at);
    return this.getReportByWeek(input.weekStart)!;
  }

  getReportByWeek(weekStart: string): ReportHistoryRow | undefined {
    const row = this.prepare("SELECT * FROM report_history WHERE week_start = ?").get(weekStart) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapReport(row);
  }

  getReport(id: number): ReportHistoryRow | undefined {
    const row = this.prepare("SELECT * FROM report_history WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapReport(row);
  }

  listReports(limit = 12): ReportHistoryRow[] {
    const rows = this.prepare(
      "SELECT * FROM report_history ORDER BY week_start DESC LIMIT ?",
    ).all(Math.max(1, Math.min(52, Math.floor(limit)))) as Record<string, unknown>[];
    return rows.map((row) => this.mapReport(row));
  }

  markReportSent(id: number, at: string): ReportHistoryRow | undefined {
    const current = this.getReport(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE report_history SET status = 'sent', sent_at = ? WHERE id = ?").run(at, id);
    return this.getReport(id);
  }

  markReportSendFailed(id: number): ReportHistoryRow | undefined {
    const current = this.getReport(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE report_history SET status = 'send-failed' WHERE id = ?").run(id);
    return this.getReport(id);
  }

  pruneReports(cutoff: string): number {
    const result = this.prepare("DELETE FROM report_history WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  /* ------------------------ M2.3 会话索引 ------------------------ */

  /** 会话索引 upsert（session_id 主键；重复采集覆盖最新值）。 */
  upsertSessionIndex(input: {
    sessionId: string;
    instance?: string;
    startedAt?: string | null;
    endedAt?: string | null;
    durationMs?: number | null;
    model?: string | null;
    taskType?: string | null;
    tokenIn?: number | null;
    tokenOut?: number | null;
    costUsd?: number | null;
    outcome: string;
    anomalyFlags: unknown[];
    actionCount?: number;
    highRiskCount?: number;
    lastActionAt?: string | null;
    at: string;
  }): SessionIndexRow {
    this.prepare(
      `INSERT INTO session_index (session_id, instance, started_at, ended_at, duration_ms, model,
         task_type, token_in, token_out, cost_usd, outcome, anomaly_flags, action_count,
         high_risk_count, last_action_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         instance = excluded.instance, started_at = excluded.started_at, ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms, model = excluded.model, task_type = excluded.task_type,
         token_in = excluded.token_in, token_out = excluded.token_out, cost_usd = excluded.cost_usd,
         outcome = excluded.outcome, anomaly_flags = excluded.anomaly_flags,
         action_count = excluded.action_count, high_risk_count = excluded.high_risk_count,
         last_action_at = excluded.last_action_at, updated_at = excluded.updated_at`,
    ).run(
      input.sessionId,
      input.instance ?? "",
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.durationMs ?? null,
      input.model ?? null,
      input.taskType ?? null,
      input.tokenIn ?? null,
      input.tokenOut ?? null,
      input.costUsd ?? null,
      input.outcome,
      toJson(input.anomalyFlags),
      input.actionCount ?? 0,
      input.highRiskCount ?? 0,
      input.lastActionAt ?? null,
      input.at,
    );
    return this.getSessionIndex(input.sessionId)!;
  }

  getSessionIndex(sessionId: string): SessionIndexRow | undefined {
    const row = this.prepare("SELECT * FROM session_index WHERE session_id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapSessionIndex(row);
  }

  listSessionIndex(
    filter: {
      /** 只看有异常的会话（anomaly_flags 非空数组）。 */
      anomalyOnly?: boolean;
      outcome?: string;
      /** 起始时间下界（ISO；按 started_at 比较，null 的旧行不参与）。 */
      since?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SessionIndexRow[] {
    const rows = this.prepare(
      `SELECT * FROM session_index
       WHERE (? IS NULL OR outcome = ?)
         AND (? IS NULL OR started_at >= ?)
         AND (? = 0 OR (anomaly_flags IS NOT NULL AND anomaly_flags NOT IN ('[]', '')))
       ORDER BY COALESCE(started_at, last_action_at, updated_at) DESC
       LIMIT ? OFFSET ?`,
    ).all(
      filter.outcome ?? null,
      filter.outcome ?? null,
      filter.since ?? null,
      filter.since ?? null,
      filter.anomalyOnly === true ? 1 : 0,
      Math.max(1, Math.min(2000, Math.floor(filter.limit ?? 100))),
      Math.max(0, Math.floor(filter.offset ?? 0)),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapSessionIndex(row));
  }

  countSessionIndex(): { total: number; anomalies: number } {
    const total = this.prepare("SELECT COUNT(*) AS n FROM session_index").get() as { n: number | bigint };
    const anomalies = this.prepare(
      "SELECT COUNT(*) AS n FROM session_index WHERE anomaly_flags IS NOT NULL AND anomaly_flags NOT IN ('[]', '')",
    ).get() as { n: number | bigint };
    return { total: Number(total.n), anomalies: Number(anomalies.n) };
  }

  pruneSessionIndex(cutoff: string): number {
    const result = this.prepare(
      "DELETE FROM session_index WHERE COALESCE(started_at, last_action_at, updated_at) < ?",
    ).run(cutoff);
    return Number(result.changes);
  }

  /* ---------------------- 通知即操作（M3.1 action_approvals） ---------------------- */

  /**
   * 创建审批单。action_id 唯一，重复创建返回既有行（幂等，防同一动作反复打扰）。
   */
  insertActionApproval(input: {
    id: string;
    actionId: string;
    fingerprint?: string;
    instance?: string;
    sessionId?: string | null;
    kind: string;
    title: string;
    detail?: unknown;
    attempts?: number;
    escalateRequired?: boolean;
    expiresAt: string;
    at: string;
  }): ActionApprovalRow {
    const existing = this.getActionApprovalByActionId(input.actionId);
    if (existing !== undefined) return existing;
    this.prepare(
      `INSERT INTO action_approvals
         (id, action_id, fingerprint, instance, session_id, kind, title, detail_json, status, channel,
          attempts, escalate_required, expires_at, responded_at, actor, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(action_id) DO NOTHING`,
    ).run(
      input.id,
      input.actionId,
      input.fingerprint ?? "",
      input.instance ?? "",
      input.sessionId ?? null,
      input.kind,
      input.title,
      toJson(input.detail ?? {}),
      Math.max(1, Math.floor(input.attempts ?? 1)),
      input.escalateRequired === true ? 1 : 0,
      input.expiresAt,
      input.at,
      input.at,
    );
    const row = this.getActionApproval(input.id) ?? this.getActionApprovalByActionId(input.actionId);
    if (row === undefined) throw new Error(`action_approvals 写入失败: ${input.id}`);
    return row;
  }

  getActionApproval(id: string): ActionApprovalRow | undefined {
    const row = this.prepare("SELECT * FROM action_approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapActionApproval(row);
  }

  getActionApprovalByActionId(actionId: string): ActionApprovalRow | undefined {
    const row = this.prepare("SELECT * FROM action_approvals WHERE action_id = ?").get(actionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapActionApproval(row);
  }

  listActionApprovals(
    filter: {
      status?: string;
      escalateOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): ActionApprovalRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_approvals
       WHERE (? IS NULL OR status = ?)
         AND (? = 0 OR escalate_required = 1)
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      filter.escalateOnly === true ? 1 : 0,
      Math.max(1, Math.min(2000, Math.floor(filter.limit ?? 100))),
      Math.max(0, Math.floor(filter.offset ?? 0)),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapActionApproval(row));
  }

  countActionApprovals(): {
    total: number;
    pending: number;
    escalated: number;
    expired: number;
    approved: number;
    denied: number;
  } {
    const one = (sql: string): number => {
      const row = this.prepare(sql).get() as { n: number | bigint };
      return Number(row.n);
    };
    return {
      total: one("SELECT COUNT(*) AS n FROM action_approvals"),
      pending: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'pending'"),
      escalated: one(
        "SELECT COUNT(*) AS n FROM action_approvals WHERE escalate_required = 1 AND status = 'pending'",
      ),
      expired: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'expired'"),
      approved: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'approved'"),
      denied: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'denied'"),
    };
  }

  /** 同一动作指纹在给定时间窗内的审批请求次数（24h 第 3 次触发升级）。 */
  countApprovalRequestsByAction(fingerprint: string, since: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) AS n FROM action_approvals WHERE fingerprint = ? AND created_at >= ?",
    ).get(fingerprint, since) as { n: number | bigint };
    return Number(row.n);
  }

  /**
   * 写回应答。仅 pending 行可流转（返回 undefined 表示已被抢先应答或不存在），
   * 保证「批准/拒绝」在并发下只有一个生效。
   */
  decideActionApproval(
    id: string,
    input: {
      status: "approved" | "denied" | "expired";
      actor?: string | null;
      channel?: string | null;
      reason?: string | null;
      at: string;
    },
  ): ActionApprovalRow | undefined {
    const result = this.prepare(
      `UPDATE action_approvals
         SET status = ?, actor = ?, channel = ?, reason = ?, responded_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(
      input.status,
      input.actor ?? null,
      input.channel ?? null,
      input.reason ?? null,
      input.at,
      input.at,
      id,
    );
    if (Number(result.changes) === 0) return undefined;
    return this.getActionApproval(id);
  }

  /** 超时批量置为 expired（默认拒绝）。返回受影响的行，供调用方补事件与审计。 */
  expireActionApprovals(now: string): ActionApprovalRow[] {
    const due = this.prepare(
      "SELECT * FROM action_approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC",
    ).all(now) as Record<string, unknown>[];
    const expired: ActionApprovalRow[] = [];
    for (const raw of due) {
      const row = this.mapActionApproval(raw);
      const updated = this.decideActionApproval(row.id, {
        status: "expired",
        actor: "system:timeout",
        reason: "超时未应答，按默认拒绝拦截",
        at: now,
      });
      if (updated !== undefined) expired.push(updated);
    }
    return expired;
  }

  pruneActionApprovals(cutoff: string): number {
    const result = this.prepare("DELETE FROM action_approvals WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  /** 增量拉取高危动作（审批侦测用）：只取 id > afterId 的行，避免全表重扫。 */
  listActionEventsAfterId(
    afterId: number,
    filter: { severity?: ActionEventRow["severity"]; limit?: number } = {},
  ): ActionEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_events
       WHERE id > ? AND (? IS NULL OR severity = ?)
       ORDER BY id ASC LIMIT ?`,
    ).all(
      Math.max(0, Math.floor(afterId)),
      filter.severity ?? null,
      filter.severity ?? null,
      Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))),
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row["id"]),
      ts: String(row["ts"]),
      kind: String(row["kind"]) as ActionEventRow["kind"],
      severity: String(row["severity"]) as ActionEventRow["severity"],
      target: String(row["target"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      sessionId: (row["session_id"] as string | null) ?? null,
      parserVersion: String(row["parser_version"]),
    }));
  }

  /* ---------------------- 升级金丝雀（M3.2 canary_runs） ---------------------- */

  insertCanaryRun(input: {
    id: string;
    instance?: string;
    fromVersion?: string | null;
    targetVersion: string;
    policy: CanaryPolicy;
    status: CanaryStatus;
    sampleRegular?: number;
    sampleFailed?: number;
    /** 抽样任务标识（调用方结构，原样 JSON 化；金丝雀存 {sessionId,outcome,bucket}）。 */
    taskIds?: unknown[];
    /** 自动回滚目标快照登记行；缺省表示无法自动回滚（必须显式登记，不猜）。 */
    rollbackSnapshotId?: number | null;
    reason?: string | null;
    at: string;
  }): CanaryRunRow {
    this.prepare(
      `INSERT INTO canary_runs
         (id, instance, from_version, target_version, policy, status,
          sample_regular, sample_failed, task_ids, baseline_json, shadow_json, verdict_json,
          observation_until, switched_at, rollback_snapshot_id, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.instance ?? "",
      input.fromVersion ?? null,
      input.targetVersion,
      input.policy,
      input.status,
      Math.max(0, Math.floor(input.sampleRegular ?? 0)),
      Math.max(0, Math.floor(input.sampleFailed ?? 0)),
      JSON.stringify(input.taskIds ?? []),
      input.rollbackSnapshotId ?? null,
      input.reason ?? null,
      input.at,
      input.at,
    );
    const row = this.getCanaryRun(input.id);
    if (row === undefined) throw new Error(`canary_runs 写入失败: ${input.id}`);
    return row;
  }

  getCanaryRun(id: string): CanaryRunRow | undefined {
    const row = this.prepare("SELECT * FROM canary_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapCanaryRun(row);
  }

  listCanaryRuns(filter: { status?: CanaryStatus; limit?: number } = {}): CanaryRunRow[] {
    const rows = this.prepare(
      `SELECT * FROM canary_runs
       WHERE (? IS NULL OR status = ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      Math.max(1, Math.min(500, Math.floor(filter.limit ?? 50))),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapCanaryRun(row));
  }

  /** 处于观察窗内、且到期的金丝雀运行（自动回滚守卫用）。 */
  listCanaryRunsObserving(): CanaryRunRow[] {
    const rows = this.prepare(
      "SELECT * FROM canary_runs WHERE status = 'observing' ORDER BY COALESCE(switched_at, created_at) ASC",
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapCanaryRun(row));
  }

  updateCanaryRun(
    id: string,
    patch: {
      status?: CanaryStatus;
      baseline?: CanaryMetrics | null;
      shadow?: CanaryMetrics | null;
      verdict?: CanaryVerdict | null;
      observationUntil?: string | null;
      switchedAt?: string | null;
      rollbackSnapshotId?: number | null;
      reason?: string | null;
      at: string;
    },
  ): CanaryRunRow | undefined {
    const existing = this.getCanaryRun(id);
    if (existing === undefined) return undefined;
    this.prepare(
      `UPDATE canary_runs
         SET status = ?, baseline_json = ?, shadow_json = ?, verdict_json = ?,
             observation_until = ?, switched_at = ?, rollback_snapshot_id = ?, reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.status ?? existing.status,
      patch.baseline === undefined
        ? existing.baselineJson
        : patch.baseline === null
          ? null
          : JSON.stringify(patch.baseline),
      patch.shadow === undefined
        ? existing.shadowJson
        : patch.shadow === null
          ? null
          : JSON.stringify(patch.shadow),
      patch.verdict === undefined
        ? existing.verdictJson
        : patch.verdict === null
          ? null
          : JSON.stringify(patch.verdict),
      patch.observationUntil === undefined ? existing.observationUntil : patch.observationUntil,
      patch.switchedAt === undefined ? existing.switchedAt : patch.switchedAt,
      patch.rollbackSnapshotId === undefined ? existing.rollbackSnapshotId : patch.rollbackSnapshotId,
      patch.reason === undefined ? existing.reason : patch.reason,
      patch.at,
      id,
    );
    return this.getCanaryRun(id);
  }

  pruneCanaryRuns(cutoff: string): number {
    const result = this.prepare("DELETE FROM canary_runs WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapCanaryRun(row: Record<string, unknown>): CanaryRunRow {
    return {
      id: String(row["id"]),
      instance: String(row["instance"] ?? ""),
      fromVersion: (row["from_version"] as string | null) ?? null,
      targetVersion: String(row["target_version"]),
      policy: String(row["policy"]) as CanaryPolicy,
      status: String(row["status"]) as CanaryStatus,
      sampleRegular: Number(row["sample_regular"] ?? 0),
      sampleFailed: Number(row["sample_failed"] ?? 0),
      taskIdsJson: String(row["task_ids"] ?? "[]"),
      baselineJson: (row["baseline_json"] as string | null) ?? null,
      shadowJson: (row["shadow_json"] as string | null) ?? null,
      verdictJson: (row["verdict_json"] as string | null) ?? null,
      observationUntil: (row["observation_until"] as string | null) ?? null,
      switchedAt: (row["switched_at"] as string | null) ?? null,
      rollbackSnapshotId:
        row["rollback_snapshot_id"] === null || row["rollback_snapshot_id"] === undefined
          ? null
          : Number(row["rollback_snapshot_id"]),
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  /* ---------------------- 运行时设置（kv） ---------------------- */

  getRuntimeSetting(key: string): string | null {
    const row = this.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? null : String(row.value);
  }

  setRuntimeSetting(key: string, value: string, at: string): void {
    this.prepare(
      `INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, at);
  }

  /* ---------------------- 假进度检测（M3.3 progress_claims） ---------------------- */

  /** 写入一条进度声明核实结果；同 (session_id, ts, claim_text) 幂等跳过。 */
  insertProgressClaim(input: {
    sessionId: string;
    ts: string;
    claimedPct?: number | null;
    claimText: string;
    sideEffectCount: number;
    sideEffectKinds?: string[];
    verdict: ProgressVerdict;
    reason?: string | null;
    at: string;
  }): boolean {
    const result = this.prepare(
      `INSERT INTO progress_claims
         (session_id, ts, claimed_pct, claim_text, side_effect_count, side_effect_kinds, verdict, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ts, claim_text) DO NOTHING`,
    ).run(
      input.sessionId,
      input.ts,
      input.claimedPct ?? null,
      input.claimText,
      Math.max(0, Math.floor(input.sideEffectCount)),
      JSON.stringify(input.sideEffectKinds ?? []),
      input.verdict,
      input.reason ?? null,
      input.at,
    );
    return Number(result.changes) > 0;
  }

  listProgressClaims(filter: { sessionId?: string; verdict?: ProgressVerdict; since?: string; limit?: number } = {}): ProgressClaimRow[] {
    const rows = this.prepare(
      `SELECT * FROM progress_claims
       WHERE (? IS NULL OR session_id = ?)
         AND (? IS NULL OR verdict = ?)
         AND (? IS NULL OR ts >= ?)
       ORDER BY ts ASC, id ASC LIMIT ?`,
    ).all(
      filter.sessionId ?? null,
      filter.sessionId ?? null,
      filter.verdict ?? null,
      filter.verdict ?? null,
      filter.since ?? null,
      filter.since ?? null,
      Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 1000))),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapProgressClaim(row));
  }

  /** 按会话聚合核实结论（周报「进度可信度」与可疑会话点名的数据来源）。 */
  aggregateProgressBySession(since: string): Array<{
    sessionId: string;
    total: number;
    verified: number;
    suspect: number;
    unverifiable: number;
    /** 最长连续 suspect 次数（周报点名用）。 */
    maxSuspectStreak: number;
    lastClaimAt: string;
  }> {
    const rows = this.listProgressClaims({ since, limit: 5000 });
    const bySession = new Map<
      string,
      { total: number; verified: number; suspect: number; unverifiable: number; streak: number; maxStreak: number; lastClaimAt: string }
    >();
    for (const row of rows) {
      const entry =
        bySession.get(row.sessionId) ??
        { total: 0, verified: 0, suspect: 0, unverifiable: 0, streak: 0, maxStreak: 0, lastClaimAt: "" };
      entry.total += 1;
      if (row.verdict === "verified") {
        entry.verified += 1;
        entry.streak = 0;
      } else if (row.verdict === "suspect") {
        entry.suspect += 1;
        entry.streak += 1;
        if (entry.streak > entry.maxStreak) entry.maxStreak = entry.streak;
      } else {
        entry.unverifiable += 1;
        entry.streak = 0;
      }
      if (row.ts > entry.lastClaimAt) entry.lastClaimAt = row.ts;
      bySession.set(row.sessionId, entry);
    }
    return Array.from(bySession.entries()).map(([sessionId, entry]) => ({
      sessionId,
      total: entry.total,
      verified: entry.verified,
      suspect: entry.suspect,
      unverifiable: entry.unverifiable,
      maxSuspectStreak: entry.maxStreak,
      lastClaimAt: entry.lastClaimAt,
    }));
  }

  countProgressClaims(since: string): { total: number; verified: number; suspect: number; unverifiable: number } {
    const one = (sql: string): number => {
      const row = this.prepare(sql).get(since) as { n: number | bigint };
      return Number(row.n);
    };
    return {
      total: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ?"),
      verified: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'verified'"),
      suspect: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'suspect'"),
      unverifiable: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'unverifiable'"),
    };
  }

  pruneProgressClaims(cutoff: string): number {
    const result = this.prepare("DELETE FROM progress_claims WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapProgressClaim(row: Record<string, unknown>): ProgressClaimRow {
    return {
      id: Number(row["id"]),
      sessionId: String(row["session_id"]),
      ts: String(row["ts"]),
      claimedPct:
        row["claimed_pct"] === null || row["claimed_pct"] === undefined ? null : Number(row["claimed_pct"]),
      claimText: String(row["claim_text"]),
      sideEffectCount: Number(row["side_effect_count"] ?? 0),
      sideEffectKindsJson: String(row["side_effect_kinds"] ?? "[]"),
      verdict: String(row["verdict"]) as ProgressVerdict,
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
    };
  }

  private mapActionApproval(row: Record<string, unknown>): ActionApprovalRow {
    return {
      id: String(row["id"]),
      actionId: String(row["action_id"]),
      fingerprint: String(row["fingerprint"] ?? ""),
      instance: String(row["instance"] ?? ""),
      sessionId: (row["session_id"] as string | null) ?? null,
      kind: String(row["kind"]),
      title: String(row["title"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      status: String(row["status"]),
      channel: (row["channel"] as string | null) ?? null,
      attempts: Number(row["attempts"] ?? 1),
      escalateRequired: Number(row["escalate_required"] ?? 0) === 1,
      expiresAt: String(row["expires_at"]),
      respondedAt: (row["responded_at"] as string | null) ?? null,
      actor: (row["actor"] as string | null) ?? null,
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapSessionIndex(row: Record<string, unknown>): SessionIndexRow {
    return {
      sessionId: String(row["session_id"]),
      instance: String(row["instance"] ?? ""),
      startedAt: (row["started_at"] as string | null) ?? null,
      endedAt: (row["ended_at"] as string | null) ?? null,
      durationMs: row["duration_ms"] === null || row["duration_ms"] === undefined ? null : Number(row["duration_ms"]),
      model: (row["model"] as string | null) ?? null,
      taskType: (row["task_type"] as string | null) ?? null,
      tokenIn: row["token_in"] === null || row["token_in"] === undefined ? null : Number(row["token_in"]),
      tokenOut: row["token_out"] === null || row["token_out"] === undefined ? null : Number(row["token_out"]),
      costUsd: row["cost_usd"] === null || row["cost_usd"] === undefined ? null : Number(row["cost_usd"]),
      outcome: String(row["outcome"] ?? "unknown"),
      anomalyFlagsJson: String(row["anomaly_flags"] ?? "[]"),
      actionCount: Number(row["action_count"] ?? 0),
      highRiskCount: Number(row["high_risk_count"] ?? 0),
      lastActionAt: (row["last_action_at"] as string | null) ?? null,
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapReport(row: Record<string, unknown>): ReportHistoryRow {
    return {
      id: Number(row["id"]),
      weekStart: String(row["week_start"]),
      weekEnd: String(row["week_end"]),
      status: String(row["status"]) as ReportHistoryRow["status"],
      markdown: String(row["markdown"]),
      dataJson: String(row["data_json"] ?? "{}"),
      sentAt: (row["sent_at"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
    };
  }

  private mapTrustEvent(row: Record<string, unknown>): TrustEventRow {
    return {
      id: Number(row["id"]),
      kind: String(row["kind"]),
      severity: String(row["severity"]) as TrustEventRow["severity"],
      title: String(row["title"]),
      firstSeen: String(row["first_seen"]),
      lastSeen: String(row["last_seen"]),
      count: Number(row["count"]),
      status: String(row["status"]) as TrustEventRow["status"],
      evidenceJson: String(row["evidence_json"] ?? "[]"),
      relatedIds: String(row["related_ids"] ?? "[]"),
      dedupeKey: String(row["dedupe_key"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapLlmProfile(r: Record<string, unknown>): LlmProfileRow {
    return { profileId: String(r["profile_id"]), instanceId: (r["instance_id"] as string | null) ?? null, provider: String(r["provider"]), protocol: String(r["protocol"]) as LlmProtocol, endpoint: String(r["endpoint"]), model: String(r["model"]), status: String(r["status"]) as LlmProfileStatus, currentVersion: Number(r["current_version"]), createdAt: String(r["created_at"]), updatedAt: String(r["updated_at"]) };
  }
  private mapLlmProfileVersion(r: Record<string, unknown>): LlmProfileVersionRow {
    return { id: Number(r["id"]), profileId: String(r["profile_id"]), version: Number(r["version"]), ciphertext: String(r["ciphertext"]), nonce: String(r["nonce"]), authTag: String(r["auth_tag"]), keyVersion: Number(r["key_version"]), status: String(r["status"]) as LlmVersionStatus, probeStatus: String(r["probe_status"]) as "pass" | "fail" | "unknown", probeCategory: String(r["probe_category"]), probeDetail: String(r["probe_detail"]), probedAt: (r["probed_at"] as string | null) ?? null, createdAt: String(r["created_at"]) };
  }
  private mapLlmBinding(r: Record<string, unknown>): LlmBindingRow {
    return { bindingId: String(r["binding_id"]), scope: String(r["scope"]) as LlmBindingScope, instanceId: (r["instance_id"] as string | null) ?? null, frameworkId: (r["framework_id"] as string | null) ?? null, targetRef: (r["target_ref"] as string | null) ?? null, profileId: String(r["profile_id"]), createdAt: String(r["created_at"]) };
  }

  private mapInstance(r: Record<string, unknown>): InstanceRow {
    return {
      instanceId: String(r["instance_id"]),
      frameworkId: String(r["framework_id"]),
      state: String(r["state"]),
      runtime: String(r["runtime"]),
      rootPath: String(r["root_path"]),
      version: (r["version"] as string | null) ?? null,
      confidence: Number(r["confidence"]),
      capabilityJson: (r["capability_json"] as string | null) ?? null,
      detailJson: (r["detail_json"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }
}

/** 由步骤状态推导 Job 状态：任一 failed→failed；全部收敛→done；否则 running。 */
export function deriveJobStatus(steps: JobStep[]): string {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.length > 0 && steps.every((s) => s.status === "passed" || s.status === "skipped")) {
    return "done";
  }
  return "running";
}
