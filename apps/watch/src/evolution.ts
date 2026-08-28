/**
 * M4 进化守门员（V1）：
 * - 运行前：依赖 / 端点 / holdout 三项预检；全部通过后才做 skills + memory 快照；
 * - 数据集不足：拒绝运行，并提供最小 JSONL 扩集工具，补齐到门槛后自动重检；
 * - 运行后：接收外部进化引擎的指标结果，只做准入判定，不代引擎执行或写技能；
 * - 指标回落：无条件拒绝、baseline 保留、紧急告警；无显著提升保持 baseline；
 * - 每次运行以本地 Markdown 台账为持久化事实源，可列表与导出。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { findVenvPython, type CommandExecutor } from "@butler/adapter-hermes";
import type { ControlAdapter, InstanceRef } from "@butler/contract";
import type { Core, InstanceRecord } from "@butler/core";
import type { AlertPoster } from "./alert-forward.js";
import type { FetchLike } from "./dashboard-signal.js";
import type { LogIssueView } from "./log-analyzer.js";

export const EVOLUTION_ACTOR = "evolution";
export const EVOLUTION_PREFLIGHT_ACTION = "preflight";
export const EVOLUTION_EXPAND_ACTION = "dataset-expand";
export const EVOLUTION_GATE_ACTION = "gate-decision";
export const EVOLUTION_RUN_ACTION = "run";
export const EVOLUTION_CANCEL_ACTION = "run-cancel";
export const EVOLUTION_PROMOTE_ACTION = "artifact-promote";
export const MIN_HOLDOUT_COUNT = 10;
export const DEFAULT_EVOLUTION_DEPENDENCIES = ["dspy", "gepa", "optuna"] as const;

export type EvolutionCheckId = "dependencies" | "endpoint" | "dataset" | "snapshot" | "hermes";
export type EvolutionRunStatus =
  | "diagnosing"
  | "rejected-preflight"
  | "preflight-failed"
  | "ready"
  | "running"
  | "evaluating"
  | "accepted"
  | "kept-baseline"
  | "rejected-regression"
  | "promoted"
  | "cancelled"
  | "failed";

export type EvolutionTargetType = "skill" | "prompt" | "config";
export type EvolutionEndpointCategory =
  | "ok"
  | "credentials"
  | "configuration"
  | "rate-limit"
  | "upstream"
  | "network"
  | "unknown";

export interface EvolutionEndpointHealth {
  status: "pass" | "fail" | "unknown";
  category: EvolutionEndpointCategory;
  detail: string;
  checkedAt: string | null;
}

export interface EvolutionRecommendation {
  id: string;
  targetType: EvolutionTargetType | "version-upgrade" | "diagnostic";
  targetRef: string;
  confidence: number;
  window: { sources: number; lines: number; occurrences: number };
  sources: string[];
  examples: string[];
  blocked: boolean;
  nextAction: "create-run" | "open-prompt-optimization" | "open-version-upgrade" | "fix-config" | "inspect";
  title: string;
  detail: string;
}

export interface EvolutionDiagnosis {
  analyzedAt: string;
  issues: LogIssueView[];
  recommendations: EvolutionRecommendation[];
}

export interface EvolutionRunCreateInput {
  targetType: EvolutionTargetType;
  targetRef: string;
  instanceId?: string;
  holdoutCount?: number;
  endpoint?: string;
  datasetPath?: string;
  iterations?: number;
  dryRun?: boolean;
}

export interface EvolutionRunView {
  runId: string;
  targetType: EvolutionTargetType;
  targetRef: string;
  status: EvolutionRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  commandSummary?: string;
  stdoutPath?: string;
  stderrPath?: string;
  artifacts?: {
    baselinePath?: string;
    candidatePath?: string;
    metricsPath?: string;
    diff?: string;
  };
  metrics?: EvolutionMetrics;
  checks: EvolutionCheck[];
  blocked: boolean;
  detail: string;
  logTail: { stdout: string[]; stderr: string[] };
  writeAuthority?: EvolutionWriteAuthority;
}

export interface EvolutionMetrics {
  baselineQuality?: number;
  candidateQuality?: number;
  qualityDelta?: number;
  holdoutCount?: number;
  elapsedSeconds?: number;
  successRate?: number;
  failureRate?: number;
  confidence?: number | null;
  constraintsPassed?: boolean;
  structureGate?: "pass" | "fail" | "unknown";
  safetyGate?: "pass" | "fail" | "unknown";
  tokenCount?: number;
  cost?: number;
}

export interface EvolutionCheck {
  id: EvolutionCheckId;
  label: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
  action?: string;
}

export interface EvolutionPreflightInput {
  instanceId?: string;
  dependencies?: string[];
  endpoint?: string;
  holdoutCount: number;
  datasetPath?: string;
  config?: Record<string, unknown>;
  errors?: string[];
  rootCause?: string;
  fixes?: string[];
}

export interface EvolutionPreflightOutcome {
  runId: string;
  status: "rejected-preflight" | "ready";
  allowRun: boolean;
  instanceId: string | null;
  checks: EvolutionCheck[];
  snapshotId?: string;
  ledgerPath: string;
  nextAction?: {
    kind: "expand-dataset";
    targetCount: number;
    endpoint: string;
  };
}

export interface EvolutionExpandInput {
  runId: string;
  holdoutCount: number;
  targetCount?: number;
  datasetPath?: string;
  seedExamples?: unknown[];
}

export interface EvolutionExpandOutcome {
  status: "ready" | "error";
  error?: "run-not-found" | "no-seed-examples" | "dataset-path-not-allowed" | "dataset-unreadable";
  beforeCount: number;
  afterCount: number;
  syntheticCount: number;
  datasetPath: string;
  recheck: EvolutionPreflightOutcome;
}

export interface EvolutionResultInput {
  runId: string;
  baselineMetric: number;
  candidateMetric: number;
  /** 显著性由外部进化引擎/评估器提供；V1 不自行实现统计检验。 */
  significant: boolean;
  errors?: string[];
  rootCause?: string;
  fixes?: string[];
  /** 可选：外部引擎产物与当前 baseline 的受控路径。 */
  targetPath?: string;
  candidatePath?: string;
}

export interface EvolutionEvaluateInput {
  runId: string;
}

export type EvolutionEvaluateOutcome =
  | ({ status: "accepted" | "kept-baseline" | "rejected-regression"; sampleCount: number; confidence: number | null; baselineMetric: number; candidateMetric: number; delta: number; canPromote: boolean; report: Record<string, unknown> } & EvolutionGateOutcome)
  | { status: "error"; error: "run-not-found" | "run-not-ready" | "evaluator-not-configured" | "evaluator-unreachable" | "invalid-evaluator-response"; detail: string; allowWrite: false; baselinePreserved: true; delta: null; ledgerPath: string | null };

export interface EvolutionWriteAuthority {
  token: string;
  runId: string;
  instanceId: string;
  targetPath: string;
  candidatePath: string;
  baselineSha256: string;
  candidateSha256: string;
  issuedAt: string;
}

export interface EvolutionPromoteInput {
  runId: string;
  token: string;
  targetPath?: string;
  candidatePath?: string;
}

export type EvolutionPromoteOutcome =
  | {
      status: "promoted";
      runId: string;
      targetPath: string;
      candidatePath: string;
      baselineSha256: string;
      candidateSha256: string;
      ledgerPath: string;
    }
  | {
      status: "error";
      error:
        | "invalid-input"
        | "run-not-found"
        | "authority-not-found"
        | "authority-used"
        | "path-not-allowed"
        | "target-changed"
        | "candidate-tampered"
        | "write-failed";
      detail: string;
      ledgerPath: string | null;
    };

export interface EvolutionGateOutcome {
  status: EvolutionRunStatus | "error";
  error?: "run-not-found" | "run-not-ready" | "invalid-metrics";
  allowWrite: boolean;
  baselinePreserved: boolean;
  delta: number | null;
  ledgerPath: string | null;
  writeAuthority?: EvolutionWriteAuthority;
}

export interface EvolutionLedgerEntry {
  runId: string;
  createdAt: string;
  updatedAt: string;
  instanceId: string | null;
  status: EvolutionRunStatus;
  holdoutCount: number;
  dependencies: string[];
  endpoint: string;
  datasetPath?: string;
  config: Record<string, unknown>;
  checks: EvolutionCheck[];
  snapshotId?: string;
  baselineMetric?: number;
  candidateMetric?: number;
  delta?: number;
  significant?: boolean;
  errors: string[];
  rootCause: string;
  fixes: string[];
  conclusion: string;
  disposition: string;
  writeAuthorityIssuedAt?: string;
  promotedAt?: string;
  promotedTargetPath?: string;
  targetType?: EvolutionTargetType;
  targetRef?: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  commandSummary?: string;
  stdoutPath?: string;
  stderrPath?: string;
  remoteRunDir?: string;
  targetPath?: string;
  candidatePath?: string;
  baselinePath?: string;
  metricsPath?: string;
  candidateDiff?: string;
  runDetail?: string;
  dryRun?: boolean;
  metrics?: EvolutionMetrics;
}

export interface EvolutionLedgerSummary {
  runId: string;
  updatedAt: string;
  instanceId: string | null;
  status: EvolutionRunStatus;
  holdoutCount: number;
  baselineMetric?: number;
  candidateMetric?: number;
  delta?: number;
  conclusion: string;
  disposition: string;
}

export interface EvolutionStatusView {
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: EvolutionLedgerSummary[];
  hermes: {
    status: "ready" | "unavailable" | "unknown";
    root: string | null;
    detail: string;
  };
  endpointHealth: EvolutionEndpointHealth;
  blocked: Array<{ category: EvolutionEndpointCategory; detail: string; affectedRuns: string[] }>;
  tasks: EvolutionRunView[];
  history: EvolutionMetrics[];
}

export interface EvolutionService {
  status(): EvolutionStatusView;
  diagnose(input?: { issues?: LogIssueView[]; scannedSources?: number; scannedLines?: number }): EvolutionDiagnosis;
  createRun(input: EvolutionRunCreateInput): Promise<EvolutionRunView>;
  getRun(runId: string): Promise<EvolutionRunView | null>;
  startRun(runId: string): Promise<EvolutionRunView | { status: "error"; error: string; detail: string }>;
  evaluateRun(runId: string): Promise<EvolutionEvaluateOutcome>;
  promoteRun(input: EvolutionPromoteInput): Promise<EvolutionPromoteOutcome>;
  cancelRun(runId: string): Promise<EvolutionRunView | { status: "error"; error: string; detail: string }>;
  preflight(input: EvolutionPreflightInput): Promise<EvolutionPreflightOutcome>;
  expandDataset(input: EvolutionExpandInput): Promise<EvolutionExpandOutcome>;
  recordResult(input: EvolutionResultInput): Promise<EvolutionGateOutcome>;
  evaluate(input: EvolutionEvaluateInput): Promise<EvolutionEvaluateOutcome>;
  promoteArtifact(input: EvolutionPromoteInput): EvolutionPromoteOutcome;
  exportLedger(runId: string): { filename: string; markdown: string } | null;
}

export interface EvolutionServiceDeps {
  core: Core;
  control: Pick<ControlAdapter, "snapshot">;
  exec: CommandExecutor;
  fetchFn?: FetchLike;
  poster: AlertPoster;
  defaultEndpoint?: string;
  llm?: { baseUrl?: string; apiKey?: string; model?: string };
  /** WSL 中的 ~/.hermes；Windows 宿主也通过 runtime executor 访问它。 */
  hermesRoot?: string;
  /** Hermes self-evolution skill checkout；缺省为 <hermesRoot>/skills/hermes-agent-self-evolution。 */
  evolutionRoot?: string;
  /**
   * 命令执行器能直接访问 Hermes 文件系统时为 true：Windows 宿主经 wsl.exe，
   * 或 Docker-in-WSL / Linux 容器内的原生 shell。路径和落盘均交给该 shell。
   */
  useWsl?: boolean;
  /** 候选、日志和克隆后的进化引擎目录；必须位于 Butler 可写数据卷。 */
  runRoot?: string;
  runTimeoutMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
}

