/**
 * runbook 执行器（Task 7.1）：声明式定义 + 统一执行规则。
 *
 * 执行规则：
 * ① 执行前先快照（hermes control.snapshot，scope ["data"]，label
 *    "pre-runbook"）；快照失败（!ok 或快照步骤 failed）→ 中止整个 runbook 记 failed；
 * ② 每步落审计（actor "runbook"）+ 结构化结果收集；
 * ③ 任一步失败 → runbook 终止 → 升级告警（POST gateway severity critical，
 *    kind "runbook-failed"，dedupeKey 含 runbookId+日期）；
 * ④ 全部成功 → 对应探针复验（重跑受影响探针阶段）；复验仍 fail → 同样升级告警；
 * ⑤ 失败（步骤/快照/复验）计入崩溃循环熔断器（breaker.recordFailure），
 *    成功 recordSuccess 复位失败累计。
 *
 * 触发：自动规则（autoTrigger，含熔断检查 + 同实例防抖窗口，默认 15min）与
 * 手动入口 runRunbook(trigger "manual"，供 Task 10 面板执行入口调用)。
 *
 * 孤儿网关进程勘察结论（真实环境 pgrep -af，2026-08-20）：
 * - 主网关进程命令行 `<rootPath>/hermes-agent/venv/bin/python -m
 *   hermes_cli.main gateway run`，其 pid 记录在 `<rootPath>/gateway.pid`
 *   （JSON {"pid":..., "kind":"hermes-gateway", ...}）；
 * - tui 网关进程 `... python -m tui_gateway.entry`（tui 会话拉起）。
 * 孤儿 = 匹配 gateway/tui 模式且非 gateway.pid 记录主进程的 pid。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceRef, Job, JobStep, Result, ControlAck, SnapshotScope } from "@butler/contract";
import type { CommandExecutor } from "@butler/adapter-hermes";
import { createExecFileExecutor } from "@butler/adapter-hermes";
import type { AuditLog, Core, RunbookStepOutcomePayload } from "@butler/core";
import { CircuitBreaker, type CircuitBreakerOptions } from "./breaker.js";
import { InspectionPipeline, type InspectionStage } from "../pipeline.js";
import type { AlertPoster } from "../alert-forward.js";

export const RUNBOOK_ACTOR = "runbook";
export const RUNBOOK_STEP_ACTION = "runbook-step";
export const RUNBOOK_ACTION = "runbook";
export const RUNBOOK_SKIPPED_ACTION = "runbook-skipped";
export const RUNBOOK_FAILED_KIND = "runbook-failed";
export const CIRCUIT_BREAKER_KIND = "circuit-breaker";
/** 自动触发防抖默认 15min。 */
export const DEFAULT_RUNBOOK_DEBOUNCE_MS = 15 * 60 * 1000;

/** 执行器所需的最小 hermes 控制面（复用 hermes adapter control）。 */
export interface RunbookControl {
  restart(instance: InstanceRef): Promise<Result<ControlAck>>;
  snapshot(instance: InstanceRef, scope: SnapshotScope): Promise<Result<Job>>;
}

export interface RunbookStepContext {
  instanceId: string;
  rootPath: string;
  runtime: "docker" | "process" | "unknown";
}

