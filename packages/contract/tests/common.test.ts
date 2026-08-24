import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fail, ok } from "../src/common";
import type { AdapterError, Result } from "../src/common";

describe("ok()/fail() 构造器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ok() 携带 data 且 durationMs 正确计算", () => {
    const r = ok({ value: 42 }, 9_000);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ value: 42 });
    expect(r.durationMs).toBe(1_000);
    expect(r.error).toBeUndefined();
  });

  it("ok() 未传 startedAt 时 durationMs 为 0", () => {
    const r = ok("x");
    expect(r.durationMs).toBe(0);
  });

  it("fail() 携带 error，retryable 由错误码表推导", () => {
    const r = fail("E202", "control timed out", {
      startedAt: 7_500,
      userHint: "控制操作超时，已转入状态复核",
      cause: new Error("timeout"),
    });
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.error?.code).toBe("E202");
    expect(r.error?.message).toBe("control timed out");
    expect(r.error?.userHint).toContain("超时");
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.cause).toBeInstanceOf(Error);
    expect(r.durationMs).toBe(2_500);
  });

  it("fail() 对不可重试错误码推导 retryable=false", () => {
    const r = fail("E303", "auth failed");
    expect(r.error?.retryable).toBe(false);
    expect(r.durationMs).toBe(0);
  });

  it("Result 结构满足约定：成功必有 data，失败必有 error", () => {
    const good: Result<number> = ok(1);
    const bad: Result<number> = fail("E002", "invalid");
    if (good.ok) expect(good.data).toBe(1);
    if (!bad.ok) expect((bad.error as AdapterError).code).toBe("E002");
    expect(typeof good.durationMs).toBe("number");
    expect(typeof bad.durationMs).toBe("number");
  });
});
