import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDecimal,
  formatDurationMs,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  isRecord,
  pickErrorText,
} from "../src/lib/format.js";

describe("formatRelative", () => {
  it("空值返回破折号", () => {
    expect(formatRelative(null)).toBe("—");
    expect(formatRelative(undefined)).toBe("—");
    expect(formatRelative("")).toBe("—");
  });

  it("无法解析的输入回退原字符串", () => {
    expect(formatRelative("not-a-date")).toBe("not-a-date");
  });

  it("一分钟内显示刚刚", () => {
    expect(formatRelative(new Date(Date.now() - 30_000).toISOString())).toBe("刚刚");
  });

  it("按分钟/小时/天递进", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 分钟前");
    expect(formatRelative(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3 小时前");
    expect(formatRelative(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2 天前");
  });
});

describe("formatTime", () => {
  it("空值使用 emptyText", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined, "尚无写入")).toBe("尚无写入");
  });

  it("输出 MM-dd HH:mm 结构（Node ICU 下分隔符可能为 /）", () => {
    const text = formatTime("2026-08-26T10:30:00Z");
    expect(text).toMatch(/^\d{2}[-/]\d{2} \d{2}:\d{2}$/);
  });

  it("解析失败回退原字符串", () => {
    expect(formatTime("bad-input")).toBe("bad-input");
  });
});

describe("formatBytes", () => {
  it("非正数归零", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
  });

  it("按单位递进", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("formatNumber", () => {
  it("千分位并兜底非法值", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });
});

describe("data metric formatting", () => {
  it("统一小数、百分比和耗时单位", () => {
    expect(formatDecimal(1234.567, 2)).toBe("1,234.57");
    expect(formatPercent(0.8766, 1)).toBe("87.7%");
    expect(formatPercent(null, 1, "未知")).toBe("未知");
    expect(formatDurationMs(240)).toBe("240 ms");
    expect(formatDurationMs(1250)).toBe("1.3 s");
  });
});

describe("isRecord / pickErrorText", () => {
  it("isRecord 区分对象与数组", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("pickErrorText 提取 error/detail", () => {
    expect(pickErrorText({ error: "boom" })).toBe("boom");
    expect(pickErrorText({ detail: "d", error: "e" })).toBe("d；e");
    expect(pickErrorText({}, "fallback")).toBe("fallback");
    expect(pickErrorText(null, "fallback")).toBe("fallback");
  });
});
