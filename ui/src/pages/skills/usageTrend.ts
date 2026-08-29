export interface UsageSeriesPoint {
  date: string;
  calls: number;
}

const DAY_MS = 86_400_000;

/** 补齐选定窗口内的日期，使用 UTC 与日志接口的日期聚合保持一致。 */
export function fillUsageSeries(
  series: UsageSeriesPoint[],
  rangeDays: number,
  nowMs = Date.now(),
): UsageSeriesPoint[] {
  const days = Math.max(1, Math.floor(rangeDays));
  const byDate = new Map(series.map((item) => [item.date, item.calls]));
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (days - index - 1) * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    return { date: key, calls: byDate.get(key) ?? 0 };
  });
}
