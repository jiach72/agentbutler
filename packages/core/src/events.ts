/**
 * 内核类型化事件总线：模块间解耦的唯一事件通道。
 *
 * 事件统一形如 { type, payload, at }；at 为 ISO-8601 时间戳。
 * CoreEventMap 固定九类内核事件：
 * - instance-state-changed 生命周期状态迁移（图 2）
 * - capability-degraded / capability-recovered 运行时能力降级与恢复
 * - job-event 长操作 Job 登记
 * - audit-appended 审计日志追加
 * - adapter-rejected 适配器被拒绝加载
 * - tail-rotated 日志文件截断/轮转检测（Task 4）
 * - fingerprint-aggregated / fingerprint-escalated 错误指纹窗口聚合与升级（Task 4）
 * - inspection-completed 巡检完成综合结论（Task 5 butler-watch）
 * - runbook-started / runbook-completed runbook 执行起止（Task 7 butler-watch）
 * - circuit-breaker-tripped 崩溃循环熔断跳闸（Task 7 butler-watch）
 */
import type { Job } from "@butler/contract";
import type { Capability } from "@butler/contract";
import type { ErrorCode } from "@butler/contract";
import type { InstanceState } from "./lifecycle.js";

export interface InstanceStatePayload {
  instanceId: string;
  frameworkId: string;
  from: InstanceState;
  to: InstanceState;
  reason?: string;
}

/** 日志文件截断/轮转：文件当前大小小于已存位点时重置 0 重读并广播。 */
export interface TailRotatedPayload {
  sourceId: string;
  path: string;
  oldOffset: number;
}

/** 错误指纹窗口聚合：每个锚定窗口开启时恰好一条（同窗后续错误只累计计数）。 */
export interface FingerprintAggregatedPayload {
  instanceId?: string;
  signature: string;
  /** 归一化错误模板。 */
  template: string;
  windowStart: string;
  count: number;
  /** store 中首次出现该签名。 */
  isFirstEver: boolean;
  /** 是否升级趋势（窗口开启时恒为 false，升级由 fingerprint-escalated 表达）。 */
  escalated: boolean;
  /** 新指纹待告警；已知模式复现只记档。 */
  alert: boolean;
  /** 触发窗口开启的原始行（前 500 字符）。 */
  sample: string;
}

/** 错误指纹升级：本窗计数首次超过上一已关闭窗口的 2 倍（且上窗 >= 3 条），整窗仅一次。 */
export interface FingerprintEscalatedPayload {
  instanceId?: string;
  signature: string;
  template: string;
  prevCount: number;
  count: number;
}

/** 巡检单个检查阶段的结论（inspection-completed.checks 元素，Task 5）。 */
export interface InspectionCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "skipped";
  detail?: string;
  durationMs?: number;
}

/** 巡检完成（Task 5 butler-watch）：全部检查阶段执行完毕后的综合结论与置信度。 */
export interface InspectionCompletedPayload {
  instanceId: string;
  frameworkId: string;
  startedAt: string;
  finishedAt: string;
  overall: "healthy" | "degraded" | "down";
  confidence: number;
  checks: InspectionCheck[];
}

/** runbook 开始执行（Task 7 butler-watch）。 */
export interface RunbookStartedPayload {
  runbookId: string;
  instanceId: string;
  trigger: "auto" | "manual";
  reason: string;
}

/** runbook 单步骤终态结论（runbook-completed.steps 元素）。 */
export interface RunbookStepOutcomePayload {
  id: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
}

/** runbook 执行完毕（Task 7 butler-watch）：success 汇总全部步骤与复验结论。 */
export interface RunbookCompletedPayload {
  runbookId: string;
  instanceId: string;
  success: boolean;
  steps: RunbookStepOutcomePayload[];
  durationMs: number;
}

/** 崩溃循环熔断跳闸（Task 7 butler-watch）：窗口内失败达到阈值。 */
export interface CircuitBreakerTrippedPayload {
  /** 熔断键（如 "<runbookId>:<instanceId>" 或 Job 级 key）。 */
  key: string;
  failures: number;
  windowMs: number;
  reason: string;
}

export interface CoreEventPayloads {
  "instance-state-changed": InstanceStatePayload;
  "capability-degraded": { instanceId: string; capability: Capability; consecutiveFailures: number; reason: string };
  "capability-recovered": { instanceId: string; capability: Capability };
  "job-event": { instanceId?: string; job: Job };
  "audit-appended": { id: number; actor: string; action: string; target: string };
  "adapter-rejected": { dir?: string; frameworkId?: string; code: ErrorCode; message: string };
  "tail-rotated": TailRotatedPayload;
  "fingerprint-aggregated": FingerprintAggregatedPayload;
  "fingerprint-escalated": FingerprintEscalatedPayload;
  "inspection-completed": InspectionCompletedPayload;
  "runbook-started": RunbookStartedPayload;
  "runbook-completed": RunbookCompletedPayload;
  "circuit-breaker-tripped": CircuitBreakerTrippedPayload;
  "backup-completed": { id: number; kind: "full" | "memory" | "event"; path: string; sizeBytes: number };
}

export type CoreEventName = keyof CoreEventPayloads;

/** 总线上的事件信封：type + payload + ISO-8601 时间戳。 */
export interface CoreEvent<K extends CoreEventName = CoreEventName> {
  type: K;
  payload: CoreEventPayloads[K];
  at: string;
}

type Listener<K extends CoreEventName> = (event: CoreEvent<K>) => void;

/** 轻量同步发布/订阅总线；on/onAny 返回退订函数。 */
export class EventBus {
  private listeners = new Map<CoreEventName, Set<Listener<CoreEventName>>>();
  private anyListeners = new Set<(event: CoreEvent) => void>();

  on<K extends CoreEventName>(type: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<CoreEventName>);
    return () => this.off(type, listener);
  }

  /** 订阅全部事件（持久化/转发用）。 */
  onAny(listener: (event: CoreEvent) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  off<K extends CoreEventName>(type: K, listener: Listener<K>): void {
    this.listeners.get(type)?.delete(listener as Listener<CoreEventName>);
  }

  emit<K extends CoreEventName>(type: K, payload: CoreEventPayloads[K]): CoreEvent<K> {
    const event: CoreEvent<K> = { type, payload, at: new Date().toISOString() };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as CoreEvent);
    }
    for (const listener of this.anyListeners) {
      listener(event as CoreEvent);
    }
    return event;
  }
}
