import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
  EVOLUTION_DAILY_METRIC_RETENTION_DAYS,
  EVOLUTION_OBSERVATION_RETENTION_DAYS,
  RETENTION_PRUNE_INTERVAL_MS,
  createRetentionPruner,
} from "../src/retention.js";

/** 保留期清理：启动即清一轮、按周期重复、清理异常不中断调度。 */
describe("createRetentionPruner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start 立即清理一轮并按周期重复，stop 后不再执行", () => {
    vi.useFakeTimers();
    const pruneEvents = vi.fn(() => 3);
    const pruneAudit = vi.fn(() => 2);
    const pruner = createRetentionPruner({ pruneEvents, pruneAudit });

    pruner.start();
    expect(pruneEvents).toHaveBeenCalledTimes(1);
    expect(pruneAudit).toHaveBeenCalledTimes(1);
    // 启动首轮的窗口：events 45 天 / audit 90 天
    expect(pruneEvents.mock.calls[0]![0]).toBe(
      new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString(),
    );
    expect(pruneAudit.mock.calls[0]![0]).toBe(
      new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString(),
    );

    vi.advanceTimersByTime(RETENTION_PRUNE_INTERVAL_MS - 1);
    expect(pruneEvents).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pruneEvents).toHaveBeenCalledTimes(2);
    expect(pruneAudit).toHaveBeenCalledTimes(2);

    pruner.stop();
    vi.advanceTimersByTime(RETENTION_PRUNE_INTERVAL_MS * 2);
    expect(pruneEvents).toHaveBeenCalledTimes(2);
  });

  it("start/stop 幂等，清理抛错不中断调度", () => {
    vi.useFakeTimers();
    const pruneEvents = vi.fn(() => {
      throw new Error("db closed");
    });
    const pruneAudit = vi.fn(() => 1);
    const onError = vi.fn();
    const pruner = createRetentionPruner({ pruneEvents, pruneAudit, onError });

    pruner.start();
    pruner.start(); // 幂等
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pruneAudit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RETENTION_PRUNE_INTERVAL_MS);
    expect(onError).toHaveBeenCalledTimes(2); // 调度未被异常打断
    pruner.stop();
    pruner.stop(); // 幂等
    vi.advanceTimersByTime(RETENTION_PRUNE_INTERVAL_MS);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("runOnce 完整执行各表清理并汇总统计（含 Trust Layer 与 evolution 遥测）", () => {
    const fixedNow = 1_700_000_000_000;
    const pruneEvents = vi.fn(() => 10);
    const pruneAudit = vi.fn(() => 20);
    const pruneActionEvents = vi.fn(() => 5);
    const pruneTrustEvents = vi.fn((_cutoff: string) => 4);
    const pruneSessionIndex = vi.fn(() => 3);
    const pruneActionApprovals = vi.fn(() => 2);
    const pruneCanaryRuns = vi.fn(() => 1);
    const pruneProgressClaims = vi.fn(() => 7);
    const pruneEvolutionHistory = vi.fn((_obsCutoff: string, _dailyCutoff: string) => ({
      observations: 15,
      dailyMetrics: 6,
    }));

    const pruner = createRetentionPruner({
      pruneEvents,
      pruneAudit,
      pruneActionEvents,
      pruneTrustEvents,
      pruneSessionIndex,
      pruneActionApprovals,
      pruneCanaryRuns,
      pruneProgressClaims,
      pruneEvolutionHistory,
      now: () => fixedNow,
    });

    const summary = pruner.runOnce();

    expect(pruneActionEvents).toHaveBeenCalledWith();
    expect(pruneSessionIndex).toHaveBeenCalledWith();
    expect(pruneActionApprovals).toHaveBeenCalledWith();
    expect(pruneCanaryRuns).toHaveBeenCalledWith();
    expect(pruneProgressClaims).toHaveBeenCalledWith();

    expect(pruneTrustEvents).toHaveBeenCalledWith(
      new Date(fixedNow - EVENT_RETENTION_DAYS * 86_400_000).toISOString(),
    );
    expect(pruneEvolutionHistory).toHaveBeenCalledWith(
      new Date(fixedNow - EVOLUTION_OBSERVATION_RETENTION_DAYS * 86_400_000).toISOString(),
      new Date(fixedNow - EVOLUTION_DAILY_METRIC_RETENTION_DAYS * 86_400_000).toISOString(),
    );

    expect(summary).toEqual({
      events: 10,
      audit: 20,
      actionEvents: 5,
      trustEvents: 4,
      sessionIndex: 3,
      actionApprovals: 2,
      canaryRuns: 1,
      progressClaims: 7,
      evolutionObservations: 15,
      evolutionDailyMetrics: 6,
    });
  });

  it("Trust Layer 与 evolution 清理异常被捕获且不影响其他清理项", () => {
    const onError = vi.fn();
    const pruner = createRetentionPruner({
      pruneEvents: () => 1,
      pruneAudit: () => 2,
      pruneActionEvents: () => {
        throw new Error("action events failure");
      },
      pruneEvolutionHistory: () => {
        throw new Error("evolution failure");
      },
      onError,
    });

    const summary = pruner.runOnce();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(summary.events).toBe(1);
    expect(summary.audit).toBe(2);
    expect(summary.actionEvents).toBe(0);
    expect(summary.evolutionObservations).toBe(0);
    expect(summary.evolutionDailyMetrics).toBe(0);
  });
});