export interface RunbookStepResult {
  status: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface RunbookStep {
  id: string;
  label: string;
  run(ctx: RunbookStepContext): Promise<RunbookStepResult>;
}

export interface RunbookDefinition {
  id: string;
  label: string;
  /** 面板展示用的一句话说明（HTTP /api/runbooks 的 description）。 */
  description?: string;
  /** 执行影响范围说明（HTTP /api/runbooks 的 impact；面向小白用户）。 */
  impact?: string;
  steps: RunbookStep[];
  /** 全部步骤成功后复验的探针阶段 id 列表。 */
  verifyStageIds: string[];
}

export interface RunbookRunOptions {
  trigger: "auto" | "manual";
  reason?: string;
  instance: InstanceRef;
}

export interface RunbookResult {
  runbookId: string;
  instanceId: string;
  trigger: "auto" | "manual";
  success: boolean;
  steps: RunbookStepOutcomePayload[];
  durationMs: number;
  /** 失败时升级告警的 dedupeKey（成功无）。 */
  alertDedupeKey?: string;
}

export type AutoTriggerOutcome =
  | { skipped: false; result: RunbookResult }
  | { skipped: true; reason: string };

export interface RunbookExecutorDeps {
  core: Core;
  control: RunbookControl;
  /** 复验阶段来源（按 id 过滤；通常传巡检全阶段）。 */
  stages: InspectionStage[];
  breaker: CircuitBreaker;
  poster: AlertPoster;
  /** 孤儿探测/kill 命令执行器（默认 execFile）。 */
  exec?: CommandExecutor;
  /** 自动触发防抖窗口（毫秒，默认 15min）。 */
  debounceMs?: number;
  now?: () => number;
}

/* ------------------------------ 孤儿网关清理 ------------------------------ */

/** 真实环境网关/tui 进程 pgrep 模式（见模块头勘察结论）。 */
export const ORPHAN_GATEWAY_PATTERNS = ["hermes_cli.main gateway run", "tui_gateway.entry"] as const;

/** pgrep -f 匹配 gateway/tui 模式，排除 gateway.pid 记录的主进程（缺失则最小 pid 为主）。 */
export async function findOrphanGatewayPids(
  exec: CommandExecutor,
  rootPath: string,
): Promise<{ orphans: string[]; mainPid: number | null }> {
  const pids = new Set<number>();
  for (const pattern of ORPHAN_GATEWAY_PATTERNS) {
    const result = await exec.exec("pgrep", ["-f", pattern], { timeoutMs: 5000 });
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  if (pids.size === 0) return { orphans: [], mainPid: null };
  let recordedPid: number | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(rootPath, "gateway.pid"), "utf8")) as { pid?: unknown };
    const pid = Number(raw["pid"]);
    if (Number.isInteger(pid) && pid > 0) recordedPid = pid;
  } catch {
    // gateway.pid 缺失/损坏：退化为最小 pid 视为主进程，绝不误杀全部。
  }
  const sorted = [...pids].sort((a, b) => a - b);
  const mainPid = recordedPid !== null && pids.has(recordedPid) ? recordedPid : sorted[0]!;
  return { orphans: sorted.filter((p) => p !== mainPid).map(String), mainPid };
}

/* -------------------------------- 执行器 -------------------------------- */

export class RunbookExecutor {
  private readonly definitions = new Map<string, RunbookDefinition>();
  private readonly core: Core;
  private readonly control: RunbookControl;
  private readonly stages: InspectionStage[];
  private readonly breaker: CircuitBreaker;
  private readonly poster: AlertPoster;
  private readonly exec: CommandExecutor;
  private readonly debounceMs: number;
  private readonly now: () => number;
  /** "<runbookId>:<instanceId>" → 上次自动执行时刻（防抖）。 */
  private readonly lastAutoAt = new Map<string, number>();
  /** "<runbookId>" → 最近一次执行结果（HTTP /api/runbooks 的 lastRun）。 */
  private readonly lastRuns = new Map<string, { at: string; success: boolean }>();

  constructor(deps: RunbookExecutorDeps, definitions: RunbookDefinition[] = []) {
    this.core = deps.core;
    this.control = deps.control;
    this.stages = deps.stages;
    this.breaker = deps.breaker;
    this.poster = deps.poster;
    this.exec = deps.exec ?? createExecFileExecutor();
    this.debounceMs = deps.debounceMs ?? DEFAULT_RUNBOOK_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
    for (const def of definitions) this.definitions.set(def.id, def);
  }

  /** 注册/覆盖一条 runbook 定义。 */
  register(def: RunbookDefinition): void {
    this.definitions.set(def.id, def);
  }

  listRunbooks(): RunbookDefinition[] {
    return [...this.definitions.values()];
  }

  /** 最近一次执行结果（HTTP /api/runbooks 的 lastRun；从未执行为 undefined）。 */
  lastRunOf(id: string): { at: string; success: boolean } | undefined {
    return this.lastRuns.get(id);
  }

