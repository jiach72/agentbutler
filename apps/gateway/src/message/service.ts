import type { BridgeHealth, InstanceRef, MessagingAdapter, PolicySnapshot } from "@butler/contract";

import { createPolicySnapshot } from "./config.js";
import { MessageReconciler } from "./reconciler.js";
import { MESSAGE_HISTORY_RETENTION_MS, MessagePolicyStore } from "./store.js";
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
  historyRetentionMs?: number;
  clock?: () => Date;
  scheduler?: Scheduler;
  randomUUID?: () => string;
}

export interface MessageGatewayStatus {
  running: boolean;
  inFlight: boolean;
  bridgeConnected: boolean;
  /** Sanitized Bridge capability snapshot. Credential material is never part of this contract. */
  bridgeHealth: BridgeHealth | null;
  policyVersion: string | null;
  policyHash: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  counts: ReturnType<MessagePolicyStore["counts"]>;
}

class MessagePolicyInstallError extends Error {
  constructor(message: string, readonly bridgeUnavailable: boolean) {
    super(message);
    this.name = "MessagePolicyInstallError";
  }
}

/** Lifecycle owner around a single reconciler. It serializes timer ticks by design. */
export class MessageGatewayService {
  private readonly intervalMs: number;
  private readonly historyRetentionMs: number;
  private readonly clock: () => Date;
  private readonly scheduler: Scheduler;
  private config: MessagePolicyConfig;
  private timer: unknown;
  private startPromise: Promise<void> | undefined;
  private cyclePromise: Promise<void> | undefined;
  private stopRequested = false;
  private running = false;
  private inFlight = false;
  private bridgeConnected = false;
  /** Bridge 断线时仍保持服务运行，下一轮会重新安装策略并恢复同步。 */
  private policyInstalled = false;
  private lastCycleAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: MessageGatewayServiceOptions) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.historyRetentionMs = options.historyRetentionMs ?? MESSAGE_HISTORY_RETENTION_MS;
    if (!Number.isFinite(this.historyRetentionMs) || this.historyRetentionMs < 0) {
      throw new Error("history retention must be a finite, non-negative number");
    }
    this.clock = options.clock ?? (() => new Date());
    this.scheduler = options.scheduler ?? { setInterval, clearInterval };
    this.config = policyConfigFromSnapshot(createPolicySnapshot(options.config));
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.startPromise !== undefined) return this.startPromise;

    this.stopRequested = false;
    const operation = this.startInternal();
    this.startPromise = operation;
    operation.then(
      () => {
        if (this.startPromise === operation) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === operation) this.startPromise = undefined;
      },
    );
    return operation;
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    requireTimeout(timeoutMs);
    this.stopRequested = true;
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }

    const pending = this.cyclePromise ?? this.startPromise;
    if (pending !== undefined) await settleWithin(pending, timeoutMs);
  }

  wake(): void {
    void this.runCycle();
  }

  async updatePolicy(config: MessagePolicyConfig): Promise<PolicySnapshot> {
    const snapshot = createPolicySnapshot(config);
    const result = await this.options.adapter.updatePolicy(this.options.instance, snapshot);
    if (!result.ok || result.data === undefined) {
      throw new MessagePolicyInstallError(
        `policy install failed: ${result.error?.message ?? "invalid adapter result"}`,
        result.error?.code === "E302",
      );
    }
    if (result.data.version !== snapshot.version || result.data.sha256 !== snapshot.sha256) {
      throw new Error("policy install failed: Bridge acknowledged a different policy snapshot");
    }
    const stored = this.options.store.savePolicy(snapshot);
    this.config = policyConfigFromSnapshot(stored);
    this.policyInstalled = true;
    this.bridgeConnected = true;
    return stored;
  }

  async status(): Promise<MessageGatewayStatus> {
    let bridgeHealth: BridgeHealth | null = null;
    try {
      const health = await this.options.adapter.health(this.options.instance);
      bridgeHealth = health.ok && health.data !== undefined ? health.data : null;
      this.bridgeConnected =
        bridgeHealth !== null && bridgeHealth.attached && bridgeHealth.outboxWritable;
    } catch {
      this.bridgeConnected = false;
    }
    const policy = this.options.store.loadPolicy();
    return {
      running: this.running,
      inFlight: this.inFlight,
      bridgeConnected: this.bridgeConnected,
      bridgeHealth,
      policyVersion: policy?.version ?? null,
      policyHash: policy?.sha256 ?? null,
      lastCycleAt: this.lastCycleAt,
      lastError: this.lastError,
      counts: this.options.store.counts(),
    };
  }

  private async startInternal(): Promise<void> {
    this.running = true;
    this.options.store.absorbPendingProgress(this.clock().toISOString());
    try {
      await this.updatePolicy(this.config);
    } catch (error) {
      if (!(error instanceof MessagePolicyInstallError) || !error.bridgeUnavailable) {
        this.running = false;
        throw error;
      }
      this.bridgeConnected = false;
      this.lastError = error.message;
    }
    await this.runCycle();
    if (this.running && !this.stopRequested) {
      this.timer = this.scheduler.setInterval(() => void this.runCycle(), this.intervalMs);
    }
  }

  private runCycle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.cyclePromise !== undefined) return this.cyclePromise;

    const operation = this.performCycle();
    this.cyclePromise = operation;
    operation.then(
      () => {
        if (this.cyclePromise === operation) this.cyclePromise = undefined;
      },
      () => {
        if (this.cyclePromise === operation) this.cyclePromise = undefined;
      },
    );
    return operation;
  }

  private async performCycle(): Promise<void> {
    this.inFlight = true;
    this.lastCycleAt = this.clock().toISOString();
    try {
      // 首次启动或 Bridge 重启后先反复安装策略。失败只标记离线，不停止
      // Gateway；下一轮会再次尝试，保证 Bridge 恢复后能自动接回。
      if (!this.policyInstalled) {
        await this.updatePolicy(this.config);
      }
      const reconciler = new MessageReconciler({
        adapter: this.options.adapter,
        instance: this.options.instance,
        store: this.options.store,
        config: this.config,
        clock: this.clock,
        randomUUID: this.options.randomUUID,
      });
      await reconciler.reconcileOnce();
      this.options.store.pruneMessageHistory(
        new Date(this.clock().getTime() - this.historyRetentionMs).toISOString(),
      );
      this.bridgeConnected = true;
      this.lastError = null;
    } catch (error) {
      this.bridgeConnected = false;
      this.policyInstalled = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = false;
    }
  }
}

function requireTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("stop timeout must be a finite, non-negative number");
  }
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`message reconciliation did not settle within ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function policyConfigFromSnapshot(snapshot: PolicySnapshot): MessagePolicyConfig {
  return structuredClone(snapshot.payload) as unknown as MessagePolicyConfig;
}
