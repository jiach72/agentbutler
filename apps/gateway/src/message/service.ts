import type { InstanceRef, MessagingAdapter, PolicySnapshot } from "@butler/contract";

import { createPolicySnapshot } from "./config.js";
import { MessageReconciler } from "./reconciler.js";
import { MessagePolicyStore } from "./store.js";
import type { MessagePolicyConfig } from "./types.js";

export interface Scheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MessageGatewayServiceOptions {
  adapter: MessagingAdapter;
  instance: InstanceRef;
  store: MessagePolicyStore;
  config: MessagePolicyConfig;
  intervalMs?: number;
  clock?: () => Date;
  scheduler?: Scheduler;
  randomUUID?: () => string;
}

export interface MessageGatewayStatus {
  running: boolean;
  inFlight: boolean;
  bridgeConnected: boolean;
  policyVersion: string | null;
  policyHash: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  counts: ReturnType<MessagePolicyStore["counts"]>;
}

/** Lifecycle owner around a single reconciler. It serializes timer ticks by design. */
export class MessageGatewayService {
  private readonly intervalMs: number;
  private readonly clock: () => Date;
  private readonly scheduler: Scheduler;
  private config: MessagePolicyConfig;
  private timer: unknown;
  private running = false;
  private inFlight = false;
  private bridgeConnected = false;
  private lastCycleAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: MessageGatewayServiceOptions) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.clock = options.clock ?? (() => new Date());
    this.scheduler = options.scheduler ?? { setInterval, clearInterval };
    this.config = policyConfigFromSnapshot(createPolicySnapshot(options.config));
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.updatePolicy(this.config);
    this.running = true;
    await this.runCycle();
    this.timer = this.scheduler.setInterval(() => void this.runCycle(), this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  wake(): void {
    void this.runCycle();
  }

  async updatePolicy(config: MessagePolicyConfig): Promise<PolicySnapshot> {
    const snapshot = createPolicySnapshot(config);
    const result = await this.options.adapter.updatePolicy(this.options.instance, snapshot);
    if (!result.ok || result.data === undefined) {
      throw new Error(`policy install failed: ${result.error?.message ?? "invalid adapter result"}`);
    }
    if (result.data.version !== snapshot.version || result.data.sha256 !== snapshot.sha256) {
      throw new Error("policy install failed: Bridge acknowledged a different policy snapshot");
    }
    const stored = this.options.store.savePolicy(snapshot);
    this.config = policyConfigFromSnapshot(stored);
    this.bridgeConnected = true;
    return stored;
  }

  async status(): Promise<MessageGatewayStatus> {
    try {
      const health = await this.options.adapter.health(this.options.instance);
      this.bridgeConnected = health.ok && health.data !== undefined && health.data.attached && health.data.outboxWritable;
    } catch {
      this.bridgeConnected = false;
    }
    const policy = this.options.store.loadPolicy();
    return {
      running: this.running,
      inFlight: this.inFlight,
      bridgeConnected: this.bridgeConnected,
      policyVersion: policy?.version ?? null,
      policyHash: policy?.sha256 ?? null,
      lastCycleAt: this.lastCycleAt,
      lastError: this.lastError,
      counts: this.options.store.counts(),
    };
  }

  private async runCycle(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    this.lastCycleAt = this.clock().toISOString();
    try {
      const reconciler = new MessageReconciler({
        adapter: this.options.adapter,
        instance: this.options.instance,
        store: this.options.store,
        config: this.config,
        clock: this.clock,
        randomUUID: this.options.randomUUID,
      });
      await reconciler.reconcileOnce();
      this.bridgeConnected = true;
      this.lastError = null;
    } catch (error) {
      this.bridgeConnected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = false;
    }
  }
}

function policyConfigFromSnapshot(snapshot: PolicySnapshot): MessagePolicyConfig {
  return structuredClone(snapshot.payload) as unknown as MessagePolicyConfig;
}
