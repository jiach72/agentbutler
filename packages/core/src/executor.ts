/**
 * 适配器调用执行器：内核对适配器方法统一施加的调用纪律边界。
 *
 * - 超时：按 contract getDiscipline(method) 取默认，opts.timeoutMs 可注入覆盖
 *   （测试用小值）；Promise.race 强制中断等待，超时按方法类别映射错误码
 *   （control/long-op → E202，messaging → E302，read-only/probe → E103）；
 * - 重试：仅 error.retryable 且未超纪律上限 maxAutoRetries 时自动重试；
 * - 异常：任何抛出的异常捕获并转为 fail Result（禁止裸异常越界）；
 * - 审计：control / long-op 类调用进入前先写审计日志（action=method, target=instance）；
 * - 幂等：opts.idempotencyKey 先查 jobs 表，命中同键直接返回已存 Job；
 *   执行产出的 Job 持久化到 jobs 表并广播 job-event；
 * - durationMs 必填：适配器返回的 Result 缺 durationMs 时兜底补全。
 */
import {
  fail,
  getDiscipline,
  ok,
  type CallCategory,
  type ErrorCode,
  type Job,
  type Result,
  type Capability,
} from "@butler/contract";
import type { EventBus } from "./events.js";
import type { AuditLog } from "./audit.js";
import type { SqliteStore } from "./store.js";
import type { CapabilityRouter } from "./router.js";
import type { InstanceManager, InstanceRecord } from "./lifecycle.js";

export interface InvokeOptions {
  /** 适配器方法名（决定纪律：超时/重试/审计/幂等）。 */
  method: string;
  /** 目标实例 id（审计 target 与 Job 归属）。 */
  instance?: string;
  /** 审计附加信息（actor 缺省 butler-core）。 */
  auditEntry?: { actor?: string; detail?: unknown };
  /** 幂等键：同键复用已存 Job，不重复执行。 */
  idempotencyKey?: string;
  /** 覆盖纪律默认超时（毫秒），测试注入用。 */
  timeoutMs?: number;
  /** 可选能力路由：提供后调用前必须通过 capabilityScan，调用后自动记录结果。 */
  capability?: Capability;
}

/** 方法类别 → 超时错误码。 */
export const TIMEOUT_CODE_BY_CATEGORY: Readonly<Record<CallCategory, ErrorCode>> = {
  "read-only": "E103",
  probe: "E103",
  control: "E202",
  "long-op": "E202",
  messaging: "E302",
};

class TimeoutSignal extends Error {}

function isJobLike(data: unknown): data is Job {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Partial<Job>;
  return typeof candidate.jobId === "string" && typeof candidate.kind === "string" && Array.isArray(candidate.steps);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AdapterExecutor {
  private audit: AuditLog;
  private store: SqliteStore;
  private bus: EventBus;
  private router?: CapabilityRouter;
  private instances?: InstanceManager;

  constructor(deps: {
    audit: AuditLog;
    store: SqliteStore;
    bus: EventBus;
    router?: CapabilityRouter;
    instances?: InstanceManager;
  }) {
    this.audit = deps.audit;
    this.store = deps.store;
    this.bus = deps.bus;
    this.router = deps.router;
    this.instances = deps.instances;
  }

  async invokeAdapter<T>(fn: () => Promise<Result<T>>, opts: InvokeOptions): Promise<Result<T>> {
    const discipline = getDiscipline(opts.method);
    const timeoutMs = opts.timeoutMs ?? discipline.timeoutMs;
    let routedInstance: InstanceRecord | undefined;
    if (opts.capability !== undefined) {
      routedInstance = opts.instance === undefined ? undefined : this.instances?.getInstance(opts.instance);
      if (routedInstance === undefined || this.router === undefined) {
        return fail("E103", `能力路由缺少实例上下文：${opts.capability}`);
      }
      const check = this.router.check(routedInstance, opts.capability);
      if (!check.allowed) {
        return fail("E103", check.reason ?? `能力 ${opts.capability} 未实现`, {
          userHint: "该能力未实现，入口已隐藏",
        });
      }
    }

    if (opts.idempotencyKey !== undefined) {
      const existing = this.store.findJobByIdempotencyKey(opts.idempotencyKey);
      if (existing !== undefined) {
        return ok({ jobId: existing.jobId, kind: existing.kind, steps: existing.steps } as T);
      }
    }

    if (discipline.category === "control" || discipline.category === "long-op") {
      this.audit.append({
        actor: opts.auditEntry?.actor ?? "butler-core",
        action: opts.method,
        target: opts.instance ?? "",
        detail: opts.auditEntry?.detail,
      });
    }

    const startedAt = Date.now();
    const maxAttempts = 1 + discipline.maxAutoRetries;
    let result: Result<T> = fail("E002", "executor did not run");
    for (let attempt = 0; ; attempt++) {
      result = await this.runOnce(fn, { method: opts.method, timeoutMs, category: discipline.category, startedAt });
      if (result.ok) break;
      const retryable = result.error?.retryable === true;
      if (!retryable || attempt + 1 >= maxAttempts) break;
    }

    if (result.ok && opts.idempotencyKey !== undefined && isJobLike(result.data)) {
      const job = result.data;
      this.store.insertJob({
        jobId: job.jobId,
        kind: job.kind,
        instance: opts.instance ?? "",
        idempotencyKey: opts.idempotencyKey,
        steps: job.steps,
      });
      this.bus.emit("job-event", { instanceId: opts.instance, job });
    }
    if (routedInstance !== undefined && opts.capability !== undefined) {
      this.router!.recordResult(routedInstance, opts.capability, result.ok);
    }
    return result;
  }

  private async runOnce<T>(
    fn: () => Promise<Result<T>>,
    ctx: { method: string; timeoutMs: number; category: CallCategory; startedAt: number },
  ): Promise<Result<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutSignal(`timed out after ${ctx.timeoutMs}ms`)), ctx.timeoutMs);
        }),
      ]);
      if (typeof raced.durationMs !== "number") {
        return { ...raced, durationMs: Math.max(0, Date.now() - ctx.startedAt) };
      }
      return raced;
    } catch (error) {
      if (error instanceof TimeoutSignal) {
        return fail(
          TIMEOUT_CODE_BY_CATEGORY[ctx.category],
          `${ctx.method} timed out after ${ctx.timeoutMs}ms (category: ${ctx.category})`,
          { startedAt: ctx.startedAt, userHint: "调用超时，已按纪律中断" },
        );
      }
      return fail("E002", `${ctx.method} threw unexpected error: ${describeError(error)}`, {
        cause: error,
        startedAt: ctx.startedAt,
        userHint: "适配器内部异常，已转为失败结果",
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
