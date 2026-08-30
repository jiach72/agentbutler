import { createHash } from "node:crypto";
import type { Core, EvolutionActionItemRow, EvolutionObservationRow, EvolutionSampleRow } from "@butler/core";
import type { EvolutionLedgerSummary, EvolutionService } from "./evolution.js";
import type { LogAnalyzeView, LogIssueView } from "./log-analyzer.js";
import type { SkillsMemoryService } from "./skills.js";

export type EvolutionDataSource = "structured" | "logs" | "mixed" | "incomplete";
export type EvolutionFailureCategory = "environment-dependency" | "runtime" | "dataset" | "engine" | "target" | "unknown";

export interface EvolutionMetricTotals {
  sessions: number;
  completedSessions: number;
  failedSessions: number;
  terminalSessions: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  unknownToolCalls: number;
  classifiedToolCalls: number;
  successRate: number | null;
  failureRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  reliability: number | null;
  completion: number | null;
  coverage: number | null;
  healthScore: number | null;
  sampleStatus: "ready" | "insufficient";
}

export interface EvolutionOverviewView {
  schemaVersion: "evolution-analytics.v1";
  instanceId: string | null;
  range: "24h" | "7d" | "30d";
  analyzedAt: string;
  source: EvolutionDataSource;
  completeness: { structuredObservations: number; logObservations: number; note: string };
  status: "healthy" | "watch" | "blocked" | "offline" | "insufficient";
  statusDetail: string;
  totals: EvolutionMetricTotals;
  trend: Array<{ date: string; sessions: number; toolCalls: number; successRate: number | null }>;
  failures: EvolutionFailureView[];
  memory: EvolutionMemoryView;
  evolution: EvolutionEngineView;
  datasets: EvolutionDatasetView;
  actionItems: EvolutionActionItemView[];
  runs: EvolutionAnalyticsRunView[];
}

export interface EvolutionFailureView {
  category: EvolutionFailureCategory;
  title: string;
  count: number;
  impact: "blocking" | "high" | "medium" | "low";
  evidence: string;
  source: "structured" | "logs" | "mixed";
  lastSeenAt: string | null;
}

export interface EvolutionMemoryView {
  used: number | null;
  capacity: number | null;
  percent: number | null;
  unit: "entries";
  trend: Array<{ date: string; used: number; capacity: number }>;
  source: "memory-service" | "unavailable";
}

export interface EvolutionEngineView {
  runCount: number;
  completedRuns: number;
  successfulRuns: number;
  successRate: number | null;
  averageDurationSeconds: number | null;
  latest: { status: string; improvement: number | null; gainScore: number | null; detail: string } | null;
  timeline: Array<{ runId: string; at: string; stage: "preflight" | "execute" | "evaluate" | "accepted" | "blocked"; status: string; detail: string }>;
}

export interface EvolutionDatasetView {
  dataset: string;
  version: string;
  realSamples: number;
  positiveSamples: number;
  negativeSamples: number;
  holdoutCount: number;
  requiredHoldout: number;
  gap: number;
  completeness: EvolutionDataSource;
  duplicateRate: number | null;
  lastCollectedAt: string | null;
  formalReady: boolean;
}

export type EvolutionActionItemView = EvolutionActionItemRow;
export interface EvolutionAnalyticsRunView {
  runId: string;
  updatedAt: string;
  status: string;
  holdout: number;
  baseline: number | null;
  candidate: number | null;
  improvement: number | null;
  confidence: number | null;
  gainScore: number | null;
  gate: "accepted" | "kept-baseline" | "rejected-regression" | "not-scored";
  detail: string;
}

export interface EvolutionAnalyticsService {
  overview(instanceId?: string, range?: "24h" | "7d" | "30d"): Promise<EvolutionOverviewView>;
  metrics(instanceId?: string, range?: "24h" | "7d" | "30d"): Promise<EvolutionOverviewView>;
  failures(instanceId?: string, range?: "24h" | "7d" | "30d"): Promise<{ instanceId: string | null; source: EvolutionDataSource; items: EvolutionFailureView[] }>;
  datasets(instanceId?: string): Promise<{ instanceId: string | null; items: EvolutionDatasetView[] }>;
  actionItems(instanceId?: string): Promise<{ instanceId: string | null; items: EvolutionActionItemView[] }>;
  recheck(actionId: string): Promise<EvolutionActionItemView | { error: string; detail: string }>;
  analyze(instanceId?: string, range?: "24h" | "7d" | "30d"): Promise<EvolutionOverviewView>;
}

