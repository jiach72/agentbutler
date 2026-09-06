import { describe, expect, it } from "vitest";
import { isSkillHubInstalled } from "../src/pages/skills/skillhub.js";

describe("SkillHub 卡片已安装判定", () => {
  const item = { slug: "self-improving-agent", name: "self-improvement" };

  it("中央库 / Hermes 目录 / 本会话记录任一命中即已安装", () => {
    expect(isSkillHubInstalled(item, [new Set(["self-improving-agent"])])).toBe(true);
    expect(isSkillHubInstalled(item, [new Set(), new Set(["self-improvement"])])).toBe(true);
    expect(isSkillHubInstalled(item, [new Set(), new Set(), new Set(["self-improving-agent"])])).toBe(true);
  });

  it("两个来源都没命中则未安装", () => {
    expect(isSkillHubInstalled(item, [new Set(["pdf-processor"]), new Set(["weekly-report"])])).toBe(false);
  });
});