  /** 手动入口（Task 10 面板执行入口）：不做熔断/防抖拦截。 */
  async runRunbook(id: string, opts: RunbookRunOptions): Promise<RunbookResult> {
    const def = this.definitions.get(id);
    if (!def) {
      throw new Error(`未知 runbook: ${id}（已注册: ${[...this.definitions.keys()].join(", ") || "无"}）`);
    }
    const instanceId = opts.instance.instanceId;
    const startedAt = this.now();
    this.core.bus.emit("runbook-started", {
      runbookId: id,
      instanceId,
      trigger: opts.trigger,
      reason: opts.reason ?? "",
    });

    const steps: RunbookStepOutcomePayload[] = [];
    let failedAt: string | null = null;

    const appendStep = (step: RunbookStepOutcomePayload): void => {
      steps.push(step);
      this.core.audit.append({
        actor: RUNBOOK_ACTOR,
        action: RUNBOOK_STEP_ACTION,
        target: instanceId,
        detail: { runbookId: id, stepId: step.id, status: step.status, detail: step.detail ?? "" },
      });
    };

    // ① 执行前快照（scope ["data"]，label "pre-runbook"）：失败 → 中止整个 runbook。
    const snapshot = await this.control.snapshot(opts.instance, { include: ["data"], label: "pre-runbook" });
    const snapshotFailedSteps = (snapshot.data?.steps ?? []).filter((s: JobStep) => s.status === "failed");
    if (!snapshot.ok || snapshotFailedSteps.length > 0) {
      failedAt = "snapshot";
      appendStep({
        id: "snapshot",
        status: "failed",
        detail: !snapshot.ok
          ? `pre-runbook 快照失败: ${snapshot.error?.message ?? "unknown"}`
          : `pre-runbook 快照步骤失败: ${snapshotFailedSteps.map((s) => s.id).join(",")}`,
      });
    } else {
      appendStep({ id: "snapshot", status: "passed", detail: `pre-runbook 快照完成（${snapshot.data?.steps.length ?? 0} 步）` });
    }

    // ② 有序步骤执行：任一 failed → 终止。
    const stepCtx: RunbookStepContext = {
      instanceId,
      rootPath: opts.instance.rootPath ?? "",
      runtime: opts.instance.runtime ?? "unknown",
    };
    if (failedAt === null) {
      for (const step of def.steps) {
        let outcome: RunbookStepResult;
        try {
          outcome = await step.run(stepCtx);
        } catch (error) {
          outcome = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
        }
        appendStep({ id: step.id, status: outcome.status, detail: outcome.detail });
        if (outcome.status === "failed") {
          failedAt = step.id;
          break;
        }
      }
    }

    // ④ 复验：全部步骤成功后重跑受影响探针阶段；任一 fail → runbook 失败。
    let verifyNote = "";
    if (failedAt === null && def.verifyStageIds.length > 0) {
      const verifyStages = def.verifyStageIds
        .map((stageId) => this.stages.find((s) => s.id === stageId))
        .filter((s): s is InspectionStage => s !== undefined);
      const missing = def.verifyStageIds.filter(
        (stageId) => !verifyStages.some((s) => s.id === stageId),
      );
      if (missing.length > 0) {
        verifyNote = `（复验阶段缺失: ${missing.join(",")}）`;
      }
      if (verifyStages.length > 0) {
        const outcome = await new InspectionPipeline(verifyStages).run({
          instanceId,
          frameworkId: "hermes",
          rootPath: stepCtx.rootPath,
          runtime: stepCtx.runtime,
          shared: {},
        });
        for (const check of outcome.checks) {
          appendStep({
            id: `verify-${check.id}`,
            status: check.status === "fail" ? "failed" : check.status === "warn" ? "skipped" : "passed",
            detail: check.detail,
          });
          if (check.status === "fail") {
            failedAt = `verify-${check.id}`;
            break;
          }
        }
      }
    }

    const durationMs = Math.max(0, this.now() - startedAt);
    const success = failedAt === null;

    // ③/④ 失败 → 升级告警 + 熔断记录失败；成功 → 复位失败累计。
    let alertDedupeKey: string | undefined;
    const breakerKey = `${id}:${instanceId}`;
    if (!success) {
      alertDedupeKey = runbookFailedDedupeKey(id, instanceId, this.now());
      void this.poster.post({
        kind: RUNBOOK_FAILED_KIND,
        severity: "critical",
        title: `runbook ${id} 执行失败（实例 ${instanceId}${verifyNote}）`,
        body: `runbook ${id} 于实例 ${instanceId} 失败（触发: ${opts.trigger}，原因: ${opts.reason ?? ""}）：失败环节 ${failedAt}。步骤: ${steps
          .map((s) => `${s.id}=${s.status}`)
          .join(", ")}`,
        source: "butler-watch",
        dedupeKey: alertDedupeKey,
      });
      this.breaker.recordFailure(breakerKey, `runbook ${id} 失败于 ${failedAt}`);
    } else {
      this.breaker.recordSuccess(breakerKey);
    }

    this.core.audit.append({
      actor: RUNBOOK_ACTOR,
      action: RUNBOOK_ACTION,
      target: instanceId,
      detail: { runbookId: id, success, failedAt: failedAt ?? "", durationMs, trigger: opts.trigger },
    });
    this.core.bus.emit("runbook-completed", {
      runbookId: id,
      instanceId,
      success,
      steps,
      durationMs,
    });
    this.lastRuns.set(id, { at: new Date(this.now()).toISOString(), success });
    return { runbookId: id, instanceId, trigger: opts.trigger, success, steps, durationMs, alertDedupeKey };
  }

