import { describe, expect, it } from "vitest";
import { fromJson, nowIso, toJson } from "../src/repositories/base.js";

describe("BaseRepository helpers", () => {
  it("toJson 将 undefined / null 规范序列化为 'null'", () => {
    expect(toJson(undefined)).toBe("null");
    expect(toJson(null)).toBe("null");
    expect(toJson({ hello: "world" })).toBe('{"hello":"world"}');
  });

  it("fromJson 安全反序列化：null / undefined / 空串均返回 fallback", () => {
    expect(fromJson(null, { default: true })).toEqual({ default: true });
    expect(fromJson(undefined, { default: true })).toEqual({ default: true });
    expect(fromJson("", [])).toEqual([]);
    expect(fromJson("   ", "fallback")).toBe("fallback");
  });

  it("fromJson 解析损坏 JSON 时静默返回 fallback 而不抛错", () => {
    expect(fromJson("invalid json", { safe: true })).toEqual({ safe: true });
    expect(fromJson("{ bad: 1 }", [])).toEqual([]);
  });

  it("fromJson 正常解析合法 JSON", () => {
    expect(fromJson('{"key": "value"}', {})).toEqual({ key: "value" });
    expect(fromJson("[1, 2, 3]", [])).toEqual([1, 2, 3]);
  });

  it("nowIso 返回合法的 ISO-8601 字符串", () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
