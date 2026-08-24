import type { InstanceId, InstanceRef, Result } from "./common.js";

export type ControlAction = "start" | "stop" | "restart";

export interface StartOpts {
  /** 单次启动等待实例就绪的超时（秒）。 */
  timeoutSec?: number;
}

export interface StopOpts {
  /** 优雅停止的等待超时（秒），超时后由执行器决定是否强杀。 */
  timeoutSec?: number;
}

export interface UpgradeOpts {
  timeoutSec?: number;
  /** 跳过升级前快照（仅排障用，不建议）。 */
  skipSnapshot?: boolean;
  /** 只跑环境预检与计划，不落盘。 */
  dryRun?: boolean;
}

/** 常规控制（start/stop/restart）的确认回执。 */
export interface ControlAck {
  instanceId: InstanceId;
  action: ControlAction;
  /** 动作受理时间（ISO-8601）。 */
  startedAt: string;
}

/** 长操作句柄：方法立即返回 Job，进度经 JobEvent 事件流推送。 */
export interface Job {
  jobId: string;
  kind: "upgrade" | "snapshot" | "rollback";
  steps: JobStep[];
}

export interface JobStep {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  detail?: string;
}

export interface JobEvent {
  type: "step-started" | "step-finished" | "job-done" | "job-failed";
  jobId: string;
  stepId?: string;
  status?: JobStep["status"];
  detail?: string;
  /** 事件时间（ISO-8601）。 */
  at: string;
}

/** 快照范围：include 为目标清单（如 ["code","venv","data"]）。 */
export interface SnapshotScope {
  include: string[];
  label?: string;
}

export interface SnapshotRef {
  snapshotId: string;
  label?: string;
  createdAt?: string;
}

export interface ConfigViolation {
  /** 违反的不变式 id（对应 ConfigDriver.invariants()）。 */
  invariant: string;
  detail: string;
  severity: "block" | "warn";
}

export interface ConfigValidation {
  passed: boolean;
  violations: ConfigViolation[];
}

export interface VersionRef {
  version: string;
  channel?: "stable" | "beta";
}

/**
 * I-2 控制适配器（L2 控制面）。
 * 纪律约束（见 discipline.ts）：常规控制必须幂等（重复 start 不报错）；
 * 长操作以 idempotencyKey 幂等——同键重复调用必须返回同一 Job。
 */
export interface ControlAdapter {
  start(instance: InstanceRef, opts?: StartOpts): Promise<Result<ControlAck>>;
  stop(instance: InstanceRef, opts?: StopOpts): Promise<Result<ControlAck>>;
  restart(instance: InstanceRef): Promise<Result<ControlAck>>;
  upgrade(
    instance: InstanceRef,
    target: VersionRef,
    opts: UpgradeOpts & { idempotencyKey: string },
  ): Promise<Result<Job>>;
  snapshot(instance: InstanceRef, scope: SnapshotScope): Promise<Result<Job>>;
  rollback(instance: InstanceRef, ref: SnapshotRef): Promise<Result<Job>>;
  validateConfig(instance: InstanceRef): Promise<Result<ConfigValidation>>;
}
