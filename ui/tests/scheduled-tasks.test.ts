import { describe, expect, it } from "vitest";
import { compareTasks, taskStatusLabel, taskMutationError, scheduleConfirmation, humanizeSchedule } from "../src/pages/tasks/taskCopy.js";

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

  it("humanizes cryptic cron expressions into clear Chinese", () => {
    expect(humanizeSchedule("0 */4 * * *")).toEqual({ text: "每 4 小时整点", rawCron: "0 */4 * * *" });
    expect(humanizeSchedule("0 9 * * *")).toEqual({ text: "每天 09:00", rawCron: "0 9 * * *" });
    expect(humanizeSchedule("0 9 * * 1-5")).toEqual({ text: "工作日 (周一至周五) 09:00", rawCron: "0 9 * * 1-5" });
    expect(humanizeSchedule("*/15 * * * *")).toEqual({ text: "每隔 15 分钟", rawCron: "*/15 * * * *" });
    expect(humanizeSchedule("0 * * * *")).toEqual({ text: "每小时整点", rawCron: "0 * * * *" });
    expect(humanizeSchedule("every 30m")).toEqual({ text: "每 30 分钟" });
    expect(humanizeSchedule("每天 09:00")).toEqual({ text: "每天 09:00" });
  });
});
