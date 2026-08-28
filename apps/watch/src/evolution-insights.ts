import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "@butler/core";
import type { EvolutionService, EvolutionRunView } from "./evolution.js";
import type { ExternalEvolutionProposal, ExternalEvolutionService } from "./external-evolution.js";
import type { LogAnalyzeView, LogIssueView } from "./log-analyzer.js";
import type { SkillsMemoryService } from "./skills.js";

export type InsightRange = "24h" | "7d" | "30d";
export type DirectionTargetType = "skill" | "prompt" | "config" | "diagnostic";
export type ExecutionMode = "hermes" | "manual";

export interface EvolutionDirection {
  id: string;
  targetType: DirectionTargetType;
  targetRef: string | null;
  title: string;
  summary: string;
  impact: "high" | "medium" | "low";
  confidence: number;
  occurrences: number;
  lastSeenAt: string | null;
  sources: string[];
  examples: string[];
  blocked: boolean;
  blockReason: string | null;
  recommendedAction: string;
  issueIds: string[];
  candidateSkills: string[];
  confirmedAt: string | null;
  executionMode: ExecutionMode | null;
  execution?: { kind: "run" | "proposal"; id: string; status?: string };
}

export interface EvolutionInsightsView {
  instanceId: string | null;
  range: InsightRange;
  coverage: LogAnalyzeView["coverage"];
  issues: LogIssueView[];
  directions: EvolutionDirection[];
  analyzedAt: string;
}

type State = { directions: EvolutionDirection[] };

function localSummary(issue: LogIssueView): string {
  if (issue.kind === "tool-failure") return "同一技能或工具调用反复失败，建议优化错误处理、输入约束或重试策略。";
  if (issue.kind === "trajectory-interrupted") return "执行轨迹多次中断，建议补充恢复路径、超时处理和阶段性检查点。";
  if (issue.kind === "quality-loop") return "输出质量反复修正，建议优化提示词约束、格式校验和验收条件。";
  return issue.detail;
}

function isEvolutionSignal(issue: LogIssueView): boolean {
  return ["tool-failure", "trajectory-interrupted", "quality-loop"].includes(issue.kind);
}

function impactOf(issue: LogIssueView): EvolutionDirection["impact"] {
  if (issue.severity === "error" && issue.count >= 5) return "high";
  if (issue.severity === "error" || issue.count >= 3) return "medium";
  return "low";
}

export function directionFrom(issue: LogIssueView, skills: string[]): EvolutionDirection {
  const legacy = issue.skill === "teams-meeting-pipeline";
  const detectedSkill = legacy ? null : issue.skill ?? null;
  const skill = detectedSkill !== null && skills.includes(detectedSkill) ? detectedSkill : null;
  const targetType: DirectionTargetType = legacy ? "diagnostic" : issue.kind === "quality-loop" ? "prompt" : "skill";
  const candidates = skill || legacy ? [] : skills.filter((name) => !name.includes("teams-meeting-pipeline")).slice(0, 8);
  const blocked = legacy || !isEvolutionSignal(issue) || skill === null;
  const blockReason = issue.skill === "teams-meeting-pipeline"
    ? "历史目标 teams-meeting-pipeline 已不存在，不可重试。"
    : detectedSkill !== null && skill === null
      ? "日志提取到的技能不在当前 Hermes 清单中，需要刷新清单并人工选择。"
    : !isEvolutionSignal(issue)
      ? "这是系统修复信号，不属于技能进化；请先处理日志页提供的修复建议。"
    : skill === null
      ? "日志未能定位具体技能，需要客户从候选技能中选择后才能执行。"
      : null;
  return {
    id: `insight-${issue.id}`,
    targetType: legacy ? "diagnostic" : isEvolutionSignal(issue) ? targetType : "config",
    targetRef: skill,
    title: issue.title,
    summary: localSummary(issue),
    impact: impactOf(issue),
    confidence: Math.min(0.98, 0.42 + Math.min(issue.count, 8) * 0.07 + (skill ? 0.15 : 0)),
    occurrences: issue.count,
    lastSeenAt: issue.lastSeenAt ?? null,
    sources: issue.sources,
    examples: issue.examples.slice(0, 2),
    blocked,
    blockReason,
    recommendedAction: legacy ? "仅保留历史记录，不可重试" : isEvolutionSignal(issue) ? (skill ? "确认方向后选择执行方式" : "选择关联技能后再确认") : "前往日志页执行修复建议",
    issueIds: [issue.id],
    candidateSkills: candidates,
    confirmedAt: null,
    executionMode: null,
  };
}

export interface EvolutionInsightsService {
  analyze(instanceId?: string, range?: InsightRange): Promise<EvolutionInsightsView>;
  get(id: string): EvolutionDirection | null;
  summarize(id: string, profileId?: string): Promise<EvolutionDirection | { error: string; detail: string; fix: string }>;
  confirm(id: string, targetRef?: string): EvolutionDirection | { error: string; detail: string; fix: string };
  start(id: string, input: { mode: ExecutionMode; targetRef?: string; profileId?: string; instanceId?: string }): Promise<EvolutionDirection | EvolutionRunView | ExternalEvolutionProposal | { error: string; detail: string; fix?: string; actions?: string[] }>;
}

