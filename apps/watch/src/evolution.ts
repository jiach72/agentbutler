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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findVenvPython, type CommandExecutor } from "@butler/adapter-hermes";
import type { ControlAdapter, InstanceRef } from "@butler/contract";
import type { Core, InstanceRecord } from "@butler/core";
import type { AlertPoster } from "./alert-forward.js";
import type { FetchLike } from "./dashboard-signal.js";

export const EVOLUTION_ACTOR = "evolution";
export const EVOLUTION_PREFLIGHT_ACTION = "preflight";
export const EVOLUTION_EXPAND_ACTION = "dataset-expand";
export const EVOLUTION_GATE_ACTION = "gate-decision";
export const MIN_HOLDOUT_COUNT = 10;
export const DEFAULT_EVOLUTION_DEPENDENCIES = ["dspy", "gepa", "optuna"] as const;

export type EvolutionCheckId = "dependencies" | "endpoint" | "dataset" | "snapshot";
export type EvolutionRunStatus =
  "rejected-preflight" | "ready" | "accepted" | "kept-baseline" | "rejected-regression";

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
}

export interface EvolutionService {
  status(): EvolutionStatusView;
  preflight(input: EvolutionPreflightInput): Promise<EvolutionPreflightOutcome>;
  expandDataset(input: EvolutionExpandInput): Promise<EvolutionExpandOutcome>;
  recordResult(input: EvolutionResultInput): Promise<EvolutionGateOutcome>;
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
  if (status === "ready") return { conclusion: "预检通过", disposition: "允许外部引擎开始进化" };
  if (status === "accepted")
    return { conclusion: "显著提升", disposition: "允许引擎替换 baseline" };
  if (status === "kept-baseline") return { conclusion: "无显著提升", disposition: "baseline 保留" };
  if (status === "rejected-regression")
    return { conclusion: "负优化", disposition: "拒绝落盘 · baseline 保留" };
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

export function createEvolutionService(deps: EvolutionServiceDeps): EvolutionService {
  const core = deps.core;
  const now = deps.now ?? Date.now;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 5000;
  const fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
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

  async function checkEndpoint(endpoint: string): Promise<EvolutionCheck> {
    if (endpoint === "") {
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: "未配置模型端点",
        action: "填写仅用于连通性探测的 API Base URL",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("bad protocol");
    } catch {
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: "端点 URL 无效",
        action: "改为 http(s) URL",
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetchFn(parsed.toString(), {
        method: "HEAD",
        signal: controller.signal,
      });
      // 401/403/404/405 均证明路由可达；5xx 表示上游当前不可用。
      const reachable = response.status > 0 && response.status < 500;
      return reachable
        ? {
            id: "endpoint",
            label: "模型端点",
            status: "pass",
            detail: `${parsed.host} 可达（HTTP ${response.status}）`,
          }
        : {
            id: "endpoint",
            label: "模型端点",
            status: "fail",
            detail: `端点返回 HTTP ${response.status}`,
            action: "检查端点、代理与供应商服务状态后重检",
          };
    } catch (error) {
      return {
        id: "endpoint",
        label: "模型端点",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        action: "检查端点、DNS、代理与证书后重检",
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
    const endpoint = (input.endpoint ?? deps.defaultEndpoint ?? "").trim();
    const holdoutCount =
      Number.isInteger(input.holdoutCount) && input.holdoutCount >= 0 ? input.holdoutCount : 0;
    const record = resolveInstance(core, input.instanceId);

    const [dependencyCheck, endpointCheck] = await Promise.all([
      checkDependencies(record, dependencies),
      checkEndpoint(endpoint),
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
        promotedAt,
        promotedTargetPath: targetPath,
        disposition: "候选已通过门禁并替换 baseline",
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
    }),
    preflight: (input) => runPreflight(input),
    expandDataset,
    recordResult,
    promoteArtifact,
    exportLedger: (runId) => {
      const path = ledgerPathOf(runId);
      if (!entries.has(runId) || !existsSync(path)) return null;
      return { filename: `evolution-${safeRunId(runId)}.md`, markdown: readFileSync(path, "utf8") };
    },
  };
}
