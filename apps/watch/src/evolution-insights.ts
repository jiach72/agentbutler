import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, type Core } from "@butler/core";
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
  optimization?: {
    goal: string;
    changes: string[];
    expectedResult: string;
    generatedAt: string;
    generatedBy: "rules" | "model";
  };
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
  execution?: {
    kind: "run" | "proposal";
    id: string;
    status?: string;
    updatedAt?: string;
    detail?: string;
  };
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
  if (issue.kind === "tool-failure")
    return "同一技能或工具调用反复失败，建议优化错误处理、输入约束或重试策略。";
  if (issue.kind === "trajectory-interrupted")
    return "执行轨迹多次中断，建议补充恢复路径、超时处理和阶段性检查点。";
  if (issue.kind === "quality-loop")
    return "输出质量反复修正，建议优化提示词约束、格式校验和验收条件。";
  return issue.detail;
}

function localOptimization(
  issue: LogIssueView,
  direction: EvolutionDirection,
  generatedAt: string,
): EvolutionDirection["optimization"] {
  const target = direction.targetRef ?? "待确认的技能";
  const changes =
    issue.kind === "tool-failure"
      ? [
          "补充输入参数校验和失败分支处理",
          "增加可控重试与错误信息记录",
          "针对 " + target + " 增加一次隔离回归检查",
        ]
      : issue.kind === "trajectory-interrupted"
        ? [
            "增加阶段性状态保存和恢复入口",
            "为长任务补充超时与中断处理",
            "对 " + target + " 的关键步骤增加可观测日志",
          ]
        : [
            "收紧输出格式和验收条件",
            "增加结果校验，减少重复修正",
            "为 " + target + " 补充边界样例",
          ];
  return {
    goal: "降低“" + issue.title + "”的重复出现，保持现有正常行为不变。",
    changes,
    expectedResult: "隔离验证通过后再应用；若验证失败，保留当前版本并提供失败原因。",
    generatedAt,
    generatedBy: "rules",
  };
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
  const detectedSkill = legacy ? null : (issue.skill ?? null);
  const skill = detectedSkill !== null && skills.includes(detectedSkill) ? detectedSkill : null;
  const targetType: DirectionTargetType = legacy
    ? "diagnostic"
    : issue.kind === "quality-loop"
      ? "prompt"
      : "skill";
  const candidates =
    !isEvolutionSignal(issue) || skill || legacy
      ? []
      : skills.filter((name) => !name.includes("teams-meeting-pipeline")).slice(0, 8);
  const blocked = legacy || !isEvolutionSignal(issue) || skill === null;
  const blockReason =
    issue.skill === "teams-meeting-pipeline"
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
    recommendedAction: legacy
      ? "仅保留历史记录，不可重试"
      : isEvolutionSignal(issue)
        ? skill
          ? "确认方向后选择执行方式"
          : "选择关联技能后再确认"
        : "前往日志页执行修复建议",
    issueIds: [issue.id],
    candidateSkills: candidates,
    confirmedAt: null,
    executionMode: null,
  };
}

export interface EvolutionInsightsService {
  analyze(instanceId?: string, range?: InsightRange): Promise<EvolutionInsightsView>;
  get(id: string): EvolutionDirection | null;
  summarize(
    id: string,
    profileId?: string,
  ): Promise<EvolutionDirection | { error: string; detail: string; fix: string }>;
  confirm(
    id: string,
    targetRef?: string,
  ): EvolutionDirection | { error: string; detail: string; fix: string };
  start(
    id: string,
    input: { mode: ExecutionMode; targetRef?: string; profileId?: string; instanceId?: string },
  ): Promise<
    | EvolutionDirection
    | EvolutionRunView
    | ExternalEvolutionProposal
    | { error: string; detail: string; fix?: string; actions?: string[] }
  >;
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
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {
    /* first run */
  }
  if (!Array.isArray(state.directions)) state = { directions: [] };
  const save = () => atomicWriteJson(statePath, state, { mode: 0o600, description: "进化洞察状态" });