  /**
   * 自动触发入口：触发前查熔断器（跳闸 → 跳过并记 audit）+ 防抖窗口
   * （同一 runbook 对同一实例执行后 N 分钟内不重复自动触发）。
   */
  async autoTrigger(id: string, instance: InstanceRef, reason: string): Promise<AutoTriggerOutcome> {
    const breakerKey = `${id}:${instance.instanceId}`;
    if (this.breaker.isTripped(breakerKey)) {
      const trip = this.breaker.tripInfo(breakerKey);
      this.core.audit.append({
        actor: RUNBOOK_ACTOR,
        action: RUNBOOK_SKIPPED_ACTION,
        target: instance.instanceId,
        detail: {
          runbookId: id,
          reason: "circuit-breaker",
          failures: trip?.failures ?? 0,
          windowMs: trip?.windowMs ?? 0,
        },
      });
      return { skipped: true, reason: "circuit-breaker" };
    }
    const last = this.lastAutoAt.get(breakerKey);
    const now = this.now();
    if (last !== undefined && now - last < this.debounceMs) {
      return { skipped: true, reason: "debounced" };
    }
    this.lastAutoAt.set(breakerKey, now);
    const result = await this.runRunbook(id, { trigger: "auto", reason, instance });
    return { skipped: false, result };
  }
}

/** runbook 失败升级告警 dedupeKey：runbookId + 实例 + 日期（当日聚合去重）。 */
export function runbookFailedDedupeKey(runbookId: string, instanceId: string, now: number): string {
  return `runbook-failed:${runbookId}:${instanceId}:${new Date(now).toISOString().slice(0, 10)}`;
}

/* ------------------------------ 三条内置 runbook ------------------------------ */

/** 内置 runbook id 常量。 */
export const RB_RESTART = "rb-restart";
export const RB_RECONNECT = "rb-reconnect";
export const RB_CLEANUP_GATEWAY = "rb-cleanup-gateway";

/** 三条内置 runbook：
 * 1. rb-restart：snapshot → restart → 复验 memory/channel 探针；
 * 2. rb-reconnect：snapshot → 清理孤儿网关 → restart → 复验 channel 探针；
 * 3. rb-cleanup-gateway：snapshot → 清理孤儿网关（无孤儿直接成功）→ 复验 process-alive。 */
