import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readDashboard(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "ui", "src", "pages", "Dashboard.tsx"), "utf8");
}

describe("Dashboard 恢复闭环文案与接线", () => {
  it("动作启动后安排 2 秒和 60 秒复验，只有 ok 才提示已解决", () => {
    const source = readDashboard();
    expect(source).toContain("verifyRecovery");
    expect(source).toContain("verifyRecovery(lowRisk.label, 2_000)");
    expect(source).toContain("verifyRecovery(lowRisk.label, 60_000)");
    expect(source).toContain("verifyRecovery(action.label, 2_000)");
    expect(source).toContain("verifyRecovery(action.label, 60_000)");
    expect(source).toContain("next.severity === \"ok\"");
    expect(source).toContain("需要人工确认");
  });

  it("不把通用 Runbook 绑定到首页每条问题", () => {
    const source = readDashboard();
    expect(source).not.toContain("firstAvailableRunbook");
  });
});
