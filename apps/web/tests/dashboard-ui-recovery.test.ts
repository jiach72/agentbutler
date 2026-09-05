import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** 排查向导源码（含 steps/ 子目录）：恢复闭环的行为契约已从旧 Recovery 页迁移至此。 */
function readTroubleshootSources(): string {
  const dir = path.resolve(process.cwd(), "ui", "src", "pages", "troubleshoot");
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(dir);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

describe("排查向导复验闭环文案与接线", () => {
  it("动作启动后进入复验轮询，窗口收口，只有 ok 才提示已解决", () => {
    const source = readTroubleshootSources();
    // 复验节奏：进行中每 3 秒复诊，窗口收口后明确转"没修好"
    expect(source).toContain("VERIFY_POLL_MS = 3_000");
    expect(source).toContain("VERIFY_WINDOW_MS = 90_000");
    // 只有诊断结果为 ok 才报"修好了"
    expect(source).toContain('next.severity === "ok"');
    expect(source).toContain('"修好了"');
  });
});
