import { parseScheduledTaskResponse } from "@butler/contract";
import type { ScheduledTaskList, ScheduledTaskStatus, ScheduledTaskSummary } from "@butler/contract";

/** Parse→preview narrowing shared by the homepage and the wall, so both accept exactly the same payloads. */
export function toPreviewTaskStatus(value: unknown): PreviewTaskStatus | null {
  const parsed = parseScheduledTaskResponse("status", value);
  return parsed !== null && "schedulerRunning" in parsed ? parsed : null;
}

export function toPreviewTaskList(value: unknown): PreviewTaskList | null {
  const parsed = parseScheduledTaskResponse("list", value);
  return parsed !== null && "items" in parsed ? parsed as PreviewTaskList : null;
}

/** Read-only projections of the shared contract; Hermes owns scheduling timestamps. */
export type PreviewTask = Pick<ScheduledTaskSummary, "id" | "name" | "enabled" | "nextRunAt" | "lastStatus">;
export type PreviewTaskStatus = Pick<ScheduledTaskStatus, "supported" | "reachable" | "schedulerRunning" | "activeCount" | "todayRunCount" | "failedTaskCount" | "nextRunAt" | "reason">;
export type PreviewTaskList = Pick<ScheduledTaskList, "supported" | "reachable" | "reason"> & { items: PreviewTask[] };

export function deriveTaskPreview(status: PreviewTaskStatus | null, list: PreviewTaskList | null, now: number) {
  const known = status?.supported === true && status.reachable === true && list !== null
    && list.reachable === true && list.supported === true && !status.reason && !list.reason && Array.isArray(list.items);
  const tasks = known ? [...(list.items ?? [])]
    .filter((task) => task.enabled && task.nextRunAt !== null && Number.isFinite(Date.parse(task.nextRunAt)))
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!)) : [];
  const future = tasks.filter((task) => Date.parse(task.nextRunAt!) >= now);
  const upcoming = future.filter((task) => Date.parse(task.nextRunAt!) <= now + 86_400_000);
  const next = future[0] ?? null;
  const label = status?.reason === "unsupported_framework" ? "当前仅 Hermes 支持"
    : !known ? "任务状态暂不可用"
      : status.schedulerRunning === null ? "任务调度状态待确认"
        : !status.schedulerRunning ? "任务调度未运行"
        : tasks.some((task) => Date.parse(task.nextRunAt!) < now) ? "有任务时间待更新"
          : next === null ? (status.activeCount > 0 ? "下次执行时间待确认" : "暂无启用的任务")
            : next.name;
  return {
    known, next, upcoming, label, running: known && status?.schedulerRunning === true,
    todayRunCount: status?.todayRunCount ?? 0, failedTaskCount: status?.failedTaskCount ?? 0,
  };
}
