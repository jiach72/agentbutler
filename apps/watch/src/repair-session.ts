/**
 * 后台修复会话。
 *
 * 会话只接收脱敏诊断、固定动作目录和受限执行器；它不传递任意命令、路径、
 * PID 或 Docker 参数。未来 Hermes/OpenClaw 若提供专用的后台诊断 API，可通过
 * RepairAdvisor 接入，但 advisor 始终只能提出本模块白名单里的动作。
 */
import { randomUUID } from "node:crypto";

export type RepairSessionStatus =
  | "collecting"
  | "awaiting-approval"
  | "applying"
  | "verifying"
  | "done"
  | "blocked"
  | "failed";

export interface RepairAction {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  impact: string;
  estimatedSeconds: number;
  requiresConfirmation: boolean;
  available: boolean;
}

export interface RepairDiagnosis {
  incidentId: string;
  severity: "ok" | "warn" | "error";
  summary: string;
  safeToRetry: boolean;
  rootCause: string | null;
  primaryFinding: {
    title: string;
    detail: string;
    suggestedAction: "rb-restart" | "rb-reconnect" | null;
    evidence: {
      source: string | null;
      kind: string;
      lastSeenLabel: string | null;
      occurrences: number;
    };
  } | null;
  probes: Array<{ id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }>;
  recommendedActions: RepairAction[];
  checkedAt: string;
}

export interface RepairJob {
  jobId: string;
  status: "running" | "done" | "failed" | "unknown";
  detail: string;
}

export interface RepairPlanView {
  actionId: string;
  label: string;
  description: string;
  impact: string;
  approvalRequired: boolean;
  source: "deterministic-policy" | "background-advisor";
}

export interface RepairVerificationView {
  status: "pending" | "passed" | "failed" | "not-needed";
  summary: string;
  checkedAt: string | null;
  probes: Array<{ label: string; status: "pass" | "warn" | "fail"; detail: string }>;
}