export function createBuiltinRunbooks(deps: { control: RunbookControl; exec?: CommandExecutor }): RunbookDefinition[] {
  const exec = deps.exec ?? createExecFileExecutor();
  const refOf = (ctx: RunbookStepContext): InstanceRef => ({
    instanceId: ctx.instanceId,
    rootPath: ctx.rootPath,
    runtime: ctx.runtime,
  });

  const restartStep: RunbookStep = {
    id: "restart",
    label: "重启实例",
    async run(ctx) {
      const result = await deps.control.restart(refOf(ctx));
      return result.ok
        ? { status: "passed", detail: "control.restart 成功" }
        : { status: "failed", detail: `control.restart 失败: ${result.error?.message ?? "unknown"}` };
    },
  };

  const cleanupOrphansStep: RunbookStep = {
    id: "cleanup-orphans",
    label: "清理孤儿网关进程",
    async run(ctx) {
      const { orphans } = await findOrphanGatewayPids(exec, ctx.rootPath);
      if (orphans.length === 0) {
        return { status: "passed", detail: "无孤儿网关进程，无需清理" };
      }
      const killed: string[] = [];
      for (const pid of orphans) {
        const result = await exec.exec("kill", [pid], { timeoutMs: 5000 });
        if (result.code !== 0) {
          return { status: "failed", detail: `kill 孤儿 pid ${pid} 失败（退出码 ${result.code}）` };
        }
        killed.push(pid);
      }
      return { status: "passed", detail: `已清理孤儿网关进程 pid ${killed.join(",")}` };
    },
  };

  return [
    {
      id: RB_RESTART,
      label: "重启实例",
      description: "快照后重启 hermes 实例并复验 memory/channel 探针（进程僵死、内存泄漏时使用）",
      impact: "Hermes 服务会短暂重启（约 1-2 分钟），期间消息收发和正在处理的会话可能中断；记忆与配置已自动备份，不会丢数据。",
      steps: [restartStep],
      verifyStageIds: ["memory-probe", "channel-probe"],
    },
    {
      id: RB_RECONNECT,
      label: "重连通道（清孤儿 + 重启）",
      description: "清理孤儿网关进程后重启实例并复验 channel 探针（消息通道断流时使用）",
      impact: "先清理多余的网关进程，再重启 Hermes；期间消息收发会短暂中断，正在进行的会话可能被打断。",
      steps: [cleanupOrphansStep, restartStep],
      verifyStageIds: ["channel-probe"],
    },
    {
      id: RB_CLEANUP_GATEWAY,
      label: "清理孤儿网关进程",
      description: "仅清理孤儿网关进程（不动主进程）并复验 process-alive 探针",
      impact: "只清理卡死的孤儿网关进程，不影响主进程；服务无需重启，消息收发基本不受影响。",
      steps: [cleanupOrphansStep],
      verifyStageIds: ["process-alive"],
    },
  ];
}

/* --------------------------- 熔断跳闸告警接线 --------------------------- */

export interface WireBreakerDeps {
  bus: Core["bus"];
  poster: AlertPoster;
  audit: AuditLog;
  now?: () => number;
}

/**
 * 组装辅助：创建已接线跳闸通知的熔断器（watch.ts 与测试共用）——
 * 跳闸时 emit circuit-breaker-tripped（经 bus 落 events 表持久化）+
 * POST gateway severity critical（kind "circuit-breaker"，dedupeKey 含 key）+ 审计。
 */
export function createWiredBreaker(
  options: Omit<CircuitBreakerOptions, "onTrip">,
  deps: WireBreakerDeps,
): CircuitBreaker {
  const now = deps.now ?? Date.now;
  return new CircuitBreaker({
    ...options,
    now,
    onTrip: (trip) => {
      deps.bus.emit("circuit-breaker-tripped", {
        key: trip.key,
        failures: trip.failures,
        windowMs: trip.windowMs,
        reason: trip.reason,
      });
      deps.audit.append({
        actor: RUNBOOK_ACTOR,
        action: "circuit-breaker-tripped",
        target: trip.key,
        detail: { failures: trip.failures, windowMs: trip.windowMs, reason: trip.reason },
      });
      void deps.poster.post({
        kind: CIRCUIT_BREAKER_KIND,
        severity: "critical",
        title: `崩溃循环熔断跳闸: ${trip.key}`,
        body: `键 ${trip.key} 在 ${trip.windowMs / 60000} 分钟窗口内累计 ${trip.failures} 次失败，已熔断（后续自动触发一律跳过，watch 重启后复位）。原因: ${trip.reason}`,
        source: "butler-watch",
        dedupeKey: `circuit-breaker:${trip.key}:${new Date(now()).toISOString().slice(0, 10)}`,
      });
    },
  });
}
