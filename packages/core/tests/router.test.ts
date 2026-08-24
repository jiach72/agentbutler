import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events";
import { InstanceManager, type InstanceRecord } from "../src/lifecycle";
import { CapabilityRouter, DEGRADE_AFTER_CONSECUTIVE_FAILURES } from "../src/router";
import { SqliteStore } from "../src/store";
import { fakeCapabilityReport, makeTempDir, rmTempDir } from "./helpers";

describe("CapabilityRouter", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let instances: InstanceManager;
  let router: CapabilityRouter;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "butler.db"));
    bus = new EventBus();
    instances = new InstanceManager({ store, bus });
    router = new CapabilityRouter({ bus, instances });
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  /** 驱动实例到 Serving，并带上能力报告：
   * probe/control ok、messaging not-implemented、memory-driver unavailable。 */
  function servingInstance(): InstanceRecord {
    instances.createInstance({ instanceId: "ins-1", frameworkId: "fake-fw", confidence: 0.9 });
    instances.beginDiscover("ins-1");
    instances.confirmInstance("ins-1", "auto");
    instances.beginNegotiate("ins-1");
    const report = fakeCapabilityReport({
      capabilities: {
        ...fakeCapabilityReport().capabilities,
        "memory-driver": "unavailable",
      },
    });
    const serving = instances.markServing("ins-1", 2, report);
    return serving.data!;
  }

  it("not-implemented → allowed:false（面板应隐藏入口）", () => {
    const ins = servingInstance();
    const check = router.check(ins, "messaging");
    expect(check.allowed).toBe(false);
    expect(check.status).toBe("not-implemented");
    expect(check.reason).toBeTruthy();
  });

  it("ok 能力 → allowed:true 且不降级", () => {
    const ins = servingInstance();
    const check = router.check(ins, "control");
    expect(check.allowed).toBe(true);
    expect(check.degraded).toBeFalsy();
    expect(check.status).toBe("ok");
  });

  it("unavailable → allowed:true + degraded:true + 原因（入口置灰而非隐藏）", () => {
    const ins = servingInstance();
    const check = router.check(ins, "memory-driver");
    expect(check.allowed).toBe(true);
    expect(check.degraded).toBe(true);
    expect(check.status).toBe("unavailable");
    expect(check.reason).toContain("unavailable");
  });

  it("连续 3 次失败 → 标 degraded：事件 + 实例 Degraded + check 受限", () => {
    const ins = servingInstance();
    const degradedHandler = vi.fn();
    bus.on("capability-degraded", degradedHandler);

    for (let i = 1; i < DEGRADE_AFTER_CONSECUTIVE_FAILURES; i++) {
      router.recordResult(ins, "control", false);
      expect(router.isRuntimeDegraded("ins-1", "control")).toBe(false);
    }
    expect(degradedHandler).not.toHaveBeenCalled();
    expect(instances.getInstance("ins-1")!.state).toBe("Serving");

    router.recordResult(ins, "control", false); // 第 3 次
    expect(router.isRuntimeDegraded("ins-1", "control")).toBe(true);
    expect(degradedHandler).toHaveBeenCalledTimes(1);
    expect(degradedHandler.mock.calls[0]![0].payload).toMatchObject({
      instanceId: "ins-1",
      capability: "control",
      consecutiveFailures: 3,
    });
    expect(instances.getInstance("ins-1")!.state).toBe("Degraded");

    const check = router.check(ins, "control");
    expect(check.allowed).toBe(true);
    expect(check.degraded).toBe(true);
  });

  it("成功重置计数：2 失败 + 1 成功 + 2 失败不降级", () => {
    const ins = servingInstance();
    router.recordResult(ins, "control", false);
    router.recordResult(ins, "control", false);
    router.recordResult(ins, "control", true);
    router.recordResult(ins, "control", false);
    router.recordResult(ins, "control", false);

    expect(router.isRuntimeDegraded("ins-1", "control")).toBe(false);
    expect(instances.getInstance("ins-1")!.state).toBe("Serving");
  });

  it("degraded 后成功 → capability-recovered，能力与实例双双恢复", () => {
    const ins = servingInstance();
    const recoveredHandler = vi.fn();
    bus.on("capability-recovered", recoveredHandler);

    for (let i = 0; i < 3; i++) router.recordResult(ins, "control", false);
    expect(instances.getInstance("ins-1")!.state).toBe("Degraded");

    router.recordResult(ins, "control", true);
    expect(recoveredHandler).toHaveBeenCalledTimes(1);
    expect(recoveredHandler.mock.calls[0]![0].payload).toEqual({ instanceId: "ins-1", capability: "control" });
    expect(router.isRuntimeDegraded("ins-1", "control")).toBe(false);
    expect(instances.getInstance("ins-1")!.state).toBe("Serving"); // 无其他降级能力 → 实例恢复
  });

  it("多能力独立降级：全部恢复后实例才回 Serving", () => {
    const ins = servingInstance();
    for (let i = 0; i < 3; i++) {
      router.recordResult(ins, "control", false);
      router.recordResult(ins, "probe", false);
    }
    expect(instances.getInstance("ins-1")!.state).toBe("Degraded");

    router.recordResult(ins, "control", true); // probe 仍降级
    expect(instances.getInstance("ins-1")!.state).toBe("Degraded");
    expect(router.check(ins, "control").degraded).toBeFalsy();
    expect(router.check(ins, "probe").degraded).toBe(true);

    router.recordResult(ins, "probe", true);
    expect(instances.getInstance("ins-1")!.state).toBe("Serving");
  });
});
