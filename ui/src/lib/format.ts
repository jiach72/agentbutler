/**
 * 展示格式化工具：全站统一的时间/字节/数字格式化，
 * 收编此前散落在 6 个页面里的多份拷贝。
 */

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，异常回退原始字符串。 */
export function formatRelative(
  ts: string | number | Date | null | undefined,
): string {
  if (ts === null || ts === undefined || ts === "") return "—";
  const time = Date.parse(ts instanceof Date ? ts.toISOString() : String(ts));
  if (Number.isNaN(time)) return String(ts);
  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 短时间：MM-dd HH:mm；空值回退 emptyText，解析失败回退原字符串。 */
export function formatTime(
  ts: string | number | Date | null | undefined,
  emptyText = "—",
): string {
  if (ts === null || ts === undefined || ts === "") return emptyText;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return String(ts);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** 字节数人性化：B / KB / MB / GB，非正数归零。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes <= 0
  )
    return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** 数字千分位，非法值回退 "—"。 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return value.toLocaleString("zh-CN");
}

/** 结构化数据守卫：对象且非数组。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从后端错误载荷提取可读文案：优先 error/detail 字段。 */
export function pickErrorText(data: unknown, fallback = "操作失败，请稍后重试"): string {
  if (isRecord(data)) {
    const parts: string[] = [];
    if (typeof data.detail === "string" && data.detail.trim() !== "")
      parts.push(data.detail);
    if (typeof data.error === "string" && data.error.trim() !== "")
      parts.push(data.error);
    if (parts.length > 0) return parts.join("；");
  }
  return fallback;
}
