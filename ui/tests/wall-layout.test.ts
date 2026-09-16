import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AttentionList, TaskPreview } from "../src/pages/dashboard/HealthOverview.js";
import { readInitialTheme } from "../src/pages/wall/WallPage.js";
import type { AttentionItem } from "@butler/contract";

const page = readFileSync(new URL("../src/pages/wall/WallPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/pages/wall/wall.css", import.meta.url), "utf8");
const data = readFileSync(new URL("../src/pages/wall/useWallData.ts", import.meta.url), "utf8");

describe("wall keeps the original chart-rich operations room", () => {
  it("keeps the 4K chart matrix and the full 9-card KPI row", () => {
    // 原始大屏的 KPI 行是 9 卡；此前被压到 6/7 卡属于误精简，这里锁死回归。
    expect((page.match(/<KpiCard/g) ?? []).length).toBe(9);
    for (const option of [
      "gaugeOption", "trendOption", "tokenTrendOption", "donutOption",
      "skillBarOption", "costTrendOption", "sparkOption",
    ]) {
      expect(page).toContain(option);
    }
    expect(page).toContain("STAGE_WIDTH");
    expect(css).toContain("width: 3840px");
    expect(readInitialTheme()).toBe("dark");
  });

  it("keeps the original four-column panels and bottom record row", () => {
    expect(page).toContain("实例健康");
    expect(page).toContain("主机资源");
    expect(page).toContain("通道质量");
    expect(page).toContain("近 7 日消息投递趋势");
    expect(page).toContain("Token 消耗趋势（7 日 · 按模型）");
    expect(page).toContain("技能调用概览");
    expect(page).toContain("模型 Token 占比（24h）");
    expect(page).toContain("告警与事件");
    expect(page).toContain("进化守门");
    expect(page).toContain("成本与用量趋势（30 日）");
    expect(page).toContain("模型成本分解");
    expect(page).toContain("预算执行");
    expect(page).toContain("通道投递汇总");
    expect(page).toContain("消息网关链路");
    expect(page).toContain("升级与备份记录");
  });

  it("reads upgrade and backup records for the bottom row", () => {
    expect(data).toContain("/api/versions");
    expect(data).toContain("/api/backups");
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
});
