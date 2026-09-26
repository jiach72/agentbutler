const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * 校验并解析严格的 UTC ISO-8601 时间戳（支持标准秒级与变长毫秒/微秒），防范非法日期溢出与时区混淆。
 */
export function parseTimestamp(value: string, field: string): number {
  if (typeof value !== "string" || !ISO_UTC_REGEX.test(value)) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  // 防范 Date.parse 将 2026-02-31 自动滚动为 2026-03-03 等日期溢出行为
  const iso = new Date(parsed).toISOString();
  if (iso.slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  return parsed;
}
