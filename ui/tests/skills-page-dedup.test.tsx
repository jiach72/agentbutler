/**
 * 技能页首屏去重验收：
 * 1. 库存类汇总收敛为「一个」紧凑计数摘要（概览统计条，3 项：技能/插件/记忆）；
 * 2. 管理标签页（技能库 / 插件 / 记忆）提前暴露，用户第一屏即可进管理；
 * 3. 结论条改为纯状态结论，不再重复「X 个技能与 Y 个插件」这类计数。
 */
import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../src/pages/skills/SkillsPage.js";
import { buildSkillsConclusion, buildSkillsOverview } from "../src/pages/skills/summary.js";
import type { SkillsPayload } from "../src/pages/skills/helpers.js";
import type { FetchState } from "../src/lib/api.js";

const sample = {
  watchReachable: true,
  instance: { instanceId: "hermes-main", frameworkId: "hermes", state: "running", version: "0.20.4" },
  skills: { mode: "driver", driverId: "x", total: 12, items: [], directory: { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false }, notice: "" },
  plugins: { mode: "driver", driverId: "x", total: 3, items: [], directory: { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false }, notice: "" },
  memory: { mode: "driver", driverId: "x", stats: { totalEntries: 240, byMonth: [], coldCandidates: 0, lastWriteAt: null, archivedEntries: 0, probeEntries: 0 }, backend: undefined },
} as unknown as SkillsPayload;

describe("技能页首屏去重", () => {
  it("单一紧凑计数摘要：概览统计条只构建 3 项（技能/插件/记忆）", () => {
    const items = buildSkillsOverview(sample, {
      enabledPluginCount: 2,
      disabledPluginCount: 1,
      memoryWritesOff: false,
    });
    expect(items.map((item) => item.key)).toEqual(["skills", "plugins", "memory-entries"]);
  });

  it("结论条只给状态、不重复库存计数", () => {
    const conclusion = buildSkillsConclusion({ status: "ready", data: sample } as FetchState<SkillsPayload>, sample, false);
    expect(conclusion.tone).toBe("ok");
    expect(conclusion.copy).not.toContain("个技能与");
    expect(conclusion.copy).not.toContain("个插件可加载");
  });

  it("首屏结构：单个概览统计条 + 插件管理标签页（无第二处插件盘点卡）", () => {
    const html = renderToStaticMarkup(
      React.createElement(App, null, React.createElement(MemoryRouter, null, React.createElement(SkillsPage))),
    );
    // 概览统计条只出现一次（库存计数只在这里说一次）。
    expect((html.match(/aria-label="概览统计"/g) ?? [])).toHaveLength(1);
    // 插件作为独立管理标签页暴露（已提前到首屏标签页）。
    expect(html).toContain('id="plugins-panel"');
    // 旧的「插件只读盘点」折叠卡已移除，不再有第二处库存汇总。
    expect(html).not.toContain("只读盘点");
  });
});
