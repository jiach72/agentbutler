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
  private inFlight: Promise<boolean> | null = null;
  private wakeCount = 0;
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
    this.wakeCount = 0;
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    await this.inFlight;
  }

  /**
   * 唤醒循环：立即触发一次投递尝试（例如新告警入队时及时响应，无需等待下一个 pace tick）。
   * 累加唤醒计数；若当前已有在途投递（inFlight !== null），在当前投递结束后顺延消费，绝不丢弃任何新告警信号。
   */
  wake(): void {
    if (!this.running) return;
    this.wakeCount += 1;
    if (this.inFlight !== null) return;
    void this.tickGuarded();
  }

  /** 单个 tick：至多认领并处理 1 条到期告警（配速缓释的核心约束）。返回是否成功认领并处理了告警。 */
  async tick(): Promise<boolean> {
    const alert = this.queue.claimNext(this.clock().toISOString());
    if (alert === undefined) return false;
    try {
      await this.deliver(alert);
    } catch (err) {
      console.error(`[gateway] delivery for alert ${alert.id} failed unexpectedly:`, err);
      try {
        this.queue.markFailed(
          alert.id,
          `delivery crashed unexpectedly: ${errorMessage(err)}`,
          this.clock().toISOString(),
        );
      } catch (markErr) {
        console.error(`[gateway] failed to markFailed for alert ${alert.id}:`, markErr);
      }
    }
    return true;
  }

  private async deliver(alert: AlertRow): Promise<void> {
    const message: OutboundMessage = {
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      source: alert.source,
      // 交互式卡片按钮随投递一起下发（M3.1）；无按钮时省略字段，保持旧报文形态。
      ...(alert.actions.length === 0 ? {} : { actions: alert.actions }),
    };

    // info/warn 无需外发；critical 但无可用外发通道时同样降级面板横幅。
    if (alert.severity !== "critical") {
      try {
        await this.panel.send(message);
      } catch (err) {
        console.warn(`[gateway] panel delivery warning for alert ${alert.id}:`, err);
      }
      this.queue.markDelivered(alert.id, this.panel.name, this.clock().toISOString());
      return;
    }
    const channels = availableOutbound(this.outbound);
    if (channels.length === 0) {
      try {
        await this.panel.send(message);
      } catch (err) {
        console.warn(`[gateway] panel fallback delivery warning for alert ${alert.id}:`, err);
      }
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

  /** 定时器与唤醒回调入口：串行化投递，同一时刻至多一条在投；若有唤醒计数，循环顺延消费直至处理完毕或队列无就绪告警。 */
  private async tickGuarded(): Promise<void> {
    if (this.inFlight !== null) return;
    do {
      if (this.wakeCount > 0) this.wakeCount -= 1;
      let claimed = false;
      this.inFlight = this.tick()
        .then((didClaim) => {
          claimed = didClaim;
          return didClaim;
        })
        .catch((err) => {
          console.error("[gateway] delivery tick failed:", err);
          return false;
        });
      try {
        await this.inFlight;
      } finally {
        this.inFlight = null;
      }
      // 若当前已无到期或就绪告警可认领，重置唤醒计数并退出循环，避免空轮询
      if (!claimed) {
        this.wakeCount = 0;
        break;
      }
    } while (this.running && this.wakeCount > 0);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
