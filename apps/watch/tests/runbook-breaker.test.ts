/**
 * circuit-breaker 熔断测试：注入时钟推窗口内失败计数 / 阈值跳闸 /
 * 窗口外出清 / recordJobFailure 公共入口 / 成功复位语义。
 */
import { describe, expect, it } from "vitest";
import { CircuitBreaker, type CircuitBreakerTrip } from "../src/runbook/breaker.js";

const WINDOW_MS = 10 * 60 * 1000;

/** 可推进 fake 时钟。 */
class FakeClock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

describe("CircuitBreaker（崩溃循环熔断）", () => {
  it("窗口内 4 次失败不熔断，第 5 次跳闸（仅首次触发 onTrip）", () => {
    const clock = new FakeClock();
    const trips: CircuitBreakerTrip[] = [];
    const breaker = new CircuitBreaker({
      windowMs: WINDOW_MS,
      threshold: 5,
      now: () => clock.now(),
      onTrip: (info) => trips.push(info),
    });

    for (let i = 0; i < 4; i++) {
      clock.advance(60_000); // 每分钟一败，均在 10min 窗口内
      expect(breaker.recordFailure("rb-restart:ins1", `第${i + 1}次`)).toBeUndefined();
    }
    expect(breaker.isTripped("rb-restart:ins1")).toBe(false);
    expect(trips).toHaveLength(0);

    clock.advance(60_000);
    const trip = breaker.recordFailure("rb-restart:ins1", "第5次");
    expect(trip).toMatchObject({ key: "rb-restart:ins1", failures: 5, windowMs: WINDOW_MS, reason: "第5次" });
    expect(breaker.isTripped("rb-restart:ins1")).toBe(true);
    expect(breaker.tripInfo("rb-restart:ins1")?.failures).toBe(5);
    expect(trips).toHaveLength(1);

    // 已跳闸后继续记录不重复跳闸（返回既有跳闸事实）。
    clock.advance(60_000);
    expect(breaker.recordFailure("rb-restart:ins1", "again")).toBe(trip);
    expect(trips).toHaveLength(1);
  });

  it("窗口外失败不累计：跨窗口间隔失败永不达阈值", () => {
    const clock = new FakeClock();
    const trips: CircuitBreakerTrip[] = [];
    const breaker = new CircuitBreaker({
      windowMs: WINDOW_MS,
      threshold: 5,
      now: () => clock.now(),
      onTrip: (info) => trips.push(info),
    });

    breaker.recordFailure("k1");
    for (let i = 0; i < 4; i++) {
      clock.advance(WINDOW_MS + 1000); // 每次都越过整个窗口 → 旧时间戳全部出窗
      expect(breaker.recordFailure("k1")).toBeUndefined();
    }
    expect(breaker.isTripped("k1")).toBe(false);
    expect(trips).toHaveLength(0);
  });

  it("recordJobFailure 公共入口与 runbook 失败同窗口同阈值判定", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ windowMs: WINDOW_MS, threshold: 5, now: () => clock.now() });
    for (let i = 0; i < 4; i++) {
      clock.advance(30_000);
      expect(breaker.recordJobFailure("job:cleanup:ins1", "Job 失败")).toBeUndefined();
    }
    clock.advance(30_000);
    const trip = breaker.recordJobFailure("job:cleanup:ins1", "Job 失败");
    expect(trip).toMatchObject({ key: "job:cleanup:ins1", failures: 5 });
    expect(breaker.isTripped("job:cleanup:ins1")).toBe(true);
  });

  it("成功清空失败累计（未跳闸时）", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ windowMs: WINDOW_MS, threshold: 5, now: () => clock.now() });
    for (let i = 0; i < 4; i++) {
      clock.advance(30_000);
      breaker.recordFailure("k2");
    }
    breaker.recordSuccess("k2"); // 累计清零
    for (let i = 0; i < 4; i++) {
      clock.advance(30_000);
      expect(breaker.recordFailure("k2")).toBeUndefined();
    }
    expect(breaker.isTripped("k2")).toBe(false); // 4 + 4 次但被成功隔断，从未连续累计到 5
  });

  it("跳闸不因单次成功复位（V1 保持跳闸直到重启）", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ windowMs: WINDOW_MS, threshold: 5, now: () => clock.now() });
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      breaker.recordFailure("k3");
    }
    expect(breaker.isTripped("k3")).toBe(true);
    breaker.recordSuccess("k3");
    expect(breaker.isTripped("k3")).toBe(true);
  });

  it("不同 key 相互独立", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ windowMs: WINDOW_MS, threshold: 5, now: () => clock.now() });
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      breaker.recordFailure("rb-restart:insA");
    }
    expect(breaker.isTripped("rb-restart:insA")).toBe(true);
    expect(breaker.isTripped("rb-restart:insB")).toBe(false);
  });
});
