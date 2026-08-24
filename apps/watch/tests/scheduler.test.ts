import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "@butler/core";
import { loadWatchConfig } from "../src/config.js";
import { createInspectionRunner, InspectionScheduler, type TimerDriver } from "../src/scheduler.js";
import type { InspectionStage } from "../src/pipeline.js";

/** fake 定时器驱动：捕获 interval 回调，由测试手动 tick。 */
class FakeDriver implements TimerDriver {
  private slots: Array<(() => void) | undefined> = [];

  setInterval(fn: () => void, ms: number): unknown {
    this.slots.push(fn);
    return { slot: this.slots.length - 1, ms };
  }

  clearInterval(handle: unknown): void {
    const slot = (handle as { slot: number }).slot;
    this.slots[slot] = undefined;
  }

  tick(): void {
    for (const fn of [...this.slots]) fn?.();
  }

  get activeCount(): number {
    return this.slots.filter((fn) => fn !== undefined).length;
  }
}

let tmp: string;
let core: Core;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-scheduler-"));
  core = createCore({ home: tmp });
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** 推进一个实例到 Serving（巡检目标态）。 */
function makeServingInstance(instanceId: string): void {
  core.instances.createInstance({ instanceId, frameworkId: "hermes", confidence: 0.9 });
  core.instances.beginDiscover(instanceId);
  core.instances.confirmInstance(instanceId, "auto");
  core.instances.beginNegotiate(instanceId);
  core.instances.markServing(instanceId, 2);
}

describe("InspectionScheduler（注入式定时器）", () => {
  it("start 立即执行一次，interval 触发循环，stop 后停止", async () => {
    const driver = new FakeDriver();
    let runs = 0;
    const scheduler = new InspectionScheduler({
      intervalMs: 60_000,
      run: async () => {
        runs += 1;
      },
      driver,
    });
    expect(runs).toBe(0);
    await scheduler.start();
    expect(runs).toBe(1); // 立即执行一次
    expect(driver.activeCount).toBe(1);

    driver.tick();
    await new Promise((resolve) => setImmediate(resolve)); // 等在飞一轮落定再触发下一轮
    driver.tick();
    expect(runs).toBe(3);

    scheduler.stop();
    expect(driver.activeCount).toBe(0);
    expect(scheduler.isRunning()).toBe(false);
    driver.tick();
    expect(runs).toBe(3); // stop 后不再触发
  });

  it("run 抛异常不中断调度循环", async () => {
    const driver = new FakeDriver();
    let runs = 0;
    const errors: unknown[] = [];
    const scheduler = new InspectionScheduler({
      intervalMs: 1000,
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error("boom");
      },
      driver,
      onError: (error) => errors.push(error),
    });
    await scheduler.start(); // 首轮异常被捕获
    expect(errors).toHaveLength(1);
    driver.tick(); // 循环继续
    expect(runs).toBe(2);
    scheduler.stop();
  });

  it("在飞巡检防重叠（fire 期间的 interval tick 被忽略）", async () => {
    const driver = new FakeDriver();
    let runs = 0;
    let release: (() => void) | undefined;
    const scheduler = new InspectionScheduler({
      intervalMs: 1000,
      run: async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      driver,
    });
    const starting = scheduler.start();
    driver.tick(); // 首轮仍在飞 → 被忽略
    expect(runs).toBe(1);
    release!();
    await starting;
    scheduler.stop();
  });
});

describe("createInspectionRunner（巡检组装）", () => {
  const passStage: InspectionStage = {
    id: "s1",
    label: "s1",
    async run() {
      return { id: "s1", status: "pass" };
    },
  };

  it("Serving 实例巡检 → inspection-completed 落 events 表 + audit 记录", async () => {
    makeServingInstance("hermes-main");
    const run = createInspectionRunner({
      core,
      config: loadWatchConfig({ home: tmp }),
      stages: [passStage],
    });
    await run();

    const events = core.store.listEvents({ type: "inspection-completed" });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload["instanceId"]).toBe("hermes-main");
    expect(payload["frameworkId"]).toBe("hermes");
    expect(payload["overall"]).toBe("healthy");
    expect(payload["confidence"]).toBe(1);
    expect(typeof payload["startedAt"]).toBe("string");
    expect(typeof payload["finishedAt"]).toBe("string");
    expect(payload["checks"]).toEqual([
      { id: "s1", status: "pass", durationMs: expect.any(Number) },
    ]);

    const audits = core.audit.list({ action: "inspection", target: "hermes-main" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe("butler-watch");
  });

  it("仅巡检 Serving/Degraded/Offline 实例（Registered 不巡检）", async () => {
    makeServingInstance("hermes-main");
    core.instances.createInstance({ instanceId: "pending-ins", frameworkId: "hermes" });
    const run = createInspectionRunner({ core, config: loadWatchConfig({ home: tmp }), stages: [passStage] });
    await run();
    const events = core.store.listEvents({ type: "inspection-completed" });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>)["instanceId"]).toBe("hermes-main");
  });

  it("阶段 fail → overall down/degraded 且 confidence 扣减", async () => {
    makeServingInstance("hermes-main");
    const run = createInspectionRunner({
      core,
      config: loadWatchConfig({ home: tmp }),
      stages: [
        { id: "process-alive", label: "", async run() { return { id: "process-alive", status: "fail" }; } },
      ],
    });
    await run();
    const events = core.store.listEvents({ type: "inspection-completed" });
    expect((events[0]!.payload as Record<string, unknown>)["overall"]).toBe("down");
    expect((events[0]!.payload as Record<string, unknown>)["confidence"]).toBe(0.8);
  });
});
