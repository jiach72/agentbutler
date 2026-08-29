import { describe, expect, it } from "vitest";
import { fillUsageSeries } from "../src/pages/skills/usageTrend.js";

describe("fillUsageSeries", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");

  it("补齐稀疏日期且不会把单日数据扩成多根调用柱", () => {
    const result = fillUsageSeries([{ date: "2026-08-29", calls: 20 }], 30, now);

    expect(result).toHaveLength(30);
    expect(result[0]).toEqual({ date: "2026-07-31", calls: 0 });
    expect(result.at(-1)).toEqual({ date: "2026-08-29", calls: 20 });
    expect(result.filter((item) => item.calls > 0)).toEqual([
      { date: "2026-08-29", calls: 20 },
    ]);
  });

  it("按 UTC 日期补齐，避免本地时区跨日错位", () => {
    const result = fillUsageSeries([{ date: "2026-08-29", calls: 1 }], 1, now);
    expect(result).toEqual([{ date: "2026-08-29", calls: 1 }]);
  });
});
