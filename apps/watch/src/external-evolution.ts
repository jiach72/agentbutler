import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Core, InstanceRecord } from "@butler/core";
import type { SkillsMemoryService } from "./skills.js";
import type { BackupService } from "./backup.js";
import type { LlmCredentialService } from "@butler/core";

export type ExternalProposalStatus = "draft" | "validating" | "ready-to-apply" | "applied" | "failed";

export interface ExternalEvolutionTarget {
  targetRef: string;
  name: string;
  source: string;
  version: string;
  category: string;
  description: string;
  path: string;
  canApply: boolean;
}

export interface ExternalEvolutionProposal {
  id: string;
  targetRef: string;
  target: ExternalEvolutionTarget;
  problem: string;
  evidence: string[];
  profileId: string | null;
  generation: "manual" | "model";
  status: ExternalProposalStatus;
  createdAt: string;
  updatedAt: string;
  baselineHash: string;
  candidateHash: string;
  diff: string;
  candidatePath: string;
  validation: {
    status: "unknown" | "pass" | "fail";
    reason: string;
    fix: string;
    actions: string[];
  };
  apply: { appliedAt?: string; backupId?: number };
  sourceInsightId?: string;
  evidenceIssueIds?: string[];
}

export interface ExternalEvolutionService {
  targets(): Promise<ExternalEvolutionTarget[]>;
  create(input: { targetRef: string; problem: string; evidence?: string[]; profileId?: string; sourceInsightId?: string; evidenceIssueIds?: string[] }): Promise<ExternalEvolutionProposal | { error: string; detail: string; fix: string; actions: string[] }>;
  list(): ExternalEvolutionProposal[];
  get(id: string): ExternalEvolutionProposal | null;
  validate(id: string): Promise<ExternalEvolutionProposal | { error: string; detail: string; fix: string; actions: string[] }>;
  apply(id: string, confirmed: boolean): Promise<ExternalEvolutionProposal | { error: string; detail: string; fix: string; actions: string[] }>;
}

interface PersistedState { proposals: ExternalEvolutionProposal[] }

