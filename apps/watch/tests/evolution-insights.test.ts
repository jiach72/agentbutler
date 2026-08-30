import { describe, expect, it } from "vitest";
import { directionFrom, createEvolutionInsightsService } from "../src/evolution-insights.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  severity: "error" as const,
  title: "工具失败",
  detail: "失败",
  count: 4,
  sources: ["hermes.log"],
  examples: ["2026-08-28 10:00:00 ERROR tool call skill=productivity/demo failed token=[REDACTED]"],
  suggestedAction: null,
  actionLabel: null,
};

describe("日志驱动进化方向", () => {
  it("将技能工具失败转为可确认方向", () => {
    const direction = directionFrom(
      {
        ...base,
        id: "a",
        kind: "tool-failure",
        skill: "productivity/demo",
        lastSeenAt: "2026-08-28T10:00:00.000Z",
      },
      ["productivity/demo"],
    );
    expect(direction).toMatchObject({
      targetType: "skill",
      targetRef: "productivity/demo",
      blocked: false,
      occurrences: 4,
    });
  });
  it("系统配置问题仅提供修复建议", () => {
    const direction = directionFrom({ ...base, id: "b", kind: "config-error" }, [
      "productivity/demo",
    ]);
    expect(direction).toMatchObject({ targetType: "config", blocked: true });
  });
  it("未知技能不自动猜路径", () => {
    const direction = directionFrom(
      { ...base, id: "u", kind: "tool-failure", skill: "unknown/skill" },
      ["productivity/demo"],
    );
    expect(direction).toMatchObject({ targetType: "skill", targetRef: null, blocked: true });
    expect(direction.candidateSkills).toEqual(["productivity/demo"]);
  });
  it("历史 teams-meeting-pipeline 不可重试", () => {
    const direction = directionFrom(
      { ...base, id: "c", kind: "tool-failure", skill: "teams-meeting-pipeline" },
      ["productivity/demo"],
    );
    expect(direction).toMatchObject({ targetType: "diagnostic", targetRef: null, blocked: true });
    expect(direction.blockReason).toContain("历史目标");
  });
  it("生成优化说明后重新分析仍然保留", async () => {
    const issue = {
      ...base,
      id: "persisted",
      kind: "tool-failure",
      skill: "productivity/demo",
      lastSeenAt: "2026-08-28T10:00:00.000Z",
    };
    const home = mkdtempSync(join(tmpdir(), "butler-insights-"));
    const service = createEvolutionInsightsService({
      core: { paths: { home }, audit: { append: () => undefined } } as never,
      analyzeLogs: () => ({
        issues: [issue],
        scannedSources: 1,
        scannedLines: 1,
        analyzedAt: new Date().toISOString(),
        coverage: { from: null, to: null, sources: 1, lines: 1, rotatedLogs: false, range: "7d" },
      }),
      evolution: {} as never,
      externalEvolution: {} as never,
      skills: {
        status: async () => ({ skills: { items: [{ name: "productivity/demo" }] } }),
      } as never,
    });
    const first = await service.analyze();
    const summarized = await service.summarize(first.directions[0]!.id);
    expect("error" in summarized ? summarized : summarized.optimization).toBeTruthy();
    const second = await service.analyze();
    expect(second.directions[0]?.optimization?.changes.length).toBeGreaterThan(0);
  });
});
