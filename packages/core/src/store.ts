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
import { DatabaseSync } from "node:sqlite";
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

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(DDL);
    // 老库兼容：fingerprints.instance 列（错误指纹归属实例/影响组件）。
    const fpColumns = this.db.prepare("PRAGMA table_info(fingerprints)").all() as Array<{
      name?: unknown;
    }>;
    if (!fpColumns.some((column) => String(column["name"] ?? "") === "instance")) {
      this.db.exec("ALTER TABLE fingerprints ADD COLUMN instance TEXT NOT NULL DEFAULT ''");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /* --------------------------------- events --------------------------------- */

  insertEvent(input: EventInput): StoredEvent {
    const ts = nowIso();
    const severity = input.severity ?? "info";
    const source = input.source ?? "";
    const payloadJson = JSON.stringify(input.payload ?? null);
    const result = this.db
      .prepare(
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

  listEvents(filter: { type?: string; limit?: number } = {}): StoredEvent[] {
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare("SELECT * FROM events WHERE type = COALESCE(?, type) ORDER BY id DESC LIMIT ?")
      .all(filter.type ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      type: String(r["type"]),
      severity: String(r["severity"]) as EventSeverity,
      source: String(r["source"]),
      payload: fromJson<unknown>(r["payload_json"] as string | null, null),
    }));
  }

  /* ------------------------------ fingerprints ------------------------------ */

  upsertFingerprint(signature: string, sample?: string, instanceId?: string): FingerprintRow {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO fingerprints (signature, first_seen, last_seen, count, status, last_sample, instance)
         VALUES (?, ?, ?, 1, 'open', ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           last_seen = excluded.last_seen,
           count = fingerprints.count + 1,
           last_sample = COALESCE(excluded.last_sample, fingerprints.last_sample),
           instance = CASE WHEN excluded.instance <> '' THEN excluded.instance ELSE fingerprints.instance END`,
      )
      .run(signature, ts, ts, sample ?? null, instanceId ?? "");
    const row = this.db
      .prepare("SELECT * FROM fingerprints WHERE signature = ?")
      .get(signature) as Record<string, unknown>;
    return this.mapFingerprint(row);
  }

  listFingerprints(limit = 100): FingerprintRow[] {
    const rows = this.db
      .prepare("SELECT * FROM fingerprints ORDER BY last_seen DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapFingerprint(r));
  }

  findFingerprint(signature: string): FingerprintRow | undefined {
    const row = this.db.prepare("SELECT * FROM fingerprints WHERE signature = ?").get(signature) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapFingerprint(row);
  }

  updateFingerprintStatus(signature: string, status: string): boolean {
    const result = this.db
      .prepare("UPDATE fingerprints SET status = ? WHERE signature = ?")
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
    this.db
      .prepare(
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
      const result = this.db
        .prepare(
          "UPDATE jobs SET status = COALESCE(?, status), steps_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(patch.status ?? null, JSON.stringify(patch.steps), ts, jobId);
      return result.changes > 0;
    }
    const result = this.db
      .prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?")
      .run(patch.status ?? "running", ts, jobId);
    return result.changes > 0;
  }

  findJobById(jobId: string): JobRow | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  findJobByIdempotencyKey(key: string): JobRow | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  listJobs(filter: { instance?: string; status?: string } = {}): JobRow[] {
    const rows = this.db
      .prepare(
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
    const result = this.db
      .prepare(
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
    const rows = this.db
      .prepare("SELECT * FROM snapshots WHERE instance = COALESCE(?, instance) ORDER BY id DESC")
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
    const result = this.db.prepare("UPDATE snapshots SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }


  /* --------------------------------- backups --------------------------------- */

  insertBackup(input: BackupInput): BackupRow {
    const ts = nowIso();
    const result = this.db
      .prepare(
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
    const rows = this.db
      .prepare("SELECT * FROM backups WHERE kind = COALESCE(?, kind) ORDER BY id DESC")
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
    const row = this.db.prepare("SELECT * FROM backups WHERE id = ?").get(id) as
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
    const result = this.db.prepare("UPDATE backups SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }

  /* ---------------------------------- audit --------------------------------- */

  appendAudit(input: AuditInput): AuditRow {
    const ts = nowIso();
    const target = input.target ?? "";
    const detailJson = input.detail === undefined ? null : JSON.stringify(input.detail);
    const result = this.db
      .prepare("INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)")
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
    const rows = this.db
      .prepare(
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
    this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT * FROM prompt_targets WHERE target_id = ?")
      .get(targetId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptTarget(row);
  }

  listPromptTargets(): PromptTargetRow[] {
    const rows = this.db.prepare("SELECT * FROM prompt_targets ORDER BY target_id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.mapPromptTarget(row));
  }

  insertPromptVersion(input: PromptVersionInput): PromptVersionRow {
    this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT * FROM prompt_versions WHERE target_id = ? AND version = ?")
      .get(targetId, version) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptVersion(row);
  }

  listPromptVersions(targetId: string): PromptVersionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM prompt_versions WHERE target_id = ? ORDER BY id DESC")
      .all(targetId) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptVersion(row));
  }

  updatePromptTargetActive(targetId: string, version: string, sha256: string): boolean {
    const result = this.db
      .prepare(
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
    this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT * FROM prompt_candidates WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptCandidate(row);
  }

  listPromptCandidates(targetId?: string): PromptCandidateRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM prompt_candidates WHERE target_id = COALESCE(?, target_id) ORDER BY updated_at DESC",
      )
      .all(targetId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptCandidate(row));
  }

  /* --------------------------- M5 prompt evaluations --------------------------- */

  savePromptEvaluation(input: PromptEvaluationInput): PromptEvaluationRow {
    this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT * FROM prompt_evaluations WHERE evaluation_id = ?")
      .get(evaluationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  getLatestPromptEvaluation(candidateId: string): PromptEvaluationRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM prompt_evaluations WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  listPromptEvaluations(candidateId?: string): PromptEvaluationRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM prompt_evaluations WHERE candidate_id = COALESCE(?, candidate_id) ORDER BY created_at DESC",
      )
      .all(candidateId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptEvaluation(row));
  }

  savePromptEvaluationCase(input: PromptEvaluationCaseInput): PromptEvaluationCaseRow {
    this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT * FROM prompt_evaluation_cases WHERE evaluation_id = ? AND case_id = ?")
      .get(evaluationId, caseId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluationCase(row);
  }

  listPromptEvaluationCases(evaluationId?: string): PromptEvaluationCaseRow[] {
    const rows = this.db
      .prepare(
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
    const row = this.db
      .prepare("SELECT byte_offset FROM tail_positions WHERE source_id = ?")
      .get(sourceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Number(row["byte_offset"]);
  }

  /** 提交日志源位点（仅在调用方成功处理完一批行后由 LogTailer 调用）。 */
  setTailPosition(sourceId: string, byteOffset: number): void {
    this.db
      .prepare(
        `INSERT INTO tail_positions (source_id, byte_offset, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           updated_at = excluded.updated_at`,
      )
      .run(sourceId, byteOffset, nowIso());
  }

  /* --------------------------- fingerprint_windows -------------------------- */

  insertFingerprintWindow(input: FingerprintWindowInput): FingerprintWindowRow {
    const result = this.db
      .prepare(
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
    const rows = this.db
      .prepare(
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
    this.db
      .prepare(
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
    const row = this.db.prepare("SELECT * FROM instances WHERE instance_id = ?").get(instanceId) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapInstance(row);
  }

  listInstances(): InstanceRow[] {
    const rows = this.db.prepare("SELECT * FROM instances ORDER BY instance_id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.mapInstance(r));
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
