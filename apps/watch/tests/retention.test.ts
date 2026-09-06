import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
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
});