  const analyze = async (
    instanceId?: string,
    range: InsightRange = "7d",
  ): Promise<EvolutionInsightsView> => {
    const analyzed = deps.analyzeLogs(instanceId, range);
    const skillView = await deps.skills.status({ instanceId });
    const names = skillView.skills.items
      .map((item) => item.name)
      .filter((name) => name !== "teams-meeting-pipeline");
    const directions = analyzed.issues
      .map((issue) => directionFrom(issue, names))
      .sort((a, b) => {
        const impactRank = { high: 3, medium: 2, low: 1 } as const;
        return (
          impactRank[b.impact] - impactRank[a.impact] ||
          b.occurrences - a.occurrences ||
          (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")
        );
      });
    state.directions = directions.map((direction) => {
      const old = state.directions.find((item) => item.id === direction.id);
      return old
        ? {
            ...direction,
            confirmedAt: old.confirmedAt,
            executionMode: old.executionMode,
            execution: old.execution,
            optimization: old.optimization,
          }
        : direction;
    });
    save();
    return {
      instanceId: instanceId ?? null,
      range,
      coverage: analyzed.coverage,
      issues: analyzed.issues,
      directions: state.directions,
      analyzedAt: analyzed.analyzedAt,
    };
  };

  const get = (id: string) => state.directions.find((item) => item.id === id) ?? null;

  return {
    analyze,
    get,
    async summarize(id, profileId) {
      const direction = get(id);
      if (!direction)
        return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      void profileId;
      const analyzed = deps.analyzeLogs(undefined, "7d");
      const issue =
        direction.issueIds.length > 0
          ? analyzed.issues.find((item) => item.id === direction.issueIds[0])
          : undefined;
      const generatedAt = new Date(now()).toISOString();
      const baseIssue =
        issue ??
        ({
          kind: direction.targetType === "prompt" ? "quality-loop" : "tool-failure",
          title: direction.title,
          detail: direction.summary,
          count: direction.occurrences,
          severity: direction.impact === "high" ? "error" : "warn",
          sources: direction.sources,
          examples: direction.examples,
          id: direction.issueIds[0] ?? direction.id,
        } as LogIssueView);
      // 当前实现使用本地规则生成可执行说明；模型 profile 仅作为后续扩展入口，不伪造模型结论。
      direction.optimization = localOptimization(baseIssue, direction, generatedAt);
      save();
      return direction;
    },
    confirm(id, targetRef) {
      const direction = get(id);
      if (!direction)
        return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      if (direction.targetType !== "skill" && direction.targetType !== "prompt")
        return {
          error: "not-evolvable",
          detail: "该项是系统修复建议，不能确认进化",
          fix: "前往日志页处理系统问题",
        };
      if (direction.targetRef === null && (!targetRef || !targetRef.trim()))
        return {
          error: "target-selection-required",
          detail: direction.blockReason ?? "需要选择技能",
          fix: "从候选技能中选择一个真实存在的技能",
        };
      if (targetRef) {
        if (!direction.candidateSkills.includes(targetRef) && direction.targetRef !== targetRef)
          return {
            error: "target-not-candidate",
            detail: "所选技能不在当前清单中",
            fix: "刷新技能清单后重新选择",
          };
        direction.targetRef = targetRef;
        direction.blocked = false;
        direction.blockReason = null;
      }
      direction.confirmedAt = new Date(now()).toISOString();
      deps.core.audit.append({
        actor: "evolution-insights",
        action: "direction-confirmed",
        target: direction.targetRef ?? direction.id,
        detail: {
          directionId: id,
          confirmedAt: direction.confirmedAt,
          issueIds: direction.issueIds,
        },
      });
      save();
      return direction;
    },
    async start(id, input) {
      const direction = get(id);
      if (!direction)
        return { error: "direction-not-found", detail: "改进方向不存在", fix: "重新扫描日志" };
      if (!direction.confirmedAt)
        return {
          error: "confirmation-required",
          detail: "请先确认这个改进方向",
          fix: "点击“确认这个方向”后再执行",
        };
      const targetRef = input.targetRef?.trim() || direction.targetRef;
      if (!targetRef)
        return {
          error: "target-selection-required",
          detail: "执行前必须选择技能",
          fix: "选择候选技能后重新确认",
        };
      direction.executionMode = input.mode;
      if (input.mode === "manual") {
        const problem = direction.optimization
          ? direction.summary +
            "\n优化目标：" +
            direction.optimization.goal +
            "\n建议改动：" +
            direction.optimization.changes.join("；") +
            "\n预期结果：" +
            direction.optimization.expectedResult
          : direction.summary;
        const proposal = await deps.externalEvolution.create({
          targetRef,
          problem,
          evidence: direction.examples,
          profileId: input.profileId,
          sourceInsightId: id,
          evidenceIssueIds: direction.issueIds,
        });
        if ("error" in proposal) return proposal;
        direction.execution = {
          kind: "proposal",
          id: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
          detail: "已生成可编辑方案，等待隔离验证",
        };
        direction.blocked = false;
        save();
        return proposal;
      }
      const run = await deps.evolution.createRun({
        targetType: direction.targetType === "prompt" ? "prompt" : "skill",
        targetRef,
        instanceId: input.instanceId,
        profileId: input.profileId,
        dryRun: true,
      });
      if (run.status !== "ready") return run;
      if (!("runId" in run)) return run;
      const started = await deps.evolution.startRun(run.runId);
      if ("runId" in started)
        direction.execution = {
          kind: "run",
          id: started.runId,
          status: started.status,
          updatedAt: started.updatedAt,
          detail: started.detail,
        };
      direction.blocked = false;
      save();
      return started;
    },
  };
}
