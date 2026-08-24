/**
 * 能力路由：调用前的能力位裁决 + 运行期降级/恢复判定。
 *
 * check(instance, capability)：
 * - not-implemented → allowed:false（面板应隐藏入口）；
 * - unavailable      → allowed:true + degraded:true + 原因（入口置灰）；
 * - 运行期已标降级   → allowed:true + degraded:true。
 *
 * recordResult(instance, capability, ok)：
 * - 连续 3 次失败 → 该能力标 degraded（发 capability-degraded +
 *   InstanceManager.markDegraded）；
 * - 成功 → 重置计数；degraded 后成功 → capability-recovered，
 *   且该实例无其他降级能力时实例转回 Serving（探测恢复）。
 */
import type { Capability, CapabilityStatus, Level } from "@butler/contract";
import type { EventBus } from "./events.js";
import type { InstanceManager, InstanceRecord } from "./lifecycle.js";

/** 连续失败多少次后标记降级。 */
export const DEGRADE_AFTER_CONSECUTIVE_FAILURES = 3;

export interface CapabilityCheckResult {
  allowed: boolean;
  degraded?: boolean;
  reason?: string;
  status: CapabilityStatus;
}

interface RuntimeCapabilityState {
  consecutiveFailures: number;
  degraded: boolean;
  reason?: string;
}

export class CapabilityRouter {
  private bus: EventBus;
  private instances: InstanceManager;
  /** instanceId → capability → 运行期状态（进程内，重启后由巡检重建）。 */
  private runtime = new Map<string, Map<Capability, RuntimeCapabilityState>>();

  constructor(deps: { bus: EventBus; instances: InstanceManager }) {
    this.bus = deps.bus;
    this.instances = deps.instances;
  }

  /** 调用前裁决：not-implemented 不允许调用；unavailable/降级 允许但受限。 */
  check(instance: InstanceRecord, capability: Capability): CapabilityCheckResult {
    const scanStatus: CapabilityStatus = instance.capability?.capabilities[capability] ?? "not-implemented";
    if (scanStatus === "not-implemented") {
      return {
        allowed: false,
        status: scanStatus,
        reason: `capability "${capability}" not implemented by ${instance.instanceId}; hide the entry`,
      };
    }
    const runtimeState = this.runtime.get(instance.instanceId)?.get(capability);
    if (runtimeState?.degraded === true) {
      return { allowed: true, degraded: true, status: "degraded", reason: runtimeState.reason };
    }
    if (scanStatus === "unavailable") {
      return {
        allowed: true,
        degraded: true,
        status: scanStatus,
        reason: `capability "${capability}" currently unavailable per capabilityScan`,
      };
    }
    if (scanStatus === "degraded") {
      return { allowed: true, degraded: true, status: scanStatus };
    }
    return { allowed: true, status: "ok" };
  }

  /** 记录一次调用结果，驱动运行期降级与恢复。 */
  recordResult(instance: InstanceRecord, capability: Capability, ok: boolean): void {
    let perInstance = this.runtime.get(instance.instanceId);
    if (perInstance === undefined) {
      perInstance = new Map();
      this.runtime.set(instance.instanceId, perInstance);
    }
    const state = perInstance.get(capability) ?? { consecutiveFailures: 0, degraded: false };

    if (ok) {
      perInstance.set(capability, { consecutiveFailures: 0, degraded: false });
      if (state.degraded) {
        this.bus.emit("capability-recovered", { instanceId: instance.instanceId, capability });
        if (!this.anyDegraded(instance.instanceId)) {
          const level: Level = instance.capability?.effectiveLevel ?? 0;
          this.instances.markServing(instance.instanceId, level);
        }
      }
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= DEGRADE_AFTER_CONSECUTIVE_FAILURES && !state.degraded) {
      const reason = `capability "${capability}" failed ${state.consecutiveFailures} consecutive times`;
      state.degraded = true;
      state.reason = reason;
      perInstance.set(capability, state);
      this.bus.emit("capability-degraded", {
        instanceId: instance.instanceId,
        capability,
        consecutiveFailures: state.consecutiveFailures,
        reason,
      });
      this.instances.markDegraded(instance.instanceId, reason);
    } else {
      perInstance.set(capability, state);
    }
  }

  /** 查询某能力当前运行期是否降级（测试/巡检用）。 */
  isRuntimeDegraded(instanceId: string, capability: Capability): boolean {
    return this.runtime.get(instanceId)?.get(capability)?.degraded === true;
  }

  private anyDegraded(instanceId: string): boolean {
    for (const state of this.runtime.get(instanceId)?.values() ?? []) {
      if (state.degraded) return true;
    }
    return false;
  }
}
