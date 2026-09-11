export interface UsageSeriesPoint {
  date: string;
  calls: number;
}

export type UsageGranularity = "day" | "week" | "month";

const DAY_MS = 86_400_000;

/** 补齐选定窗口内的日期，使用 UTC 与日志接口的日期聚合保持一致。 */
export function fillUsageSeries(
  series: UsageSeriesPoint[],
  rangeDays: number,
  granularityOrNow: UsageGranularity | number = "day",
  nowMs = Date.now(),
): UsageSeriesPoint[] {
  const granularity: UsageGranularity = typeof granularityOrNow === "number" ? "day" : granularityOrNow;
  if (typeof granularityOrNow === "number") nowMs = granularityOrNow;
  const days = Math.max(1, Math.floor(rangeDays));
  const byDate = new Map(series.map((item) => [item.date, item.calls]));
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  if (granularity === "day") {
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(today.getTime() - (days - index - 1) * DAY_MS);
      const key = date.toISOString().slice(0, 10);
      return { date: key, calls: byDate.get(key) ?? 0 };
    });
  }
  if (granularity === "month") {
    const start = new Date(today.getTime() - (days - 1) * DAY_MS);
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const count = (end.getUTCFullYear() - first.getUTCFullYear()) * 12 + end.getUTCMonth() - first.getUTCMonth() + 1;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1));
      const key = date.toISOString().slice(0, 10);
      return { date: key, calls: byDate.get(key) ?? 0 };
    });
  }
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  const first = new Date(start.getTime());
  const firstDay = first.getUTCDay();
  first.setUTCDate(first.getUTCDate() + (firstDay === 0 ? -6 : 1 - firstDay));
  const end = new Date(today.getTime());
  const endDay = end.getUTCDay();
  end.setUTCDate(end.getUTCDate() + (endDay === 0 ? -6 : 1 - endDay));
  const count = Math.max(1, Math.floor((end.getTime() - first.getTime()) / (7 * DAY_MS)) + 1);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first.getTime() + index * 7 * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    return { date: key, calls: byDate.get(key) ?? 0 };
  });
}
