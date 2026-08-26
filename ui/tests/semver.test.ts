import { describe, expect, it } from "vitest";
import { compareVersion } from "../src/lib/semver.js";

describe("compareVersion", () => {
  it("主/次/修订号数值比较", () => {
    expect(compareVersion("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersion("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersion("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersion("1.2.4", "1.2.10")).toBe(-1);
  });

  it("忽略 v 前缀", () => {
    expect(compareVersion("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersion("V2.0.0", "1.9.9")).toBe(1);
  });

  it("prerelease 低于正式版", () => {
    expect(compareVersion("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersion("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("prerelease 标识逐段比较，数值段小于字母段", () => {
    expect(compareVersion("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersion("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersion("1.0.0-beta.1", "1.0.0-beta.1.1")).toBe(-1);
    expect(compareVersion("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("不可解析输入视为相等（避免误判升级）", () => {
    expect(compareVersion("unknown", "1.0.0")).toBe(0);
    expect(compareVersion("", "1.0.0")).toBe(0);
  });
});
