/**
 * 投递循环（Task 8）：配速缓释 + 逐级降级路由。
 *
 * - 每个 pace tick 至多处理 1 条 alert（tick 间隔 BUTLER_GATEWAY_PACE_SEC）；
 * - info/warn：面板即达，tick 内直接 delivered(channel='panel')；
 * - critical：依序尝试可用外发通道（Telegram → SMTP），任一成功即 delivered；
 *   无任何可用外发通道 → 降级面板 delivered（凭据缺失体现在 degradedChannels）；
 *   全部失败 → 走指数退避重试，attempts ≥ 5 → failed（不静默丢弃）。
 *
 * 时钟与调度器均可注入，tick() 暴露为公开方法便于独立测试。
 */
import { availableOutbound, NullChannel, type AlertChannel, type OutboundMessage } from "./channels.js";
import type { AlertQueue, AlertRow } from "./queue.js";

export type Clock = () => Date;

/** 调度器抽象：默认 setInterval，测试可注入假调度器。 */
export interface LoopScheduler {
  every(ms: number, fn: () => void): () => void;
}

export const intervalScheduler: LoopScheduler = {
  every: (ms, fn) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

export interface DeliveryLoopOptions {
  queue: AlertQueue;
  /** 外发候选序列（已按降级优先级排序，如 Telegram → SMTP）。 */
  outbound: AlertChannel[];
  paceSec?: number;
  clock?: Clock;
  scheduler?: LoopScheduler;
}

export class DeliveryLoop {
  private readonly queue: AlertQueue;
  private readonly outbound: AlertChannel[];
  private readonly paceMs: number;
  private readonly clock: Clock;
  private readonly scheduler: LoopScheduler;
  private readonly panel: AlertChannel = new NullChannel();
  private cancelTimer: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  constructor(options: DeliveryLoopOptions) {
    this.queue = options.queue;
    this.outbound = options.outbound;
    const paceSec = options.paceSec ?? 30;
    this.paceMs = Math.max(1, paceSec) * 1000;
    this.clock = options.clock ?? (() => new Date());
    this.scheduler = options.scheduler ?? intervalScheduler;
  }

  /** 启动循环：立即跑一个 tick 尽快消化积压，其后按 pace 间隔持续。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.cancelTimer = this.scheduler.every(this.paceMs, () => void this.tickGuarded());
    void this.tickGuarded();
  }

  /** 停止循环：取消定时器并等待在途投递完成（不丢已认领行）。 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    await this.inFlight;
  }

  /** 单个 tick：至多认领并处理 1 条到期告警（配速缓释的核心约束）。 */
  async tick(): Promise<void> {
    const alert = this.queue.claimNext(this.clock().toISOString());
    if (alert === undefined) return;
    await this.deliver(alert);
  }

  private async deliver(alert: AlertRow): Promise<void> {
    const message: OutboundMessage = {
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      source: alert.source,
    };

    // info/warn 无需外发；critical 但无可用外发通道时同样降级面板横幅。
    if (alert.severity !== "critical") {
      await this.panel.send(message);
      this.queue.markDelivered(alert.id, this.panel.name, this.clock().toISOString());
      return;
    }
    const channels = availableOutbound(this.outbound);
    if (channels.length === 0) {
      await this.panel.send(message);
      this.queue.markDelivered(alert.id, this.panel.name, this.clock().toISOString());
      return;
    }

    // 逐级降级：任一成功即 delivered；全部失败 → 重试（指数退避在队列侧）。
    const errors: string[] = [];
    for (const channel of channels) {
      try {
        await channel.send(message);
        this.queue.markDelivered(alert.id, channel.name, this.clock().toISOString());
        return;
      } catch (err) {
        errors.push(`${channel.name}: ${errorMessage(err)}`);
      }
    }
    this.queue.markFailed(alert.id, errors.join("; "), this.clock().toISOString());
  }

  /** 定时器回调入口：上一 tick 未完成则跳过（保证至多一条在投、节奏不被追帧）。 */
  private async tickGuarded(): Promise<void> {
    if (this.inFlight !== null) return;
    this.inFlight = this.tick().catch((err) => {
      console.error("[gateway] delivery tick failed:", err);
    });
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
