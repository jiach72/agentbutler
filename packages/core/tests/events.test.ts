import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events";

describe("EventBus", () => {
  it("emit 按类型分发且事件形如 {type, payload, at}", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("audit-appended", handler);

    const event = bus.emit("audit-appended", { id: 7, actor: "tester", action: "start", target: "ins-1" });

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0]![0] as typeof event;
    expect(received.type).toBe("audit-appended");
    expect(received.payload).toEqual({ id: 7, actor: "tester", action: "start", target: "ins-1" });
    expect(typeof received.at).toBe("string");
    expect(Number.isNaN(Date.parse(received.at))).toBe(false);
    expect(event).toEqual(received);
  });

  it("off 取消订阅后不再收到事件", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("capability-recovered", handler);
    bus.emit("capability-recovered", { instanceId: "ins-1", capability: "probe" });
    bus.off("capability-recovered", handler);
    bus.emit("capability-recovered", { instanceId: "ins-1", capability: "probe" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("on 返回的退订函数生效", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsubscribe = bus.on("job-event", handler);
    unsubscribe();
    bus.emit("job-event", { job: { jobId: "j1", kind: "snapshot", steps: [] } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("不同类型互不串扰，onAny 收到全部事件", () => {
    const bus = new EventBus();
    const onlyA = vi.fn();
    const any = vi.fn();
    bus.on("capability-degraded", onlyA);
    bus.onAny(any);

    bus.emit("capability-degraded", {
      instanceId: "ins-1",
      capability: "control",
      consecutiveFailures: 3,
      reason: "boom",
    });
    bus.emit("adapter-rejected", { code: "E001", message: "bad manifest" });

    expect(onlyA).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(2);
    expect(any.mock.calls[1]![0].type).toBe("adapter-rejected");
  });
});