function safeRunId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveInstance(core: Core, instanceId?: string): InstanceRecord | undefined {
  if (instanceId !== undefined && instanceId !== "") return core.instances.getInstance(instanceId);
  const candidates = core.instances.listInstances().filter((item) => item.rootPath !== "");
  return candidates.find((item) => item.state === "Serving") ?? candidates[0];
}

function pathInside(candidate: string, allowedRoot: string): boolean {
  const rel = relative(resolve(allowedRoot), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function atomicReplace(path: string, content: Buffer | string): void {
  const temp = `${path}.butler-promote-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function labels(status: EvolutionRunStatus): { conclusion: string; disposition: string } {
  if (status === "diagnosing") return { conclusion: "正在诊断", disposition: "等待生成进化方向" };
  if (status === "ready") return { conclusion: "预检通过", disposition: "允许外部引擎开始进化" };
  if (status === "running") return { conclusion: "Hermes 正在进化", disposition: "候选写入隔离运行目录" };
  if (status === "evaluating") return { conclusion: "正在评估候选", disposition: "baseline 保持只读" };
  if (status === "accepted")
    return { conclusion: "显著提升", disposition: "允许引擎替换 baseline" };
  if (status === "kept-baseline") return { conclusion: "无显著提升", disposition: "baseline 保留" };
  if (status === "rejected-regression")
    return { conclusion: "负优化", disposition: "拒绝落盘 · baseline 保留" };
  if (status === "promoted") return { conclusion: "候选已采用", disposition: "已原子替换 baseline" };
  if (status === "cancelled") return { conclusion: "任务已取消", disposition: "baseline 保留" };
  if (status === "failed") return { conclusion: "运行失败", disposition: "baseline 保留，查看日志诊断" };
  if (status === "preflight-failed") return { conclusion: "预检失败", disposition: "仅阻断受影响任务" };
  return { conclusion: "预检拒绝", disposition: "不启动进化" };
}

function encodeEntry(entry: EvolutionLedgerEntry): string {
  return Buffer.from(JSON.stringify(entry), "utf8").toString("base64");
}

function decodeEntry(markdown: string): EvolutionLedgerEntry | null {
  const match = /<!-- agent-butler-evolution:([A-Za-z0-9+/=]+) -->/.exec(markdown);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as unknown;
    return isRecord(parsed) ? (parsed as unknown as EvolutionLedgerEntry) : null;
  } catch {
    return null;
  }
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderLedger(entry: EvolutionLedgerEntry): string {
  const metric =
    entry.baselineMetric !== undefined && entry.candidateMetric !== undefined
      ? `${entry.baselineMetric} → ${entry.candidateMetric}（${entry.delta! >= 0 ? "+" : ""}${entry.delta!.toFixed(6)}）`
      : "尚未提交运行结果";
  const checks =
    entry.checks.length === 0
      ? "| — | — | — |\n| — | — | — |"
      : [
          "| 检查 | 状态 | 详情 / 修复动作 |",
          "| --- | --- | --- |",
          ...entry.checks.map(
            (check) =>
              `| ${check.label} | ${check.status} | ${(check.detail + (check.action ? `；${check.action}` : "")).replace(/\|/g, "\\|")} |`,
          ),
        ].join("\n");
  const list = (items: string[]) =>
    items.length === 0 ? "- 无" : items.map((item) => `- ${item}`).join("\n");

  return [
    `<!-- agent-butler-evolution:${encodeEntry(entry)} -->`,
    `# 进化实验台账 · ${entry.runId}`,
    "",
    `- 创建时间：${entry.createdAt}`,
    `- 更新时间：${entry.updatedAt}`,
    `- 实例：${entry.instanceId ?? "未解析"}`,
    `- 状态：${entry.status}`,
    `- 结论：${entry.conclusion}`,
    `- 处置：${entry.disposition}`,
    "",
    "## 配置",
    "",
    fencedJson({
      dependencies: entry.dependencies,
      endpoint: entry.endpoint,
      holdoutCount: entry.holdoutCount,
      datasetPath: entry.datasetPath ?? null,
      ...entry.config,
    }),
    "",
    "## 运行前预检",
    "",
    checks,
    "",
    `- 运行前快照：${entry.snapshotId ?? "未创建"}`,
    "",
    "## 指标与守门结论",
    "",
    `- holdout：${metric}`,
    `- 显著性：${entry.significant === undefined ? "未提交" : entry.significant ? "显著" : "不显著"}`,
    `- 守门结论：${entry.conclusion}`,
    `- 最终处置：${entry.disposition}`,
    "",
    "## 错误",
    "",
    list(entry.errors),
    "",
    "## 根因",
    "",
    entry.rootCause || "未填写",
    "",
    "## 修复动作",
    "",
    list(entry.fixes),
    "",
  ].join("\n");
}

function readExamples(path: string): unknown[] {
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

function synthesizeMinimum(seed: unknown[], targetCount: number, generatedAt: string): unknown[] {
  const rows = [...seed];
  let variant = 1;
  while (rows.length < targetCount) {
    const sourceIndex = (rows.length - seed.length) % seed.length;
    const source = seed[sourceIndex];
    const metadata = {
      synthetic: true,
      sourceIndex,
      variant,
      generatedAt,
      method: "template-variation",
    };
    rows.push(
      isRecord(source)
        ? { ...source, _butlerSynthetic: metadata }
        : { value: source, _butlerSynthetic: metadata },
    );
    variant += 1;
  }
  return rows;
}

function shellQuote(value: string): string {
  // POSIX 单引号安全转义；所有 WSL 路径与 CLI 参数均经此函数进入 shell。
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeTargetRef(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(normalized) &&
    !normalized.includes("..") &&
    !normalized.startsWith("/")
    ? normalized
    : null;
}

function trimLog(value: string, limit = 120): string[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-limit)
    .map((line) => redactSecret(line).slice(0, 500));
}

function redactSecret(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]");
}

function readJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function chatCompletionUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function endpointCategory(status: number | null): EvolutionEndpointCategory {
  if (status === null) return "network";
  if (status === 401 || status === 403) return "credentials";
  if (status === 404) return "configuration";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "upstream";
  return status >= 200 && status < 300 ? "ok" : "unknown";
}

function endpointAction(category: EvolutionEndpointCategory): string {
  if (category === "credentials") return "检查 Hermes API Key 是否失效或权限不足后重试";
  if (category === "configuration") return "检查模型名、API Base URL 与 /chat/completions 路径";
  if (category === "rate-limit") return "等待限流窗口恢复或降低并发后重试";
  if (category === "upstream") return "上游服务异常，稍后重试并查看供应商状态";
  if (category === "network") return "检查 DNS、代理、证书和网络连通性";
  return "检查模型端点配置后重试";
}

function endpointDetail(host: string, status: number | null, category: EvolutionEndpointCategory): string {
  if (category === "ok") return `${host} 带鉴权补全探针通过${status === null ? "" : `（HTTP ${status}）`}`;
  if (category === "network") return `${host} 不可达`;
  return `${host} 补全探针返回 HTTP ${status ?? "未知"}（${category}）`;
}

export function createEvolutionService(deps: EvolutionServiceDeps): EvolutionService {
  const core = deps.core;
  const now = deps.now ?? Date.now;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 5000;
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const runTimeoutMs = deps.runTimeoutMs ?? 45 * 60_000;
  const hermesRoot = deps.hermesRoot?.trim() || null;
  const evolutionRoot = deps.evolutionRoot?.trim() ||
    (hermesRoot === null ? null : posix.join(hermesRoot.replaceAll("\\", "/"), "skills", "hermes-agent-self-evolution"));
  const hermesAgentRoot = hermesRoot === null ? null : posix.join(hermesRoot.replaceAll("\\", "/"), "hermes-agent");
  // 候选不能落在 Hermes checkout：生产容器将其挂为只读，baseline 也必须保持隔离。
  const runRoot = deps.runRoot?.trim() ||
    (hermesRoot === null ? null : posix.join(hermesRoot.replaceAll("\\", "/"), ".butler-evolution-runs"));
  // WSL venv 的 python 常是指向宿主绝对路径的符号链接；容器内需要映射到
  // 当前挂载点，随后所有 Hermes 探测与任务启动都复用同一解析结果。
  const pythonResolver = (): string => {
    if (hermesAgentRoot === null || hermesRoot === null) return "false";
    const primary = posix.join(hermesAgentRoot, "venv", "bin", "python3");
    const runtimeRoot = posix.join(hermesAgentRoot, ".hermes-runtime");
    const venvSite = posix.join(hermesAgentRoot, "venv", "lib", "python3.11", "site-packages");
    return [
      `python=${shellQuote(primary)}`,
      `if [ ! -x "$python" ]; then link=$(readlink "$python" 2>/dev/null || true); case "$link" in /home/*/.hermes/*) python=${shellQuote(hermesRoot)}"/\${link#*/.hermes/}";; esac; fi`,
      `if [ ! -x "$python" ]; then python=$(find ${shellQuote(runtimeRoot)} -type f -name 'python3.11' -perm -111 -print -quit 2>/dev/null || true); fi`,
      `test -x "$python"`,
      `if [ -n "\${PYTHONPATH:-}" ]; then export PYTHONPATH=${shellQuote(venvSite)}:"$PYTHONPATH"; else export PYTHONPATH=${shellQuote(venvSite)}; fi`,
    ].join("; ");
  };
  const activeTargets = new Map<string, string>();
  let endpointHealth: EvolutionEndpointHealth = {
    status: "unknown",
    category: "unknown",
    detail: "尚未执行带鉴权模型探针",
    checkedAt: null,
  };
  const ledgerDir = join(core.paths.ledgerDir, "evolution");
  const datasetDir = join(core.paths.home, "evolution", "datasets");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(datasetDir, { recursive: true });

  const entries = new Map<string, EvolutionLedgerEntry>();
  const authorities = new Map<string, EvolutionWriteAuthority>();
  const usedAuthorities = new Set<string>();
  for (const name of readdirSync(ledgerDir).filter((item) => item.endsWith(".md"))) {
    try {
      const parsed = decodeEntry(readFileSync(join(ledgerDir, name), "utf8"));
      if (parsed !== null) entries.set(parsed.runId, parsed);
    } catch {
      // 单个损坏台账不阻断服务启动；导出时自然不可见。
    }
  }

  for (const entry of entries.values()) {
    if (entry.status === "running" && entry.targetType !== undefined && entry.targetRef !== undefined) {
      activeTargets.set(`${entry.targetType}:${entry.targetRef}`, entry.runId);
    }
  }

  const ledgerPathOf = (runId: string): string => join(ledgerDir, `${safeRunId(runId)}.md`);
  const persist = (entry: EvolutionLedgerEntry): string => {
    const path = ledgerPathOf(entry.runId);
    writeFileSync(path, renderLedger(entry), "utf8");
    entries.set(entry.runId, entry);
    return path;
  };

  async function checkDependencies(
    record: InstanceRecord | undefined,
    dependencies: string[],
  ): Promise<EvolutionCheck> {
    if (deps.useWsl && hermesAgentRoot !== null) {
      const script =
        "import importlib.util,json,sys; print(json.dumps({n: importlib.util.find_spec(n) is not None for n in sys.argv[1:]}))";
      const result = await deps.exec.exec(
        "sh",
        [
          "-lc",
          `${pythonResolver()} && "$python" -c ${shellQuote(script)} ${dependencies.map(shellQuote).join(" ")}`,
        ],
        { timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        return {
          id: "dependencies",
          label: "技能依赖",
          status: "fail",
          detail: redactSecret(result.stderr.trim() || `WSL Hermes venv 依赖探测退出码 ${result.code}`),
          action: "前往版本升级页检查 Hermes venv 与依赖版本；Butler 不会自动安装依赖",
        };
      }
      try {
        const found = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        const missing = dependencies.filter((name) => found[name] !== true);
        return missing.length === 0
          ? {
              id: "dependencies",
              label: "技能依赖",
              status: "pass",
              detail: `${dependencies.join(" · ")} 均存在于 WSL Hermes venv`,
            }
          : {
              id: "dependencies",
              label: "技能依赖",
              status: "fail",
              detail: `WSL Hermes venv 缺少：${missing.join("、")}`,
              action: "前往版本升级页处理依赖缺失；Butler 不会自动安装依赖",
            };
      } catch {
        return {
          id: "dependencies",
          label: "技能依赖",
          status: "fail",
          detail: "WSL Hermes venv 依赖探测返回无法解析",
          action: "检查 Hermes Python 环境后重试",
        };
      }
    }
    if (record === undefined || record.rootPath === "") {
      return {
        id: "dependencies",
        label: "技能依赖",
        status: "fail",
        detail: "未找到可用实例，无法定位进化 venv",
        action: "先在健康大盘确认 Hermes 实例",
      };
    }
    const pythonRel = findVenvPython(record.rootPath);
    if (pythonRel === null) {
      return {
        id: "dependencies",
        label: "技能依赖",
        status: "fail",
        detail: "未找到实例 venv Python",
        action: "修复或重新创建 Hermes venv 后重检",
      };
    }
    if (dependencies.length === 0) {
      return { id: "dependencies", label: "技能依赖", status: "pass", detail: "未声明额外依赖" };
    }
    const script =
      "import importlib.util,json,sys; print(json.dumps({n: importlib.util.find_spec(n) is not None for n in sys.argv[1:]}))";
    const result = await deps.exec.exec(
      join(record.rootPath, pythonRel),
      ["-c", script, ...dependencies],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0) {
      return {
        id: "dependencies",
        label: "技能依赖",
        status: "fail",
        detail: result.stderr.trim() || `venv 依赖探测退出码 ${result.code}`,
        action: "在实例 venv 中检查 Python 与依赖安装状态",
      };
    }
    try {
      const found = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      const missing = dependencies.filter((name) => found[name] !== true);
      return missing.length === 0
        ? {
            id: "dependencies",
            label: "技能依赖",
            status: "pass",
            detail: `${dependencies.join(" · ")} 均存在于 venv`,
          }
        : {
            id: "dependencies",
            label: "技能依赖",
            status: "fail",
            detail: `venv 缺少：${missing.join("、")}`,
            action: `在实例 venv 安装 ${missing.join(" ")} 后重检`,
          };
    } catch {
      return {
        id: "dependencies",
        label: "技能依赖",
        status: "fail",
        detail: "venv 依赖探测返回无法解析",
        action: "检查 venv Python 是否可正常执行 importlib",
      };
    }
  }

  async function readHermesLlmConfig(): Promise<{ baseUrl?: string; apiKey?: string; model?: string; provider?: string }> {
    const explicit = {
      ...(deps.llm?.baseUrl?.trim() ? { baseUrl: deps.llm.baseUrl.trim() } : {}),
      ...(deps.llm?.apiKey?.trim() ? { apiKey: deps.llm.apiKey.trim() } : {}),
      ...(deps.llm?.model?.trim() ? { model: deps.llm.model.trim() } : {}),
    };
    if (hermesRoot === null) return explicit;
    // Key 只在进程内短暂用于探针，绝不写入台账、审计、告警或 HTTP 响应。
    const script = [
      "import json, os, re",
      "from pathlib import Path",
      "root = Path(" + JSON.stringify(hermesRoot) + ")",
      "env_values = {}",
      "for path in (root / '.env',):",
      "  try:",
      "    for raw in path.read_text(errors='ignore').splitlines():",
      "      line = raw.strip()",
      "      if not line or line.startswith('#') or '=' not in line: continue",
      "      key, value = line.split('=', 1)",
      "      key = key.strip().upper().replace('-', '_')",
      "      value = value.strip().strip(\"'\\\"\")",
      "      value = re.sub(r'\\$\\{([^}]+)\\}', lambda m: os.getenv(m.group(1), env_values.get(m.group(1), '')), value)",
      "      env_values.setdefault(key, value)",
      "  except OSError: pass",
      "config = {}",
      "try:",
      "  import yaml",
      "  parsed = yaml.safe_load((root / 'config.yaml').read_text(errors='ignore')) or {}",
      "  if isinstance(parsed, dict): config = parsed",
      "except Exception: pass",
      "model_cfg = config.get('model') if isinstance(config.get('model'), dict) else {}",
      "provider = str(model_cfg.get('provider') or '').strip()",
      "model = str(model_cfg.get('default') or model_cfg.get('model') or '').strip()",
      "base = str(model_cfg.get('base_url') or model_cfg.get('baseUrl') or '').strip()",
      "custom = config.get('custom_providers') if isinstance(config.get('custom_providers'), list) else []",
      "for item in custom:",
      "  if not isinstance(item, dict): continue",
      "  item_provider = str(item.get('provider') or item.get('name') or '').strip()",
      "  item_model = str(item.get('model') or '').strip()",
      "  if (provider and item_provider.lower() == provider.lower()) or (model and item_model == model):",
      "    base = base or str(item.get('base_url') or '').strip()",
      "    model = model or item_model",
      "    break",
      "merged = {**env_values, **os.environ}",
      "prefix = re.sub(r'[^A-Za-z0-9]+', '_', provider).strip('_').upper()",
      "base_candidates = ([base] if base else []) + ([merged.get(prefix + '_BASE_URL')] if prefix else []) + [merged.get('OPENAI_BASE_URL'), merged.get('LLM_BASE_URL')]",
      "key_candidates = ([str(model_cfg.get('api_key')).strip()] if model_cfg.get('api_key') else []) + ([merged.get(prefix + '_API_KEY')] if prefix else []) + [merged.get('OPENAI_API_KEY'), merged.get('DEEPSEEK_API_KEY'), merged.get('XIAOMI_API_KEY'), merged.get('OPENROUTER_API_KEY'), merged.get('LLM_API_KEY')]",
      "base = next((str(v).strip() for v in base_candidates if isinstance(v, str) and str(v).strip()), None)",
      "key = next((str(v).strip() for v in key_candidates if isinstance(v, str) and str(v).strip()), None)",
      "model = model or next((str(merged.get(k)).strip() for k in ('BUTLER_LLM_MODEL', 'LLM_MODEL') if merged.get(k)), None)",
      "overrides = os.environ",
      "base = overrides.get('BUTLER_LLM_BASE_URL') or base",
      "key = overrides.get('BUTLER_LLM_API_KEY') or key",
      "model = overrides.get('BUTLER_LLM_MODEL') or model",
      "print(json.dumps({'baseUrl': base or None, 'apiKey': key or None, 'model': model or None, 'provider': provider or None}))",
    ].join("\\n");
    const result = await deps.exec.exec("sh", ["-lc", `${pythonResolver()} && "$python" -c ${shellQuote(script)}`], { timeoutMs: 8_000 });
    if (result.code !== 0) return explicit;
    const parsed = readJson<{ baseUrl?: unknown; apiKey?: unknown; model?: unknown; provider?: unknown }>(result.stdout.trim());
    if (parsed === null) return explicit;
    return {
      ...(typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? { baseUrl: parsed.baseUrl.trim() } : {}),
      ...(typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? { apiKey: parsed.apiKey.trim() } : {}),
      ...(typeof parsed.model === "string" && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
      ...(typeof parsed.provider === "string" && parsed.provider.trim() ? { provider: parsed.provider.trim() } : {}),
      ...explicit,
    };
  }

  async function checkEndpoint(
    endpointInput: string,
    configOverride?: { baseUrl?: string; apiKey?: string; model?: string },
  ): Promise<EvolutionCheck> {
    const hermesConfig = configOverride ?? (await readHermesLlmConfig());
    const endpoint = endpointInput || hermesConfig.baseUrl || "";
    if (endpoint === "") {
      endpointHealth = {
        status: "fail",
        category: "configuration",
        detail: "未在 Hermes 配置或 BUTLER_LLM_BASE_URL 中找到模型端点",
        checkedAt: new Date(now()).toISOString(),
      };
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: endpointHealth.detail,
        action: "修复 Hermes config.yaml/.env 中的模型端点后重检",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("bad protocol");
    } catch {
      endpointHealth = {
        status: "fail",
        category: "configuration",
        detail: "端点 URL 无效",
        checkedAt: new Date(now()).toISOString(),
      };
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: "端点 URL 无效",
        action: "改为 http(s) URL",
      };
    }
    if (!hermesConfig.apiKey) {
      endpointHealth = {
        status: "fail",
        category: "credentials",
        detail: `${parsed.host} 未找到可用 API Key`,
        checkedAt: new Date(now()).toISOString(),
      };
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: endpointHealth.detail,
        action: endpointAction("credentials"),
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetchFn(chatCompletionUrl(parsed.toString()), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hermesConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: hermesConfig.model ?? "gpt-4.1-mini",
          messages: [{ role: "user", content: "health check" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      const category = endpointCategory(response.status);
      endpointHealth = {
        status: category === "ok" ? "pass" : "fail",
        category,
        detail: endpointDetail(parsed.host, response.status, category),
        checkedAt: new Date(now()).toISOString(),
      };
      return category === "ok"
        ? { id: "endpoint", label: "模型端点", status: "pass", detail: endpointHealth.detail }
        : {
            id: "endpoint",
            label: "模型端点",
            status: "fail",
            detail: endpointHealth.detail,
            action: endpointAction(category),
          };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      endpointHealth = {
        status: "fail",
        category: "network",
        detail: `${parsed.host} 补全探针异常：${detail}`,
        checkedAt: new Date(now()).toISOString(),
      };
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: endpointHealth.detail,
        action: endpointAction("network"),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function checkDataset(holdoutCount: number): EvolutionCheck {
    return holdoutCount >= MIN_HOLDOUT_COUNT
      ? {
          id: "dataset",
          label: "评估集规模",
          status: "pass",
          detail: `holdout ${holdoutCount} 条（门槛 ≥ ${MIN_HOLDOUT_COUNT}）`,
        }
      : {
          id: "dataset",
          label: "评估集规模",
          status: "fail",
          detail: `holdout 仅 ${holdoutCount} 条，低于门槛 ${MIN_HOLDOUT_COUNT}`,
          action: `使用最小扩集工具补齐到 ${MIN_HOLDOUT_COUNT} 条后自动重检`,
        };
  }

  async function runPreflight(
    input: EvolutionPreflightInput,
    existingRunId?: string,
  ): Promise<EvolutionPreflightOutcome> {
    const runId = existingRunId ?? randomUUID();
    const timestamp = new Date(now()).toISOString();
    const previous = entries.get(runId);
    const dependencies = [
      ...new Set(
        (input.dependencies ?? [...DEFAULT_EVOLUTION_DEPENDENCIES])
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    const hermesLlm = await readHermesLlmConfig();
    const endpoint = (input.endpoint ?? hermesLlm.baseUrl ?? deps.defaultEndpoint ?? "").trim();
    const holdoutCount =
      Number.isInteger(input.holdoutCount) && input.holdoutCount >= 0 ? input.holdoutCount : 0;
    const record = resolveInstance(core, input.instanceId);

    const [dependencyCheck, endpointCheck] = await Promise.all([
      checkDependencies(record, dependencies),
      checkEndpoint(endpoint, hermesLlm),
    ]);
    const datasetCheck = checkDataset(holdoutCount);
    const checks: EvolutionCheck[] = [dependencyCheck, endpointCheck, datasetCheck];
    const prechecksPassed = checks.every((check) => check.status === "pass");
    let snapshotId: string | undefined;

    if (prechecksPassed && record !== undefined) {
      // 只接受本次 snapshot 调用新登记的行，避免历史同标签快照掩盖
      // 当前调用未登记或登记失败的情况。
      const snapshotRowsBefore = new Set(
        core.store.listSnapshots(record.instanceId).map((row) => row.id),
      );
      const ref: InstanceRef = {
        instanceId: record.instanceId,
        rootPath: record.rootPath,
        runtime: record.runtime,
      };
      const snapshot = await deps.control.snapshot(ref, {
        include: ["skills", "memory"],
        label: "pre-evolution",
      });
      const failedStep = snapshot.data?.steps.find(
        (step) =>
          step.status === "failed" || (step.id.startsWith("copy-") && step.status !== "passed"),
      );
      const registered = core.store
        .listSnapshots(record.instanceId)
        .find(
          (row) =>
            !snapshotRowsBefore.has(row.id) &&
            row.label === "pre-evolution" &&
            row.status === "ok",
        );
      const scope = registered?.scope;
      if (
        snapshot.ok &&
        snapshot.data !== undefined &&
        failedStep === undefined &&
        isRecord(scope) &&
        typeof scope["snapshotId"] === "string"
      ) {
        snapshotId = scope["snapshotId"];
        checks.push({
          id: "snapshot",
          label: "运行前快照",
          status: "pass",
          detail: `技能库 + 记忆库 · ${snapshotId}`,
        });
      } else {
        checks.push({
          id: "snapshot",
          label: "运行前快照",
          status: "fail",
          detail:
            failedStep?.detail ??
            snapshot.error?.userHint ??
            snapshot.error?.message ??
            "快照结果缺少登记信息",
          action: "确认 skills/ 与 memory_store.db 可读、快照目录可写后重检",
        });
      }
    } else {
      checks.push({
        id: "snapshot",
        label: "运行前快照",
        status: "skipped",
        detail: "三项预检未全部通过，未触碰技能库与记忆库",
      });
    }

    const ready = checks.every((check) => check.status === "pass");
    const status: EvolutionPreflightOutcome["status"] = ready ? "ready" : "rejected-preflight";
    const label = labels(status);
    const entry: EvolutionLedgerEntry = {
      runId,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      instanceId: record?.instanceId ?? input.instanceId ?? null,
      status,
      holdoutCount,
      dependencies,
      endpoint,
      config: input.config ?? previous?.config ?? {},
      checks,
      errors: input.errors ?? previous?.errors ?? [],
      rootCause: input.rootCause ?? previous?.rootCause ?? "",
      fixes: input.fixes ?? previous?.fixes ?? [],
      conclusion: label.conclusion,
      disposition: label.disposition,
    };
    const datasetPath = input.datasetPath ?? previous?.datasetPath;
    if (datasetPath !== undefined && datasetPath !== "") entry.datasetPath = datasetPath;
    if (snapshotId !== undefined) entry.snapshotId = snapshotId;
    const ledgerPath = persist(entry);
    const nextAction =
      holdoutCount < MIN_HOLDOUT_COUNT
        ? {
            kind: "expand-dataset" as const,
            targetCount: MIN_HOLDOUT_COUNT,
            endpoint: `/api/evolution/runs/${runId}/expand`,
          }
        : undefined;

    core.audit.append({
      actor: EVOLUTION_ACTOR,
      action: EVOLUTION_PREFLIGHT_ACTION,
      target: record?.instanceId ?? input.instanceId ?? "",
      detail: { runId, status, holdoutCount, checks },
    });
    return {
      runId,
      status,
      allowRun: ready,
      instanceId: record?.instanceId ?? input.instanceId ?? null,
      checks,
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ledgerPath,
      ...(nextAction !== undefined ? { nextAction } : {}),
    };
  }

  async function expandDataset(input: EvolutionExpandInput): Promise<EvolutionExpandOutcome> {
    const entry = entries.get(input.runId);
    const fallbackRecheck: EvolutionPreflightOutcome = {
      runId: input.runId,
      status: "rejected-preflight",
      allowRun: false,
      instanceId: entry?.instanceId ?? null,
      checks: entry?.checks ?? [],
      ledgerPath: entry === undefined ? "" : ledgerPathOf(entry.runId),
    };
    const fail = (error: EvolutionExpandOutcome["error"]): EvolutionExpandOutcome => ({
      status: "error",
      error,
      beforeCount: input.holdoutCount,
      afterCount: input.holdoutCount,
      syntheticCount: 0,
      datasetPath: "",
      recheck: fallbackRecheck,
    });
    if (entry === undefined) return fail("run-not-found");

    const record = resolveInstance(core, entry.instanceId ?? undefined);
    let seed = input.seedExamples ?? [];
    const requestedPath = input.datasetPath ?? entry.datasetPath;
    if (seed.length === 0 && requestedPath !== undefined) {
      if (record === undefined || !pathInside(requestedPath, record.rootPath))
        return fail("dataset-path-not-allowed");
      try {
        seed = readExamples(requestedPath);
      } catch {
        return fail("dataset-unreadable");
      }
    }
    if (seed.length === 0) return fail("no-seed-examples");

    const targetCount = Math.max(
      MIN_HOLDOUT_COUNT,
      Math.floor(input.targetCount ?? MIN_HOLDOUT_COUNT),
    );
    const effectiveSeed = seed.slice(
      0,
      Math.max(1, Math.min(seed.length, input.holdoutCount || seed.length)),
    );
    const rows = synthesizeMinimum(effectiveSeed, targetCount, new Date(now()).toISOString());
    const outputPath = join(datasetDir, `${safeRunId(input.runId)}-expanded.jsonl`);
    writeFileSync(outputPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const fix = `最小扩集：${input.holdoutCount} → ${rows.length}（${rows.length - effectiveSeed.length} 条 template-variation 合成样本）`;
    const recheck = await runPreflight(
      {
        instanceId: entry.instanceId ?? undefined,
        dependencies: entry.dependencies,
        endpoint: entry.endpoint,
        holdoutCount: rows.length,
        datasetPath: outputPath,
        config: entry.config,
        errors: entry.errors,
        rootCause: entry.rootCause,
        fixes: [...entry.fixes, fix],
      },
      entry.runId,
    );
    core.audit.append({
      actor: EVOLUTION_ACTOR,
      action: EVOLUTION_EXPAND_ACTION,
      target: entry.instanceId ?? "",
      detail: {
        runId: entry.runId,
        beforeCount: input.holdoutCount,
        afterCount: rows.length,
        outputPath,
      },
    });
    return {
      status: recheck.allowRun ? "ready" : "error",
      beforeCount: input.holdoutCount,
      afterCount: rows.length,
      syntheticCount: rows.length - effectiveSeed.length,
      datasetPath: outputPath,
      recheck,
    };
  }

  async function recordResult(input: EvolutionResultInput): Promise<EvolutionGateOutcome> {
    const entry = entries.get(input.runId);
    const error = (kind: EvolutionGateOutcome["error"]): EvolutionGateOutcome => ({
      status: "error",
      error: kind,
      allowWrite: false,
      baselinePreserved: true,
      delta: null,
      ledgerPath: entry === undefined ? null : ledgerPathOf(entry.runId),
    });
    if (entry === undefined) return error("run-not-found");
    if (entry.status !== "ready") return error("run-not-ready");
    if (!Number.isFinite(input.baselineMetric) || !Number.isFinite(input.candidateMetric))
      return error("invalid-metrics");

    const delta = input.candidateMetric - input.baselineMetric;
    const status: EvolutionRunStatus =
      delta < 0
        ? "rejected-regression"
        : delta > 0 && input.significant
          ? "accepted"
          : "kept-baseline";
    const label = labels(status);
    const updated: EvolutionLedgerEntry = {
      ...entry,
      updatedAt: new Date(now()).toISOString(),
      status,
      baselineMetric: input.baselineMetric,
      candidateMetric: input.candidateMetric,
      delta,
      significant: input.significant,
      errors: input.errors ?? entry.errors,
      rootCause: input.rootCause ?? entry.rootCause,
      fixes: input.fixes ?? entry.fixes,
      conclusion: label.conclusion,
      disposition: label.disposition,
    };
    const ledgerPath = persist(updated);
    if (status === "rejected-regression") {
      await deps.poster.post({
        kind: "evolution-regression",
        severity: "critical",
        title: `进化负优化已拦截：${input.baselineMetric} → ${input.candidateMetric}`,
        body: `运行 ${input.runId} 指标回落 ${delta.toFixed(6)}。候选产物不允许落盘，baseline 已保留；建议回看评估集与错误根因。`,
        source: "butler-watch",
        dedupeKey: `evolution-regression:${input.runId}`,
      });
    }
    core.audit.append({
      actor: EVOLUTION_ACTOR,
      action: EVOLUTION_GATE_ACTION,
      target: entry.instanceId ?? "",
      detail: {
        runId: input.runId,
        status,
        baselineMetric: input.baselineMetric,
        candidateMetric: input.candidateMetric,
        delta,
        writeAuthorized: false,
        writeAuthority: status === "accepted" ? "one-time-artifact-token" : "none",
      },
    });
    let writeAuthority: EvolutionWriteAuthority | undefined;
    if (status === "accepted" && input.targetPath !== undefined && input.candidatePath !== undefined) {
      const record = resolveInstance(core, entry.instanceId ?? undefined);
      const skillsRoot = record === undefined ? "" : join(record.rootPath, "skills");
      const targetPath = resolve(input.targetPath);
      const candidatePath = resolve(input.candidatePath);
      if (
        record !== undefined &&
        pathInside(targetPath, skillsRoot) &&
        pathInside(candidatePath, skillsRoot) &&
        targetPath !== skillsRoot &&
        candidatePath !== skillsRoot &&
        targetPath !== candidatePath
      ) {
        try {
          const baselineSha256 = sha256File(targetPath);
          const candidateSha256 = sha256File(candidatePath);
          writeAuthority = {
            token: randomUUID(),
            runId: input.runId,
            instanceId: record.instanceId,
            targetPath,
            candidatePath,
            baselineSha256,
            candidateSha256,
            issuedAt: new Date(now()).toISOString(),
          };
          authorities.set(writeAuthority.token, writeAuthority);
          const authorityUpdated: EvolutionLedgerEntry = {
            ...updated,
            writeAuthorityIssuedAt: writeAuthority.issuedAt,
          };
          persist(authorityUpdated);
        } catch {
          // 候选路径未准备好时仍只保留台账，不签发任何写权限。
        }
      }
    }
    return {
      status,
      allowWrite: false,
      baselinePreserved: true,
      delta,
      ledgerPath,
      ...(writeAuthority !== undefined ? { writeAuthority } : {}),
    };
  }

  async function evaluate(input: EvolutionEvaluateInput): Promise<EvolutionEvaluateOutcome> {
    const entry = entries.get(input.runId);
    if (entry === undefined) return { status: "error", error: "run-not-found", detail: "运行不存在", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: null };
    if (entry.status !== "ready") return { status: "error", error: "run-not-ready", detail: "预检尚未通过，不能开始真实评估", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: ledgerPathOf(input.runId) };
    if (entry.endpoint === "") return { status: "error", error: "evaluator-not-configured", detail: "没有配置外部评估器地址", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: ledgerPathOf(input.runId) };
    const fetchFn = deps.fetchFn ?? ((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => fetch(url, init));
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchFn(entry.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: input.runId, datasetPath: entry.datasetPath ?? null, holdoutCount: entry.holdoutCount, mode: "paired-evaluation" }),
        signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? 20_000),
      });
    } catch (error) {
      return { status: "error", error: "evaluator-unreachable", detail: `评估器不可达：${error instanceof Error ? error.message : String(error)}`, allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: ledgerPathOf(input.runId) };
    }
    if (!response.ok) return { status: "error", error: "evaluator-unreachable", detail: `评估器返回 HTTP ${response.status}`, allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: ledgerPathOf(input.runId) };
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    if (!isRecord(payload) || typeof payload["baselineMetric"] !== "number" || typeof payload["candidateMetric"] !== "number") {
      return { status: "error", error: "invalid-evaluator-response", detail: "评估器响应缺少 baselineMetric/candidateMetric 数值", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: ledgerPathOf(input.runId) };
    }
    const baselineMetric = payload["baselineMetric"] as number;
    const candidateMetric = payload["candidateMetric"] as number;
    const significant = payload["significant"] === true || (typeof payload["confidence"] === "number" && payload["confidence"] >= 0.95);
    const gate = await recordResult({ runId: input.runId, baselineMetric, candidateMetric, significant });
    if (gate.status === "error") return { status: "error", error: "invalid-evaluator-response", detail: "评估结果未通过守门器", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: gate.ledgerPath };
    if (gate.status !== "accepted" && gate.status !== "kept-baseline" && gate.status !== "rejected-regression") {
      return { status: "error", error: "invalid-evaluator-response", detail: "评估结果状态不可识别", allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: gate.ledgerPath };
    }
    return {
      ...gate,
      status: gate.status,
      sampleCount: typeof payload["sampleCount"] === "number" ? payload["sampleCount"] : entry.holdoutCount,
      confidence: typeof payload["confidence"] === "number" ? payload["confidence"] : null,
      baselineMetric,
      candidateMetric,
      delta: gate.delta ?? candidateMetric - baselineMetric,
      canPromote: gate.status === "accepted" && gate.allowWrite,
      report: payload,
    };
  }

  function promoteArtifact(input: EvolutionPromoteInput): EvolutionPromoteOutcome {
    if (!isRecord(input) || typeof input.runId !== "string" || input.runId === "" ||
        typeof input.token !== "string" || input.token === "") {
      return {
        status: "error",
        error: "invalid-input",
        detail: "runId 与 token 必须是非空字符串",
        ledgerPath: null,
      };
    }
    const entry = entries.get(input.runId);
    if (entry === undefined) {
      return {
        status: "error",
        error: "run-not-found",
        detail: `运行不存在：${input.runId}`,
        ledgerPath: null,
      };
    }
    const authority = authorities.get(input.token);
    if (authority === undefined && usedAuthorities.has(input.token)) {
      return {
        status: "error",
        error: "authority-used",
        detail: "写入授权令牌只能使用一次",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    if (authority === undefined || authority.runId !== input.runId) {
      return {
        status: "error",
        error: "authority-not-found",
        detail: "写入授权令牌不存在、已过期或不属于该运行",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    const targetPath = resolve(input.targetPath ?? authority.targetPath);
    const candidatePath = resolve(input.candidatePath ?? authority.candidatePath);
    const record = resolveInstance(core, authority.instanceId);
    const skillsRoot = record === undefined ? "" : join(record.rootPath, "skills");
    if (
      record === undefined ||
      !pathInside(targetPath, skillsRoot) ||
      !pathInside(candidatePath, skillsRoot) ||
      targetPath === skillsRoot ||
      candidatePath === skillsRoot ||
      targetPath !== authority.targetPath ||
      candidatePath !== authority.candidatePath
    ) {
      return {
        status: "error",
        error: "path-not-allowed",
        detail: "目标与候选路径必须固定在同一实例 skills/ 根目录内",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    let previousContent: Buffer;
    let candidateContent: Buffer;
    try {
      previousContent = readFileSync(targetPath);
      candidateContent = readFileSync(candidatePath);
    } catch {
      return {
        status: "error",
        error: "candidate-tampered",
        detail: "目标或候选文件缺失、不可读",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    if (createHash("sha256").update(previousContent).digest("hex") !== authority.baselineSha256) {
      return {
        status: "error",
        error: "target-changed",
        detail: "baseline 文件已变化，请重新预检并评估",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    if (createHash("sha256").update(candidateContent).digest("hex") !== authority.candidateSha256) {
      return {
        status: "error",
        error: "candidate-tampered",
        detail: "候选文件 hash 与授权令牌不一致",
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
    try {
      atomicReplace(targetPath, candidateContent);
      const promotedAt = new Date(now()).toISOString();
      persist({
        ...entry,
        updatedAt: promotedAt,
        status: "promoted",
        promotedAt,
        promotedTargetPath: targetPath,
        runDetail: "用户已确认采用，候选已原子替换 baseline",
        ...labels("promoted"),
      });
      authorities.delete(input.token);
      usedAuthorities.add(input.token);
      core.audit.append({
        actor: EVOLUTION_ACTOR,
        action: "artifact-promote",
        target: authority.instanceId,
        detail: {
          runId: input.runId,
          targetPath,
          candidatePath,
          baselineSha256: authority.baselineSha256,
          candidateSha256: authority.candidateSha256,
        },
      });
      return {
        status: "promoted",
        runId: input.runId,
        targetPath,
        candidatePath,
        baselineSha256: authority.baselineSha256,
        candidateSha256: authority.candidateSha256,
        ledgerPath: ledgerPathOf(input.runId),
      };
    } catch (error) {
      try {
        atomicReplace(targetPath, previousContent);
      } catch {
        // 最佳努力恢复；错误仍以 fail-closed 返回，避免宣称已采用。
      }
      return {
        status: "error",
        error: "write-failed",
        detail: `候选替换或台账登记失败：${error instanceof Error ? error.message : String(error)}`,
        ledgerPath: ledgerPathOf(input.runId),
      };
    }
  }

  const runDirectory = (runId: string): string | null =>
    runRoot === null ? null : posix.join(runRoot, safeRunId(runId));

  const targetKeyOf = (type: EvolutionTargetType, ref: string): string => `${type}:${ref}`;

  function detailOf(entry: EvolutionLedgerEntry): string {
    if (entry.runDetail?.trim()) return entry.runDetail;
    return labels(entry.status).disposition;
  }

  function viewOf(
    entry: EvolutionLedgerEntry,
    logTail: EvolutionRunView["logTail"] = { stdout: [], stderr: [] },
  ): EvolutionRunView {
    const targetType = entry.targetType ?? "skill";
    const targetRef = entry.targetRef ?? "";
    const artifacts = {
      ...(entry.baselinePath ? { baselinePath: entry.baselinePath } : {}),
      ...(entry.candidatePath ? { candidatePath: entry.candidatePath } : {}),
      ...(entry.metricsPath ? { metricsPath: entry.metricsPath } : {}),
      ...(entry.candidateDiff ? { diff: entry.candidateDiff } : {}),
    };
    return {
      runId: entry.runId,
      targetType,
      targetRef,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(entry.commandSummary ? { commandSummary: entry.commandSummary } : {}),
      ...(entry.stdoutPath ? { stdoutPath: entry.stdoutPath } : {}),
      ...(entry.stderrPath ? { stderrPath: entry.stderrPath } : {}),
      ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(entry.metrics ? { metrics: entry.metrics } : {}),
      checks: entry.checks,
      blocked: entry.status === "preflight-failed" || entry.status === "rejected-preflight",
      detail: detailOf(entry),
      logTail,
    };
  }

  async function wsl(script: string, timeoutMs = 15_000) {
    return deps.exec.exec("sh", ["-lc", script], { timeoutMs });
  }

  async function readRemoteTail(entry: EvolutionLedgerEntry): Promise<EvolutionRunView["logTail"]> {
    if (!deps.useWsl || !entry.stdoutPath || !entry.stderrPath) return { stdout: [], stderr: [] };
    const read = async (path: string): Promise<string[]> => {
      const result = await wsl(`test -f ${shellQuote(path)} && tail -n 120 ${shellQuote(path)} || true`);
      return result.code === 0 ? trimLog(result.stdout) : [];
    };
    const [stdout, stderr] = await Promise.all([read(entry.stdoutPath), read(entry.stderrPath)]);
    return { stdout, stderr };
  }

  async function remoteJson(script: string): Promise<Record<string, unknown> | null> {
    const result = await wsl(`${pythonResolver()} && "$python" -c ${shellQuote(script)}`);
    if (result.code !== 0) return null;
    const parsed = readJson<unknown>(result.stdout.trim());
    return isRecord(parsed) ? parsed : null;
  }

  async function checkHermesWorkspace(
    targetRef: string,
    runId: string,
  ): Promise<
    | { ok: true; targetPath: string; runDir: string; baselinePath: string; stdoutPath: string; stderrPath: string }
    | { ok: false; detail: string }
  > {
    const runDir = runDirectory(runId);
    if (!deps.useWsl || evolutionRoot === null || hermesAgentRoot === null || hermesRoot === null || runDir === null) {
      return { ok: false, detail: "当前运行环境未提供可访问的 Hermes 自我进化工作区" };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}){0,7}$/.test(targetRef)) {
      return { ok: false, detail: "Hermes skill 名称只能包含字母、数字、点、下划线和连字符" };
    }
    const skillRoot = posix.join(hermesRoot, "skills");
    const engineRoot = posix.join(runDir, "engine");
    const result = await wsl(
      [
        "set -eu",
        `test -d ${shellQuote(evolutionRoot)}`,
        pythonResolver(),
        `target=$(find ${shellQuote(skillRoot)} -type f -name SKILL.md -path ${shellQuote(`*/${targetRef}/SKILL.md`)} -print -quit)`,
        'test -n "$target"',
        `mkdir -p ${shellQuote(runDir)}`,
        `cp -- "$target" ${shellQuote(posix.join(runDir, "baseline_skill.md"))}`,
        // Hermes CLI 使用相对 output/ 路径；克隆引擎副本确保候选只落在 run 目录。
        `test ! -e ${shellQuote(engineRoot)}`,
        `mkdir -p ${shellQuote(engineRoot)}`,
        `(cd ${shellQuote(evolutionRoot)} && find . -mindepth 1 -maxdepth 1 ! -name .git ! -name output -exec cp -a -- {} ${shellQuote(engineRoot)} \\;)`,
        'printf "%s\\n" "$target"',
      ].join("; "),
      20_000,
    );
    const targetPath = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (result.code !== 0 || !targetPath) {
      return {
        ok: false,
        detail: redactSecret(result.stderr.trim() || `未在 Hermes skills 中找到 ${targetRef}，或自我进化 venv 不可用`),
      };
    }
    return {
      ok: true,
      targetPath,
      runDir,
      baselinePath: posix.join(runDir, "baseline_skill.md"),
      stdoutPath: posix.join(runDir, "stdout.log"),
      stderrPath: posix.join(runDir, "stderr.log"),
    };
  }

  async function collectRunArtifacts(entry: EvolutionLedgerEntry): Promise<EvolutionLedgerEntry> {
    if (!deps.useWsl || !entry.remoteRunDir) return entry;
    const script = [
      "import difflib, json, shutil",
      "from pathlib import Path",
      `run = Path(${JSON.stringify(entry.remoteRunDir)})`,
      "outputs = sorted((run / 'engine' / 'output').glob('**/evolved_skill.md'), key=lambda p: p.stat().st_mtime)",
      "source_candidate = outputs[-1] if outputs else None",
      "candidate = source_candidate",
      "metrics = None",
      "if candidate:",
      "  local_candidate = run / 'evolved_skill.md'",
      "  shutil.copy2(candidate, local_candidate)",
      "  candidate = local_candidate",
      "  source_metrics = source_candidate.parent / 'metrics.json'",
      "  if source_metrics.is_file():",
      "    local_metrics = run / 'metrics.json'",
      "    shutil.copy2(source_metrics, local_metrics)",
      "    metrics = local_metrics",
      "  baseline = run / 'baseline_skill.md'",
      "  if baseline.is_file():",
      "    (run / 'candidate.diff').write_text(''.join(difflib.unified_diff(baseline.read_text(errors='ignore').splitlines(True), candidate.read_text(errors='ignore').splitlines(True), fromfile='baseline_skill.md', tofile='evolved_skill.md')))",
      "print(json.dumps({'candidatePath': str(candidate) if candidate else None, 'metricsPath': str(metrics) if metrics else None, 'diffPath': str(run / 'candidate.diff') if candidate else None}))",
    ].join("\n");
    const result = await remoteJson(script);
    if (result === null) return entry;
    const candidatePath = typeof result["candidatePath"] === "string" ? result["candidatePath"] : undefined;
    const metricsPath = typeof result["metricsPath"] === "string" ? result["metricsPath"] : undefined;
    const diffPath = typeof result["diffPath"] === "string" ? result["diffPath"] : undefined;
    let candidateDiff: string | undefined;
    if (diffPath) {
      const diffResult = await wsl(`test -f ${shellQuote(diffPath)} && sed -n '1,800p' ${shellQuote(diffPath)} || true`);
      candidateDiff = redactSecret(diffResult.stdout).slice(0, 60_000);
    }
    return {
      ...entry,
      ...(candidatePath ? { candidatePath } : {}),
      ...(metricsPath ? { metricsPath } : {}),
      ...(candidateDiff ? { candidateDiff } : {}),
    };
  }

  function metricsFrom(raw: Record<string, unknown>, holdoutFallback: number): EvolutionMetrics | null {
    const number = (keys: string[]): number | undefined => {
      for (const key of keys) if (typeof raw[key] === "number" && Number.isFinite(raw[key])) return raw[key] as number;
      return undefined;
    };
    const baselineQuality = number(["baseline_score", "baselineMetric", "baseline_quality"]);
    const candidateQuality = number(["evolved_score", "candidateMetric", "candidate_quality"]);
    const qualityDelta = number(["improvement", "delta"]) ??
      (baselineQuality !== undefined && candidateQuality !== undefined ? candidateQuality - baselineQuality : undefined);
    if (baselineQuality === undefined || candidateQuality === undefined || qualityDelta === undefined) return null;
    const holdoutCount = number(["holdout_examples", "holdoutCount", "sampleCount"]) ?? holdoutFallback;
    const successRate = number(["success_rate", "successRate"]);
    const failureRate = number(["failure_rate", "failureRate"]) ??
      (successRate === undefined ? undefined : Math.max(0, 1 - successRate));
    const constraintsPassed = raw["constraints_passed"] === undefined
      ? raw["constraintsPassed"] === undefined ? true : raw["constraintsPassed"] === true
      : raw["constraints_passed"] === true;
    return {
      baselineQuality,
      candidateQuality,
      qualityDelta,
      holdoutCount,
      ...(number(["elapsed_seconds", "elapsedSeconds"]) !== undefined ? { elapsedSeconds: number(["elapsed_seconds", "elapsedSeconds"]) } : {}),
      ...(successRate !== undefined ? { successRate } : {}),
      ...(failureRate !== undefined ? { failureRate } : {}),
      confidence: number(["confidence"] ) ?? null,
      constraintsPassed,
      structureGate: constraintsPassed ? "pass" : "fail",
      safetyGate: raw["safety_passed"] === false ? "fail" : "unknown",
      ...(number(["token_count", "tokenCount"]) !== undefined ? { tokenCount: number(["token_count", "tokenCount"]) } : {}),
      ...(number(["cost"]) !== undefined ? { cost: number(["cost"]) } : {}),
    };
  }

  async function readRunMetrics(entry: EvolutionLedgerEntry): Promise<EvolutionMetrics | null> {
    if (!deps.useWsl || !entry.metricsPath) return entry.metrics ?? null;
    const result = await wsl(`test -f ${shellQuote(entry.metricsPath)} && cat ${shellQuote(entry.metricsPath)} || true`);
    const parsed = readJson<unknown>(result.stdout);
    return isRecord(parsed) ? metricsFrom(parsed, entry.holdoutCount) : null;
  }

  async function refreshRun(entry: EvolutionLedgerEntry): Promise<EvolutionLedgerEntry> {
    if (entry.status !== "running" || !deps.useWsl || !entry.remoteRunDir) return entry;
    const state = await remoteJson([
      "import json, os",
      "from pathlib import Path",
      `run = Path(${JSON.stringify(entry.remoteRunDir)})`,
      "pid = int((run / 'pid').read_text().strip()) if (run / 'pid').is_file() and (run / 'pid').read_text().strip().isdigit() else None",
      "code_raw = (run / 'exit-code').read_text().strip() if (run / 'exit-code').is_file() else ''",
      "try: code = int(code_raw)\nexcept ValueError: code = None",
      "alive = False",
      "if pid is not None and code is None:",
      "  try: os.kill(pid, 0); alive = True",
      "  except OSError: alive = False",
      "print(json.dumps({'pid': pid, 'code': code, 'alive': alive}))",
    ].join("\n"));
    if (state === null) return entry;
    const pid = typeof state["pid"] === "number" ? state["pid"] : entry.pid;
    const code = typeof state["code"] === "number" ? state["code"] : null;
    const alive = state["alive"] === true;
    const elapsed = entry.startedAt ? now() - Date.parse(entry.startedAt) : 0;
    if (code === null && alive && elapsed <= runTimeoutMs) return { ...entry, ...(pid !== undefined ? { pid } : {}) };

    const completedAt = new Date(now()).toISOString();
    if (code === 0) {
      const collected = await collectRunArtifacts({ ...entry, ...(pid !== undefined ? { pid } : {}) });
      const finalStatus: EvolutionRunStatus = collected.candidatePath ? "evaluating" : "kept-baseline";
      const updated: EvolutionLedgerEntry = {
        ...collected,
        updatedAt: completedAt,
        completedAt,
        status: finalStatus,
        runDetail: collected.candidatePath
          ? "Hermes 已生成隔离候选，等待读取 metrics.json 并评估；baseline 未修改"
          : entry.dryRun
            ? "Hermes dry-run 通过；没有生成候选，baseline 未修改"
            : "Hermes 未生成可评估候选，baseline 保留",
        ...labels(finalStatus),
      };
      activeTargets.delete(targetKeyOf(updated.targetType ?? "skill", updated.targetRef ?? ""));
      persist(updated);
      return updated;
    }

    const timedOut = code === null && elapsed > runTimeoutMs;
    if (timedOut && pid !== undefined) {
      await wsl(`kill -TERM -- -${String(pid)} 2>/dev/null || kill -TERM ${String(pid)} 2>/dev/null || true`);
    }
    const updated: EvolutionLedgerEntry = {
      ...entry,
      updatedAt: completedAt,
      completedAt,
      ...(pid !== undefined ? { pid } : {}),
      status: "failed",
      runDetail: timedOut
        ? `Hermes 运行超过 ${Math.round(runTimeoutMs / 60_000)} 分钟超时，已尝试终止；baseline 保留`
        : `Hermes 进化进程异常退出（${code === null ? "未写入退出码" : `exit ${code}`}）；baseline 保留`,
      ...labels("failed"),
    };
    activeTargets.delete(targetKeyOf(updated.targetType ?? "skill", updated.targetRef ?? ""));
    persist(updated);
    await deps.poster.post({
      kind: "evolution-run-failed",
      severity: "critical",
      title: "Hermes 自我进化任务失败",
      body: `${updated.targetRef ?? updated.runId}：${updated.runDetail}`,
      source: "butler-watch",
      dedupeKey: `evolution-run-failed:${updated.runId}`,
    });
    core.audit.append({
      actor: EVOLUTION_ACTOR,
      action: EVOLUTION_RUN_ACTION,
      target: updated.targetRef ?? updated.instanceId ?? "",
      detail: { runId: updated.runId, status: "failed", timedOut, exitCode: code },
    });
    return updated;
  }

  async function createRun(input: EvolutionRunCreateInput): Promise<EvolutionRunView> {
    const targetRef = safeTargetRef(input.targetRef);
    const timestamp = new Date(now()).toISOString();
    const runId = randomUUID();
    const targetType = input.targetType;
    const invalid = targetRef === null || !["skill", "prompt", "config"].includes(targetType);
    if (invalid) {
      const entry: EvolutionLedgerEntry = {
        runId,
        createdAt: timestamp,
        updatedAt: timestamp,
        instanceId: input.instanceId ?? null,
        targetType,
        targetRef: input.targetRef,
        status: "preflight-failed",
        holdoutCount: Math.max(0, Math.floor(input.holdoutCount ?? MIN_HOLDOUT_COUNT)),
        dependencies: [...DEFAULT_EVOLUTION_DEPENDENCIES],
        endpoint: input.endpoint ?? "",
        config: {},
        checks: [],
        errors: ["invalid-target"],
        rootCause: "目标引用不合法",
        fixes: ["使用相对 skill / prompt / config 名称，不允许绝对路径或 .."],
        runDetail: "目标引用不合法，未启动 Hermes",
        ...labels("preflight-failed"),
      };
      persist(entry);
      return viewOf(entry);
    }

    if (targetType !== "skill") {
      const entry: EvolutionLedgerEntry = {
        runId,
        createdAt: timestamp,
        updatedAt: timestamp,
        instanceId: input.instanceId ?? null,
        targetType,
        targetRef,
        status: "preflight-failed",
        holdoutCount: Math.max(0, Math.floor(input.holdoutCount ?? MIN_HOLDOUT_COUNT)),
        dependencies: [],
        endpoint: input.endpoint ?? "",
        config: {},
        checks: [{
          id: "hermes",
          label: "Hermes 候选生成器",
          status: "fail",
          detail: targetType === "prompt" ? "当前 Hermes CLI 只接受 --skill；请使用提示词优化页生成候选" : "配置类建议仅只读展示，Butler 不会自动修改 Hermes 配置",
          action: targetType === "prompt" ? "前往提示词优化页" : "查看配置诊断并手动修复",
        }],
        errors: [],
        rootCause: "当前 Hermes 自我进化 CLI 不支持该目标类型",
        fixes: [],
        runDetail: targetType === "prompt" ? "请转到提示词优化页" : "配置建议保持只读",
        ...labels("preflight-failed"),
      };
      persist(entry);
      return viewOf(entry);
    }

    const preflight = await runPreflight({
      instanceId: input.instanceId,
      endpoint: input.endpoint,
      holdoutCount: Math.max(0, Math.floor(input.holdoutCount ?? MIN_HOLDOUT_COUNT)),
      datasetPath: input.datasetPath,
      config: { targetType, targetRef, iterations: Math.max(1, Math.floor(input.iterations ?? 3)), dryRun: input.dryRun !== false },
    }, runId);
    let entry = entries.get(runId)!;
    const workspace = preflight.allowRun ? await checkHermesWorkspace(targetRef, runId) : null;
    const hermesCheck: EvolutionCheck | null = workspace === null
      ? null
      : workspace.ok
        ? { id: "hermes", label: "Hermes 自我进化", status: "pass", detail: "WSL CLI 与隔离运行目录已就绪" }
        : { id: "hermes", label: "Hermes 自我进化", status: "fail", detail: workspace.detail, action: "检查 WSL Ubuntu-24.04、Hermes 项目和 venv" };
    const ready = preflight.allowRun && workspace?.ok === true;
    const status: EvolutionRunStatus = ready ? "ready" : "preflight-failed";
    entry = {
      ...entry,
      updatedAt: new Date(now()).toISOString(),
      status,
      targetType,
      targetRef,
      dryRun: input.dryRun !== false,
      ...(workspace?.ok ? {
        remoteRunDir: workspace.runDir,
        targetPath: workspace.targetPath,
        baselinePath: workspace.baselinePath,
        stdoutPath: workspace.stdoutPath,
        stderrPath: workspace.stderrPath,
        commandSummary: `${posix.join(hermesAgentRoot ?? "~/.hermes/hermes-agent", "venv/bin/python3")} -m evolution.skills.evolve_skill --skill ${targetRef}${input.dryRun === false ? "" : " --dry-run"}`,
      } : {}),
      checks: hermesCheck === null ? entry.checks : [...entry.checks, hermesCheck],
      runDetail: ready ? "预检通过，已创建隔离候选目录；等待用户启动 Hermes" : "预检或 Hermes 工作区未通过，未触碰 baseline",
      ...labels(status),
    };
    persist(entry);
    if (!ready) {
      const failed = entry.checks.filter((item) => item.status === "fail");
      const endpointFailure = failed.find((item) => item.id === "endpoint");
      if (endpointFailure) {
        await deps.poster.post({
          kind: "evolution-preflight-blocked",
          severity: "critical",
          title: "Hermes 进化被模型连接阻断",
          body: endpointFailure.detail,
          source: "butler-watch",
          dedupeKey: `evolution-preflight:${endpointHealth.category}:${targetRef}`,
        });
      }
    }
    return viewOf(entry);
  }

  async function startRun(runId: string): Promise<EvolutionRunView | { status: "error"; error: string; detail: string }> {
    let entry = entries.get(runId);
    if (!entry) return { status: "error", error: "run-not-found", detail: "运行不存在" };
    if (entry.status === "running") return viewOf(await refreshRun(entry));
    if (entry.status !== "ready" || !entry.targetType || !entry.targetRef || !entry.remoteRunDir || !entry.targetPath) {
      return { status: "error", error: "run-not-ready", detail: "只有预检通过的技能任务可以启动" };
    }
    const key = targetKeyOf(entry.targetType, entry.targetRef);
    const active = activeTargets.get(key);
    if (active && active !== runId) return { status: "error", error: "target-busy", detail: `该目标已有运行中的任务：${active}` };
    if (!deps.useWsl || evolutionRoot === null || hermesAgentRoot === null || hermesRoot === null || !entry.stdoutPath || !entry.stderrPath) {
      return { status: "error", error: "hermes-unavailable", detail: "Hermes 运行环境不可用" };
    }
    const engineRoot = posix.join(entry.remoteRunDir, "engine");
    const hermesEnvPath = posix.join(posix.dirname(hermesAgentRoot), ".env");
    // Hermes 的 dspy/litellm 读取 OpenAI 兼容环境变量；配置文件本身保持只读，
    // 只在子进程环境中注入已发现的 provider/base URL，不把密钥写入命令摘要或产物。
    const hermesLlm = await readHermesLlmConfig();
    const providerEnv = hermesLlm.provider
      ? `${hermesLlm.provider.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`
      : null;
    const modelName = hermesLlm.model
      ? hermesLlm.model.includes("/")
        ? hermesLlm.model
        : `openai/${hermesLlm.model}`
      : null;
    // Hermes 自我进化脚本按技能目录 basename 查找；Butler 对外保留
    // category/name 形式的 targetRef，启动时转换为 CLI 所需的名称。
    const hermesSkillName = entry.targetRef.split("/").filter(Boolean).at(-1) ?? entry.targetRef;
    const args = [
      "-m",
      "evolution.skills.evolve_skill",
      "--skill",
      shellQuote(hermesSkillName),
      "--hermes-repo",
      shellQuote(hermesRoot),
      "--iterations",
      String(Math.max(1, Math.floor(typeof entry.config["iterations"] === "number" ? entry.config["iterations"] : 3))),
      ...(entry.datasetPath ? ["--dataset-path", shellQuote(entry.datasetPath)] : []),
      ...(modelName ? ["--optimizer-model", shellQuote(modelName), "--eval-model", shellQuote(modelName)] : []),
      ...(entry.dryRun ? ["--dry-run"] : []),
    ].join(" ");
    const exitPath = posix.join(entry.remoteRunDir, "exit-code");
    const pidPath = posix.join(entry.remoteRunDir, "pid");
    const runner = [
      "set +e",
      `if [ -f ${shellQuote(hermesEnvPath)} ]; then set -a; . ${shellQuote(hermesEnvPath)}; set +a; fi`,
      // Hermes 的进化脚本会在构造配置时先读取 HERMES_AGENT_REPO，
      // 因此必须显式指向容器内的只读 checkout，不能依赖宿主绝对路径。
      `export HERMES_AGENT_REPO=${shellQuote(hermesRoot)}`,
      ...(providerEnv
        ? [`if [ -n "\${${providerEnv}:-}" ]; then export OPENAI_API_KEY="\$${providerEnv}"; fi`]
        : []),
      'export OPENAI_API_KEY="${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-${XIAOMI_API_KEY:-${OPENROUTER_API_KEY:-}}}}"',
      ...(hermesLlm.baseUrl ? [`export OPENAI_BASE_URL=${shellQuote(hermesLlm.baseUrl)}`] : []),
      `cd ${shellQuote(engineRoot)}`,
      `${pythonResolver()} && PYTHONPATH=${shellQuote(engineRoot)}:"\${PYTHONPATH:-}" "$python" ${args}`,
      "code=$?",
      `printf '%s\\n' "$code" > ${shellQuote(exitPath)}`,
      "exit $code",
    ].join("; ");
    const launch = [
      "set -eu",
      `mkdir -p ${shellQuote(entry.remoteRunDir)}`,
      `rm -f ${shellQuote(exitPath)} ${shellQuote(pidPath)}`,
      `: > ${shellQuote(entry.stdoutPath)}`,
      `: > ${shellQuote(entry.stderrPath)}`,
      `setsid sh -lc ${shellQuote(runner)} < /dev/null > ${shellQuote(entry.stdoutPath)} 2> ${shellQuote(entry.stderrPath)} &`,
      "pid=$!",
      `printf '%s\\n' "$pid" > ${shellQuote(pidPath)}`,
      "printf '%s\\n' \"$pid\"",
    ].join("; ");
    const result = await wsl(launch, 20_000);
    const pid = Number(result.stdout.trim().split(/\r?\n/).at(-1));
    if (result.code !== 0 || !Number.isInteger(pid) || pid <= 1) {
      const updated: EvolutionLedgerEntry = {
        ...entry,
        updatedAt: new Date(now()).toISOString(),
        completedAt: new Date(now()).toISOString(),
        status: "failed",
        runDetail: redactSecret(result.stderr.trim() || "无法启动 Hermes 自我进化进程"),
        ...labels("failed"),
      };
      persist(updated);
      await deps.poster.post({ kind: "evolution-run-failed", severity: "critical", title: "Hermes 自我进化未能启动", body: updated.runDetail ?? "无法启动 Hermes 自我进化进程", source: "butler-watch", dedupeKey: `evolution-start:${runId}` });
      return viewOf(updated);
    }
    entry = {
      ...entry,
      updatedAt: new Date(now()).toISOString(),
      startedAt: new Date(now()).toISOString(),
      status: "running",
      pid,
      runDetail: entry.dryRun ? "Hermes dry-run 正在验证配置与技能路径" : "Hermes 正在生成隔离候选",
      ...labels("running"),
    };
    activeTargets.set(key, runId);
    persist(entry);
    core.audit.append({ actor: EVOLUTION_ACTOR, action: EVOLUTION_RUN_ACTION, target: entry.targetRef, detail: { runId, pid, dryRun: entry.dryRun === true, commandSummary: entry.commandSummary } });
    return viewOf(entry);
  }

  async function getRun(runId: string): Promise<EvolutionRunView | null> {
    const entry = entries.get(runId);
    if (!entry) return null;
    const refreshed = await refreshRun(entry);
    return viewOf(refreshed, await readRemoteTail(refreshed));
  }

  async function evaluateRun(runId: string): Promise<EvolutionEvaluateOutcome> {
    let entry = entries.get(runId);
    const error = (kind: Extract<EvolutionEvaluateOutcome, { status: "error" }>["error"], detail: string): EvolutionEvaluateOutcome => ({
      status: "error", error: kind, detail, allowWrite: false, baselinePreserved: true, delta: null, ledgerPath: entry ? ledgerPathOf(entry.runId) : null,
    });
    if (!entry) return error("run-not-found", "运行不存在");
    entry = await refreshRun(entry);
    if (entry.status === "running") return error("run-not-ready", "Hermes 仍在运行，尚不能评估");
    if (entry.status !== "evaluating" || !entry.candidatePath || !entry.targetPath || !entry.baselinePath) {
      return error("run-not-ready", "没有可评估的隔离候选；dry-run 和失败运行不会产生可发布产物");
    }
    const metrics = await readRunMetrics(entry);
    if (!metrics || metrics.baselineQuality === undefined || metrics.candidateQuality === undefined || metrics.qualityDelta === undefined) {
      return error("invalid-evaluator-response", "metrics.json 缺少 baseline_score/evolved_score/improvement，baseline 保留");
    }
    const completedAt = new Date(now()).toISOString();
    const passesGates = metrics.constraintsPassed !== false && metrics.structureGate !== "fail" && metrics.safetyGate !== "fail";
    const status: EvolutionRunStatus = !passesGates || metrics.qualityDelta < 0
      ? "rejected-regression"
      : metrics.qualityDelta > 0 && (metrics.holdoutCount ?? 0) >= MIN_HOLDOUT_COUNT
        ? "accepted"
        : "kept-baseline";
    let writeAuthority: EvolutionWriteAuthority | undefined;
    if (status === "accepted" && deps.useWsl) {
      const result = await remoteJson([
        "import hashlib, json",
        "from pathlib import Path",
        `target = Path(${JSON.stringify(entry.targetPath)})`,
        `candidate = Path(${JSON.stringify(entry.candidatePath)})`,
        `skill_root = Path(${JSON.stringify(posix.join(hermesAgentRoot ?? "", "skills"))})`,
        `run_root = Path(${JSON.stringify(runRoot ?? "")})`,
        "def inside(path, root):",
        "  try: path.resolve().relative_to(root.resolve()); return True",
        "  except ValueError: return False",
        "def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()",
        "allowed = inside(target, skill_root) and inside(candidate, run_root)",
        "print(json.dumps({'target': target.is_file(), 'candidate': candidate.is_file(), 'allowed': allowed, 'baselineSha256': digest(target) if target.is_file() and allowed else None, 'candidateSha256': digest(candidate) if candidate.is_file() and allowed else None}))",
      ].join("\n"));
      if (result?.["target"] === true && result["candidate"] === true && result["allowed"] === true && typeof result["baselineSha256"] === "string" && typeof result["candidateSha256"] === "string") {
        writeAuthority = {
          token: randomUUID(), runId, instanceId: entry.instanceId ?? "hermes-wsl", targetPath: entry.targetPath,
          candidatePath: entry.candidatePath, baselineSha256: result["baselineSha256"], candidateSha256: result["candidateSha256"], issuedAt: completedAt,
        };
        authorities.set(writeAuthority.token, writeAuthority);
      } else {
        return error("invalid-evaluator-response", "候选或 baseline 路径不受发布门禁允许，未签发发布令牌");
      }
    }
    const label = labels(status);
    entry = {
      ...entry,
      updatedAt: completedAt,
      completedAt,
      status,
      baselineMetric: metrics.baselineQuality,
      candidateMetric: metrics.candidateQuality,
      delta: metrics.qualityDelta,
      significant: status === "accepted",
      metrics,
      ...(writeAuthority ? { writeAuthorityIssuedAt: writeAuthority.issuedAt } : {}),
      runDetail: status === "accepted"
        ? "候选质量提升且结构门禁通过；等待用户确认采用"
        : status === "rejected-regression"
          ? "候选质量回落或结构/安全门禁失败，baseline 保留"
          : "候选未达到采用门槛，baseline 保留",
      ...label,
    };
    persist(entry);
    if (status === "rejected-regression") {
      await deps.poster.post({ kind: "evolution-regression", severity: "critical", title: "Hermes 进化候选被守门器拦截", body: `${entry.targetRef ?? runId}：${entry.runDetail}`, source: "butler-watch", dedupeKey: `evolution-regression:${runId}` });
    }
    core.audit.append({ actor: EVOLUTION_ACTOR, action: EVOLUTION_GATE_ACTION, target: entry.targetRef ?? entry.instanceId ?? "", detail: { runId, status, baselineQuality: metrics.baselineQuality, candidateQuality: metrics.candidateQuality, qualityDelta: metrics.qualityDelta, constraintsPassed: metrics.constraintsPassed, writeAuthorized: writeAuthority !== undefined } });
    return {
      status: status as "accepted" | "kept-baseline" | "rejected-regression",
      sampleCount: metrics.holdoutCount ?? entry.holdoutCount,
      confidence: metrics.confidence ?? null,
      baselineMetric: metrics.baselineQuality,
      candidateMetric: metrics.candidateQuality,
      delta: metrics.qualityDelta,
      canPromote: writeAuthority !== undefined,
      report: metrics as unknown as Record<string, unknown>,
      allowWrite: false,
      baselinePreserved: true,
      ledgerPath: ledgerPathOf(runId),
      ...(writeAuthority ? { writeAuthority } : {}),
    };
  }

  async function promoteRun(input: EvolutionPromoteInput): Promise<EvolutionPromoteOutcome> {
    if (!deps.useWsl) return promoteArtifact(input);
    const entry = entries.get(input.runId);
    const authority = authorities.get(input.token);
    if (!entry) return { status: "error", error: "run-not-found", detail: "运行不存在", ledgerPath: null };
    if (!authority || authority.runId !== input.runId) return { status: "error", error: usedAuthorities.has(input.token) ? "authority-used" : "authority-not-found", detail: "发布令牌不存在、已过期或不属于该运行", ledgerPath: ledgerPathOf(input.runId) };
    if (entry.status !== "accepted" || input.targetPath || input.candidatePath) return { status: "error", error: "path-not-allowed", detail: "只能采用评估通过后原样签发的隔离候选", ledgerPath: ledgerPathOf(input.runId) };
    const script = [
      "import hashlib, os, sys",
      "from pathlib import Path",
      `target = Path(${JSON.stringify(authority.targetPath)})`,
      `candidate = Path(${JSON.stringify(authority.candidatePath)})`,
      `skill_root = Path(${JSON.stringify(posix.join(hermesAgentRoot ?? "", "skills"))})`,
      `run_root = Path(${JSON.stringify(runRoot ?? "")})`,
      `expected_target = ${JSON.stringify(authority.baselineSha256)}`,
      `expected_candidate = ${JSON.stringify(authority.candidateSha256)}`,
      "def inside(path, root):",
      "  try: path.resolve().relative_to(root.resolve()); return True",
      "  except ValueError: return False",
      "def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()",
      "if not inside(target, skill_root) or not inside(candidate, run_root): sys.exit(14)",
      "if not target.is_file() or not candidate.is_file(): sys.exit(11)",
      "if digest(target) != expected_target: sys.exit(12)",
      "if digest(candidate) != expected_candidate: sys.exit(13)",
      "temp = target.with_name(target.name + '.butler-promote-' + os.urandom(8).hex() + '.tmp')",
      "temp.write_bytes(candidate.read_bytes())",
      "os.replace(temp, target)",
    ].join("\n");
    const result = await wsl(`python3 -c ${shellQuote(script)}`, 20_000);
    if (result.code !== 0) {
      const mapping: Record<number, "candidate-tampered" | "target-changed" | "path-not-allowed"> = { 11: "candidate-tampered", 12: "target-changed", 13: "candidate-tampered", 14: "path-not-allowed" };
      return { status: "error", error: mapping[result.code] ?? "write-failed", detail: redactSecret(result.stderr.trim() || "候选原子替换失败"), ledgerPath: ledgerPathOf(input.runId) };
    }
    const promotedAt = new Date(now()).toISOString();
    const updated: EvolutionLedgerEntry = { ...entry, updatedAt: promotedAt, completedAt: promotedAt, status: "promoted", promotedAt, promotedTargetPath: authority.targetPath, runDetail: "用户已确认采用，候选已原子替换 baseline", ...labels("promoted") };
    persist(updated);
    authorities.delete(input.token);
    usedAuthorities.add(input.token);
    core.audit.append({ actor: EVOLUTION_ACTOR, action: EVOLUTION_PROMOTE_ACTION, target: authority.instanceId, detail: { runId: input.runId, targetPath: authority.targetPath, candidatePath: authority.candidatePath, baselineSha256: authority.baselineSha256, candidateSha256: authority.candidateSha256 } });
    return { status: "promoted", runId: input.runId, targetPath: authority.targetPath, candidatePath: authority.candidatePath, baselineSha256: authority.baselineSha256, candidateSha256: authority.candidateSha256, ledgerPath: ledgerPathOf(input.runId) };
  }

  async function cancelRun(runId: string): Promise<EvolutionRunView | { status: "error"; error: string; detail: string }> {
    const entry = entries.get(runId);
    if (!entry) return { status: "error", error: "run-not-found", detail: "运行不存在" };
    if (entry.status !== "running" || !entry.pid || !deps.useWsl) return { status: "error", error: "run-not-running", detail: "只有运行中的 Hermes 任务可以取消" };
    await wsl(`kill -TERM -- -${String(entry.pid)} 2>/dev/null || kill -TERM ${String(entry.pid)} 2>/dev/null || true`);
    const updated: EvolutionLedgerEntry = { ...entry, updatedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString(), status: "cancelled", runDetail: "用户取消了 Hermes 任务；baseline 未修改", ...labels("cancelled") };
    activeTargets.delete(targetKeyOf(updated.targetType ?? "skill", updated.targetRef ?? ""));
    persist(updated);
    core.audit.append({ actor: EVOLUTION_ACTOR, action: EVOLUTION_CANCEL_ACTION, target: updated.targetRef ?? updated.instanceId ?? "", detail: { runId, pid: entry.pid } });
    return viewOf(updated, await readRemoteTail(updated));
  }

  function inferTargetRef(issue: LogIssueView): string {
    const match = issue.examples.join("\n").match(/(?:skills?[\\/]|--skill\s+)([A-Za-z0-9._-]+)/i);
    return match?.[1] ?? "待从日志定位";
  }

  function diagnose(input: { issues?: LogIssueView[]; scannedSources?: number; scannedLines?: number } = {}): EvolutionDiagnosis {
    const issues = input.issues ?? [];
    const sources = Math.max(0, Math.floor(input.scannedSources ?? new Set(issues.flatMap((issue) => issue.sources)).size));
    const lines = Math.max(0, Math.floor(input.scannedLines ?? 0));
    const recommendations: EvolutionRecommendation[] = issues.map((issue): EvolutionRecommendation => {
      const targetRef = inferTargetRef(issue);
      const occurrences = issue.count;
      const confidence = Math.min(0.98, 0.45 + Math.min(occurrences, 6) * 0.08 + (issue.severity === "error" ? 0.08 : 0));
      const base = { id: `evolution-${issue.id}`, confidence, window: { sources, lines, occurrences }, sources: issue.sources, examples: issue.examples.map((line) => redactSecret(line)), blocked: false };
      if (["llm-auth", "llm-route", "config-error"].includes(issue.kind)) {
        const category = issue.kind === "llm-auth" ? "credentials" : "configuration";
        const recommendation: EvolutionRecommendation = { ...base, targetType: "config", targetRef, blocked: true, nextAction: "fix-config", title: issue.title, detail: issue.detail };
        void deps.poster.post({ kind: "evolution-config-blocked", severity: "critical", title: "Hermes 配置错误阻断进化", body: issue.detail, source: "butler-watch", dedupeKey: `evolution-config:${category}:${issue.id}` });
        return recommendation;
      }
      if (issue.kind === "dependency") return { ...base, targetType: "version-upgrade", targetRef, nextAction: "open-version-upgrade", title: issue.title, detail: issue.detail };
      if (["tool-failure", "trajectory-interrupted"].includes(issue.kind)) return { ...base, targetType: "skill", targetRef, nextAction: targetRef === "待从日志定位" ? "inspect" : "create-run", title: issue.title, detail: issue.detail };
      if (issue.kind === "quality-loop") return { ...base, targetType: "prompt", targetRef, nextAction: "open-prompt-optimization", title: issue.title, detail: issue.detail };
      return { ...base, targetType: "diagnostic", targetRef, nextAction: "inspect", title: issue.title, detail: issue.detail };
    });
    return { analyzedAt: new Date(now()).toISOString(), issues, recommendations };
  }

  return {
    status: () => ({
      minHoldoutCount: MIN_HOLDOUT_COUNT,
      defaultDependencies: [...DEFAULT_EVOLUTION_DEPENDENCIES],
      defaultEndpoint: deps.defaultEndpoint ?? "",
      ledger: [...entries.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((entry) => ({
          runId: entry.runId,
          updatedAt: entry.updatedAt,
          instanceId: entry.instanceId,
          status: entry.status,
          holdoutCount: entry.holdoutCount,
          ...(entry.baselineMetric !== undefined ? { baselineMetric: entry.baselineMetric } : {}),
          ...(entry.candidateMetric !== undefined
            ? { candidateMetric: entry.candidateMetric }
            : {}),
          ...(entry.delta !== undefined ? { delta: entry.delta } : {}),
          conclusion: entry.conclusion,
          disposition: entry.disposition,
        })),
      hermes: {
        status: deps.useWsl && evolutionRoot !== null && hermesAgentRoot !== null && runRoot !== null ? "ready" : hermesRoot === null ? "unknown" : "unavailable",
        root: hermesRoot,
        detail: deps.useWsl
          ? `Hermes 进化引擎：${evolutionRoot ?? "未配置自我进化目录"}；隔离运行目录：${runRoot ?? "未配置"}`
          : "当前 Watch 未连接可执行的 Hermes runtime",
      },
      endpointHealth,
      blocked: [...entries.values()]
        .filter((entry) => entry.status === "preflight-failed" || entry.status === "rejected-preflight")
        .map((entry) => ({
          category: entry.checks.some((check) => check.id === "endpoint") ? endpointHealth.category : "unknown" as EvolutionEndpointCategory,
          detail: detailOf(entry),
          affectedRuns: [entry.runId],
        })),
      tasks: [...entries.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50)
        .map((entry) => viewOf(entry)),
      history: [...entries.values()]
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((entry) => entry.metrics)
        .filter((metric): metric is EvolutionMetrics => metric !== undefined),
    }),
    diagnose,
    createRun,
    getRun,
    startRun,
    evaluateRun,
    promoteRun,
    cancelRun,
    preflight: (input) => runPreflight(input),
    expandDataset,
    recordResult,
    evaluate,
    promoteArtifact,
    exportLedger: (runId) => {
      const path = ledgerPathOf(runId);
      if (!entries.has(runId) || !existsSync(path)) return null;
      return { filename: `evolution-${safeRunId(runId)}.md`, markdown: readFileSync(path, "utf8") };
    },
  };
}
