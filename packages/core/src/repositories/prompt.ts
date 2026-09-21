import type { DatabaseSync, StatementSync } from "node:sqlite";
import { BaseRepository, fromJson, nowIso, toJson } from "./base.js";
import type { AuditInput } from "./lifecycle.js";

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

export class PromptRepository extends BaseRepository {
  constructor(
    db: DatabaseSync,
    statements: Map<string, StatementSync>,
    private readonly appendAuditFn?: (input: AuditInput) => void,
  ) {
    super(db, statements);
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
    ).run(
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
    const row = this.prepare("SELECT * FROM prompt_targets WHERE target_id = ?").get(targetId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapPromptTarget(row);
  }

  listPromptTargets(): PromptTargetRow[] {
    const rows = this.prepare("SELECT * FROM prompt_targets ORDER BY target_id").all() as Record<string, unknown>[];
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
    ).run(
      input.targetId,
      input.version,
      input.sourcePath,
      input.contentSha256,
      input.snapshotPath,
      input.kind ?? "baseline",
      nowIso(),
    );
    const row = this.getPromptVersion(input.targetId, input.version);
    if (row === undefined) throw new Error(`prompt version ${input.targetId}:${input.version} missing after upsert`);
    return row;
  }

  getPromptVersion(targetId: string, version: string): PromptVersionRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_versions WHERE target_id = ? AND version = ?").get(
      targetId,
      version,
    ) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptVersion(row);
  }

  listPromptVersions(targetId: string): PromptVersionRow[] {
    const rows = this.prepare("SELECT * FROM prompt_versions WHERE target_id = ? ORDER BY id DESC").all(
      targetId,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptVersion(row));
  }

  updatePromptTargetActive(targetId: string, version: string, sha256: string): boolean {
    const result = this.prepare(
      "UPDATE prompt_targets SET active_version = ?, active_sha256 = ?, updated_at = ? WHERE target_id = ?",
    ).run(version, sha256, nowIso(), targetId);
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
      if (this.appendAuditFn) {
        this.appendAuditFn(input.audit);
      } else {
        // Fallback: write audit directly if no callback passed
        const ts = nowIso();
        this.prepare("INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)").run(
          ts,
          input.audit.actor,
          input.audit.action,
          input.audit.target ?? "",
          input.audit.detail === undefined ? null : JSON.stringify(input.audit.detail),
        );
      }
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
    ).run(
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
    if (row === undefined) throw new Error(`prompt candidate ${input.candidateId} missing after upsert`);
    return row;
  }

  getPromptCandidate(candidateId: string): PromptCandidateRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_candidates WHERE candidate_id = ?").get(candidateId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapPromptCandidate(row);
  }

  listPromptCandidates(targetId?: string): PromptCandidateRow[] {
    const rows = this.prepare(
      "SELECT * FROM prompt_candidates WHERE target_id = COALESCE(?, target_id) ORDER BY updated_at DESC",
    ).all(targetId ?? null) as Record<string, unknown>[];
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
    ).run(
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
    if (row === undefined) throw new Error(`prompt evaluation ${input.evaluationId} missing after upsert`);
    return row;
  }

  getPromptEvaluation(evaluationId: string): PromptEvaluationRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_evaluations WHERE evaluation_id = ?").get(evaluationId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  getLatestPromptEvaluation(candidateId: string): PromptEvaluationRow | undefined {
    const row = this.prepare(
      "SELECT * FROM prompt_evaluations WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(candidateId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluation(row);
  }

  listPromptEvaluations(candidateId?: string): PromptEvaluationRow[] {
    const rows = this.prepare(
      "SELECT * FROM prompt_evaluations WHERE candidate_id = COALESCE(?, candidate_id) ORDER BY created_at DESC",
    ).all(candidateId ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapPromptEvaluation(row));
  }

  savePromptEvaluationCase(input: PromptEvaluationCaseInput): PromptEvaluationCaseRow {
    this.prepare(
      `INSERT INTO prompt_evaluation_cases (evaluation_id, case_id, raw_json)
       VALUES (?, ?, ?)
       ON CONFLICT(evaluation_id, case_id) DO UPDATE SET
         raw_json = excluded.raw_json`,
    ).run(input.evaluationId, input.caseId, toJson(input.raw));
    const row = this.getPromptEvaluationCase(input.evaluationId, input.caseId);
    if (row === undefined) {
      throw new Error(`prompt evaluation case ${input.evaluationId}/${input.caseId} missing after upsert`);
    }
    return row;
  }

  savePromptEvaluationCases(input: { evaluationId: string; cases: unknown[] }): void {
    for (const [index, raw] of input.cases.entries()) {
      const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
      const caseId = typeof record["caseId"] === "string" && record["caseId"] !== ""
        ? record["caseId"]
        : `case-${index + 1}`;
      this.savePromptEvaluationCase({ evaluationId: input.evaluationId, caseId, raw });
    }
  }

  getPromptEvaluationCase(evaluationId: string, caseId: string): PromptEvaluationCaseRow | undefined {
    const row = this.prepare("SELECT * FROM prompt_evaluation_cases WHERE evaluation_id = ? AND case_id = ?").get(
      evaluationId,
      caseId,
    ) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapPromptEvaluationCase(row);
  }

  listPromptEvaluationCases(evaluationId?: string): PromptEvaluationCaseRow[] {
    const rows = this.prepare(
      "SELECT * FROM prompt_evaluation_cases WHERE evaluation_id = COALESCE(?, evaluation_id) ORDER BY id ASC",
    ).all(evaluationId ?? null) as Record<string, unknown>[];
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
      protectedClauses: fromJson<PromptProtectedClause[]>(r["protected_clauses_json"] as string | null, []),
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
}
