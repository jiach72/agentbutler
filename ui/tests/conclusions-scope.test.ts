/**
 * 首页健康结论（HeroConclusion/结论条）口径回归：英雄区只描述
 * 「本次实际检查到的本机运行时状态」，不得写成对全部历史消息/全局业务的判断。
 */
import { describe, expect, it } from "vitest";
import { buildConclusions } from "../src/pages/dashboard/conclusions.js";
import type { DashboardPayload } from "../src/pages/dashboard/types.js";

/** 禁用词：任何一条出现在 hero 文案里都意味着结论越界成了全局/历史判断。 */
const FORBIDDEN = ["全局", "历史", "所有消息", "全部业务", "从未", "一直都", "一直没", "全局业务"];

function dashboard(overrides: Partial<DashboardPayload>): DashboardPayload {
  return {
    instances: [],
    latestInspections: [],
    fingerprints: [],
    inspectStatus: { reachable: true, inFlight: false, lastCompletedAt: null },
    ...overrides,
  } as DashboardPayload;
}

describe("首页健康结论口径（只描述本次本机检查）", () => {
  const scenarios: Array<[string, DashboardPayload | null]> = [
    ["加载中", null],
    [
      "正常",
      dashboard({
        instances: [
          { instanceId: "hermes-main", frameworkId: "hermes", state: "running", runtime: "docker", version: "0.20.4", confidence: 0.9 },
        ],
        latestInspections: [
          { instanceId: "hermes-main", ts: "2026-09-01T08:00:00.000Z", overall: "healthy", confidence: 1, checks: [] },
        ],
      }),
    ],
    [
      "异常",
      dashboard({
        latestInspections: [
          { instanceId: "hermes-main", ts: "x", overall: "down", confidence: 0.9, checks: [{ id: "s", status: "fail", detail: "x", durationMs: 1 }] },
        ],
      }),
    ],
    [
      "降级",
      dashboard({
        latestInspections: [
          { instanceId: "hermes-main", ts: "x", overall: "degraded", confidence: 0.8, checks: [{ id: "m", status: "warn", detail: "x", durationMs: 1 }] },
        ],
      }),
    ],
    ["无实例", dashboard({ instances: [] })],
    [
      "无结果",
      dashboard({
        instances: [{ instanceId: "hermes-main", frameworkId: "hermes", state: "running", runtime: "docker", version: "0.20.4", confidence: 0.9 }],
      }),
    ],
  ];

  for (const [name, payload] of scenarios) {
    it(`「${name}」结论不写全局/历史判断`, () => {
      const { hero } = buildConclusions(payload, null);
      const text = `${hero.title} ${hero.copy}`;
      for (const word of FORBIDDEN) {
        expect(text, `hero 含禁用全局口径：${word}`).not.toContain(word);
      }
    });
  }

  it("正常结论明确来自本次检查，且不对消息历史下判断", () => {
    const { hero } = buildConclusions(
      dashboard({
        instances: [
          { instanceId: "hermes-main", frameworkId: "hermes", state: "running", runtime: "docker", version: "0.20.4", confidence: 0.9 },
        ],
        latestInspections: [
          { instanceId: "hermes-main", ts: "2026-09-01T08:00:00.000Z", overall: "healthy", confidence: 1, checks: [] },
        ],
      }),
      null,
    );
    expect(hero.copy).toContain("本次");
    expect(hero.copy).not.toContain("消息");
  });
});
