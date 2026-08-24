/**
 * 巡检调度器（InspectionScheduler）：注入式定时器驱动。
 *
 * start() 立即执行一次后按 intervalMs 循环；inFlight 防重叠；stop() 停止。
 * createInspectionRunner 组装 pipeline + dashboard 信号：
 * 巡检 Serving/Degraded/Offline 实例 → emit inspection-completed
 * （经 core.bus 自动落 events 表）+ audit 记录（actor "butler-watch"），
 * 每轮巡检后回调 afterInspection（watch 用于幂等重注册日志源）。
 */
import type { Core, InstanceState, InspectionCompletedPayload } from "@butler/core";
import type { WatchConfig } from "./config.js";
import { probeDashboardSignal, type FetchLike } from "./dashboard-signal.js";
import {
  InspectionPipeline,
  overallOf,
  type InspectionContext,
  type InspectionStage,
} from "./pipeline.js";

/** 可注入定时器驱动（测试注入 fake timer）。 */
export interface TimerDriver {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultTimerDriver: TimerDriver = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** 参与巡检的实例状态（已确认服务 / 降级 / 失联均需持续巡检）。 */
const INSPECTABLE_STATES: readonly InstanceState[] = ["Serving", "Degraded", "Offline"];

export interface InspectionSchedulerOptions {
  /** 巡检间隔（毫秒）。 */
  intervalMs: number;
  /** 单轮巡检执行体（createInspectionRunner 产物）。 */
  run: () => Promise<void>;
  driver?: TimerDriver;
  /** run 抛异常时的兜底（默认 console.warn，绝不中断调度循环）。 */
  onError?: (error: unknown) => void;
  /** 可注入时钟（runNow/status 的 lastAt/nextAt 推算，默认 Date.now）。 */
  now?: () => number;
}

/** 巡检状态快照（HTTP /api/inspect/status 契约）。 */
export interface InspectionStatus {
  /** 上一次巡检完成时刻（ISO；从未巡检为 null）。 */
  lastAt: string | null;
  /** 下一次预计巡检时刻（ISO；从未启动为 null；由 interval 自 lastAt/首触推算）。 */
  nextAt: string | null;
  /** 巡检间隔（分钟）。 */
  intervalMin: number;
  /** 是否有巡检在飞。 */
  inFlight: boolean;
}

export class InspectionScheduler {
  private intervalMs: number;
  private run: () => Promise<void>;
  private driver: TimerDriver;
  private onError: (error: unknown) => void;
  private now: () => number;
  private handle: unknown;
  private inFlight = false;
  /** 首次触发时刻（毫秒；nextAt 推算基点，早于首次完成时使用）。 */
  private firstFireAt: number | null = null;
  /** 上次巡检完成时刻（ISO）。 */
  private lastCompletedAt: string | null = null;

  constructor(options: InspectionSchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.run = options.run;
    this.driver = options.driver ?? defaultTimerDriver;
    this.onError = options.onError ?? ((error) => console.warn("[butler-watch] 巡检执行异常:", error));
    this.now = options.now ?? Date.now;
  }

  /** 立即执行一次（await 首轮完成）后按 interval 循环。 */
  async start(): Promise<void> {
    if (this.handle !== undefined) return;
    await this.fire();
    this.handle = this.driver.setInterval(() => void this.fire(), this.intervalMs);
  }

  /** 手动触发一次（测试 / 即时巡检，不受 stop 影响）。 */
  async runOnce(): Promise<void> {
    await this.fire();
  }

  /**
   * 立即巡检入口（Task 10 HTTP /api/inspect/run）：与定时循环共用 inFlight
   * 防重叠——在飞时返回 false（调用方映射 409），否则异步触发并立即返回 true。
   */
  runNow(): boolean {
    if (this.inFlight) return false;
    void this.fire();
    return true;
  }

  /** 巡检状态查询（HTTP /api/inspect/status）。 */
  status(): InspectionStatus {
    const baseMs = this.lastCompletedAt !== null ? Date.parse(this.lastCompletedAt) : this.firstFireAt;
    const nextAt =
      this.handle !== undefined && baseMs !== null
        ? new Date(baseMs + this.intervalMs).toISOString()
        : null;
    return {
      lastAt: this.lastCompletedAt,
      nextAt,
      intervalMin: Math.round((this.intervalMs / 60_000) * 100) / 100,
      inFlight: this.inFlight,
    };
  }

  isRunning(): boolean {
    return this.handle !== undefined;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  stop(): void {
    if (this.handle !== undefined) {
      this.driver.clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  private async fire(): Promise<void> {
    if (this.inFlight) return; // 防重叠：上一轮未完成时跳过本次触发
    if (this.firstFireAt === null) this.firstFireAt = this.now();
    this.inFlight = true;
    try {
      await this.run();
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = false;
      this.lastCompletedAt = new Date(this.now()).toISOString();
    }
  }
}

export interface InspectionRunnerDeps {
  core: Core;
  config: WatchConfig;
  stages: InspectionStage[];
  fetchFn?: FetchLike;
  /** 每轮巡检后回调（日志源幂等重注册等）。 */
  afterInspection?: () => void;
  /**
   * 单实例 inspection-completed 之后的回调（emit 后同步 await）。
   * Task 7 自动 runbook 触发判定挂在这里（比再订阅 bus 更直接，
   * 且天然串行于下一实例巡检之前）。
   */
  onInspection?: (payload: InspectionCompletedPayload) => void | Promise<void>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 组装单轮巡检执行体：pipeline + dashboard 信号 → 事件 + 审计。 */
export function createInspectionRunner(deps: InspectionRunnerDeps): () => Promise<void> {
  const pipeline = new InspectionPipeline(deps.stages);
  return async () => {
    const targets = deps.core.instances
      .listInstances()
      .filter((record) => INSPECTABLE_STATES.includes(record.state));
    for (const record of targets) {
      const startedAt = new Date().toISOString();
      const ctx: InspectionContext = {
        instanceId: record.instanceId,
        frameworkId: record.frameworkId,
        rootPath: record.rootPath,
        runtime: record.runtime,
        shared: {},
      };
      const outcome = await pipeline.run(ctx);
      const signal = await probeDashboardSignal({
        rootPath: record.rootPath,
        dashboardUrl: deps.config.dashboardUrl,
        fetchFn: deps.fetchFn,
        timeoutMs: deps.config.fetchTimeoutMs,
      });
      // dashboard 信号只产生 pass/skipped，不改变 overall；仅叠加置信度。
      const checks = signal.check === undefined ? outcome.checks : [...outcome.checks, signal.check];
      const overall = outcome.overall ?? overallOf(checks);
      const confidence = round2(Math.min(1, Math.max(0, outcome.confidence + signal.confidenceDelta)));

      const payload: InspectionCompletedPayload = {
        instanceId: record.instanceId,
        frameworkId: record.frameworkId,
        startedAt,
        finishedAt: new Date().toISOString(),
        overall,
        confidence,
        checks,
      };
      deps.core.bus.emit("inspection-completed", payload);
      deps.core.audit.append({
        actor: "butler-watch",
        action: "inspection",
        target: record.instanceId,
        detail: { overall, confidence, checkCount: checks.length },
      });
      try {
        await deps.onInspection?.(payload);
      } catch (error) {
        // 巡检后处理（如自动 runbook）失败不阻断巡检循环。
        console.warn("[butler-watch] 巡检后处理异常（继续巡检）:", error);
      }
    }
    deps.afterInspection?.();
  };
}
