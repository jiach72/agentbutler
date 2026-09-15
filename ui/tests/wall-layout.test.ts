import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AttentionList, TaskPreview } from "../src/pages/dashboard/HealthOverview.js";
import { latencyConclusion, readInitialTheme } from "../src/pages/wall/WallPage.js";
import type { AttentionItem } from "@butler/contract";

describe("simplified wall and dashboard layout", () => {
  it("wall has exactly six KPIs, no scaled stage, and a real small-screen layout", () => {
    const page = readFileSync(new URL("../src/pages/wall/WallPage.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/pages/wall/wall.css", import.meta.url), "utf8");
    expect((page.match(/<Kpi /g) ?? []).length).toBe(6);
    expect(page).not.toMatch(/STAGE_WIDTH|scale\(/);
    expect(css).toContain("@media (max-width: 1023px)");
    expect(css).not.toMatch(/text-shadow|box-shadow|radial-gradient|3840/);
    expect(page).toContain("打开首页");
    expect(readInitialTheme()).toBe("dark");
  });
  it("shows five attention rows with impact and actions, with further entries collapsed", () => {
    const attention: AttentionItem[] = Array.from({ length: 7 }, (_, index) => ({
      id: String(index), severity: "action", title: `问题 ${index}`, impact: "消息可能未送达",
      actionLabel: "核对结果", actionHref: "/gateway", lastSeenAt: "",
    }));
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(AttentionList, { attention })));
    expect((html.match(/<li /g) ?? []).length).toBe(5);
    expect(html).toContain("另有 2 项待确认");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("消息可能未送达");
    expect(html).toContain('href="/gateway"');
  });
  it("task unavailable state is honest and links to the real tasks route", () => {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(TaskPreview, {
      tasks: { known: false, next: null, upcoming: [], label: "任务状态暂不可用", running: false },
    })));
    expect(html).toContain("尚未获得任务列表");
    expect(html).toContain('href="/tasks"');
    expect(html).not.toContain("暂无启用的任务");
  });
  it("P95 cannot claim within threshold without a configured threshold", () => {
    expect(latencyConclusion(50)).toBe("P95 50 毫秒，未设阈值");
    expect(latencyConclusion(1500, 1000)).toContain("超过阈值");
    expect(latencyConclusion(1000, 1000)).toContain("阈值内");
    expect(latencyConclusion(null)).toBe("暂无延迟样本");
  });
});
