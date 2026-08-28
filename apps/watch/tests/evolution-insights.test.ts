import { describe, expect, it } from "vitest";
import { directionFrom } from "../src/evolution-insights.js";

const base = { severity: "error" as const, title: "工具失败", detail: "失败", count: 4, sources: ["hermes.log"], examples: ["2026-08-28 10:00:00 ERROR tool call skill=productivity/demo failed token=[REDACTED]"], suggestedAction: null, actionLabel: null };

describe("日志驱动进化方向", () => {
  it("将技能工具失败转为可确认方向", () => {
    const direction = directionFrom({ ...base, id: "a", kind: "tool-failure", skill: "productivity/demo", lastSeenAt: "2026-08-28T10:00:00.000Z" }, ["productivity/demo"]);
    expect(direction).toMatchObject({ targetType: "skill", targetRef: "productivity/demo", blocked: false, occurrences: 4 });
  });
  it("系统配置问题仅提供修复建议", () => {
    const direction = directionFrom({ ...base, id: "b", kind: "config-error" }, ["productivity/demo"]);
    expect(direction).toMatchObject({ targetType: "config", blocked: true });
  });
  it("未知技能不自动猜路径", () => {
    const direction = directionFrom({ ...base, id: "u", kind: "tool-failure", skill: "unknown/skill" }, ["productivity/demo"]);
    expect(direction).toMatchObject({ targetType: "skill", targetRef: null, blocked: true });
    expect(direction.candidateSkills).toEqual(["productivity/demo"]);
  });
  it("历史 teams-meeting-pipeline 不可重试", () => {
    const direction = directionFrom({ ...base, id: "c", kind: "tool-failure", skill: "teams-meeting-pipeline" }, ["productivity/demo"]);
    expect(direction).toMatchObject({ targetType: "diagnostic", targetRef: null, blocked: true });
    expect(direction.blockReason).toContain("历史目标");
  });
});
