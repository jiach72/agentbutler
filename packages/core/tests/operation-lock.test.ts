import { resetManagedOperationLocksForTests, withManagedOperationLock } from "../src/operation-lock.js";
import { afterEach, describe, expect, it } from "vitest";

describe("withManagedOperationLock", () => {
  afterEach(() => resetManagedOperationLocksForTests());

  it("serializes operations sharing a key", async () => {
    const events: string[] = [];
    let release!: () => void;
    const first = withManagedOperationLock("instance:a", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("first-end");
    });
    const second = withManagedOperationLock("instance:a", async () => { events.push("second"); });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("前序操作抛错被 reject 时，后序操作仍能正常获取锁并执行，不发生死锁", async () => {
    let failedRan = false;
    let subsequentRan = false;

    const first = withManagedOperationLock("instance:b", async () => {
      failedRan = true;
      throw new Error("first-failed");
    });

    const second = withManagedOperationLock("instance:b", async () => {
      subsequentRan = true;
      return "second-ok";
    });

    await expect(first).rejects.toThrow("first-failed");
    const result = await second;
    expect(failedRan).toBe(true);
    expect(subsequentRan).toBe(true);
    expect(result).toBe("second-ok");
  });

  it("操作超时被 reject 后，锁能被正确释放给后续排队任务", async () => {
    const first = withManagedOperationLock("instance:c", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }, { timeoutMs: 20 });

    const second = withManagedOperationLock("instance:c", async () => {
      return "next-ok";
    }, { timeoutMs: 500 });

    await expect(first).rejects.toThrow("超时");
    const result = await second;
    expect(result).toBe("next-ok");
  });
});
