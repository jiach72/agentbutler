/**
 * M5 提示词优化（切片 1/2）：
 * - Prompt Registry：只允许服务端登记真实路径，API 不接受调用方自由路径；
 * - baseline/version 内容快照：复制到 BUTLER_HOME/prompts/，正文不写入 SQLite；
 * - protected clauses 静态门禁：缺文件、hash 漂移、保护段变化、未知字段全部拒绝；
 * - 候选持久化与 baseline/holdout 成对评估：<10 硬拒绝，10-29 探索性，>=30 输出指标与置信区间；
 * - 强制提升：只有受信 evaluator 的正式评估可通过唯一 promoteCandidate 入口原子替换。
 *
 * 本模块不进入 Gateway / Outbox / Hermes 消息热路径，也不修改 Hermes 源文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  Core,
  PromptCandidateRow,
  PromptEvaluationRow,
  PromptFormat,
  PromptProtectedClause,
  PromptReloadMode,
  PromptTargetRow,
} from "@butler/core";

export const PROMPT_OPTIMIZATION_ACTOR = "prompt-optimization";
export const PROMPT_REGISTER_ACTION = "prompt-target-register";
export const PROMPT_VERIFY_ACTION = "prompt-target-verify";
export const PROMPT_CANDIDATE_ACTION = "prompt-candidate-static-gate";
export const PROMPT_CREATE_CANDIDATE_ACTION = "prompt-candidate-create";
export const PROMPT_EVALUATE_ACTION = "prompt-candidate-evaluate";
export const PROMPT_PROMOTE_ACTION = "prompt-candidate-promote";
export const PROMPT_BASELINE_VERSION = "baseline";
export const PROMPT_MIN_HOLDOUT_COUNT = 10;
export const PROMPT_EXPLORATORY_MAX_COUNT = 29;
export const PROMPT_CI_Z = 1.96;
const PROMPT_METRIC_PRECISION = 10;

const PROMPT_FORMATS: PromptFormat[] = ["markdown", "plain", "yaml-template"];
const PROMPT_RELOAD_MODES: PromptReloadMode[] = ["next-run", "service-restart-required"];
const PROMPT_CANDIDATE_FIELDS = new Set(["targetId", "content", "baseSha256"]);
const PROMPT_CANDIDATE_INPUT_FIELDS = new Set([
  "targetId",
  "content",
  "baseSha256",
  "source",
  "description",
]);
const PROMPT_PROMOTION_FIELDS = new Set(["candidateId", "evaluationId", "confirmed"]);

/** 默认从真实 Hermes 提示词中找出的安全关键词；未命中时不虚构保护段。 */
const PROMPT_SAFETY_MARKERS = [
  "DEFAULT_AGENT_IDENTITY",
  "HERMES_AGENT_HELP_GUIDANCE",
  "MEMORY_GUIDANCE",
  "SESSION_SEARCH_GUIDANCE",
  "SKILLS_GUIDANCE",
  "KANBAN_GUIDANCE",
  "TOOL_USE_ENFORCEMENT_GUIDANCE",
  "TASK_COMPLETION_GUIDANCE",
  "未授权",
  "不得",
  "confirmation",
  "permission",
  "external action",
] as const;

const PYTHON_GUIDANCE_CONSTANTS = [
  "DEFAULT_AGENT_IDENTITY",
  "HERMES_AGENT_HELP_GUIDANCE",
  "MEMORY_GUIDANCE",
  "SESSION_SEARCH_GUIDANCE",
  "SKILLS_GUIDANCE",
  "KANBAN_GUIDANCE",
  "TOOL_USE_ENFORCEMENT_GUIDANCE",
  "TASK_COMPLETION_GUIDANCE",
] as const;

export type PromptGateStatus =
  "ok" | "missing" | "hash-mismatch" | "protected-clause-mismatch" | "unknown-target";

export interface PromptGateView {
  status: PromptGateStatus;
  detail: string;
  checkedAt: string;
}

export interface PromptTargetView {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: PromptFormat;
  editableSections: string[];
  protectedClauseCount: number;
  protectedSha256: string;
  reloadMode: PromptReloadMode;
  activeVersion: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
  gate: PromptGateView;
}

export interface PromptVersionView {
  version: string;
  sourcePath: string;
  contentSha256: string;
  snapshotPath: string;
  kind: "baseline" | "version";
  createdAt: string;
}

export interface PromptActiveView {
  target: PromptTargetView;
  active: PromptVersionView | null;
}

export interface RegisterPromptTargetInput {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: PromptFormat;
  editableSections?: string[];
  protectedClauses?: PromptProtectedClause[];
  reloadMode?: PromptReloadMode;
}

export type PromptRegisterOutcome =
  | { status: "registered"; target: PromptTargetView; created: boolean }
  | {
      status: "error";
      error:
        | "invalid-input"
        | "path-not-allowed"
        | "source-not-found"
        | "registered-path-conflict"
        | "registered-source-changed"
        | "registered-protected-conflict";
      detail: string;
    };

export interface PromptVerifyOutcome {
  ok: boolean;
  status: PromptGateStatus;
  detail: string;
  checkedAt: string;
}

export interface PromptCandidateCheckInput {
  targetId: string;
  content: string;
  baseSha256: string;
}

export interface PromptCandidateCheckOutcome {
  ok: boolean;
  status: "allowed" | "rejected-static";
  errors: string[];
}

export type PromptCandidateSource = "manual" | "generator";
export type PromptCandidateStatus =
  | "pending-evaluation"
  | "approval-pending"
  | "rejected-static"
  | "rejected-quality"
  | "kept-baseline"
  | "promoted";
export type PromptEvaluationTier = "insufficient" | "exploratory" | "formal";
export type PromptEvaluationStatus =
  "rejected-insufficient" | "approval-pending" | "rejected-quality" | "kept-baseline";

export interface PromptPairCase {
  caseId: string;
  baselineScore: number;
  candidateScore: number;
  baselineSuccess?: boolean;
  candidateSuccess?: boolean;
  baselineLatencyMs?: number;
  candidateLatencyMs?: number;
  baselineTokens?: number;
  candidateTokens?: number;
  baselineToolErrors?: number;
  candidateToolErrors?: number;
  safetyViolations?: number;
  note?: string;
}

export interface PromptConfidenceView {
  method: "paired-normal-approx";
  n: number;
  z: number;
  deltaMean: number;
  deltaPp: number | null;
  lower: number;
  upper: number;
  lowerPp: number | null;
  upperPp: number | null;
}

export interface PromptEvaluationMetricsView {
  baselineMean: number;
  candidateMean: number;
  deltaMean: number;
  deltaPp: number | null;
  baselineSuccessRate: number | null;
  candidateSuccessRate: number | null;
  baselineToolErrorRate: number | null;
  candidateToolErrorRate: number | null;
  safetyViolationCount: number;
  p95BaselineLatencyMs: number | null;
  p95CandidateLatencyMs: number | null;
  costDeltaPct: number | null;
  trustedEvaluator: boolean;
  canPromote: boolean;
  exploratory: boolean;
  reasons: string[];
  datasetSchemaVersion: string;
  modelParams: Record<string, unknown>;
  seed: number | null;
}