export interface RepairSessionView {
  sessionId: string;
  instanceId: string | null;
  status: RepairSessionStatus;
  progress: number;
  detail: string;
  diagnosis: RepairDiagnosis | null;
  plan: RepairPlanView | null;
  changes: string[];
  verification: RepairVerificationView;
  advisor: {
    source: "deterministic-policy" | "background-advisor";
    promptDispatched: boolean;
    detail: string;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RepairRecommendation {
  actionId: string | null;
  source: "deterministic-policy" | "background-advisor";
  /** 仅用于审计；任何 prompt 正文都不能进入这里。 */
  promptDispatched: boolean;
  detail: string;
}

/**
 * 可选的后台顾问接口。实现者只能返回 actionId，不能夹带 shell、路径或补丁文本。
 */
export interface RepairAdvisor {
  recommend(input: { diagnosis: RepairDiagnosis; actions: RepairAction[] }): Promise<RepairRecommendation>;
}

export interface RepairActionExecution {
  ok: boolean;
  detail: string;
  changes: string[];
  jobId?: string;
}

export interface RepairSessionDeps {
  diagnose(instanceId?: string): Promise<RepairDiagnosis>;
  actions(instanceId?: string): RepairAction[];
  execute(actionId: string, instanceId?: string): Promise<RepairActionExecution>;
  getJob(jobId: string): RepairJob | undefined;
  advisor?: RepairAdvisor;
  audit?: { append(entry: { actor: string; action: string; target?: string; detail?: unknown }): void };
  now?: () => Date;
  pollMs?: number;
  verificationTimeoutMs?: number;
}

const REPAIR_ACTOR = "recovery-session";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function isTerminal(status: RepairSessionStatus): boolean {
  return status === "done" || status === "blocked" || status === "failed";
}

function planForAction(action: RepairAction, source: RepairRecommendation["source"]): RepairPlanView {
  return {
    actionId: action.id,
    label: action.label,
    description: action.description,
    impact: action.impact,
    approvalRequired: action.requiresConfirmation,
    source,
  };
}

/** 默认策略按现有诊断字段将根因映射回固定动作目录，不执行自由文本。 */
export function createDeterministicRepairAdvisor(): RepairAdvisor {
  return {
    async recommend({ diagnosis, actions }): Promise<RepairRecommendation> {
      if (diagnosis.severity === "ok") {
        return {
          actionId: null,
          source: "deterministic-policy",
          promptDispatched: false,
          detail: "所有检查已通过，不需要变更。",
        };
      }

      const actionById = new Map(actions.filter((action) => action.available).map((action) => [action.id, action]));
      const candidates: string[] = [];
      if (diagnosis.primaryFinding?.suggestedAction === "rb-reconnect") candidates.push("reconnect-channel");
      if (diagnosis.primaryFinding?.suggestedAction === "rb-restart") candidates.push("restart-instance");
      if (diagnosis.primaryFinding?.evidence.kind === "rate-limit") candidates.push("apply-throttle-patch");
      if (diagnosis.primaryFinding?.evidence.kind === "memory") candidates.push("rebuild-memory-index");
      if (diagnosis.probes.some((probe) => probe.id === "connection" && probe.status === "fail")) {
        candidates.unshift("reconnect-channel", "cleanup-gateway");
      }
      candidates.push("cleanup-gateway", "restart-instance");

      const actionId = candidates.find((id) => actionById.has(id)) ?? null;
      return {
        actionId,
        source: "deterministic-policy",
        promptDispatched: false,
        detail: actionId === null
          ? "没有与当前根因匹配且可安全执行的受限动作。"
          : "已按诊断证据匹配到受限修复动作。",
      };
    },
  };
}

export class RepairSessionService {
  private readonly sessions = new Map<string, RepairSessionView>();
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly advisor: RepairAdvisor;

  constructor(private readonly deps: RepairSessionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollMs = Math.max(50, deps.pollMs ?? DEFAULT_POLL_MS);
    this.verificationTimeoutMs = Math.max(1_000, deps.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
    this.advisor = deps.advisor ?? createDeterministicRepairAdvisor();
  }

  start(instanceId?: string): RepairSessionView {
    const sessionId = `repair-${randomUUID()}`;
    const createdAt = isoNow(this.now);
    const session: RepairSessionView = {
      sessionId,
      instanceId: instanceId ?? null,
      status: "collecting",
      progress: 8,
      detail: "正在采集当前状态和可验证证据",
      diagnosis: null,
      plan: null,
      changes: [],
      verification: { status: "pending", summary: "等待诊断完成", checkedAt: null, probes: [] },
      advisor: {
        source: "deterministic-policy",
        promptDispatched: false,
        detail: "尚未生成修复计划。",
      },
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
    };
    this.sessions.set(sessionId, session);
    this.appendAudit("repair-session-started", session, {});
    void this.collect(sessionId);
    return structuredClone(session);
  }

  get(sessionId: string): RepairSessionView | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  approve(sessionId: string): RepairSessionView | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== "awaiting-approval") return session === undefined ? undefined : structuredClone(session);
    void this.apply(sessionId);
    return structuredClone(session);
  }

  private update(session: RepairSessionView, patch: Partial<RepairSessionView>): void {
    Object.assign(session, patch, { updatedAt: isoNow(this.now) });
  }

  private complete(session: RepairSessionView, status: Extract<RepairSessionStatus, "done" | "blocked" | "failed">, detail: string): void {
    this.update(session, { status, progress: status === "done" ? 100 : Math.max(session.progress, 90), detail, finishedAt: isoNow(this.now) });
    this.appendAudit(`repair-session-${status}`, session, { detail, actionId: session.plan?.actionId ?? null });
  }

  private appendAudit(action: string, session: RepairSessionView, detail: Record<string, unknown>): void {
    this.deps.audit?.append({
      actor: REPAIR_ACTOR,
      action,
      target: session.instanceId ?? "default",
      detail: { sessionId: session.sessionId, ...detail },
    });
  }

  private async collect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || isTerminal(session.status)) return;
    try {
      const diagnosis = await this.deps.diagnose(session.instanceId ?? undefined);
      const actions = this.deps.actions(session.instanceId ?? undefined);
      const recommendation = await this.advisor.recommend({ diagnosis, actions });
      const action = recommendation.actionId === null ? undefined : actions.find((item) => item.id === recommendation.actionId && item.available);
      this.update(session, {
        diagnosis,
        progress: 42,
        detail: diagnosis.rootCause === null ? diagnosis.summary : `已定位：${diagnosis.rootCause}`,
        advisor: {
          source: recommendation.source,
          promptDispatched: recommendation.promptDispatched,
          detail: recommendation.detail,
        },
      });

      if (action === undefined) {
        if (diagnosis.severity === "ok") {
          this.update(session, {
            verification: { status: "not-needed", summary: "所有检查已通过，无需执行修复。", checkedAt: diagnosis.checkedAt, probes: diagnosis.probes },
          });
          this.complete(session, "done", "当前状态正常，无需变更。");
        } else {
          this.update(session, {
            verification: { status: "failed", summary: "没有匹配到可安全执行的受限动作。", checkedAt: diagnosis.checkedAt, probes: diagnosis.probes },
          });
          this.complete(session, "blocked", "已定位问题，但没有可安全自动执行的修复方案。");
        }
        return;
      }

      const plan = planForAction(action, recommendation.source);
      this.update(session, { plan, progress: 58 });
      this.appendAudit("repair-session-planned", session, {
        actionId: action.id,
        approvalRequired: action.requiresConfirmation,
        advisor: recommendation.source,
        promptDispatched: recommendation.promptDispatched,
      });
      if (action.requiresConfirmation) {
        this.update(session, {
          status: "awaiting-approval",
          detail: `已定位根因，建议${action.label}。${action.impact}，需要确认后执行。`,
        });
        return;
      }
      await this.apply(sessionId);
    } catch (error) {
      this.complete(session, "failed", `诊断会话失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async apply(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.plan === null || isTerminal(session.status)) return;
    try {
      this.update(session, { status: "applying", progress: 68, detail: `正在执行${session.plan.label}` });
      this.appendAudit("repair-session-applying", session, { actionId: session.plan.actionId });
      const outcome = await this.deps.execute(session.plan.actionId, session.instanceId ?? undefined);
      if (!outcome.ok) {
        this.complete(session, "failed", outcome.detail);
        return;
      }
      this.update(session, { changes: outcome.changes, progress: 80, detail: outcome.detail });
      if (outcome.jobId !== undefined) {
        const complete = await this.waitForJob(outcome.jobId);
        if (!complete.ok) {
          this.complete(session, "failed", complete.detail);
          return;
        }
      }
      await this.verify(session);
    } catch (error) {
      this.complete(session, "failed", `修复执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async waitForJob(jobId: string): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + this.verificationTimeoutMs;
    while (Date.now() < deadline) {
      const job = this.deps.getJob(jobId);
      if (job === undefined) return { ok: false, detail: "修复任务状态已丢失，无法继续复验。" };
      if (job.status === "done") return { ok: true, detail: job.detail };
      if (job.status === "failed" || job.status === "unknown") return { ok: false, detail: job.detail };
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
    }
    return { ok: false, detail: "修复任务超时，未能取得可验证的结果。" };
  }

  private async verify(session: RepairSessionView): Promise<void> {
    this.update(session, { status: "verifying", progress: 92, detail: "正在复验根因是否消失" });
    const diagnosis = await this.deps.diagnose(session.instanceId ?? undefined);
    const verification: RepairVerificationView = {
      status: diagnosis.severity === "ok" ? "passed" : "failed",
      summary: diagnosis.severity === "ok"
        ? "复验通过，所有检查已恢复正常。"
        : diagnosis.rootCause ?? diagnosis.primaryFinding?.title ?? "复验后仍有未解决问题。",
      checkedAt: diagnosis.checkedAt,
      probes: diagnosis.probes,
    };
    this.update(session, { diagnosis, verification });
    if (diagnosis.severity === "ok") {
      this.complete(session, "done", "修复已完成并通过复验。");
      return;
    }
    this.complete(session, "blocked", "修复动作已执行，但复验仍发现问题；未进行未经确认的额外变更。");
  }
}
