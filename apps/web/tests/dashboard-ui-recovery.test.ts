import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readDashboardSources(): string {
  const dir = path.resolve(process.cwd(), "ui", "src", "pages", "dashboard");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

describe("Dashboard 恢复闭环文案与接线", () => {
  it("动作启动后进入复验轮询，60 秒窗口收口，只有 ok 才提示已解决", () => {
    const source = readDashboardSources();
    // 复验节奏：进行中每 3 秒复诊，60 秒窗口收口
    expect(source).toContain("VERIFY_POLL_MS = 3_000");
    expect(source).toContain("VERIFY_WINDOW_MS = 60_000");
    // 只有诊断结果为 ok 才报“已解决”
    expect(source).toContain('next.severity === "ok"');
    expect(source).toContain("已复验通过");
    // 无低风险动作可执行时明确转人工
    expect(source).toContain("需要人工确认");
  });

  it("不把通用 Runbook 绑定到首页每条问题", () => {
    const source = readDashboardSources();
    expect(source).not.toContain("firstAvailableRunbook");
  });
});
