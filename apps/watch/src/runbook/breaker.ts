/**
 * 崩溃循环熔断器（circuit-breaker，Task 7.2）。
 *
 * 按 key（runbook 场景 = "<runbookId>:<instanceId>"；Job 场景 = 任意 Job key）
 * 维护失败时间戳的滚动窗口记录：窗口（默认 10min）内失败达到阈值（默认第 5 次）
 * → 熔断跳闸，onTrip 回调触发 circuit-breaker-tripped 事件 + critical 告警
 * （由组装层接线），此后 isTripped(key) 恒 true，自动触发一律跳过。
 *
 * ⚠️ V1 取舍：熔断状态只在内存（watch 重启即复位）；跳闸事实经
 * circuit-breaker-tripped 事件落 events 表持久化，重启后可从事件流追溯。
 */
export interface CircuitBreakerOptions {
  /** 失败累计窗口（毫秒，默认 10min）。 */
  windowMs?: number;
  /** 窗口内失败次数阈值（默认 5）。 */
  threshold?: number;
  /** 可注入时钟（默认 Date.now）。 */
  now?: () => number;
  /** 跳闸回调（emit 事件 + POST gateway 由组装层接线，仅首次跳闸触发）。 */
  onTrip?: (info: CircuitBreakerTrip) => void;
}

export interface CircuitBreakerTrip {
  key: string;
  failures: number;
  windowMs: number;
  reason: string;
}

/** 单 key 失败时间戳滚动窗口的容量上限（环形覆盖，防极端频率下无界增长）。 */
const MAX_RECORDED = 64;

export class CircuitBreaker {
  readonly windowMs: number;
  readonly threshold: number;
  private readonly now: () => number;
  private readonly onTrip?: (info: CircuitBreakerTrip) => void;
  /** key → 窗口内失败时间戳（升序）。 */
  private readonly failures = new Map<string, number[]>();
  /** key → 跳闸事实（跳闸后常驻，直到进程重启或显式 reset）。 */
  private readonly trips = new Map<string, CircuitBreakerTrip>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.threshold = options.threshold ?? 5;
    this.now = options.now ?? Date.now;
    this.onTrip = options.onTrip;
  }

  /** 该 key 是否已熔断（跳闸后自动触发一律跳过）。 */
  isTripped(key: string): boolean {
    return this.trips.has(key);
  }

  /** 该 key 的跳闸事实（未跳闸返回 undefined）。 */
  tripInfo(key: string): CircuitBreakerTrip | undefined {
    return this.trips.get(key);
  }

  /** 全部已跳闸 key（HTTP 面板按 "<runbookId>:" 前缀聚合展示用）。 */
  trippedKeys(): string[] {
    return [...this.trips.keys()];
  }

  /**
   * 记录一次失败：窗口外旧时间戳先出窗；窗口内累计达到阈值 → 跳闸
   * （仅首次返回 trip 信息并触发 onTrip；已跳闸后继续记录但不重复跳闸）。
   */
  recordFailure(key: string, reason = ""): CircuitBreakerTrip | undefined {
    if (this.trips.has(key)) return this.trips.get(key);
    const now = this.now();
    const stamps = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    stamps.push(now);
    // 环形覆盖：只保留最近 MAX_RECORDED 条。
    while (stamps.length > MAX_RECORDED) stamps.shift();
    this.failures.set(key, stamps);
    if (stamps.length >= this.threshold) {
      const info: CircuitBreakerTrip = { key, failures: stamps.length, windowMs: this.windowMs, reason };
      this.trips.set(key, info);
      this.onTrip?.(info);
      return info;
    }
    return undefined;
  }

  /**
   * Job 级密集失败公共入口（Task 13 复用）：与 runbook 失败同窗口同阈值判定。
   */
  recordJobFailure(key: string, reason = ""): CircuitBreakerTrip | undefined {
    return this.recordFailure(key, reason);
  }

  /** 记录成功：清空该 key 的失败累计（熔断态不因单次成功复位，V1 保持跳闸直到重启）。 */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