export function createEvolutionInsightsService(deps: {
  core: Core;
  analyzeLogs: (instanceId?: string, range?: InsightRange) => LogAnalyzeView;
  evolution: EvolutionService;
  externalEvolution: ExternalEvolutionService;
  skills: SkillsMemoryService;
  now?: () => number;
}): EvolutionInsightsService {
  const now = deps.now ?? Date.now;
  const root = join(deps.core.paths.home, "evolution", "insights");
  mkdirSync(root, { recursive: true });
  const statePath = join(root, "index.json");
  let state: State = { directions: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")) as State; } catch { /* first run */ }
  if (!Array.isArray(state.directions)) state = { directions: [] };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

  const analyze = async (instanceId?: string, range: InsightRange = "7d"): Promise<EvolutionInsightsView> => {
    const analyzed = deps.analyzeLogs(instanceId, range);
    const skillView = await deps.skills.status({ instanceId });
    const names = skillView.skills.items.map((item) => item.name).filter((name) => name !== "teams-meeting-pipeline");
    const directions = analyzed.issues.map((issue) => directionFrom(issue, names)).sort((a, b) => {
      const impactRank = { high: 3, medium: 2, low: 1 } as const;
      return impactRank[b.impact] - impactRank[a.impact] || b.occurrences - a.occurrences || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
    });
    state.directions = directions.map((direction) => {
      const old = state.directions.find((item) => item.id === direction.id);
      return old ? { ...direction, confirmedAt: old.confirmedAt, executionMode: old.executionMode, execution: old.execution } : direction;
    });
    save();
    return { instanceId: instanceId ?? null, range, coverage: analyzed.coverage, issues: analyzed.issues, directions: state.directions, analyzedAt: analyzed.analyzedAt };
  };

  const get = (id: string) => state.directions.find((item) => item.id === id) ?? null;

  return {
    analyze,
    get,
    async summarize(id, profileId) {
      const direction = get(id);
      if (!direction) return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      // 模型调用保持显式可选；未配置或探针失败时继续使用本地规则总结。
      if (!profileId) return direction;
      // 当前版本仅保留本地规则结果，避免在模型不可用时伪造“已生成”结论。
      return { ...direction, summary: `${direction.summary}（已保留本地规则总结；模型 profile ${profileId} 需在设置中完成探针后再使用）` };
    },
    confirm(id, targetRef) {
      const direction = get(id);
      if (!direction) return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      if (direction.targetType !== "skill" && direction.targetType !== "prompt") return { error: "not-evolvable", detail: "该项是系统修复建议，不能确认进化", fix: "前往日志页处理系统问题" };
      if (direction.targetRef === null && (!targetRef || !targetRef.trim())) return { error: "target-selection-required", detail: direction.blockReason ?? "需要选择技能", fix: "从候选技能中选择一个真实存在的技能" };
      if (targetRef) {
        if (!direction.candidateSkills.includes(targetRef) && direction.targetRef !== targetRef) return { error: "target-not-candidate", detail: "所选技能不在当前清单中", fix: "刷新技能清单后重新选择" };
        direction.targetRef = targetRef;
        direction.blocked = false;
        direction.blockReason = null;
      }
      direction.confirmedAt = new Date(now()).toISOString();
      deps.core.audit.append({ actor: "evolution-insights", action: "direction-confirmed", target: direction.targetRef ?? direction.id, detail: { directionId: id, confirmedAt: direction.confirmedAt, issueIds: direction.issueIds } });
      save();
      return direction;
    },
    async start(id, input) {
      const direction = get(id);
      if (!direction) return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      if (!direction.confirmedAt) return { error: "confirmation-required", detail: "请先确认这个改进方向", fix: "点击“确认这个方向”后再执行" };
      const targetRef = input.targetRef?.trim() || direction.targetRef;
      if (!targetRef) return { error: "target-selection-required", detail: "执行前必须选择技能", fix: "选择候选技能后重新确认" };
      direction.executionMode = input.mode;
      if (input.mode === "manual") {
        const proposal = await deps.externalEvolution.create({ targetRef, problem: direction.summary, evidence: direction.examples, profileId: input.profileId, sourceInsightId: id, evidenceIssueIds: direction.issueIds });
        if ("error" in proposal) return proposal;
        direction.execution = { kind: "proposal", id: proposal.id, status: proposal.status };
        direction.blocked = false;
        save();
        return proposal;
      }
      const run = await deps.evolution.createRun({ targetType: direction.targetType === "prompt" ? "prompt" : "skill", targetRef, instanceId: input.instanceId, profileId: input.profileId, dryRun: true });
      if (run.status !== "ready") return run;
      if (!("runId" in run)) return run;
      const started = await deps.evolution.startRun(run.runId);
      if ("runId" in started) direction.execution = { kind: "run", id: started.runId, status: started.status };
      direction.blocked = false;
      save();
      return started;
    },
  };
}
