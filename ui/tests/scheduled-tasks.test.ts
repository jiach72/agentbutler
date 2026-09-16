import { describe, expect, it } from "vitest";
import { compareTasks, taskStatusLabel, taskMutationError, scheduleConfirmation } from "../src/pages/tasks/taskCopy.js";

describe("scheduled task presentation", () => {
  it("puts failed tasks before imminent tasks and paused tasks last", () => {
    const items = [
      { id: "paused", enabled: false, lastStatus: "failed", nextRunAt: null },
      { id: "later", enabled: true, lastStatus: "success", nextRunAt: "2026-09-17T01:00:00Z" },
      { id: "failed", enabled: true, lastStatus: "failed", nextRunAt: "2026-09-18T01:00:00Z" },
      { id: "next", enabled: true, lastStatus: "never", nextRunAt: "2026-09-16T01:00:00Z" },
    ];
    expect(items.sort(compareTasks).map((task) => task.id)).toEqual(["failed", "next", "later", "paused"]);
  });

  it("keeps a delivery failure distinct from a failed run", () => {
    expect(taskStatusLabel("delivery_failed")).toBe("通知未送达");
    const items = [
      { id: "ok", enabled: true, lastStatus: "success", nextRunAt: null },
      { id: "undelivered", enabled: true, lastStatus: "delivery_failed", nextRunAt: "2026-09-18T01:00:00Z" },
    ];
    expect(items.sort(compareTasks).map((task) => task.id)).toEqual(["undelivered", "ok"]);
  });

  it("does not pretend unknown or never run is successful", () => {
    expect(taskStatusLabel("unknown")).toBe("结果待确认");
    expect(taskStatusLabel("never")).toBe("尚未执行");
  });

  it("does not expose server errors containing task prompts", () => {
    expect(taskMutationError(500, { error: "prompt=secret api_key=value" })).not.toContain("secret");
    expect(taskMutationError(0, null)).toContain("重复");
  });

  it("uses only the scheduler's real preview", () => {
    expect(scheduleConfirmation("每天 09:00", null, "Asia/Shanghai")).toContain("尚未");
    expect(scheduleConfirmation("每天 09:00", "2026-09-16T01:00:00Z", "Asia/Shanghai")).toContain("09:00");
  });
});
