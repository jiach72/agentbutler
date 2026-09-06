import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecoveryJobTracker } from "../src/recovery-jobs.js";

/**
 * recovery-jobs 抽取后的生命周期回归：终态任务按保留期清除（防内存泄漏）、
 * Runbook 执行监控有兜底上限、监控循环在任务提前终态后自行退出。
 */
describe("createRecoveryJobTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("终态任务在保留期后被清除，运行中任务不受影响", () => {
    const tracker = createRecoveryJobTracker({ retentionMs: 60_000 });
    const job = tracker.start("cleanup-gateway", "清理消息网关", 5);
    vi.advanceTimersByTime(5_000); // 无 hold：进度 tick 到点自动 done
    expect(tracker.get(job.jobId)?.status).toBe("done");

    vi.advanceTimersByTime(59_000);
    expect(tracker.get(job.jobId)).toBeDefined();
    vi.advanceTimersByTime(2_000);
    expect(tracker.get(job.jobId)).toBeUndefined();
  });

  it("runbook 在兜底上限内未上报结果时收敛为 unknown", () => {
    // 监控兜底（50s）必须先于进度 tick 自带的 90s+30s 兜底触发，
    // 才能验证监控路径本身的超时收敛。
    const tracker = createRecoveryJobTracker({ monitorMaxMs: 50_000 });
    const job = tracker.start("rb-restart", "重启 AI 实例", 90, "hermes-main", true);
    tracker.monitorRunbook(job.jobId, () => [], "rb-restart", null);

    vi.advanceTimersByTime(49_000);
    expect(tracker.get(job.jobId)?.status).toBe("running");
    vi.advanceTimersByTime(2_000);
    const finished = tracker.get(job.jobId);
    expect(finished?.status).toBe("unknown");
    expect(finished?.detail).toContain("监控超时");
  });

  it("runbook 上报新的 lastRun 后按结果收敛为 done/failed", () => {
    const tracker = createRecoveryJobTracker();
    const job = tracker.start("rb-reconnect", "重新连接消息通道", 20, "hermes-main", true);
    let lastRun: { at: string; success: boolean } | null = null;
    tracker.monitorRunbook(job.jobId, () => [
      { id: "rb-reconnect", lastRun },
    ], "rb-reconnect", null);

    vi.advanceTimersByTime(3_000);
    expect(tracker.get(job.jobId)?.status).toBe("running");
    lastRun = { at: "2026-09-06T00:05:00.000Z", success: true };
    vi.advanceTimersByTime(2_000);
    expect(tracker.get(job.jobId)?.status).toBe("done");

    const failed = tracker.start("rb-reconnect", "重新连接消息通道", 20, "hermes-main", true);
    lastRun = { at: "2026-09-06T00:06:00.000Z", success: false, detail: "control 不可用" };
    tracker.monitorRunbook(failed.jobId, () => [{ id: "rb-reconnect", lastRun }], "rb-reconnect", null);
    vi.advanceTimersByTime(2_000);
    const finished = tracker.get(failed.jobId);
    expect(finished?.status).toBe("failed");
    expect(finished?.detail).toBe("control 不可用");
  });

  it("任务经其它路径终态后监控循环自行退出（不再每秒空转）", () => {
    const tracker = createRecoveryJobTracker({ retentionMs: 60_000 });
    const job = tracker.start("rb-reconnect", "重新连接消息通道", 20, "hermes-main", true);
    tracker.monitorRunbook(job.jobId, () => [], "rb-reconnect", null);

    tracker.finish(job.jobId, "failed", "没有可用的 Hermes 实例");
    expect(tracker.get(job.jobId)?.status).toBe("failed");
    // 终态后只剩保留期 cleanup 定时器；推过保留期后应全部归零
    vi.advanceTimersByTime(61_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(tracker.get(job.jobId)).toBeUndefined();
  });
});