type LogDeps = {
  listSources(instanceId?: string): Array<{ id: string; path?: string }>;
  readTail(sourceId: string, instanceId?: string, limit?: number): { lines: string[] } | null;
};

const DATASET = "evolution-real";
const DATASET_VERSION = "v1";
const REQUIRED_HOLDOUT = 10;
const REQUIRED_SAMPLES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringValue(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim() ?? null;
}
function numberValue(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? null;
}
function outcomeOf(payload: Record<string, unknown>, type: string): EvolutionObservationRow["outcome"] {
  if (payload["success"] === true || payload["ok"] === true) return "success";
  if (payload["success"] === false || payload["ok"] === false) return "failure";
  const status = stringValue(payload["status"], payload["state"], payload["outcome"]);
  if (status && /^(success|succeeded|passed|done|completed|delivered|healthy|ok|accepted)$/i.test(status)) return "success";
  if (status && /^(fail|failed|error|rejected|cancelled|timeout|timed-out|down)$/i.test(status)) return "failure";
  if (/(failed|error|failure|rejected|timeout|timed?\s*out|失败|错误|超时)/i.test(type)) return "failure";
  if (/(completed|succeeded|success|passed|done|healthy|成功|完成)/i.test(type)) return "success";
  return "unknown";
}
function timestampOf(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function redact(value: string): string {
  return value.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/(?:[A-Za-z]:\\|\/home\/|\/Users\/|\/mnt\/)[^\s]+/g, "[PATH]")
    .replace(/(?:prompt|message|content|chat)\s*[:=][^\n]*/gi, "$&".replace(/[:=].*/, ": [REDACTED]"))
    .slice(0, 240);
}
function parseTimestamp(line: string, fallback: string): string {
  const match = line.match(/20\d\d[-/]\d\d?[-/]\d\d?(?:[T ]\d\d?:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?/);
  if (!match) return fallback;
  const parsed = Date.parse(match[0]!.replaceAll("/", "-"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}
function categoryOf(text: string, structured?: string | null): EvolutionFailureCategory {
  const value = `${structured ?? ""} ${text}`;
  if (/(exa[_ -]?api|chrome|browser|api[_ -]?key|credential|unauthori[sz]ed|forbidden|endpoint|network|dns|proxy|证书|密钥|凭据|浏览器|网络)/i.test(value)) return "environment-dependency";
  if (/(E202|E203|E204|timeout|timed\s*out|child process|subprocess|permission|denied|docker|wsl|oom|out of memory|disk full|ENOSPC|进程|权限|内存|磁盘)/i.test(value)) return "runtime";
  if (/(sample|holdout|dataset|duplicate|synthetic|数据集|样本|重复)/i.test(value)) return "dataset";
  if (/(metrics\.json|evaluator|candidate|improvement|regression|engine|评估器|候选|无提升|回归)/i.test(value)) return "engine";
  if (/(skill not found|target|path conflict|baseline changed|技能不存在|路径冲突|baseline.*changed)/i.test(value)) return "target";
  return "unknown";
}
function issueCategory(issue: LogIssueView): EvolutionFailureCategory { return categoryOf(`${issue.title} ${issue.detail}`, issue.kind); }
function actionTitle(category: EvolutionFailureCategory, title: string): string {
  if (category === "environment-dependency" && /exa/i.test(title)) return "配置 Exa 搜索凭据";
  if (category === "environment-dependency" && /chrome|browser/i.test(title)) return "启动 Chrome 后重新检查";
  if (category === "dataset") return "补充真实评估样本";
  if (category === "engine") return "检查进化引擎评估结果";
  return title;
}
function gainScore(status: string, improvement: number | null): number | null {
  if (status === "accepted" || status === "promoted") return 100;
  if (status === "kept-baseline" || improvement === 0) return 50;
  if (status === "rejected-regression") return 0;
  return null;
}
function quantile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? null;
}
function defaultInstance(core: Core, instanceId?: string): string | null {
  if (instanceId?.trim()) return instanceId.trim();
  const instances = core.instances.listInstances().filter((item) => item.rootPath !== "");
  return (instances.find((item) => item.state === "Serving") ?? instances[0])?.instanceId ?? null;
}

export function createEvolutionAnalyticsService(deps: {
  core: Core;
  evolution: EvolutionService;
  analyzeLogs: (instanceId?: string, range?: "24h" | "7d" | "30d") => LogAnalyzeView;
  logs?: LogDeps;
  skills?: SkillsMemoryService;
  now?: () => number;
}): EvolutionAnalyticsService {
  const now = deps.now ?? Date.now;
  const observedEventIds = new Set<string>();

  function observeStructuredEvent(event: { type: string; at: string; payload: unknown }): void {
    if (!isRecord(event.payload)) return;
    const payload = event.payload;
    const instanceId = stringValue(payload["instanceId"], payload["instance_id"]) ?? defaultInstance(deps.core) ?? "unknown";
    const sessionId = stringValue(payload["sessionId"], payload["session_id"]);
    const runId = stringValue(payload["runId"], payload["run_id"]);
    const tool = stringValue(payload["tool"], payload["toolName"], payload["function"], payload["skill"], payload["method"]);
    const kind: EvolutionObservationRow["kind"] = tool || /tool|function|skill/i.test(event.type) ? "tool" : sessionId ? "session" : "tool";
    const outcome = outcomeOf(payload, event.type);
    const detail = stringValue(payload["detail"], payload["error"], payload["summary"]) ?? "";
    const key = `structured:${event.type}:${event.at}:${sessionId ?? ""}:${runId ?? ""}:${tool ?? ""}:${outcome}`;
    if (observedEventIds.has(key)) return;
    observedEventIds.add(key);
    deps.core.store.saveEvolutionObservation({
      observationId: hash(key), instanceId, sessionId, runId, kind, name: tool,
      outcome, failureCategory: outcome === "failure" ? categoryOf(detail, stringValue(payload["errorCode"], payload["code"])) : null,
      durationMs: numberValue(payload["durationMs"], payload["duration_ms"]), occurredAt: timestampOf(payload["occurredAt"], event.at),
      source: "structured", detail: { summary: redact(detail), errorCode: stringValue(payload["errorCode"], payload["code"]) }, contentHash: hash(`${kind}:${tool ?? ""}:${outcome}:${redact(detail)}`),
    });
  }

  const unsubscribe = deps.core.bus.onAny((event) => observeStructuredEvent(event));
  void unsubscribe;

  function collectLogs(instanceId: string | null, range: "24h" | "7d" | "30d"): number {
    if (!deps.logs || !instanceId) return 0;
    const cutoff = now() - (range === "24h" ? 86_400_000 : range === "30d" ? 30 * 86_400_000 : 7 * 86_400_000);
    let count = 0;
    for (const source of deps.logs.listSources(instanceId)) {
      const tail = deps.logs.readTail(source.id, instanceId, 2_000);
      for (const line of tail?.lines ?? []) {
        const occurredAt = parseTimestamp(line, new Date(now()).toISOString());
        if (Date.parse(occurredAt) < cutoff) continue;
        const toolMatch = /(?:tool(?:\s+(?:call|invocation))?|function(?:\s+call)?|skill(?:Name|Ref)?)\s*[=: ]+([A-Za-z0-9._/-]+)/i.exec(line);
        const sessionMatch = /(?:session[_ -]?id|run[_ -]?id)\s*[=: ]+([A-Za-z0-9._/-]+)/i.exec(line);
        const isTool = toolMatch !== null || /(?:tool call|function call|技能)/i.test(line);
        const isSession = sessionMatch !== null && /(?:done|complete|success|failed|error|finish|完成|失败)/i.test(line);
        if (!isTool && !isSession) continue;
        const outcome = outcomeOf({}, line);
        const detail = redact(line);
        const kind: EvolutionObservationRow["kind"] = isTool ? "tool" : "session";
        const key = `log:${source.id}:${occurredAt}:${detail}`;
        const durationMatch = /(?:duration|latency|耗时)\s*[=: ]\s*(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(line);
        const durationMs = durationMatch === null ? null : Number(durationMatch[1]) * (durationMatch[2]?.toLowerCase() === "s" ? 1000 : 1);
        deps.core.store.saveEvolutionObservation({
          observationId: hash(key), instanceId, sessionId: sessionMatch?.[1] ?? null, runId: null,
          kind, name: toolMatch?.[1] ?? null, outcome, failureCategory: outcome === "failure" ? categoryOf(detail) : null,
          durationMs,
          occurredAt, source: "logs", detail: { summary: detail }, contentHash: hash(`${kind}:${detail}`),
        });
        count += 1;
      }
    }
    return count;
  }

  async function memoryOf(instanceId: string | null): Promise<EvolutionMemoryView> {
    if (!deps.skills || !instanceId) return { used: null, capacity: null, percent: null, unit: "entries", trend: [], source: "unavailable" };
    try {
      const status = await deps.skills.status({ instanceId });
      const used = status.memory.stats?.totalEntries ?? null;
      const capacity = 5_000;
      return { used, capacity, percent: used === null ? null : Math.min(100, Math.round((used / capacity) * 1000) / 10), unit: "entries", trend: used === null ? [] : [{ date: new Date(now()).toISOString().slice(0, 10), used, capacity }], source: "memory-service" };
    } catch { return { used: null, capacity: null, percent: null, unit: "entries", trend: [], source: "unavailable" }; }
  }

  function runsOf(status: ReturnType<EvolutionService["status"]>): EvolutionAnalyticsRunView[] {
    const tasks = new Map(status.tasks.map((task) => [task.runId, task]));
    return status.ledger.map((run: EvolutionLedgerSummary) => {
      const improvement = run.delta ?? null;
      const score = gainScore(run.status, improvement);
      const gate: EvolutionAnalyticsRunView["gate"] = score === null ? "not-scored" : run.status === "accepted" || run.status === "promoted" ? "accepted" : run.status === "rejected-regression" ? "rejected-regression" : "kept-baseline";
      const task = tasks.get(run.runId);
      const detail = improvement === 0 ? `未检测到提升（improvement=0），保留当前版本；holdout=${run.holdoutCount}` : run.disposition;
      return { runId: run.runId, updatedAt: run.updatedAt, status: run.status, holdout: run.holdoutCount, baseline: run.baselineMetric ?? null, candidate: run.candidateMetric ?? null, improvement, confidence: task?.metrics?.confidence ?? null, gainScore: score, gate, detail };
    });
  }

  function failuresOf(observations: EvolutionObservationRow[], issues: LogIssueView[], runs: EvolutionAnalyticsRunView[]): EvolutionFailureView[] {
    const buckets = new Map<string, EvolutionFailureView>();
    for (const observation of observations.filter((item) => item.outcome === "failure")) {
      const category = (observation.failureCategory as EvolutionFailureCategory | null) ?? "unknown";
      const title = observation.name ? `${observation.name} 调用失败` : "未归类失败";
      const key = `${category}:${title}`;
      const current = buckets.get(key) ?? { category, title, count: 0, impact: category === "environment-dependency" || category === "engine" ? "blocking" : "high", evidence: "结构化观测记录", source: observation.source, lastSeenAt: null };
      current.count += 1; current.lastSeenAt = current.lastSeenAt === null || current.lastSeenAt < observation.occurredAt ? observation.occurredAt : current.lastSeenAt;
      current.source = current.source === observation.source ? current.source : "mixed";
      buckets.set(key, current);
    }
    for (const issue of issues) {
      const category = issueCategory(issue);
      const title = issue.title;
      const key = `${category}:${title}`;
      const current = buckets.get(key) ?? { category, title, count: 0, impact: category === "environment-dependency" || category === "engine" ? "blocking" : issue.severity === "error" ? "high" : "medium", evidence: issue.detail, source: "logs", lastSeenAt: issue.lastSeenAt ?? null };
      current.count += issue.count; current.evidence = issue.detail; current.source = current.source === "logs" ? "logs" : "mixed";
      current.lastSeenAt = current.lastSeenAt === null || (issue.lastSeenAt ?? "") > current.lastSeenAt ? issue.lastSeenAt ?? null : current.lastSeenAt;
      buckets.set(key, current);
    }
    for (const run of runs.filter((item) => item.status === "rejected-regression" || item.status === "kept-baseline")) {
      const category: EvolutionFailureCategory = run.status === "rejected-regression" ? "engine" : "dataset";
      const title = run.status === "rejected-regression" ? "候选出现回归" : "未检测到提升";
      const key = `${category}:${title}`;
      const current = buckets.get(key) ?? { category, title, count: 0, impact: category === "engine" ? "blocking" : "medium", evidence: `improvement=${run.improvement ?? "未知"}，holdout=${run.holdout}`, source: "structured", lastSeenAt: run.updatedAt };
      current.count += 1; current.lastSeenAt = run.updatedAt; buckets.set(key, current);
    }
    return [...buckets.values()].sort((a, b) => b.count - a.count);
  }

  function syncActions(instanceId: string | null, failures: EvolutionFailureView[], dataset: EvolutionDatasetView): EvolutionActionItemView[] {
    if (!instanceId) return [];
    const nowIso = new Date(now()).toISOString();
    const items: EvolutionActionItemView[] = failures.map((failure) => {
      const actionId = hash(`${instanceId}:${failure.category}:${actionTitle(failure.category, failure.title)}`).slice(0, 16);
      const old = deps.core.store.getEvolutionActionItem(actionId);
      const item: EvolutionActionItemRow = {
        actionId, instanceId, category: failure.category, title: actionTitle(failure.category, failure.title), impact: failure.impact,
        firstSeenAt: old?.firstSeenAt ?? failure.lastSeenAt ?? nowIso, lastSeenAt: failure.lastSeenAt ?? nowIso, occurrences: (old?.occurrences ?? 0) + failure.count,
        relatedRuns: old?.relatedRuns ?? [], evidence: failure.evidence, nextAction: failure.category === "environment-dependency" && /exa/i.test(failure.title) ? "配置 EXA_API_KEY 后点击重新检查；Butler 不会写外部配置" : failure.category === "environment-dependency" && /chrome|browser/i.test(failure.title) ? "启动 Chrome 后点击重新检查" : failure.category === "dataset" ? `当前真实样本 ${dataset.realSamples} 条，还缺 ${dataset.gap} 条` : "查看证据并完成处理后重新检查",
        status: old?.status ?? "open", resolvedAt: old?.resolvedAt ?? null, updatedAt: nowIso,
      };
      return deps.core.store.upsertEvolutionActionItem(item);
    });
    if (dataset.realSamples < REQUIRED_SAMPLES) {
      const actionId = hash(`${instanceId}:dataset:sample-size`).slice(0, 16);
      const old = deps.core.store.getEvolutionActionItem(actionId);
      items.push(deps.core.store.upsertEvolutionActionItem({ actionId, instanceId, category: "dataset", title: "补充真实评估样本", impact: "blocking", firstSeenAt: old?.firstSeenAt ?? nowIso, lastSeenAt: nowIso, occurrences: (old?.occurrences ?? 0) + 1, relatedRuns: old?.relatedRuns ?? [], evidence: `真实样本 ${dataset.realSamples}/${REQUIRED_SAMPLES}；holdout ${dataset.holdoutCount}/${REQUIRED_HOLDOUT}`, nextAction: `再收集 ${Math.max(0, REQUIRED_SAMPLES - dataset.realSamples)} 条明确结果，不使用环境失败或合成样本`, status: old?.status ?? "open", resolvedAt: old?.resolvedAt ?? null, updatedAt: nowIso }));
    }
    return items;
  }

  async function build(instanceId?: string, range: "24h" | "7d" | "30d" = "7d"): Promise<EvolutionOverviewView> {
    const selected = defaultInstance(deps.core, instanceId);
    const cutoff = new Date(now() - (range === "24h" ? 86_400_000 : range === "30d" ? 30 * 86_400_000 : 7 * 86_400_000)).toISOString();
    const logCount = collectLogs(selected, range);
    const observations = selected ? deps.core.store.listEvolutionObservations({ instanceId: selected, since: cutoff }) : [];
    const structuredCount = observations.filter((item) => item.source === "structured").length;
    const logObservationCount = observations.filter((item) => item.source === "logs").length;
    const logs = deps.analyzeLogs(selected ?? undefined, range);
    const status = deps.evolution.status();
    const runs = runsOf(status);
    const tools = observations.filter((item) => item.kind === "tool");
    const sessions = observations.filter((item) => item.kind === "session");
    const sessionIds = new Set(sessions.map((item) => item.sessionId).filter((item): item is string => item !== null));
    const terminalSessions = sessions.filter((item) => item.outcome !== "unknown");
    const completedSessions = sessions.filter((item) => item.outcome === "success").length;
    const failedSessions = sessions.filter((item) => item.outcome === "failure").length;
    const successfulTools = tools.filter((item) => item.outcome === "success").length;
    const failedTools = tools.filter((item) => item.outcome === "failure").length;
    const unknownTools = tools.filter((item) => item.outcome === "unknown").length;
    const classifiedTools = successfulTools + failedTools;
    const reliability = classifiedTools ? successfulTools / classifiedTools : null;
    const completion = terminalSessions.length ? completedSessions / terminalSessions.length : null;
    const coverage = tools.length ? classifiedTools / tools.length : null;
    const totals: EvolutionMetricTotals = {
      sessions: sessionIds.size || sessions.length, completedSessions, failedSessions, terminalSessions: terminalSessions.length,
      toolCalls: tools.length, successfulToolCalls: successfulTools, failedToolCalls: failedTools, unknownToolCalls: unknownTools, classifiedToolCalls: classifiedTools,
      successRate: reliability, failureRate: classifiedTools ? failedTools / classifiedTools : null, p50DurationMs: quantile(tools.flatMap((item) => item.durationMs === null ? [] : [item.durationMs]), 0.5), p95DurationMs: quantile(tools.flatMap((item) => item.durationMs === null ? [] : [item.durationMs]), 0.95), reliability, completion, coverage,
      healthScore: tools.length >= 20 && completedSessions >= 5 && reliability !== null && completion !== null && coverage !== null ? Math.round((reliability * 0.6 + completion * 0.25 + coverage * 0.15) * 1000) / 10 : null,
      sampleStatus: tools.length >= 20 && completedSessions >= 5 ? "ready" : "insufficient",
    };
    for (const observation of tools.filter((item) => item.outcome === "success" || item.outcome === "failure")) {
      const category = observation.failureCategory;
      if (observation.outcome === "failure" && category === "environment-dependency") continue;
      const contentHash = observation.contentHash;
      const sample: EvolutionSampleRow = { sampleId: hash(`${selected ?? "unknown"}:${contentHash}`).slice(0, 16), instanceId: selected ?? "unknown", dataset: DATASET, outcome: observation.outcome === "success" ? "positive" : "negative", label: observation.name ?? "tool-result", contentHash, datasetVersion: DATASET_VERSION, synthetic: false, source: observation.source, createdAt: observation.occurredAt };
      deps.core.store.saveEvolutionSample(sample);
    }
    const samples = deps.core.store.listEvolutionSamples({ instanceId: selected ?? undefined, dataset: DATASET });
    const dataset: EvolutionDatasetView = { dataset: DATASET, version: DATASET_VERSION, realSamples: samples.filter((item) => !item.synthetic).length, positiveSamples: samples.filter((item) => !item.synthetic && item.outcome === "positive").length, negativeSamples: samples.filter((item) => !item.synthetic && item.outcome === "negative").length, holdoutCount: Math.min(REQUIRED_HOLDOUT, samples.filter((item) => !item.synthetic).length), requiredHoldout: REQUIRED_HOLDOUT, gap: Math.max(0, REQUIRED_SAMPLES - samples.filter((item) => !item.synthetic).length), completeness: structuredCount > 0 && logObservationCount > 0 ? "mixed" : structuredCount > 0 ? "structured" : logObservationCount > 0 ? "logs" : "incomplete", duplicateRate: null, lastCollectedAt: samples[0]?.createdAt ?? null, formalReady: samples.filter((item) => !item.synthetic).length >= REQUIRED_SAMPLES && samples.filter((item) => !item.synthetic).length >= REQUIRED_HOLDOUT };
    const failures = failuresOf(observations, logs.issues, runs);
    const actionItems = syncActions(selected, failures, dataset);
    const trendMap = new Map<string, { sessions: number; toolCalls: number; successes: number; classified: number }>();
    for (const observation of observations) { const date = observation.occurredAt.slice(0, 10); const point = trendMap.get(date) ?? { sessions: 0, toolCalls: 0, successes: 0, classified: 0 }; if (observation.kind === "session") point.sessions += 1; else { point.toolCalls += 1; if (observation.outcome !== "unknown") point.classified += 1; if (observation.outcome === "success") point.successes += 1; } trendMap.set(date, point); }
    const memory = await memoryOf(selected);
    const latestRun = runs[0] ?? null;
    const completedRuns = runs.filter((item) => ["accepted", "promoted", "kept-baseline", "rejected-regression"].includes(item.status));
    const successfulRuns = runs.filter((item) => ["accepted", "promoted"].includes(item.status));
    const durations = status.tasks.flatMap((task) => typeof task.metrics?.elapsedSeconds === "number" && Number.isFinite(task.metrics.elapsedSeconds) ? [task.metrics.elapsedSeconds] : []);
    const engine: EvolutionEngineView = { runCount: runs.length, completedRuns: completedRuns.length, successfulRuns: successfulRuns.length, successRate: completedRuns.length ? successfulRuns.length / completedRuns.length : null, averageDurationSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null, latest: latestRun ? { status: latestRun.status, improvement: latestRun.improvement, gainScore: latestRun.gainScore, detail: latestRun.detail } : null, timeline: runs.slice(0, 12).flatMap((run) => [{ runId: run.runId, at: run.updatedAt, stage: run.status === "preflight-failed" || run.status === "rejected-preflight" ? "blocked" as const : run.status === "ready" ? "preflight" as const : run.status === "running" ? "execute" as const : run.status === "evaluating" ? "evaluate" as const : run.status === "accepted" || run.status === "promoted" ? "accepted" as const : "evaluate" as const, status: run.status, detail: run.detail }]) };
    const source: EvolutionDataSource = structuredCount > 0 && logObservationCount > 0 ? "mixed" : structuredCount > 0 ? "structured" : logObservationCount > 0 || logCount > 0 ? "logs" : "incomplete";
    const statusValue: EvolutionOverviewView["status"] = !selected ? "offline" : totals.sampleStatus === "insufficient" ? "insufficient" : actionItems.some((item) => item.impact === "blocking" && item.status !== "resolved" && item.status !== "ignored") ? "blocked" : totals.healthScore !== null && totals.healthScore >= 85 ? "healthy" : "watch";
    const statusDetail = !selected ? "没有可用 Hermes 实例" : totals.sampleStatus === "insufficient" ? `样本不足：工具调用 ${totals.toolCalls}/20，完成会话 ${totals.completedSessions}/5` : statusValue === "blocked" ? "存在阻断进化的行动事项" : "观测数据持续更新中";
    const snapshot = { totals, source, dataset, engine, memory };
    if (selected) deps.core.store.upsertEvolutionDailyMetric({ instanceId: selected, date: new Date(now()).toISOString().slice(0, 10), snapshot });
    return { schemaVersion: "evolution-analytics.v1", instanceId: selected, range, analyzedAt: new Date(now()).toISOString(), source, completeness: { structuredObservations: structuredCount, logObservations: logObservationCount, note: source === "logs" ? "当前指标来自日志估算，字段不完整" : source === "incomplete" ? "尚未采集到足够观测" : "结构化观测优先，日志用于补充" }, status: statusValue, statusDetail, totals, trend: [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, item]) => ({ date, sessions: item.sessions, toolCalls: item.toolCalls, successRate: item.classified ? item.successes / item.classified : null })), failures, memory, evolution: engine, datasets: dataset, actionItems, runs };
  }

  return {
    overview: build,
    metrics: build,
    failures: async (instanceId, range = "7d") => { const view = await build(instanceId, range); return { instanceId: view.instanceId, source: view.source, items: view.failures }; },
    datasets: async (instanceId) => { const view = await build(instanceId, "7d"); return { instanceId: view.instanceId, items: [view.datasets] }; },
    actionItems: async (instanceId) => { const view = await build(instanceId, "7d"); return { instanceId: view.instanceId, items: view.actionItems }; },
    recheck: async (actionId) => {
      const item = deps.core.store.getEvolutionActionItem(actionId);
      if (!item) return { error: "action-not-found", detail: "行动事项不存在" };
      deps.core.store.updateEvolutionActionItemStatus(actionId, "checking");
      const view = await build(item.instanceId, "7d");
      const stillOpen = view.actionItems.some((candidate) => candidate.actionId === actionId && candidate.status !== "resolved" && candidate.status !== "ignored");
      return deps.core.store.updateEvolutionActionItemStatus(actionId, stillOpen ? "open" : "resolved") ?? item;
    },
    analyze: build,
  };
}