export interface PromptEvaluationSummaryView {
  evaluationId: string;
  status: PromptEvaluationStatus;
  tier: PromptEvaluationTier;
  holdoutCount: number;
  canPromote: boolean;
  confidence: PromptConfidenceView | null;
  createdAt: string;
}

export interface PromptEvaluationFailureView {
  caseId: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
  note: string;
}

export interface PromptEvaluationReportView extends PromptEvaluationSummaryView {
  candidateId: string;
  targetId: string;
  datasetPath: string;
  datasetHash: string;
  baselineSha256: string;
  candidateSha256: string;
  metrics: PromptEvaluationMetricsView;
  failures: PromptEvaluationFailureView[];
  casesPath: string;
  reportPath: string;
}

export interface PromptCandidateView {
  candidateId: string;
  targetId: string;
  contentSha256: string;
  baseSha256: string;
  snapshotPath: string;
  source: PromptCandidateSource;
  description: string;
  status: PromptCandidateStatus;
  gateErrors: string[];
  createdAt: string;
  updatedAt: string;
  latestEvaluation: PromptEvaluationSummaryView | null;
}

export interface PromptCreateCandidateInput {
  targetId: string;
  content: string;
  baseSha256: string;
  source?: PromptCandidateSource;
  description?: string;
}

export type PromptCreateCandidateOutcome =
  | { status: "created"; candidate: PromptCandidateView }
  | {
      status: "error";
      error: "invalid-input" | "unknown-fields" | "target-not-found" | "static-rejected";
      detail: string;
    };

export interface PromptEvaluateCandidateInput {
  candidateId: string;
  cases?: unknown[];
  datasetPath?: string;
  datasetHash?: string;
  datasetSchemaVersion?: string;
  modelParams?: Record<string, unknown>;
  seed?: number;
}

export type PromptEvaluationOutcome =
  | { status: "completed"; report: PromptEvaluationReportView }
  | {
      status: "error";
      error:
        | "invalid-input"
        | "candidate-not-found"
        | "missing-cases"
        | "invalid-cases"
        | "dataset-path-not-allowed"
        | "dataset-unreadable"
        | "no-evaluation-results";
      detail: string;
    };

export interface PromptCandidateReportOutcome {
  candidate: PromptCandidateView;
  report: PromptEvaluationReportView | null;
}

export type PromptPromotionOutcome =
  | {
      status: "promoted";
      candidate: PromptCandidateView;
      active: PromptActiveView;
      reloadRequired: boolean;
    }
  | {
      status: "error";
      error:
        | "invalid-input"
        | "confirmation-required"
        | "candidate-not-found"
        | "target-not-found"
        | "evaluation-not-found"
        | "evaluation-stale"
        | "promotion-not-allowed"
        | "source-changed"
        | "candidate-tampered"
        | "write-failed";
      detail: string;
    };

export interface PromptOptimizationService {
  registerTarget(input: RegisterPromptTargetInput): PromptRegisterOutcome;
  listTargets(): PromptTargetView[];
  getActive(targetId: string): PromptActiveView | null;
  verifyTarget(targetId: string): PromptVerifyOutcome;
  checkCandidate(input: unknown): PromptCandidateCheckOutcome;
  createCandidate(input: unknown): PromptCreateCandidateOutcome;
  listCandidates(targetId?: string): PromptCandidateView[];
  getCandidate(candidateId: string): PromptCandidateView | null;
  getCandidateReport(candidateId: string): PromptCandidateReportOutcome | null;
  evaluateCandidate(input: unknown): Promise<PromptEvaluationOutcome>;
  promoteCandidate(input: unknown): PromptPromotionOutcome;
}