function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function inside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`..${sep}`));
}
function findSkillFile(root: string, name: string): string | null {
  const skillsRoot = join(root, "skills");
  if (!existsSync(skillsRoot)) return null;
  const visit = (dir: string, depth: number): string | null => {
    if (depth > 8) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === name && existsSync(join(path, "SKILL.md"))) return join(path, "SKILL.md");
        const nested = visit(path, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(skillsRoot, 0);
}
function chooseInstance(core: Core): InstanceRecord | undefined {
  const all = core.instances.listInstances().filter((item) => item.rootPath !== "");
  return all.find((item) => item.state === "Serving") ?? all[0];
}
function nowIso(now: () => number): string { return new Date(now()).toISOString(); }
function errorPayload(error: string, detail: string, fix: string, ...actions: string[]) { return { error, detail, fix, actions }; }

export function createExternalEvolutionService(deps: {
  core: Core;
  skills: SkillsMemoryService;
  backup?: BackupService;
  now?: () => number;
  llm?: LlmCredentialService;
}): ExternalEvolutionService {
  const now = deps.now ?? Date.now;
  const root = join(deps.core.paths.home, "evolution", "external-proposals");
  mkdirSync(root, { recursive: true });
  const statePath = join(root, "index.json");
  let state: PersistedState = { proposals: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")) as PersistedState; } catch { /* first run */ }
  if (!Array.isArray(state.proposals)) state = { proposals: [] };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

  const targets = async (): Promise<ExternalEvolutionTarget[]> => {
    const instance = chooseInstance(deps.core);
    if (!instance) return [];
    const view = await deps.skills.status({ instanceId: instance.instanceId });
    return view.skills.items
      .filter((item) => item.name !== "teams-meeting-pipeline" && item.version !== "解析失败")
      .map((item) => {
        const path = findSkillFile(instance.rootPath, item.name) ?? join(instance.rootPath, "skills", item.name, "SKILL.md");
        return {
          targetRef: item.name,
          name: item.name,
          source: item.source,
          version: item.version,
          category: item.category ?? "其他",
          description: item.description ?? "暂无简介",
          path,
          canApply: item.source !== "builtin" && existsSync(path),
        };
      });
  };

  const findTarget = async (targetRef: string): Promise<ExternalEvolutionTarget | null> => {
    const all = await targets();
    return all.find((item) => item.targetRef === targetRef || `${item.name}@${item.version}` === targetRef) ?? null;
  };

  return {
    targets,
    async create(input) {
      const problem = input.problem.trim();
      if (!problem) return errorPayload("invalid-problem", "请描述希望改进的问题", "补充可复现的问题、期望行为或限制", "返回编辑");
      const target = await findTarget(input.targetRef.trim());
      if (!target) return errorPayload("target-not-found", "技能不在当前 Hermes 清单中", "刷新技能清单后选择一个真实存在的技能", "刷新技能清单");
      if (!existsSync(target.path)) return errorPayload("target-unreadable", "技能定义文件不可读", "检查 Hermes skills 目录和文件权限", "检查 Hermes 实例");
      const baseline = readFileSync(target.path, "utf8");
      const id = randomUUID();
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      const candidate = `${baseline.trimEnd()}\n\n## Butler 外部改进提案\n\n<!-- problem -->\n${problem}\n<!-- /problem -->\n`;
      const candidatePath = join(dir, "SKILL.md");
      writeFileSync(candidatePath, candidate, { mode: 0o600 });
      const proposal: ExternalEvolutionProposal = {
        id,
        targetRef: target.targetRef,
        target,
        problem,
        evidence: (input.evidence ?? []).filter((item) => typeof item === "string").slice(0, 20),
        profileId: input.profileId ?? null,
        generation: "manual",
        status: "draft",
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        baselineHash: hashText(baseline),
        candidateHash: hashText(candidate),
        diff: `--- ${target.path}\n+++ ${candidatePath}\n@@\n+## Butler 外部改进提案\n+${problem}`,
        candidatePath,
        validation: { status: "unknown", reason: "尚未验证", fix: "运行隔离验证", actions: ["隔离验证"] },
        apply: {},
        ...(input.sourceInsightId ? { sourceInsightId: input.sourceInsightId } : {}),
        ...(input.evidenceIssueIds ? { evidenceIssueIds: input.evidenceIssueIds.slice(0, 20) } : {}),
      };
      state.proposals = [proposal, ...state.proposals].slice(0, 200);
      save();
      return proposal;
    },
    list() { return [...state.proposals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    get(id) { return state.proposals.find((item) => item.id === id) ?? null; },
    async validate(id) {
      const proposal = state.proposals.find((item) => item.id === id);
      if (!proposal) return errorPayload("proposal-not-found", "提案不存在", "返回提案列表并重新选择", "刷新提案");
      proposal.status = "validating";
      proposal.updatedAt = nowIso(now);
      save();
      const issues: string[] = [];
      let candidate = "";
      try { candidate = readFileSync(proposal.candidatePath, "utf8"); } catch { issues.push("候选文件不可读"); }
      if (!candidate.includes("SKILL.md") && !candidate.includes("---")) issues.push("缺少可识别的技能文档结构");
      if (/rm\s+-rf|curl\s+[^\n|]+\|\s*(sh|bash)|powershell\s+-enc/i.test(candidate)) issues.push("检测到高风险命令片段");
      const valid = issues.length === 0;
      proposal.validation = valid
        ? { status: "pass", reason: "结构和安全检查通过；未执行真实 Hermes 进程", fix: "无需修复", actions: ["查看差异", "应用到 Hermes"] }
        : { status: "fail", reason: issues.join("；"), fix: "编辑候选内容后重新验证", actions: ["编辑提案", "重新验证"] };
      proposal.status = valid ? "ready-to-apply" : "failed";
      proposal.updatedAt = nowIso(now);
      save();
      return proposal;
    },
    async apply(id, confirmed) {
      const proposal = state.proposals.find((item) => item.id === id);
      if (!proposal) return errorPayload("proposal-not-found", "提案不存在", "返回提案列表并重新选择", "刷新提案");
      if (!confirmed) return errorPayload("confirmation-required", "应用前需要用户确认", "确认后再次点击应用", "确认应用");
      if (proposal.status !== "ready-to-apply") return errorPayload("not-ready", "提案尚未验证通过", "先完成隔离验证", "隔离验证");
      if (proposal.target.source === "builtin" || !proposal.target.canApply) return errorPayload("target-readonly", "内置技能或不可写目标不能应用", "选择 user、market 或 self-evolved 技能", "返回技能清单");
      const currentTarget = (await targets()).find((item) => item.targetRef === proposal.targetRef);
      if (currentTarget === undefined || currentTarget.path !== proposal.target.path || !existsSync(currentTarget.path) || hashText(readFileSync(currentTarget.path, "utf8")) !== proposal.baselineHash) return errorPayload("baseline-changed", "Hermes 中的 baseline 已变化", "刷新并基于最新版本重新生成提案", "重新生成提案");
      if (deps.backup === undefined) return errorPayload("backup-unavailable", "应用前备份服务不可用", "先恢复 Butler 备份服务，再应用提案", "检查备份服务");
      let backupId: number | undefined;
      try {
        backupId = (await deps.backup.run("event", "应用技能改进提案 " + proposal.id)).id;
        const candidate = readFileSync(proposal.candidatePath, "utf8");
        if (!inside(proposal.candidatePath, root) || !inside(proposal.target.path, dirname(proposal.target.path))) throw new Error("path-not-allowed");
        const temp = `${proposal.target.path}.butler-${randomUUID()}.tmp`;
        writeFileSync(temp, candidate, { mode: 0o600 });
        renameSync(temp, proposal.target.path);
        proposal.status = "applied";
        proposal.apply = { appliedAt: nowIso(now), ...(backupId === undefined ? {} : { backupId }) };
        proposal.updatedAt = nowIso(now);
        deps.core.audit.append({ actor: "external-evolution", action: "proposal-applied", target: proposal.targetRef, detail: { proposalId: proposal.id, backupId, baselineHash: proposal.baselineHash, candidateHash: proposal.candidateHash } });
        save();
        return proposal;
      } catch (error) {
        return errorPayload("apply-failed", error instanceof Error ? error.message : String(error), "检查备份目录、文件权限和 Hermes 目标路径", "重试应用");
      }
    },
  };
}
