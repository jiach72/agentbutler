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
});