export interface PromptOptimizationServiceDeps {
  core: Core;
  hermesRoot?: string;
  now?: () => number;
  evaluator?: (input: {
    baselineSnapshotPath: string;
    candidateSnapshotPath: string;
    cases: unknown[];
  }) => PromptPairCase[] | Promise<PromptPairCase[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function atomicReplace(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function hashProtectedClauses(clauses: PromptProtectedClause[]): string {
  return sha256(clauses.map((clause) => `${clause.id}\u0000${clause.text}`).join("\u0000"));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isInside(root: string, source: string): boolean {
  const rootPath = resolve(root);
  const sourcePath = resolve(source);
  return sourcePath === rootPath || sourcePath.startsWith(rootPath + sep);
}

function isoNow(now?: () => number): string {
  return new Date(now?.() ?? Date.now()).toISOString();
}

function readSourceHash(sourcePath: string): { hash: string } | { error: string } {
  if (!existsSync(sourcePath)) return { error: "source-missing" };
  try {
    return { hash: sha256(readFileSync(sourcePath, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function inspectTarget(row: PromptTargetRow, now?: () => number): PromptGateView {
  const checkedAt = isoNow(now);
  const source = readSourceHash(row.sourcePath);
  if ("error" in source) {
    return { status: "missing", detail: `源文件不可读：${source.error}`, checkedAt };
  }
  if (source.hash !== row.activeSha256) {
    return {
      status: "hash-mismatch",
      detail: `源文件 hash 与登记 activeSha256 不一致（期望 ${row.activeSha256.slice(0, 12)}，实际 ${source.hash.slice(0, 12)}）`,
      checkedAt,
    };
  }
  const expectedProtectedHash = hashProtectedClauses(row.protectedClauses);
  if (expectedProtectedHash !== row.protectedSha256) {
    return {
      status: "protected-clause-mismatch",
      detail: `登记的保护段元数据 hash 不一致（${row.protectedSha256.slice(0, 12)}），可能被篡改`,
      checkedAt,
    };
  }
  const normalized = normalizePrompt(readFileSync(row.sourcePath, "utf8"));
  for (const clause of row.protectedClauses) {
    if (!normalized.includes(normalizePrompt(clause.text))) {
      return {
        status: "protected-clause-mismatch",
        detail: `保护段 ${clause.id}（${clause.label}）在源文件中缺失或已变化`,
        checkedAt,
      };
    }
  }
  return { status: "ok", detail: "源文件 hash 与保护段检查通过", checkedAt };
}

function toTargetView(row: PromptTargetRow, now?: () => number): PromptTargetView {
  return {
    targetId: row.targetId,
    instanceId: row.instanceId,
    frameworkId: row.frameworkId,
    sourcePath: row.sourcePath,
    format: row.format,
    editableSections: [...row.editableSections],
    protectedClauseCount: row.protectedClauses.length,
    protectedSha256: row.protectedSha256,
    reloadMode: row.reloadMode,
    activeVersion: row.activeVersion,
    activeSha256: row.activeSha256,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    gate: inspectTarget(row, now),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === null ? undefined : parsed;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  return undefined;
}

function normalizePairCase(row: unknown, index: number): PromptPairCase | null {
  if (!isRecord(row)) return null;
  const baseline = isRecord(row["baseline"]) ? row["baseline"] : undefined;
  const candidate = isRecord(row["candidate"]) ? row["candidate"] : undefined;
  const baselineScore = finiteNumber(row["baselineScore"]) ?? finiteNumber(baseline?.["score"]);
  const candidateScore = finiteNumber(row["candidateScore"]) ?? finiteNumber(candidate?.["score"]);
  if (baselineScore === null || candidateScore === null) return null;
  const caseId = (
    typeof row["caseId"] === "string" && row["caseId"] !== ""
      ? row["caseId"]
      : typeof row["id"] === "string" && row["id"] !== ""
        ? row["id"]
        : `case-${index + 1}`
  ) as string;
  return {
    caseId,
    baselineScore,
    candidateScore,
    baselineSuccess:
      optionalBoolean(row["baselineSuccess"]) ?? optionalBoolean(baseline?.["success"]),
    candidateSuccess:
      optionalBoolean(row["candidateSuccess"]) ?? optionalBoolean(candidate?.["success"]),
    baselineLatencyMs:
      optionalNumber(row["baselineLatencyMs"]) ?? optionalNumber(baseline?.["latencyMs"]),
    candidateLatencyMs:
      optionalNumber(row["candidateLatencyMs"]) ?? optionalNumber(candidate?.["latencyMs"]),
    baselineTokens: optionalNumber(row["baselineTokens"]) ?? optionalNumber(baseline?.["tokens"]),
    candidateTokens:
      optionalNumber(row["candidateTokens"]) ?? optionalNumber(candidate?.["tokens"]),
    baselineToolErrors:
      optionalNumber(row["baselineToolErrors"]) ??
      optionalNumber(row["baselineToolErrorCount"]) ??
      optionalNumber(baseline?.["toolErrors"]),
    candidateToolErrors:
      optionalNumber(row["candidateToolErrors"]) ??
      optionalNumber(row["candidateToolErrorCount"]) ??
      optionalNumber(candidate?.["toolErrors"]),
    safetyViolations:
      optionalNumber(row["safetyViolations"]) ??
      optionalNumber(candidate?.["safetyViolations"]) ??
      0,
    ...(typeof row["note"] === "string" && row["note"] !== "" ? { note: row["note"] } : {}),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMetric(value: number): number;
function roundMetric(value: number | null): number | null;
function roundMetric(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(PROMPT_METRIC_PRECISION));
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index]!;
}

function isBinaryScores(pairs: PromptPairCase[]): boolean {
  return pairs.every(
    (pair) =>
      (pair.baselineScore === 0 || pair.baselineScore === 1) &&
      (pair.candidateScore === 0 || pair.candidateScore === 1),
  );
}

function readDatasetRows(path: string): unknown[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function toEvaluationReport(row: PromptEvaluationRow): PromptEvaluationReportView {
  const metrics = isRecord(row.metrics) ? row.metrics : {};
  const confidence = isRecord(row.confidence) ? row.confidence : null;
  const failuresRaw = Array.isArray(row.failures) ? row.failures : [];
  const failures = failuresRaw.filter(isRecord).map((failure) => ({
    caseId: String(failure["caseId"] ?? ""),
    baselineScore: Number(failure["baselineScore"] ?? 0),
    candidateScore: Number(failure["candidateScore"] ?? 0),
    delta: Number(failure["delta"] ?? 0),
    note: String(failure["note"] ?? ""),
  }));
  return {
    evaluationId: row.evaluationId,
    candidateId: row.candidateId,
    targetId: row.targetId,
    status: row.status as PromptEvaluationStatus,
    tier: row.tier,
    holdoutCount: row.holdoutCount,
    canPromote: metrics["canPromote"] === true,
    confidence:
      confidence !== null && finiteNumber(confidence["z"]) !== null
        ? (confidence as unknown as PromptConfidenceView)
        : null,
    createdAt: row.createdAt,
    datasetPath: row.datasetPath,
    datasetHash: row.datasetHash,
    baselineSha256: row.baselineSha256,
    candidateSha256: row.candidateSha256,
    metrics: {
      baselineMean: Number(metrics["baselineMean"] ?? 0),
      candidateMean: Number(metrics["candidateMean"] ?? 0),
      deltaMean: Number(metrics["deltaMean"] ?? 0),
      deltaPp: finiteNumber(metrics["deltaPp"]),
      baselineSuccessRate: finiteNumber(metrics["baselineSuccessRate"]),
      candidateSuccessRate: finiteNumber(metrics["candidateSuccessRate"]),
      baselineToolErrorRate: finiteNumber(metrics["baselineToolErrorRate"]),
      candidateToolErrorRate: finiteNumber(metrics["candidateToolErrorRate"]),
      safetyViolationCount: Number(metrics["safetyViolationCount"] ?? 0),
      p95BaselineLatencyMs: finiteNumber(metrics["p95BaselineLatencyMs"]),
      p95CandidateLatencyMs: finiteNumber(metrics["p95CandidateLatencyMs"]),
      costDeltaPct: finiteNumber(metrics["costDeltaPct"]),
      trustedEvaluator: metrics["trustedEvaluator"] === true,
      canPromote: metrics["canPromote"] === true,
      exploratory: metrics["exploratory"] === true,
      reasons: Array.isArray(metrics["reasons"])
        ? metrics["reasons"].filter((item): item is string => typeof item === "string")
        : [],
      datasetSchemaVersion: String(metrics["datasetSchemaVersion"] ?? "pair-v1"),
      modelParams: isRecord(metrics["modelParams"]) ? metrics["modelParams"] : {},
      seed: finiteNumber(metrics["seed"]),
    },
    failures,
    casesPath: row.casesPath,
    reportPath: row.reportPath,
  };
}

function toEvaluationSummary(row: PromptEvaluationRow): PromptEvaluationSummaryView {
  const report = toEvaluationReport(row);
  return {
    evaluationId: report.evaluationId,
    status: report.status,
    tier: report.tier,
    holdoutCount: report.holdoutCount,
    canPromote: report.canPromote,
    confidence: report.confidence,
    createdAt: report.createdAt,
  };
}

/** 真实 Hermes 提示词目标的服务端默认定义；只登记存在的文件，绝不接受请求路径。 */
export function defaultPromptTargets(hermesRoot: string): RegisterPromptTargetInput[] {
  const agentDir = join(hermesRoot, "hermes-agent");
  return [
    {
      targetId: "hermes-system-prompt",
      instanceId: "hermes-main",
      frameworkId: "hermes",
      sourcePath: join(agentDir, "agent", "system_prompt.py"),
      format: "plain",
      editableSections: ["prompt-content"],
      reloadMode: "next-run",
    },
    {
      targetId: "hermes-prompt-builder",
      instanceId: "hermes-main",
      frameworkId: "hermes",
      sourcePath: join(agentDir, "agent", "prompt_builder.py"),
      format: "plain",
      editableSections: ["guidance-content"],
      reloadMode: "next-run",
    },
    {
      targetId: "hermes-tool-guardrails",
      instanceId: "hermes-main",
      frameworkId: "hermes",
      sourcePath: join(agentDir, "agent", "tool_guardrails.py"),
      format: "plain",
      editableSections: ["tool-policy"],
      reloadMode: "service-restart-required",
    },
    {
      targetId: "hermes-soul",
      instanceId: "hermes-main",
      frameworkId: "hermes",
      sourcePath: join(hermesRoot, "SOUL.md"),
      format: "markdown",
      editableSections: ["identity"],
      reloadMode: "next-run",
    },
  ];
}

/** 从源文件筛选安全关键词所在行作为默认保护段；不命中时为空数组，不虚构条款。 */
export function defaultProtectedClauses(content: string): PromptProtectedClause[] {
  const clauses: PromptProtectedClause[] = [];
  for (const name of PYTHON_GUIDANCE_CONSTANTS) {
    const assignment = new RegExp(`^${name}\\s*=`, "m").exec(content);
    if (assignment === null) continue;
    const exprStart = content.indexOf("(", assignment.index);
    if (exprStart < 0) continue;
    const close = /\r?\n\)\r?\n/.exec(content.slice(exprStart));
    if (close === null) continue;
    const exprEnd = exprStart + close.index + close[0].length - 1;
    clauses.push({
      id: `constant-${name}`,
      label: name,
      text: content.slice(assignment.index, exprEnd + 2),
    });
  }

  const lines = content.split(/\r?\n/);
  for (const marker of PROMPT_SAFETY_MARKERS) {
    const line = lines.find((candidate) => candidate.includes(marker));
    if (line === undefined) continue;
    const text = line.trim();
    if (text === "" || clauses.some((clause) => clause.text === text)) continue;
    clauses.push({ id: `safety-${marker}`, label: marker, text });
  }
  return clauses;
}

/** 组装 M5 切片 1/2 服务；仅登记服务端定义的目标，不开放任意路径写入口。 */
export function createPromptOptimizationService(
  deps: PromptOptimizationServiceDeps,
): PromptOptimizationService {
  const { core } = deps;
  const configuredRoot =
    deps.hermesRoot?.trim() ||
    process.env["HERMES_ROOT"]?.trim() ||
    process.env["BUTLER_HERMES_ROOT"]?.trim();
  const root = configuredRoot ? resolve(configuredRoot) : resolve(homedir(), ".hermes");
  const promptsDir = core.paths.promptsDir;
  const now = deps.now;

  const snapshotPathFor = (targetId: string, version: string, contentSha256: string): string =>
    join(promptsDir, safeSegment(targetId), `${safeSegment(version)}-${contentSha256}.txt`);

  function registerTarget(input: RegisterPromptTargetInput): PromptRegisterOutcome {
    const targetId = input.targetId?.trim();
    const instanceId = input.instanceId?.trim();
    const frameworkId = input.frameworkId?.trim();
    const sourcePath = input.sourcePath?.trim();
    if (
      targetId === undefined ||
      targetId === "" ||
      instanceId === undefined ||
      instanceId === "" ||
      frameworkId === undefined ||
      frameworkId === "" ||
      sourcePath === undefined ||
      sourcePath === "" ||
      !PROMPT_FORMATS.includes(input.format) ||
      (input.reloadMode !== undefined && !PROMPT_RELOAD_MODES.includes(input.reloadMode)) ||
      !isInside(root, sourcePath)
    ) {
      return {
        status: "error",
        error: !isInside(root, sourcePath) ? "path-not-allowed" : "invalid-input",
        detail: !isInside(root, sourcePath)
          ? "sourcePath 必须位于服务端登记的 hermes 根目录内"
          : "登记字段缺失、为空或格式不受支持",
      };
    }

    const editableSections = input.editableSections ?? ["all"];
    const protectedClauses = input.protectedClauses ?? [];
    if (
      !Array.isArray(editableSections) ||
      !editableSections.every((section) => typeof section === "string" && section.trim() !== "") ||
      !Array.isArray(protectedClauses) ||
      protectedClauses.some(
        (clause) =>
          !isRecord(clause) ||
          typeof clause["id"] !== "string" ||
          clause["id"] === "" ||
          typeof clause["label"] !== "string" ||
          clause["label"] === "" ||
          typeof clause["text"] !== "string" ||
          clause["text"] === "",
      )
    ) {
      return {
        status: "error",
        error: "invalid-input",
        detail: "editableSections 或 protectedClauses 格式非法",
      };
    }

    const normalizedClauses = protectedClauses.map((clause) => ({
      id: clause.id,
      label: clause.label,
      text: clause.text,
    }));
    const protectedSha256 = hashProtectedClauses(normalizedClauses);
    const source = readSourceHash(sourcePath);
    if ("error" in source) {
      return { status: "error", error: "source-not-found", detail: source.error };
    }

    const existing = core.store.getPromptTarget(targetId);
    if (existing !== undefined) {
      if (resolve(existing.sourcePath) !== resolve(sourcePath)) {
        return {
          status: "error",
          error: "registered-path-conflict",
          detail: `目标 ${targetId} 已登记不同的 sourcePath`,
        };
      }
      if (existing.activeSha256 !== source.hash) {
        return {
          status: "error",
          error: "registered-source-changed",
          detail: `目标 ${targetId} 源文件已变化，静态门禁不会自动重新登记`,
        };
      }
      if (existing.protectedSha256 !== protectedSha256) {
        return {
          status: "error",
          error: "registered-protected-conflict",
          detail: `目标 ${targetId} 已登记不同的保护段集合`,
        };
      }
      return { status: "registered", target: toTargetView(existing, now), created: false };
    }

    const createdAt = isoNow(now);
    const snapshotPath = snapshotPathFor(targetId, PROMPT_BASELINE_VERSION, source.hash);
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    writeFileSync(snapshotPath, readFileSync(sourcePath, "utf8"), {
      encoding: "utf8",
      mode: 0o600,
    });

    const row: PromptTargetRow = {
      targetId,
      instanceId,
      frameworkId,
      sourcePath: resolve(sourcePath),
      format: input.format,
      editableSections,
      protectedClauses: normalizedClauses,
      protectedSha256,
      reloadMode: input.reloadMode ?? "next-run",
      activeVersion: PROMPT_BASELINE_VERSION,
      activeSha256: source.hash,
      createdAt,
      updatedAt: createdAt,
    };
    core.store.savePromptTarget(row);
    core.store.insertPromptVersion({
      targetId,
      version: PROMPT_BASELINE_VERSION,
      sourcePath: row.sourcePath,
      contentSha256: source.hash,
      snapshotPath,
      kind: "baseline",
    });
    core.audit.append({
      actor: PROMPT_OPTIMIZATION_ACTOR,
      action: PROMPT_REGISTER_ACTION,
      target: targetId,
      detail: {
        sourcePath: row.sourcePath,
        snapshotPath,
        contentSha256: source.hash,
        protectedClauseCount: normalizedClauses.length,
      },
    });
    return { status: "registered", target: toTargetView(row, now), created: true };
  }

  function checkCandidate(input: unknown): PromptCandidateCheckOutcome {
    const errors: string[] = [];
    if (!isRecord(input)) {
      return { ok: false, status: "rejected-static", errors: ["候选输入必须是对象"] };
    }
    const unknownFields = Object.keys(input).filter((key) => !PROMPT_CANDIDATE_FIELDS.has(key));
    if (unknownFields.length > 0) {
      errors.push(`未知字段：${unknownFields.join(", ")}`);
    }
    const targetId = input["targetId"];
    const content = input["content"];
    const baseSha256 = input["baseSha256"];
    if (typeof targetId !== "string" || targetId === "") errors.push("targetId 必须是非空字符串");
    if (typeof content !== "string" || content === "") errors.push("content 必须是非空字符串");
    if (typeof baseSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(baseSha256)) {
      errors.push("baseSha256 必须是 64 位十六进制 hash");
    }
    if (errors.length > 0) return { ok: false, status: "rejected-static", errors };

    const row = core.store.getPromptTarget(targetId as string);
    if (row === undefined) {
      return {
        ok: false,
        status: "rejected-static",
        errors: ["未登记目标：静态门禁拒绝该 targetId"],
      };
    }
    const current = readSourceHash(row.sourcePath);
    if ("error" in current) {
      return {
        ok: false,
        status: "rejected-static",
        errors: [`源文件不可用：${current.error}`],
      };
    }
    if (current.hash !== row.activeSha256) {
      return {
        ok: false,
        status: "rejected-static",
        errors: ["hash 不匹配：源文件与登记 activeSha256 不一致"],
      };
    }
    if (current.hash !== baseSha256) {
      return {
        ok: false,
        status: "rejected-static",
        errors: ["hash 不匹配：候选 baseSha256 与当前源文件不一致"],
      };
    }
    const normalizedCandidate = normalizePrompt(content as string);
    for (const clause of row.protectedClauses) {
      if (!normalizedCandidate.includes(normalizePrompt(clause.text))) {
        return {
          ok: false,
          status: "rejected-static",
          errors: [`保护段变化：${clause.id}（${clause.label}）缺失或被改写`],
        };
      }
    }
    return { ok: true, status: "allowed", errors: [] };
  }

  const datasetRoots = [
    join(core.paths.promptsDir, "datasets"),
    join(core.paths.home, "evolution", "datasets"),
  ];

  function toCandidateView(row: PromptCandidateRow): PromptCandidateView {
    const latest = core.store.getLatestPromptEvaluation(row.candidateId);
    return {
      candidateId: row.candidateId,
      targetId: row.targetId,
      contentSha256: row.contentSha256,
      baseSha256: row.baseSha256,
      snapshotPath: row.snapshotPath,
      source: row.source,
      description: row.description,
      status: row.status,
      gateErrors: [...row.gateErrors],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestEvaluation: latest === undefined ? null : toEvaluationSummary(latest),
    };
  }

  function isAllowedDatasetPath(candidate: string): boolean {
    const normalized = resolve(candidate);
    return datasetRoots.some((root) => isInside(root, normalized));
  }

  function createCandidate(input: unknown): PromptCreateCandidateOutcome {
    const invalid = (
      error: "invalid-input" | "unknown-fields" | "target-not-found" | "static-rejected",
      detail: string,
    ) => ({
      status: "error" as const,
      error,
      detail,
    });
    if (!isRecord(input)) return invalid("invalid-input", "候选项必须是对象");
    const unknownFields = Object.keys(input).filter(
      (key) => !PROMPT_CANDIDATE_INPUT_FIELDS.has(key),
    );
    if (unknownFields.length > 0) {
      return invalid("unknown-fields", `未知字段：${unknownFields.join(", ")}`);
    }
    const targetId = input["targetId"];
    const content = input["content"];
    const baseSha256 = input["baseSha256"];
    const source = input["source"];
    const description = input["description"];
    if (
      typeof targetId !== "string" ||
      targetId === "" ||
      typeof content !== "string" ||
      content === "" ||
      typeof baseSha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(baseSha256) ||
      (source !== undefined && source !== "manual" && source !== "generator") ||
      (description !== undefined && typeof description !== "string")
    ) {
      return invalid("invalid-input", "候选字段缺失、为空或格式非法");
    }
    const target = core.store.getPromptTarget(targetId);
    if (target === undefined) return invalid("target-not-found", `未登记目标：${targetId}`);

    const staticCheck = checkCandidate({ targetId, content, baseSha256 });
    const contentSha256 = sha256(content);
    const candidateId = randomUUID();
    const snapshotPath = snapshotPathFor(targetId, "candidate", contentSha256);
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    writeFileSync(snapshotPath, content, { encoding: "utf8", mode: 0o600 });
    const row = core.store.savePromptCandidate({
      candidateId,
      targetId,
      contentSha256,
      baseSha256,
      snapshotPath,
      source: source === "generator" ? "generator" : "manual",
      description: typeof description === "string" ? description : "",
      status: staticCheck.ok ? "pending-evaluation" : "rejected-static",
      gateErrors: staticCheck.errors,
    });
    core.audit.append({
      actor: PROMPT_OPTIMIZATION_ACTOR,
      action: PROMPT_CREATE_CANDIDATE_ACTION,
      target: targetId,
      detail: {
        candidateId,
        contentSha256,
        baseSha256,
        snapshotPath,
        staticAllowed: staticCheck.ok,
      },
    });
    return { status: "created", candidate: toCandidateView(row) };
  }

  async function evaluateCandidate(input: unknown): Promise<PromptEvaluationOutcome> {
    const invalid = (
      error: Exclude<PromptEvaluationOutcome, { status: "completed" }>["error"],
      detail: string,
    ) => ({ status: "error" as const, error, detail });
    if (!isRecord(input)) return invalid("invalid-input", "评估请求必须是对象");
    const candidateId = input["candidateId"];
    if (typeof candidateId !== "string" || candidateId === "") {
      return invalid("invalid-input", "candidateId 必须是非空字符串");
    }
    if (input["cases"] !== undefined && !Array.isArray(input["cases"])) {
      return invalid("invalid-input", "cases 必须是数组");
    }
    if (
      input["datasetPath"] !== undefined &&
      (typeof input["datasetPath"] !== "string" || input["datasetPath"] === "")
    ) {
      return invalid("invalid-input", "datasetPath 必须是非空字符串");
    }
    if (
      input["datasetHash"] !== undefined &&
      (typeof input["datasetHash"] !== "string" || input["datasetHash"] === "")
    ) {
      return invalid("invalid-input", "datasetHash 必须是非空字符串");
    }
    if (
      input["datasetSchemaVersion"] !== undefined &&
      (typeof input["datasetSchemaVersion"] !== "string" || input["datasetSchemaVersion"] === "")
    ) {
      return invalid("invalid-input", "datasetSchemaVersion 必须是非空字符串");
    }
    if (input["modelParams"] !== undefined && !isRecord(input["modelParams"])) {
      return invalid("invalid-input", "modelParams 必须是对象");
    }
    if (input["seed"] !== undefined && finiteNumber(input["seed"]) === null) {
      return invalid("invalid-input", "seed 必须是有限数字");
    }

    const row = core.store.getPromptCandidate(candidateId);
    if (row === undefined) {
      return invalid("candidate-not-found", `候选不存在：${candidateId}`);
    }
    const target = core.store.getPromptTarget(row.targetId);
    if (target === undefined) {
      return invalid("candidate-not-found", `候选目标已不存在：${row.targetId}`);
    }
    const baseline = core.store.getPromptVersion(row.targetId, target.activeVersion);
    if (baseline === undefined) {
      return invalid("no-evaluation-results", "目标缺少 baseline 快照，无法成对评估");
    }

    const rawCases = Array.isArray(input["cases"]) ? input["cases"] : undefined;
    const datasetPath = typeof input["datasetPath"] === "string" ? input["datasetPath"].trim() : "";
    let datasetContent = "";
    let rows: unknown[];
    if (rawCases !== undefined) {
      rows = rawCases;
    } else {
      if (datasetPath === "") return invalid("missing-cases", "请提供 cases 或 datasetPath");
      if (!isAllowedDatasetPath(datasetPath)) {
        return invalid("dataset-path-not-allowed", "评估集路径必须在 BUTLER_HOME 受控目录内");
      }
      try {
        datasetContent = readFileSync(datasetPath, "utf8");
        rows = readDatasetRows(datasetPath);
      } catch {
        return invalid("dataset-unreadable", "评估集不存在、不可读或不是合法 JSON/JSONL");
      }
    }
    if (rows.length === 0) return invalid("missing-cases", "评估集为空");

    const trustedEvaluator = deps.evaluator !== undefined;
    let pairs: Array<PromptPairCase | null>;
    if (deps.evaluator !== undefined) {
      let evaluated: PromptPairCase[];
      try {
        evaluated = await deps.evaluator({
          baselineSnapshotPath: baseline.snapshotPath,
          candidateSnapshotPath: row.snapshotPath,
          cases: rows,
        });
      } catch (error) {
        return invalid(
          "no-evaluation-results",
          `evaluator 执行失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (evaluated.length !== rows.length) {
        return invalid("no-evaluation-results", "evaluator 返回的用例数量与评估集不一致");
      }
      pairs = evaluated.map((pair, index) => normalizePairCase(pair, index));
      if (pairs.some((pair) => pair === null)) {
        return invalid("no-evaluation-results", "evaluator 返回的用例缺少成对分数");
      }
    } else {
      pairs = rows.map((rowItem, index) => normalizePairCase(rowItem, index));
      if (pairs.some((pair) => pair === null)) {
        return invalid(
          "invalid-cases",
          "用例缺少 baselineScore/candidateScore；未配置 evaluator 时无法执行真实评估",
        );
      }
    }
    const cases = pairs as PromptPairCase[];
    const n = cases.length;
    const deltas = cases.map((item) => item.candidateScore - item.baselineScore);
    const baselineMeanValue = mean(cases.map((item) => item.baselineScore));
    const candidateMeanValue = mean(cases.map((item) => item.candidateScore));
    const deltaMeanValue = mean(deltas);
    const binary = isBinaryScores(cases);
    const deltaPpValue = binary ? deltaMeanValue * 100 : null;
    const baselineSuccessCount = cases.filter((item) => item.baselineSuccess === true).length;
    const candidateSuccessCount = cases.filter((item) => item.candidateSuccess === true).length;
    const baselineSuccessRate = cases.some((item) => item.baselineSuccess !== undefined)
      ? baselineSuccessCount / n
      : null;
    const candidateSuccessRate = cases.some((item) => item.candidateSuccess !== undefined)
      ? candidateSuccessCount / n
      : null;
    const baselineToolErrors = cases.reduce((sum, item) => sum + (item.baselineToolErrors ?? 0), 0);
    const candidateToolErrors = cases.reduce(
      (sum, item) => sum + (item.candidateToolErrors ?? 0),
      0,
    );
    const baselineToolErrorRate = cases.some((item) => item.baselineToolErrors !== undefined)
      ? baselineToolErrors / n
      : null;
    const candidateToolErrorRate = cases.some((item) => item.candidateToolErrors !== undefined)
      ? candidateToolErrors / n
      : null;
    const safetyViolationCount = cases.reduce((sum, item) => sum + (item.safetyViolations ?? 0), 0);
    const baselineLatencies = cases
      .map((item) => item.baselineLatencyMs)
      .filter((value): value is number => value !== undefined);
    const candidateLatencies = cases
      .map((item) => item.candidateLatencyMs)
      .filter((value): value is number => value !== undefined);
    const baselineTokens = cases.reduce((sum, item) => sum + (item.baselineTokens ?? 0), 0);
    const candidateTokens = cases.reduce((sum, item) => sum + (item.candidateTokens ?? 0), 0);
    const costDeltaPct =
      baselineTokens > 0 ? ((candidateTokens - baselineTokens) / baselineTokens) * 100 : null;

    let confidence: PromptConfidenceView | null = null;
    if (n >= PROMPT_MIN_HOLDOUT_COUNT * 3) {
      const spread = stdDev(deltas);
      const margin = (PROMPT_CI_Z * spread) / Math.sqrt(n);
      const lower = deltaMeanValue - margin;
      const upper = deltaMeanValue + margin;
      confidence = {
        method: "paired-normal-approx",
        n,
        z: PROMPT_CI_Z,
        deltaMean: roundMetric(deltaMeanValue),
        deltaPp: roundMetric(deltaPpValue),
        lower: roundMetric(lower),
        upper: roundMetric(upper),
        lowerPp: roundMetric(deltaPpValue === null ? null : lower * 100),
        upperPp: roundMetric(deltaPpValue === null ? null : upper * 100),
      };
    }

    const reasons: string[] = [];
    let tier: PromptEvaluationTier = "insufficient";
    let status: PromptEvaluationStatus = "rejected-insufficient";
    let canPromote = false;
    if (n < PROMPT_MIN_HOLDOUT_COUNT) {
      reasons.push(`holdout 仅 ${n} 条，低于硬门槛 ${PROMPT_MIN_HOLDOUT_COUNT}`);
    } else if (n <= PROMPT_EXPLORATORY_MAX_COUNT) {
      tier = "exploratory";
      reasons.push(
        `holdout ${n} 条属于探索性区间 10-${PROMPT_EXPLORATORY_MAX_COUNT}，不得宣称显著`,
      );
      status = "approval-pending";
    } else {
      tier = "formal";
      if (safetyViolationCount > 0) {
        status = "rejected-quality";
        reasons.push(`候选存在 ${safetyViolationCount} 个安全违规，硬门禁拒绝`);
      } else if (
        baselineToolErrorRate !== null &&
        candidateToolErrorRate !== null &&
        candidateToolErrorRate > baselineToolErrorRate
      ) {
        status = "rejected-quality";
        reasons.push("候选工具错误率高于 baseline，质量门禁拒绝");
      } else if (
        candidateMeanValue < baselineMeanValue ||
        (confidence !== null &&
          (confidence.lowerPp !== null ? confidence.lowerPp < -2 : confidence.lower < -0.02))
      ) {
        status = "rejected-quality";
        reasons.push("候选主任务指标未达基线或 95% 置信区间下界低于允许阈值");
      } else if (candidateMeanValue <= baselineMeanValue + 1e-9) {
        status = "kept-baseline";
        reasons.push("候选未优于 baseline，保留 baseline");
      } else {
        status = "approval-pending";
        canPromote = trustedEvaluator;
        reasons.push(
          trustedEvaluator
            ? "候选通过受信 evaluator 的成对质量门禁，等待人工批准"
            : "候选质量指标通过，但未配置受信 evaluator，只记录报告且禁止提升",
        );
      }
    }

    const failures = cases
      .filter(
        (item) => item.candidateScore < item.baselineScore || (item.safetyViolations ?? 0) > 0,
      )
      .map((item) => ({
        caseId: item.caseId,
        baselineScore: item.baselineScore,
        candidateScore: item.candidateScore,
        delta: item.candidateScore - item.baselineScore,
        note: item.note ?? "",
      }));
    const datasetHash =
      typeof input["datasetHash"] === "string" && input["datasetHash"] !== ""
        ? input["datasetHash"]
        : sha256(datasetContent !== "" ? datasetContent : JSON.stringify(rows));
    const evaluationId = randomUUID();
    const evaluationDir = join(promptsDir, safeSegment(row.targetId), "evaluations");
    const casesPath = join(evaluationDir, `${evaluationId}-cases.jsonl`);
    const reportPath = join(evaluationDir, `${evaluationId}.json`);
    mkdirSync(evaluationDir, { recursive: true, mode: 0o700 });
    writeFileSync(casesPath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const metrics: PromptEvaluationMetricsView = {
      baselineMean: roundMetric(baselineMeanValue),
      candidateMean: roundMetric(candidateMeanValue),
      deltaMean: roundMetric(deltaMeanValue),
      deltaPp: roundMetric(deltaPpValue),
      baselineSuccessRate: roundMetric(baselineSuccessRate),
      candidateSuccessRate: roundMetric(candidateSuccessRate),
      baselineToolErrorRate: roundMetric(baselineToolErrorRate),
      candidateToolErrorRate: roundMetric(candidateToolErrorRate),
      safetyViolationCount,
      p95BaselineLatencyMs: roundMetric(percentile(baselineLatencies, 0.95)),
      p95CandidateLatencyMs: roundMetric(percentile(candidateLatencies, 0.95)),
      costDeltaPct: roundMetric(costDeltaPct),
      trustedEvaluator,
      canPromote,
      exploratory: tier === "exploratory",
      reasons,
      datasetSchemaVersion:
        typeof input["datasetSchemaVersion"] === "string"
          ? input["datasetSchemaVersion"]
          : "pair-v1",
      modelParams: isRecord(input["modelParams"]) ? input["modelParams"] : {},
      seed: finiteNumber(input["seed"]),
    };
    const report: PromptEvaluationReportView = {
      evaluationId,
      candidateId: row.candidateId,
      targetId: row.targetId,
      status,
      tier,
      holdoutCount: n,
      canPromote,
      confidence,
      createdAt: isoNow(now),
      datasetPath,
      datasetHash,
      baselineSha256: baseline.contentSha256,
      candidateSha256: row.contentSha256,
      metrics,
      failures,
      casesPath,
      reportPath,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    core.store.savePromptEvaluation({
      evaluationId,
      candidateId: row.candidateId,
      targetId: row.targetId,
      status,
      tier,
      holdoutCount: n,
      datasetPath,
      datasetHash,
      baselineSha256: baseline.contentSha256,
      candidateSha256: row.contentSha256,
      casesPath,
      reportPath,
      metrics,
      confidence,
      failures,
    });
    core.store.savePromptEvaluationCases({ evaluationId, cases });
    const candidateStatus: PromptCandidateStatus =
      status === "approval-pending"
        ? "approval-pending"
        : status === "kept-baseline"
          ? "kept-baseline"
          : "rejected-quality";
    core.store.savePromptCandidate({
      ...row,
      status: candidateStatus,
      updatedAt: isoNow(now),
    });
    core.audit.append({
      actor: PROMPT_OPTIMIZATION_ACTOR,
      action: PROMPT_EVALUATE_ACTION,
      target: row.targetId,
      detail: {
        candidateId: row.candidateId,
        evaluationId,
        status,
        tier,
        holdoutCount: n,
        deltaMean: roundMetric(deltaMeanValue),
        trustedEvaluator,
        canPromote,
      },
    });
    return { status: "completed", report };
  }

  function promoteCandidate(input: unknown): PromptPromotionOutcome {
    const invalid = (
      error: Exclude<PromptPromotionOutcome, { status: "promoted" }>["error"],
      detail: string,
    ) => ({ status: "error" as const, error, detail });
    if (!isRecord(input)) return invalid("invalid-input", "提升请求必须是对象");
    const unknownFields = Object.keys(input).filter((key) => !PROMPT_PROMOTION_FIELDS.has(key));
    if (unknownFields.length > 0) {
      return invalid("invalid-input", `未知字段：${unknownFields.join(", ")}`);
    }
    const candidateId = input["candidateId"];
    const evaluationId = input["evaluationId"];
    if (
      typeof candidateId !== "string" ||
      candidateId === "" ||
      typeof evaluationId !== "string" ||
      evaluationId === ""
    ) {
      return invalid("invalid-input", "candidateId 与 evaluationId 必须是非空字符串");
    }
    if (input["confirmed"] !== true) {
      return invalid("confirmation-required", "必须明确 confirmed=true 才能采用候选");
    }

    const candidate = core.store.getPromptCandidate(candidateId);
    if (candidate === undefined) {
      return invalid("candidate-not-found", `候选不存在：${candidateId}`);
    }
    const target = core.store.getPromptTarget(candidate.targetId);
    if (target === undefined) {
      return invalid("target-not-found", `候选目标不存在：${candidate.targetId}`);
    }
    const evaluation = core.store.getPromptEvaluation(evaluationId);
    if (evaluation === undefined || evaluation.candidateId !== candidateId) {
      return invalid("evaluation-not-found", `候选没有对应评估：${evaluationId}`);
    }
    const latest = core.store.getLatestPromptEvaluation(candidateId);
    if (latest === undefined || latest.evaluationId !== evaluationId) {
      return invalid("evaluation-stale", "只能使用该候选最新一次评估进行提升");
    }

    const report = toEvaluationReport(evaluation);
    if (
      candidate.status !== "approval-pending" ||
      report.status !== "approval-pending" ||
      report.tier !== "formal" ||
      report.holdoutCount < PROMPT_EXPLORATORY_MAX_COUNT + 1 ||
      !report.canPromote ||
      !report.metrics.trustedEvaluator ||
      report.baselineSha256 !== candidate.baseSha256 ||
      report.candidateSha256 !== candidate.contentSha256
    ) {
      return invalid(
        "promotion-not-allowed",
        "最新评估未同时满足正式样本、受信 evaluator、质量门禁与候选 hash 约束",
      );
    }

    const source = readSourceHash(target.sourcePath);
    if (
      "error" in source ||
      source.hash !== candidate.baseSha256 ||
      source.hash !== target.activeSha256
    ) {
      return invalid("source-changed", "真实源文件或 active 版本已变化，请重新生成并评估候选");
    }

    let candidateContent: string;
    try {
      candidateContent = readFileSync(candidate.snapshotPath, "utf8");
    } catch {
      return invalid("candidate-tampered", "候选快照缺失或不可读");
    }
    if (sha256(candidateContent) !== candidate.contentSha256) {
      return invalid("candidate-tampered", "候选快照 hash 与登记值不一致");
    }
    const staticCheck = checkCandidate({
      targetId: candidate.targetId,
      content: candidateContent,
      baseSha256: candidate.baseSha256,
    });
    if (!staticCheck.ok) {
      return invalid("promotion-not-allowed", `静态保护门禁拒绝：${staticCheck.errors.join("；")}`);
    }

    const previousContent = readFileSync(target.sourcePath, "utf8");
    try {
      atomicReplace(target.sourcePath, candidateContent);
    } catch (error) {
      return invalid(
        "write-failed",
        `替换真实源文件失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const updatedAt = isoNow(now);
    const version = `candidate-${candidate.candidateId}`;
    try {
      core.store.promotePromptCandidate({
        candidateId: candidate.candidateId,
        targetId: target.targetId,
        version,
        sourcePath: target.sourcePath,
        contentSha256: candidate.contentSha256,
        snapshotPath: candidate.snapshotPath,
        updatedAt,
        audit: {
          actor: PROMPT_OPTIMIZATION_ACTOR,
          action: PROMPT_PROMOTE_ACTION,
          target: target.targetId,
          detail: {
            candidateId: candidate.candidateId,
            evaluationId: evaluation.evaluationId,
            version,
            previousSha256: candidate.baseSha256,
            promotedSha256: candidate.contentSha256,
            trustedEvaluator: true,
          },
        },
      });
    } catch (error) {
      try {
        atomicReplace(target.sourcePath, previousContent);
      } catch (restoreError) {
        return invalid(
          "write-failed",
          `提升登记失败且源文件恢复失败：${error instanceof Error ? error.message : String(error)}；${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
      return invalid(
        "write-failed",
        `提升登记失败，已恢复原文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const promoted = core.store.getPromptCandidate(candidate.candidateId);
    const promotedTarget = core.store.getPromptTarget(target.targetId);
    const activeVersion = core.store.getPromptVersion(target.targetId, version);
    if (promoted === undefined || promotedTarget === undefined || activeVersion === undefined) {
      return invalid("write-failed", "提升已提交但读取最新状态失败");
    }
    return {
      status: "promoted",
      candidate: toCandidateView(promoted),
      active: {
        target: toTargetView(promotedTarget, now),
        active: {
          version: activeVersion.version,
          sourcePath: activeVersion.sourcePath,
          contentSha256: activeVersion.contentSha256,
          snapshotPath: activeVersion.snapshotPath,
          kind: activeVersion.kind,
          createdAt: activeVersion.createdAt,
        },
      },
      reloadRequired: target.reloadMode === "service-restart-required",
    };
  }

  // 服务端默认 Hermes 目标：文件存在才登记，失败静默跳过，不修改真实源文件。
  for (const target of defaultPromptTargets(root)) {
    if (!existsSync(target.sourcePath)) continue;
    const content = readFileSync(target.sourcePath, "utf8");
    registerTarget({ ...target, protectedClauses: defaultProtectedClauses(content) });
  }

  return {
    registerTarget,
    listTargets: () => core.store.listPromptTargets().map((row) => toTargetView(row, now)),
    getActive: (targetId) => {
      const row = core.store.getPromptTarget(targetId);
      if (row === undefined) return null;
      const version = core.store.getPromptVersion(row.targetId, row.activeVersion);
      return {
        target: toTargetView(row, now),
        active:
          version === undefined
            ? null
            : {
                version: version.version,
                sourcePath: version.sourcePath,
                contentSha256: version.contentSha256,
                snapshotPath: version.snapshotPath,
                kind: version.kind,
                createdAt: version.createdAt,
              },
      };
    },
    verifyTarget: (targetId) => {
      const row = core.store.getPromptTarget(targetId);
      if (row === undefined) {
        return {
          ok: false,
          status: "unknown-target",
          detail: "未登记目标",
          checkedAt: isoNow(now),
        };
      }
      const gate = inspectTarget(row, now);
      return {
        ok: gate.status === "ok",
        status: gate.status,
        detail: gate.detail,
        checkedAt: gate.checkedAt,
      };
    },
    checkCandidate,
    createCandidate,
    listCandidates: (targetId) =>
      core.store.listPromptCandidates(targetId).map((row) => toCandidateView(row)),
    getCandidate: (candidateId) => {
      const row = core.store.getPromptCandidate(candidateId);
      return row === undefined ? null : toCandidateView(row);
    },
    getCandidateReport: (candidateId) => {
      const row = core.store.getPromptCandidate(candidateId);
      if (row === undefined) return null;
      const latest = core.store.getLatestPromptEvaluation(candidateId);
      return {
        candidate: toCandidateView(row),
        report: latest === undefined ? null : toEvaluationReport(latest),
      };
    },
    evaluateCandidate,
    promoteCandidate,
  };
}
