/**
 * SQLite 状态存储（node:sqlite DatabaseSync，WAL 模式）。
 *
 * 领域仓储门面（Facade）：
 * - telemetry  : events, fingerprints, tail_positions, fingerprint_windows, dailyInspectionMetrics
 * - lifecycle  : jobs, snapshots, backups, audit, instances, app_config, runtime_settings
 * - prompt     : prompt_targets, prompt_versions, prompt_candidates, prompt_evaluations, prompt_evaluation_cases
 * - llm        : llm_profiles, llm_profile_versions, llm_bindings
 * - evolution  : evolution_observations, evolution_daily_metrics, evolution_samples, evolution_action_items
 * - trust      : budget_state, killswitch_log, action_events, trust_events, report_history,
 *                session_index, action_approvals, canary_runs, progress_claims
 *
 * 数据库文件不存在时自动建目录建表；所有列均为 SQLite 原生类型。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { JobStep } from "@butler/contract";
import {
  TelemetryRepository,
  LifecycleRepository,
  PromptRepository,
  LlmRepository,
  EvolutionRepository,
  TrustRepository,
  ApiCredentialRepository,
  type StoredEvent,
  type EventInput,
  type FingerprintRow,
  type FingerprintWindowRow,
  type FingerprintWindowInput,
  type JobRow,
  type JobInput,
  type SnapshotRow,
  type BackupRow,
  type BackupInput,
  type AuditRow,
  type AuditInput,
  type InstanceRow,
  type PromptTargetRow,
  type PromptVersionRow,
  type PromptVersionInput,
  type PromptCandidateInput,
  type PromptCandidateRow,
  type PromptEvaluationInput,
  type PromptEvaluationRow,
  type PromptEvaluationCaseInput,
  type PromptEvaluationCaseRow,
  type LlmProfileRow,
  type LlmProfileInput,
  type LlmProfileVersionRow,
  type LlmProfileVersionInput,
  type LlmBindingRow,
  type LlmBindingInput,
  type EvolutionObservationRow,
  type EvolutionDailyMetricRow,
  type EvolutionSampleRow,
  type EvolutionActionStatus,
  type EvolutionActionItemRow,
  type BudgetStateRow,
  type KillswitchLogRow,
  type ActionEventRow,
  type TrustEventRow,
  type ReportHistoryRow,
  type SessionIndexRow,
  type ActionApprovalRow,
  type ProgressVerdict,
  type ProgressClaimRow,
  type CanaryPolicy,
  type CanaryStatus,
  type CanaryMetrics,
  type CanaryVerdict,
  type CanaryRunRow,
} from "./repositories/index.js";

export * from "./repositories/index.js";

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

-- 面板可写的轻量配置（键值对；重启后仍生效）。
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  env_var TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  endpoint TEXT,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  probe_status TEXT NOT NULL DEFAULT 'unknown',
  probe_category TEXT,
  probe_detail TEXT,
  probed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_credentials_category ON api_credentials(category);
CREATE INDEX IF NOT EXISTS idx_api_credentials_env_var ON api_credentials(env_var);
`;

export class SqliteStore {
  readonly dbFile: string;
  private db: DatabaseSync;
  private closed = false;
  /** 预编译语句缓存：同一 SQL 文本只编译一次（node:sqlite 每次都重新 prepare）。 */
  private readonly statements = new Map<string, StatementSync>();

  readonly telemetry: TelemetryRepository;
  readonly lifecycle: LifecycleRepository;
  readonly prompt: PromptRepository;
  readonly llm: LlmRepository;
  readonly evolution: EvolutionRepository;
  readonly trust: TrustRepository;
  readonly credentials: ApiCredentialRepository;

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile, { timeout: 5000 });
    // 跨进程/跨容器共享同一 db 文件（web 直读、watch 写），并发写锁冲突时等待而非立即抛 SQLITE_BUSY。
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA journal_mode=WAL;");
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

    // 初始化领域子仓储
    this.telemetry = new TelemetryRepository(this.db, this.statements);
    this.lifecycle = new LifecycleRepository(this.db, this.statements);
    this.prompt = new PromptRepository(this.db, this.statements, (audit) => this.lifecycle.appendAudit(audit));
    this.llm = new LlmRepository(this.db, this.statements);
    this.evolution = new EvolutionRepository(this.db, this.statements);
    this.trust = new TrustRepository(this.db, this.statements);
    this.credentials = new ApiCredentialRepository(this.db, this.statements);
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
    return this.telemetry.insertEvent(input);
  }

  listEvents(filter: { type?: string; limit?: number; afterId?: number } = {}): StoredEvent[] {
    return this.telemetry.listEvents(filter);
  }

  pruneEvents(cutoff: string): number {
    return this.telemetry.pruneEvents(cutoff);
  }

  dailyInspectionMetrics(since: string): Array<{
    date: string;
    count: number;
    avgDurationMs: number | null;
    errorCount: number;
  }> {
    return this.telemetry.dailyInspectionMetrics(since);
  }

  /* ------------------------------ fingerprints ------------------------------ */

  upsertFingerprint(signature: string, sample?: string, instanceId?: string): FingerprintRow {
    return this.telemetry.upsertFingerprint(signature, sample, instanceId);
  }

  listFingerprints(limit = 100, since?: string): FingerprintRow[] {
    return this.telemetry.listFingerprints(limit, since);
  }

  findFingerprint(signature: string): FingerprintRow | undefined {
    return this.telemetry.findFingerprint(signature);
  }

  updateFingerprintStatus(signature: string, status: string): boolean {
    return this.telemetry.updateFingerprintStatus(signature, status);
  }

  /* ----------------------------- tail_positions ----------------------------- */

  getTailPosition(sourceId: string): number | undefined {
    return this.telemetry.getTailPosition(sourceId);
  }

  setTailPosition(sourceId: string, byteOffset: number): void {
    this.telemetry.setTailPosition(sourceId, byteOffset);
  }

  /* --------------------------- fingerprint_windows -------------------------- */

  insertFingerprintWindow(input: FingerprintWindowInput): FingerprintWindowRow {
    return this.telemetry.insertFingerprintWindow(input);
  }

  listFingerprintWindows(filter: { signature?: string; limit?: number } = {}): FingerprintWindowRow[] {
    return this.telemetry.listFingerprintWindows(filter);
  }

  /* ---------------------------------- jobs ---------------------------------- */

  insertJob(input: JobInput): JobRow {
    return this.lifecycle.insertJob(input);
  }

  updateJob(jobId: string, patch: { status?: string; steps?: JobStep[] }): boolean {
    return this.lifecycle.updateJob(jobId, patch);
  }

  findJobById(jobId: string): JobRow | undefined {
    return this.lifecycle.findJobById(jobId);
  }

  findJobByIdempotencyKey(key: string): JobRow | undefined {
    return this.lifecycle.findJobByIdempotencyKey(key);
  }

  listJobs(filter: { instance?: string; status?: string } = {}): JobRow[] {
    return this.lifecycle.listJobs(filter);
  }

  /* -------------------------------- snapshots ------------------------------- */

  insertSnapshot(input: {
    instance: string;
    scope: unknown;
    label?: string;
    status?: string;
  }): SnapshotRow {
    return this.lifecycle.insertSnapshot(input);
  }

  listSnapshots(instance?: string): SnapshotRow[] {
    return this.lifecycle.listSnapshots(instance);
  }

  updateSnapshotStatus(id: number, status: string): boolean {
    return this.lifecycle.updateSnapshotStatus(id, status);
  }

  /* --------------------------------- backups --------------------------------- */

  insertBackup(input: BackupInput): BackupRow {
    return this.lifecycle.insertBackup(input);
  }

  listBackups(kind?: string): BackupRow[] {
    return this.lifecycle.listBackups(kind);
  }

  getBackup(id: number): BackupRow | undefined {
    return this.lifecycle.getBackup(id);
  }

  updateBackupStatus(id: number, status: string): boolean {
    return this.lifecycle.updateBackupStatus(id, status);
  }

  /* ---------------------------------- audit --------------------------------- */

  appendAudit(input: AuditInput): AuditRow {
    return this.lifecycle.appendAudit(input);
  }

  listAudit(filter: { action?: string; target?: string; limit?: number } = {}): AuditRow[] {
    return this.lifecycle.listAudit(filter);
  }

  pruneAudit(cutoff: string): number {
    return this.lifecycle.pruneAudit(cutoff);
  }

  /* -------------------------------- instances ------------------------------- */

  saveInstance(row: InstanceRow): void {
    this.lifecycle.saveInstance(row);
  }

  getInstance(instanceId: string): InstanceRow | undefined {
    return this.lifecycle.getInstance(instanceId);
  }

  listInstances(): InstanceRow[] {
    return this.lifecycle.listInstances();
  }

  /* --------------------------- prompt optimization -------------------------- */

  savePromptTarget(row: PromptTargetRow): void {
    this.prompt.savePromptTarget(row);
  }

  getPromptTarget(targetId: string): PromptTargetRow | undefined {
    return this.prompt.getPromptTarget(targetId);
  }

  listPromptTargets(): PromptTargetRow[] {
    return this.prompt.listPromptTargets();
  }

  insertPromptVersion(input: PromptVersionInput): PromptVersionRow {
    return this.prompt.insertPromptVersion(input);
  }

  getPromptVersion(targetId: string, version: string): PromptVersionRow | undefined {
    return this.prompt.getPromptVersion(targetId, version);
  }

  listPromptVersions(targetId: string): PromptVersionRow[] {
    return this.prompt.listPromptVersions(targetId);
  }

  updatePromptTargetActive(targetId: string, version: string, sha256: string): boolean {
    return this.prompt.updatePromptTargetActive(targetId, version, sha256);
  }

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
    this.prompt.promotePromptCandidate(input);
  }

  /* ---------------------------- M5 prompt candidates ---------------------------- */

  savePromptCandidate(input: PromptCandidateInput): PromptCandidateRow {
    return this.prompt.savePromptCandidate(input);
  }

  getPromptCandidate(candidateId: string): PromptCandidateRow | undefined {
    return this.prompt.getPromptCandidate(candidateId);
  }

  listPromptCandidates(targetId?: string): PromptCandidateRow[] {
    return this.prompt.listPromptCandidates(targetId);
  }

  /* --------------------------- M5 prompt evaluations --------------------------- */

  savePromptEvaluation(input: PromptEvaluationInput): PromptEvaluationRow {
    return this.prompt.savePromptEvaluation(input);
  }

  getPromptEvaluation(evaluationId: string): PromptEvaluationRow | undefined {
    return this.prompt.getPromptEvaluation(evaluationId);
  }

  getLatestPromptEvaluation(candidateId: string): PromptEvaluationRow | undefined {
    return this.prompt.getLatestPromptEvaluation(candidateId);
  }

  listPromptEvaluations(candidateId?: string): PromptEvaluationRow[] {
    return this.prompt.listPromptEvaluations(candidateId);
  }

  savePromptEvaluationCase(input: PromptEvaluationCaseInput): PromptEvaluationCaseRow {
    return this.prompt.savePromptEvaluationCase(input);
  }

  savePromptEvaluationCases(input: { evaluationId: string; cases: unknown[] }): void {
    this.prompt.savePromptEvaluationCases(input);
  }

  getPromptEvaluationCase(evaluationId: string, caseId: string): PromptEvaluationCaseRow | undefined {
    return this.prompt.getPromptEvaluationCase(evaluationId, caseId);
  }

  listPromptEvaluationCases(evaluationId?: string): PromptEvaluationCaseRow[] {
    return this.prompt.listPromptEvaluationCases(evaluationId);
  }

  /* -------------------------------- llm_profiles -------------------------------- */

  insertLlmProfile(input: LlmProfileInput): LlmProfileRow {
    return this.llm.insertLlmProfile(input);
  }

  getLlmProfile(profileId: string): LlmProfileRow | undefined {
    return this.llm.getLlmProfile(profileId);
  }

  listLlmProfiles(): LlmProfileRow[] {
    return this.llm.listLlmProfiles();
  }

  updateLlmProfile(
    profileId: string,
    patch: Partial<
      Pick<
        LlmProfileInput,
        "status" | "currentVersion" | "endpoint" | "model" | "provider" | "protocol" | "instanceId"
      >
    >,
  ): LlmProfileRow | undefined {
    return this.llm.updateLlmProfile(profileId, patch);
  }

  /* ---------------------------- llm_profile_versions ---------------------------- */

  insertLlmProfileVersion(input: LlmProfileVersionInput): LlmProfileVersionRow {
    return this.llm.insertLlmProfileVersion(input);
  }

  getLlmProfileVersion(profileId: string, version?: number): LlmProfileVersionRow | undefined {
    return this.llm.getLlmProfileVersion(profileId, version);
  }

  listLlmProfileVersions(profileId: string): LlmProfileVersionRow[] {
    return this.llm.listLlmProfileVersions(profileId);
  }

  updateLlmProfileVersion(
    profileId: string,
    version: number,
    patch: Partial<
      Pick<LlmProfileVersionInput, "status" | "probeStatus" | "probeCategory" | "probeDetail" | "probedAt">
    >,
  ): LlmProfileVersionRow | undefined {
    return this.llm.updateLlmProfileVersion(profileId, version, patch);
  }

  /* -------------------------------- llm_bindings -------------------------------- */

  insertLlmBinding(input: LlmBindingInput): LlmBindingRow {
    return this.llm.insertLlmBinding(input);
  }

  getLlmBinding(bindingId: string): LlmBindingRow | undefined {
    return this.llm.getLlmBinding(bindingId);
  }

  listLlmBindings(filter: { profileId?: string; instanceId?: string } = {}): LlmBindingRow[] {
    return this.llm.listLlmBindings(filter);
  }

  deleteLlmBinding(bindingId: string): boolean {
    return this.llm.deleteLlmBinding(bindingId);
  }

  deleteLlmProfileVersions(profileId: string): number {
    return this.llm.deleteLlmProfileVersions(profileId);
  }

  deleteLlmProfile(profileId: string): boolean {
    return this.llm.deleteLlmProfile(profileId);
  }

  /* ------------------------- evolution ------------------------- */

  saveEvolutionObservation(input: EvolutionObservationRow): void {
    this.evolution.saveEvolutionObservation(input);
  }

  listEvolutionObservations(
    filter: { instanceId?: string; since?: string; limit?: number } = {},
  ): EvolutionObservationRow[] {
    return this.evolution.listEvolutionObservations(filter);
  }

  upsertEvolutionDailyMetric(input: {
    instanceId: string;
    date: string;
    snapshot: unknown;
    createdAt?: string;
  }): EvolutionDailyMetricRow {
    return this.evolution.upsertEvolutionDailyMetric(input);
  }

  listEvolutionDailyMetrics(
    filter: { instanceId?: string; since?: string; limit?: number } = {},
  ): EvolutionDailyMetricRow[] {
    return this.evolution.listEvolutionDailyMetrics(filter);
  }

  saveEvolutionSample(input: EvolutionSampleRow): void {
    this.evolution.saveEvolutionSample(input);
  }

  listEvolutionSamples(
    filter: { instanceId?: string; dataset?: string; limit?: number } = {},
  ): EvolutionSampleRow[] {
    return this.evolution.listEvolutionSamples(filter);
  }

  upsertEvolutionActionItem(input: EvolutionActionItemRow): EvolutionActionItemRow {
    return this.evolution.upsertEvolutionActionItem(input);
  }

  getEvolutionActionItem(actionId: string): EvolutionActionItemRow | undefined {
    return this.evolution.getEvolutionActionItem(actionId);
  }

  listEvolutionActionItems(
    filter: { instanceId?: string; status?: EvolutionActionStatus; limit?: number } = {},
  ): EvolutionActionItemRow[] {
    return this.evolution.listEvolutionActionItems(filter);
  }

  pruneEvolutionHistory(
    observationCutoff: string,
    dailyMetricCutoff: string,
  ): { observations: number; dailyMetrics: number } {
    return this.evolution.pruneEvolutionHistory(observationCutoff, dailyMetricCutoff);
  }

  updateEvolutionActionItemStatus(
    actionId: string,
    status: EvolutionActionStatus,
    resolvedAt?: string | null,
  ): EvolutionActionItemRow | undefined {
    return this.evolution.updateEvolutionActionItemStatus(actionId, status, resolvedAt);
  }

  /* ----------------------- 信任层（Trust Layer）存取 ----------------------- */

  getBudgetState(month: string): BudgetStateRow | undefined {
    return this.trust.getBudgetState(month);
  }

  getAppConfig(key: string): string | null {
    return this.lifecycle.getAppConfig(key);
  }

  setAppConfig(key: string, value: string): void {
    this.lifecycle.setAppConfig(key, value);
  }

  saveBudgetState(input: Omit<BudgetStateRow, "updatedAt">): BudgetStateRow {
    return this.trust.saveBudgetState(input);
  }

  insertKillswitchLog(input: {
    engagedAt: string;
    trigger: string;
    snapshotId: number | null;
    actor: string;
    detail?: unknown;
  }): KillswitchLogRow {
    return this.trust.insertKillswitchLog(input);
  }

  latestKillswitchLog(): KillswitchLogRow | undefined {
    return this.trust.latestKillswitchLog();
  }

  closeKillswitchLog(id: number, releasedAt: string): void {
    this.trust.closeKillswitchLog(id, releasedAt);
  }

  listKillswitchLog(limit = 20): KillswitchLogRow[] {
    return this.trust.listKillswitchLog(limit);
  }

  /* ------------------------------- action_events ------------------------------- */

  insertActionEvent(input: {
    ts: string;
    kind: ActionEventRow["kind"];
    severity: ActionEventRow["severity"];
    target: string;
    detail?: unknown;
    sessionId?: string | null;
    parserVersion: string;
  }): ActionEventRow {
    return this.trust.insertActionEvent(input);
  }

  listActionEvents(
    filter: {
      since?: string;
      until?: string;
      kind?: ActionEventRow["kind"];
      severity?: ActionEventRow["severity"];
      sessionId?: string;
      limit?: number;
    } = {},
  ): ActionEventRow[] {
    return this.trust.listActionEvents(filter);
  }

  countActionEvents(since: string, severity?: ActionEventRow["severity"]): number {
    return this.trust.countActionEvents(since, severity);
  }

  aggregateActionEventsBySession(since: string): Array<{
    sessionId: string;
    count: number;
    highRisk: number;
    lastAt: string;
    kinds: Record<string, number>;
  }> {
    return this.trust.aggregateActionEventsBySession(since);
  }

  pruneActionEvents(cutoff: string): number {
    return this.trust.pruneActionEvents(cutoff);
  }

  listActionEventsAfterId(
    afterId: number,
    filter: { severity?: ActionEventRow["severity"]; limit?: number } = {},
  ): ActionEventRow[] {
    return this.trust.listActionEventsAfterId(afterId, filter);
  }

  /* ------------------------------- trust_events ------------------------------- */

  upsertTrustEvent(input: {
    kind: string;
    severity: TrustEventRow["severity"];
    title: string;
    evidence?: unknown[];
    relatedIds?: string[];
    dedupeKey: string;
    at: string;
  }): TrustEventRow {
    return this.trust.upsertTrustEvent(input);
  }

  getTrustEvent(id: number): TrustEventRow | undefined {
    return this.trust.getTrustEvent(id);
  }

  listTrustEvents(
    filter: {
      status?: TrustEventRow["status"];
      severity?: TrustEventRow["severity"];
      kind?: string;
      lastSeenSince?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): TrustEventRow[] {
    return this.trust.listTrustEvents(filter);
  }

  updateTrustEventStatus(id: number, status: TrustEventRow["status"]): TrustEventRow | undefined {
    return this.trust.updateTrustEventStatus(id, status);
  }

  pruneTrustEvents(cutoff: string): number {
    return this.trust.pruneTrustEvents(cutoff);
  }

  /* ------------------------ M2.1 Agent 周报存档 ------------------------ */

  upsertReport(input: {
    weekStart: string;
    weekEnd: string;
    status: ReportHistoryRow["status"];
    markdown: string;
    data: unknown;
    at: string;
  }): ReportHistoryRow {
    return this.trust.upsertReport(input);
  }

  getReportByWeek(weekStart: string): ReportHistoryRow | undefined {
    return this.trust.getReportByWeek(weekStart);
  }

  getReport(id: number): ReportHistoryRow | undefined {
    return this.trust.getReport(id);
  }

  listReports(limit = 12): ReportHistoryRow[] {
    return this.trust.listReports(limit);
  }

  markReportSent(id: number, at: string): ReportHistoryRow | undefined {
    return this.trust.markReportSent(id, at);
  }

  markReportSendFailed(id: number): ReportHistoryRow | undefined {
    return this.trust.markReportSendFailed(id);
  }

  pruneReports(cutoff: string): number {
    return this.trust.pruneReports(cutoff);
  }

  /* ------------------------ M2.3 会话索引 ------------------------ */

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
    return this.trust.upsertSessionIndex(input);
  }

  getSessionIndex(sessionId: string): SessionIndexRow | undefined {
    return this.trust.getSessionIndex(sessionId);
  }

  listSessionIndex(
    filter: {
      anomalyOnly?: boolean;
      outcome?: string;
      since?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SessionIndexRow[] {
    return this.trust.listSessionIndex(filter);
  }

  countSessionIndex(): { total: number; anomalies: number } {
    return this.trust.countSessionIndex();
  }

  pruneSessionIndex(cutoff: string): number {
    return this.trust.pruneSessionIndex(cutoff);
  }

  /* ---------------------- 通知即操作（M3.1 action_approvals） ---------------------- */

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
    return this.trust.insertActionApproval(input);
  }

  getActionApproval(id: string): ActionApprovalRow | undefined {
    return this.trust.getActionApproval(id);
  }

  getActionApprovalByActionId(actionId: string): ActionApprovalRow | undefined {
    return this.trust.getActionApprovalByActionId(actionId);
  }

  getOpenActionApprovalByFingerprint(fingerprint: string): ActionApprovalRow | undefined {
    return this.trust.getOpenActionApprovalByFingerprint(fingerprint);
  }

  bumpActionApprovalAttempts(
    id: string,
    input: { attempts: number; escalateRequired: boolean; at: string },
  ): ActionApprovalRow | undefined {
    return this.trust.bumpActionApprovalAttempts(id, input);
  }

  listActionApprovals(
    filter: {
      status?: string;
      escalateOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): ActionApprovalRow[] {
    return this.trust.listActionApprovals(filter);
  }

  countActionApprovals(): {
    total: number;
    pending: number;
    escalated: number;
    expired: number;
    approved: number;
    denied: number;
  } {
    return this.trust.countActionApprovals();
  }

  countApprovalRequestsByAction(fingerprint: string, since: string): number {
    return this.trust.countApprovalRequestsByAction(fingerprint, since);
  }

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
    return this.trust.decideActionApproval(id, input);
  }

  expireActionApprovals(now: string, reasonOf?: (row: ActionApprovalRow) => string): ActionApprovalRow[] {
    return this.trust.expireActionApprovals(now, reasonOf);
  }

  pruneActionApprovals(cutoff: string): number {
    return this.trust.pruneActionApprovals(cutoff);
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
    taskIds?: unknown[];
    rollbackSnapshotId?: number | null;
    reason?: string | null;
    at: string;
  }): CanaryRunRow {
    return this.trust.insertCanaryRun(input);
  }

  getCanaryRun(id: string): CanaryRunRow | undefined {
    return this.trust.getCanaryRun(id);
  }

  listCanaryRuns(filter: { status?: CanaryStatus; limit?: number } = {}): CanaryRunRow[] {
    return this.trust.listCanaryRuns(filter);
  }

  listCanaryRunsObserving(): CanaryRunRow[] {
    return this.trust.listCanaryRunsObserving();
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
    return this.trust.updateCanaryRun(id, patch);
  }

  pruneCanaryRuns(cutoff: string): number {
    return this.trust.pruneCanaryRuns(cutoff);
  }

  /* ---------------------- 运行时设置（kv） ---------------------- */

  getRuntimeSetting(key: string): string | null {
    return this.lifecycle.getRuntimeSetting(key);
  }

  setRuntimeSetting(key: string, value: string, at: string): void {
    this.lifecycle.setRuntimeSetting(key, value, at);
  }

  /* ---------------------- 假进度检测（M3.3 progress_claims） ---------------------- */

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
    return this.trust.insertProgressClaim(input);
  }

  listProgressClaims(
    filter: { sessionId?: string; verdict?: ProgressVerdict; since?: string; limit?: number } = {},
  ): ProgressClaimRow[] {
    return this.trust.listProgressClaims(filter);
  }

  aggregateProgressBySession(since: string): Array<{
    sessionId: string;
    total: number;
    verified: number;
    suspect: number;
    unverifiable: number;
    maxSuspectStreak: number;
    lastClaimAt: string;
  }> {
    return this.trust.aggregateProgressBySession(since);
  }

  countProgressClaims(since: string): { total: number; verified: number; suspect: number; unverifiable: number } {
    return this.trust.countProgressClaims(since);
  }

  pruneProgressClaims(cutoff: string): number {
    return this.trust.pruneProgressClaims(cutoff);
  }
}
