/**
 * 修复/巡检动作的内存任务生命周期。
 *
 * 从 http.ts 抽出的纯模块：任务条目只存在内存，供「排查问题」流程轮询进度。
 * 终态任务按保留时长从 Map 清除（此前只增不删，长期常驻会慢性泄漏内存）；
 * Runbook 执行监控带兜底上限，runbook 迟迟未上报结果时收敛为 unknown，
 * 避免每秒轮询的 interval 永久空转。
 */
import { randomUUID } from "node:crypto";

export interface RecoveryJobView {
  jobId: string;
  actionId: string;
  label: string;
  instanceId: string | null;
  status: "running" | "done" | "failed" | "unknown";
  progress: number;
  detail: string;
  startedAt: string;
  finishedAt: string | null;
}

/** monitorRunbook 需要的最小 runbook 结构（RunbookSummary 的结构子集）。 */
export interface MonitoredRunbook {
  id: string;
  lastRun?: { at: string; success: boolean; detail?: string } | null;
}

export interface RecoveryJobTimers {
  setInterval(fn: () => void, ms: number): unknown;
  setTimeout(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  clearTimeout(handle: unknown): void;
}

export interface RecoveryJobTrackerOptions {
  /** 进度 tick 周期（默认 1 秒）。 */
  tickMs?: number;
  /** 终态任务在内存中的保留时长（默认 30 分钟）。 */
  retentionMs?: number;
  /** Runbook 执行监控兜底上限（默认 15 分钟）。 */
  monitorMaxMs?: number;
  /** 可注入定时器（默认全局；测试注入 fake timers）。 */
  timers?: RecoveryJobTimers;
}

export interface RecoveryJobTracker {
  start(
    actionId: string,
    label: string,
    estimatedSeconds: number,
    instanceId?: string,
    holdForVerification?: boolean,
  ): RecoveryJobView;
  finish(jobId: string, status: "done" | "failed" | "unknown", detail: string): void;
  monitorRunbook(
    jobId: string,
    runbooks: () => MonitoredRunbook[],
    runbookId: string,
    previousLastRunAt: string | null,
  ): void;
  get(jobId: string): RecoveryJobView | undefined;
}

const defaultTimers: RecoveryJobTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createRecoveryJobTracker(options: RecoveryJobTrackerOptions = {}): RecoveryJobTracker {
  const tickMs = options.tickMs ?? 1_000;
  // 终态任务久留只服务 UI 复查，久留只会慢性泄漏内存。
  const retentionMs = options.retentionMs ?? 30 * 60 * 1000;
  const monitorMaxMs = options.monitorMaxMs ?? 15 * 60 * 1000;
  const timers = options.timers ?? defaultTimers;

  const jobs = new Map<string, RecoveryJobView>();
  const jobTimers = new Map<string, unknown>();
  const completionTimers = new Map<string, unknown>();
  const cleanupTimers = new Map<string, unknown>();

  function scheduleCleanup(jobId: string): void {
    const existing = cleanupTimers.get(jobId);
    if (existing !== undefined) timers.clearTimeout(existing);
    const timer = timers.setTimeout(() => {
      jobs.delete(jobId);
      cleanupTimers.delete(jobId);
    }, retentionMs);
    cleanupTimers.set(jobId, timer);
  }

  function clearCompletionTimer(jobId: string): void {
    const completionTimer = completionTimers.get(jobId);
    if (completionTimer !== undefined) timers.clearInterval(completionTimer);
    completionTimers.delete(jobId);
  }

  function start(
    actionId: string,
    label: string,
    estimatedSeconds: number,
    instanceId?: string,
    holdForVerification = false,
  ): RecoveryJobView {
    const jobId = `recovery-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const job: RecoveryJobView = {
      jobId,
      actionId,
      label,
      instanceId: instanceId ?? null,
      status: "running",
      progress: 8,
      detail: "已确认，正在准备执行",
      startedAt,
      finishedAt: null,
    };
    jobs.set(jobId, job);
    const duration = Math.max(5, estimatedSeconds) * 1000;
    const timer = timers.setInterval(() => {
      const current = jobs.get(jobId);
      if (!current || current.status !== "running") return;
      const elapsed = Date.now() - Date.parse(current.startedAt);
      const progress = Math.min(92, Math.max(current.progress, 8 + Math.round((elapsed / duration) * 84)));
      current.progress = progress;
      current.detail = progress >= 90 ? "正在进行最后复验" : "正在执行修复步骤";
      if (elapsed >= duration && !holdForVerification) {
        current.progress = 100;
        current.status = "done";
        current.detail = "修复步骤已完成，等待复验结果";
        current.finishedAt = new Date().toISOString();
        timers.clearInterval(timer);
        jobTimers.delete(jobId);
        scheduleCleanup(jobId);
      }
      if (elapsed >= duration + 30_000 && holdForVerification) {
        current.progress = 95;
        current.status = "unknown";
        current.detail = "执行时间已到，但 Watch 尚未返回最终复验结果";
        current.finishedAt = new Date().toISOString();
        timers.clearInterval(timer);
        jobTimers.delete(jobId);
        clearCompletionTimer(jobId);
        scheduleCleanup(jobId);
      }
    }, tickMs);
    jobTimers.set(jobId, timer);
    return job;
  }

  function finish(jobId: string, status: "done" | "failed" | "unknown", detail: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.progress = status === "done" ? 100 : Math.min(job.progress, 95);
    job.detail = detail;
    job.finishedAt = new Date().toISOString();
    const timer = jobTimers.get(jobId);
    if (timer !== undefined) timers.clearInterval(timer);
    jobTimers.delete(jobId);
    clearCompletionTimer(jobId);
    scheduleCleanup(jobId);
  }

  function monitorRunbook(
    jobId: string,
    runbooks: () => MonitoredRunbook[],
    runbookId: string,
    previousLastRunAt: string | null,
  ): void {
    const startedAt = Date.now();
    const timer = timers.setInterval(() => {
      const current = jobs.get(jobId);
      // 任务已通过其它路径终态或被清理时，监控循环必须自行退出；
      // 否则这个每秒轮询的 interval 会永久空转。
      if (!current || current.status !== "running") {
        timers.clearInterval(timer);
        completionTimers.delete(jobId);
        return;
      }
      const lastRun = runbooks().find((item) => item.id === runbookId)?.lastRun;
      if (lastRun && lastRun.at !== previousLastRunAt) {
        finish(
          jobId,
          lastRun.success ? "done" : "failed",
          lastRun.success
            ? "Runbook 已完成并通过复验"
            : lastRun.detail ??
              "Runbook 未完成：请打开连接诊断，确认 control 能力、实例运行环境和快照步骤；修复前置问题后再重试。",
        );
        return;
      }
      if (Date.now() - startedAt >= monitorMaxMs) {
        finish(
          jobId,
          "unknown",
          "Runbook 执行监控超时：Watch 长时间未上报执行结果，请查看系统日志确认实际执行情况后再重试。",
        );
      }
    }, tickMs);
    completionTimers.set(jobId, timer);
  }

  return {
    start,
    finish,
    monitorRunbook,
    get: (jobId) => jobs.get(jobId),
  };
}
