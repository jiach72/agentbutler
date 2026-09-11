/**
 * 进化页共享类型与工具：预检/评估/门禁载荷类型、状态文案与徽标 tone 映射、
 * Steps 推进计算，以及带兜底的种子样本解析。
 */
import type { SemanticTone } from "../../components/StatusBadge.js";
import { isRecord } from "../../lib/format.js";

export type CheckStatus = "pass" | "fail" | "skipped";

export interface EvolutionCheck {
  id: "dependencies" | "endpoint" | "dataset" | "snapshot";
  label: string;
  status: CheckStatus;
  detail: string;
  action?: string;
}

export interface LedgerEntry {
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

export interface EvolutionPayload {
  watchReachable: boolean;
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: LedgerEntry[];
}

export interface PreflightOutcome {
  runId: string;
  status: "rejected-preflight" | "ready";
  allowRun: boolean;
  instanceId: string | null;
  checks: EvolutionCheck[];
  snapshotId?: string;
  ledgerPath: string;
  nextAction?: { kind: "expand-dataset"; targetCount: number; endpoint: string };
}

export interface ExpandOutcome {
  status: "ready" | "error";
  error?: string;
  beforeCount: number;
  afterCount: number;
  syntheticCount: number;
  datasetPath: string;
  recheck: PreflightOutcome;
}

export interface GateOutcome {
  status: string;
  error?: string;
  allowWrite: boolean;
  baselinePreserved: boolean;
  delta: number | null;
  ledgerPath: string | null;
}

export interface EvaluationOutcome extends GateOutcome {
  status: "accepted" | "kept-baseline" | "rejected-regression";
  sampleCount: number;
  confidence: number | null;
  baselineMetric: number;
  candidateMetric: number;
  canPromote: boolean;
  report: Record<string, unknown>;
}

/** 页面表单统一收进一个 antd Form 实例（此前 11 个散装 useState 字段）。 */
export interface EvolutionFormValues {
  dependencies: string;
  endpoint: string;
  holdoutCount: number | null;
  datasetPath: string;
  instanceId: string;
  seedExamples: string;
  baselineMetric: number | null;
  candidateMetric: number | null;
  significant: boolean;
  rootCause: string;
  fixes: string;
}

export const PENDING_CHECKS: EvolutionCheck[] = [
  { id: "dependencies", label: "运行依赖", status: "skipped", detail: "等待检查当前运行依赖" },
  { id: "endpoint", label: "模型连接", status: "skipped", detail: "等待模型连接检查" },
  { id: "dataset", label: "测试样本", status: "skipped", detail: "等待校验测试样本数量" },
  { id: "snapshot", label: "运行前备份", status: "skipped", detail: "前三项通过后才创建" },
];

export type BusyKind = "preflight" | "expand" | "gate" | "evaluate" | null;

const HOLDOUT_MESSAGE = "测试样本数量必须是大于等于 0 的整数。";

/** 原有校验规则平移为 antd Form rules。 */
export const HOLDOUT_RULES = [
  {
    validator: (_rule: unknown, value: unknown): Promise<void> =>
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? Promise.resolve()
        : Promise.reject(new Error(HOLDOUT_MESSAGE)),
  },
];

const METRIC_MESSAGE = "当前版本与改进后的指标都必须是有效数值。";

export const METRIC_RULES = [
  {
    validator: (_rule: unknown, value: unknown): Promise<void> =>
      typeof value === "number" && Number.isFinite(value)
        ? Promise.resolve()
        : Promise.reject(new Error(METRIC_MESSAGE)),
  },
];

export type SeedParseResult = { ok: true; values: unknown[] } | { ok: false; error: string };

/** 种子样本解析：所有 JSON.parse 路径都有 try/catch 兜底，不会抛未捕获异常。 */
export function parseSeedExamples(raw: string): SeedParseResult {
  const text = raw.trim();
  if (text === "") return { ok: true, values: [] };
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: "种子样本 JSON 必须是数组或 JSONL" };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: "种子样本 JSON 必须是数组或 JSONL" };
    return { ok: true, values: parsed };
  }
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      return { ok: false, error: "种子样本 JSON 必须是数组或 JSONL" };
    }
  }
  return { ok: true, values };
}

export function responseError(data: unknown): string {
  if (!isRecord(data)) return "未知错误";
  const detail = typeof data["detail"] === "string" ? data["detail"] : "";
  const error = typeof data["error"] === "string" ? data["error"] : "请求失败";
  return detail === "" ? error : `${error}：${detail}`;
}

export function checkTone(status: CheckStatus): string {
  if (status === "pass") return "is-pass";
  if (status === "fail") return "is-fail";
  return "is-pending";
}

export const DISPOSITION_LABELS: Record<string, string> = {
  accepted: "已采用",
  "kept-baseline": "保留当前版本",
  "rejected-regression": "已拦截",
  "rejected-preflight": "检查未通过",
  pending: "等待确认",
};

export function dispositionLabel(value: string): string {
  return DISPOSITION_LABELS[value] ?? "其他结论";
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    "rejected-preflight": "检查未通过",
    ready: "可以运行",
    accepted: "明显更好",
    "kept-baseline": "没有明显提升",
    "rejected-regression": "结果变差，已拦截",
  };
  return labels[status] ?? "其他状态";
}

/** 状态/结论 → 徽标语义 tone（StatusBadge 统一渲染）。 */
export function outcomeTone(value: string): SemanticTone {
  switch (value) {
    case "accepted":
      return "ok";
    case "rejected-regression":
      return "error";
    case "rejected-preflight":
      return "warn";
    case "pending":
      return "info";
    default:
      return "muted";
  }
}

/**
 * Steps current 计算：预检(1) → 外部评估(2) → 安全门禁(3) → 结论(4)。
 * 门禁步骤保证可达；评估完成但被拦截时停在第 3 步（安全门禁），只有
 * 「已采用」才推进到结论，不再从评估直接跳过门禁。
 */
export function stepsCurrent(
  preflightAllowRun: boolean,
  evaluation: EvaluationOutcome | null,
  gate: GateOutcome | null,
): number {
  if (gate?.status === "accepted") return 4;
  if (evaluation !== null || gate !== null) return 3;
  if (preflightAllowRun) return 2;
  return 1;
}

export function formatMetric(entry: LedgerEntry): string {
  if (entry.baselineMetric === undefined || entry.candidateMetric === undefined) {
    return `${entry.holdoutCount} 条`;
  }
  return `${entry.baselineMetric.toFixed(3)} → ${entry.candidateMetric.toFixed(3)}`;
}
