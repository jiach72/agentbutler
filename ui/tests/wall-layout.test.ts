import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AttentionList, TaskPreview } from "../src/pages/dashboard/HealthOverview.js";
import { latencyConclusion, readInitialTheme } from "../src/pages/wall/WallPage.js";
import type { AttentionItem } from "@butler/contract";

const page = readFileSync(new URL("../src/pages/wall/WallPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/pages/wall/wall.css", import.meta.url), "utf8");
const data = readFileSync(new URL("../src/pages/wall/useWallData.ts", import.meta.url), "utf8");

describe("wall keeps a chart-rich operations room", () => {
  it("keeps the 4K chart matrix and only trims duplicated top KPIs", () => {
    expect((page.match(/<KpiCard/g) ?? []).length).toBe(7);
    // 主体保持四列图表矩阵，底部四块战斗信息；用双空格界定类名，避免匹配到 wall-kpirow。
    expect(page).toContain('className="wall-main"');
    expect(css).toContain("grid-template-columns: 3fr 4.2fr 3fr 3.4fr");
    expect(css).toContain(".wall-kpi {");
    expect(css).toContain(".wall-kpirow");
    for (const option of [
      "gaugeOption", "trendOption", "tokenTrendOption", "donutOption",
      "skillBarOption", "costTrendOption", "sparkOption",
    ]) {
      expect(page).toContain(option);
    }
    expect(page).toContain("STAGE_WIDTH");
    expect(css).toContain("width: 3840px");
    expect(css).toContain("@media (max-width: 1023px)");
    expect(page).toContain("MOBILE_BREAKPOINT");
    expect(readInitialTheme()).toBe("dark");
  });

  it("turns the bottom record row into an operations-room queue", () => {
    expect(page).toContain("行动队列");
    expect(page).toContain("未来 24 小时任务");
    expect(page).toContain("通道投递汇总");
    expect(page).toContain("消息网关链路");
    expect(page).not.toContain("升级与备份记录");
  });

  it("derives the wall conclusion from the same contract as the homepage", () => {
    // 共用首页同一套健康推导入口（buildUserHealthInput 由该模块内部调用）。
    expect(data).toContain("deriveHealthView as deriveHealth");
    expect(data).toContain("../dashboard/userHealth.js");
    expect(data).toContain("deriveTaskPreview");
    expect(data).toContain("/api/scheduled-tasks/status");
    expect(data).toContain("/api/approvals?status=pending&limit=200");
    expect(data).not.toContain("/api/backups");
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
