/**
 * 访问口径守门（审计 D-7 收口）。
 *
 * 旧顶栏/首页把 0.0.0.0 通配发布也说成「仅本地访问」，对安全产品是致命的安抚式
 * 谎言。现在访问范围只有一个口径：ui/src/lib/accessScope.ts 的 describeAccess()，
 * 首页读 /api/security-baseline 真实基线渲染。这组测试防止任何一处硬编码结论回归。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeAccess } from "../src/lib/accessScope.js";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** 去掉注释再扫描：注释里可以记录「删掉了什么」，代码里不能再出现。 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("describeAccess 行为口径", () => {
  it("回环是「仅本机可访问」", () => {
    expect(describeAccess({ publishHost: "127.0.0.1", loopback: true, auth: false })).toMatchObject({
      title: "仅本机可访问",
      tone: "ok",
    });
  });

  it("0.0.0.0 如实说「所有网络接口可访问」，无口令是 error", () => {
    expect(describeAccess({ publishHost: "0.0.0.0", loopback: false, auth: false }).title).toBe("所有网络接口可访问");
    expect(describeAccess({ publishHost: "0.0.0.0", loopback: false, auth: false }).tone).toBe("error");
    expect(describeAccess({ publishHost: "0.0.0.0", loopback: false, auth: true }).tone).toBe("warn");
  });

  it("非回环具体地址是「同一网络可访问」；未读到时不下结论", () => {
    expect(describeAccess({ publishHost: "192.168.1.5", loopback: false, auth: true }).title).toBe("同一网络可访问");
    expect(describeAccess({ publishHost: "192.168.1.5", loopback: false, auth: false }).tone).toBe("error");
    expect(describeAccess(null).tone).toBe("unknown");
  });
});

describe("访问结论不得再被硬编码", () => {
  it("首页安全位经 describeAccess 渲染真实基线", () => {
    const dashboard = code(read("../src/pages/dashboard/DashboardPage.tsx"));
    expect(dashboard).toContain("describeAccess");
    expect(dashboard).toContain("securityBaselinePoll");
    expect(dashboard).not.toContain("仅回环保护");
  });

  it("外壳不再携带旧的撒谎口径", () => {
    const layout = code(read("../src/components/Layout.tsx"));
    expect(layout).not.toContain("仅本地访问");
    expect(layout).not.toContain("baselineTitle");
  });
});
