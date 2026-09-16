/* 首页 + 作战室大屏浏览器回归：所有 /api/** 请求都由本脚本拦截，
   用真实 Chromium 验证「大屏保留图表矩阵、桌面一屏、移动端纵向可读」。
   运行前置：ui dev server 已在 http://127.0.0.1:5173 提供服务。
   运行：node ui/tests/dashboard-wall.browser.mjs */
/* global document, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BUTLER_PLAYWRIGHT_PATH ?? "playwright");
const output = path.resolve("output/playwright");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BUTLER_BROWSER_CHANNEL ?? "chrome" });

const now = new Date().toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();
const days = Array.from({ length: 7 }, (_, i) => {
  const date = new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
  return date;
});
const payloads = {
  "/api/setup/status": { configured: true },
  "/api/alerts": {
    reachable: true, counts: {}, unreadCount: 0, degradedChannels: [],
    items: [{ id: 1, status: "active", severity: "warning", title: "待核对提醒" }],
  },
  "/api/approvals": { reachable: true, summary: { pending: 2, escalated: 0, expired: 15, total: 17 }, items: [] },
  "/api/dashboard": {
    instances: [{ instanceId: "hermes-main", frameworkId: "hermes", state: "Serving", runtime: "process", version: "1.0", confidence: 1 }],
    latestInspections: [{
      instanceId: "hermes-main", ts: now, overall: "degraded", confidence: 1,
      checks: [
        { id: "memory", status: "fail", detail: "fixture", durationMs: 4 },
        { id: "llm-probe", status: "pass", detail: "fixture", durationMs: 4 },
      ],
    }],
    fingerprints: [{ id: "fp-1" }],
  },
  "/api/connections": {
    reachable: true,
    connections: [{ instanceId: "hermes-main", frameworkId: "hermes", displayName: "Hermes 主实例", state: "Serving", connected: true, runtime: "process", version: "1.0", lastCheckedAt: now }],
  },
  "/api/messages/status": {
    reachable: true,
    status: {
      bridge: { connected: true, running: true, attached: true, outboxWritable: true },
      counts: { delivery_unknown: 3, failed: 1 },
      relay: { enabled: true, pending: false },
    },
  },
  "/api/scheduled-tasks/status": {
    schemaVersion: 1, supported: true, reachable: true, schedulerRunning: true, activeCount: 2,
    todayRunCount: 12, failedTaskCount: 1, nextRunAt: future, heartbeatAgeSeconds: 3,
    timezone: "Asia/Shanghai", writesSupported: false, runSupported: false,
  },
  "/api/scheduled-tasks": {
    schemaVersion: 1, supported: true, reachable: true,
    items: [{
      id: "daily", name: "每日项目进展与待处理事项汇总", enabled: true, scheduleLabel: "每日",
      nextRunAt: future, lastRunAt: null, lastStatus: "success", failureStreak: 0,
      deliveryEnabled: true, editable: false,
    }],
  },
  "/api/messages/metrics": {
    days: 7, retries: 2,
    channels: [{ channel: "wecom", delivered: 28, failed: 2, uncertain: 0, total: 30, successRate: 28 / 30, p50LatencyMs: 420, p95LatencyMs: 1250, latencySamples: 30, retries: 2 }],
    latency: { p95Ms: 1250, samples: 30, unknown: 0, p50Ms: 420 },
    daily: [
      { date: days[4], channel: "wecom", delivered: 10, failed: 1, uncertain: 0 },
      { date: days[5], channel: "wecom", delivered: 12, failed: 0, uncertain: 0 },
      { date: days[6], channel: "wecom", delivered: 8, failed: 2, uncertain: 0 },
    ],
  },
  "/api/host/metrics": {
    machine: { capturedAt: now, cpuPercent: 18, memTotalBytes: 1000, memFreeBytes: 550, diskTotalBytes: 1000, diskUsedBytes: 380 },
    agents: [{ instanceId: "hermes-main", cpuPercent: 6, rssBytes: 268_435_456 }],
    samples: Array.from({ length: 12 }, (_, i) => ({
      capturedAt: now, cpuPercent: 10 + i, memTotalBytes: 1000, memFreeBytes: 550, diskTotalBytes: 1000, diskUsedBytes: 380,
    })),
  },
  "/api/skills/usage": {
    rangeDays: 30,
    series: days.map((date, i) => ({ date, calls: 4 + i * 3 })),
    skills: [
      { name: "memory.search", calls: 42, lastUsedAt: now, successRate: 1, status: "known" },
      { name: "repo.review", calls: 31, lastUsedAt: now, successRate: 0.97, status: "known" },
      { name: "docs.write", calls: 18, lastUsedAt: now, successRate: 0.99, status: "known" },
    ],
    notice: "",
  },
  "/api/evolution/proposals": { proposals: [{ id: "p1" }, { id: "p2" }] },
  "/api/llm/usage": {
    rangeDays: 7,
    days: days.map((date, i) => ({ date, tokens: 120_000 + i * 45_000 })),
    models: [
      { model: "claude-sonnet-4", tokens: 620_000, daily: days.map((_, i) => 60_000 + i * 8_000) },
      { model: "gpt-5-codex", tokens: 410_000, daily: days.map((_, i) => 40_000 + i * 5_000) },
      { model: "deepseek-v3", tokens: 180_000, daily: days.map((_, i) => 18_000 + i * 2_000) },
    ],
  },
  "/api/llm/cost/summary": {
    rangeDays: 30, costAvailable: true,
    total: { estimatedUsd: 12.4, actualUsd: 10.8, verifiedUsd: 8.2 },
    days: days.map((date, i) => ({
      date, tokens: 150_000 + i * 30_000,
      estimatedCostUsd: 0.4 + i * 0.06, actualCostUsd: i % 3 === 0 ? null : 0.36 + i * 0.05,
    })),
    models: [
      { model: "claude-sonnet-4", tokens: 620_000, estimatedCostUsd: 6.2, actualCostUsd: 5.4 },
      { model: "gpt-5-codex", tokens: 410_000, estimatedCostUsd: 4.1, actualCostUsd: 3.6 },
      { model: "deepseek-v3", tokens: 180_000, estimatedCostUsd: 1.8, actualCostUsd: 1.6 },
    ],
  },
  "/api/budget": { enabled: true, budgetUsd: 50, month: "2026-09", spentUsd: 10.8, ratio: 0.216, threshold: "ok" },
  "/api/health": {
    ok: true,
    services: {
      gateway: { reachable: true, serviceVersion: "0.1.0", latencyMs: 8 },
      watch: { reachable: true, serviceVersion: "0.1.0", latencyMs: 6 },
    },
  },
};

const results = [];
try {
  for (const [route, width, height] of [
    ["/dashboard", 1440, 1000],
    ["/wall", 1920, 1080],
    ["/wall", 1365, 768],
    ["/wall", 390, 844],
    ["/dashboard", 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (request) => {
      const pathname = new URL(request.request().url()).pathname;
      await request.fulfill({ json: payloads[pathname] ?? { ok: true, configured: true, enabled: false, items: [], counts: {} } });
    });
    await page.goto(`http://127.0.0.1:5173${route}`);
    // 两块屏首帧不同：首页等健康结论标题，大屏等画布挂载。
    if (route === "/dashboard") {
      await page.getByRole("heading", { name: "有事项需要你处理", exact: true }).waitFor();
    } else {
      await page.locator(".wall-root").waitFor();
    }
    await page.evaluate(() => document.fonts.ready);
    // ECharts 动画 600ms，稍等后 canvas 位图才有真实墨迹。
    await page.waitForTimeout(1_000);
    const layout = await page.evaluate(() => {
      const wall = document.querySelector(".wall-root");
      const root = wall ?? document.querySelector(".dashboard-simple");
      const stage = document.querySelector(".wall-stage");
      const visible = (element) => element.getBoundingClientRect().height > 0;
      // 图表类名有 wall-chart / wall-gauge-chart / wall-spark 三种，统一按 canvas 收敛。
      const canvasInk = [...document.querySelectorAll(".wall-root canvas")]
        .filter(visible)
        .map((canvas) => {
          const context = canvas.getContext("2d");
          if (context === null) return 0;
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) ink++;
          return ink;
        });
      const kpiValue = document.querySelector(".wall-kpi-value");
      const attentionStrong = document.querySelector(".health-attention strong");
      const taskPreview = document.querySelector(".health-tasks");
      return {
        viewport: innerWidth,
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, root?.scrollWidth ?? 0) > innerWidth,
        kpis: document.querySelectorAll(".wall-kpi").length,
        stageTransform: stage === null ? null : getComputedStyle(stage).transform,
        stageScrollHeight: stage === null ? 0 : stage.scrollHeight,
        stageClientHeight: stage === null ? 0 : stage.clientHeight,
        bodyScrollHeight: document.body.scrollHeight,
        attentionRows: [...document.querySelectorAll(".health-attention li")].filter(visible).length,
        textSize: attentionStrong === null ? null : getComputedStyle(attentionStrong).fontSize,
        tasksTop: taskPreview === null ? null : taskPreview.getBoundingClientRect().top,
        taskStats: document.querySelector(".health-task-stats")?.textContent ?? null,
        wallScroll: wall ? wall.scrollHeight - wall.clientHeight : 0,
        canvasInk,
        chartCount: canvasInk.length,
        inkedCharts: canvasInk.filter((ink) => ink > 100).length,
        kpiFontSize: kpiValue === null ? null : getComputedStyle(kpiValue).fontSize,
        panels: {
          actions: document.querySelector(".wall-actions, .wall-bottom .wall-empty") !== null,
          channels: document.querySelector(".wall-table") !== null,
          tasks: document.querySelector(".wall-tasks, .wall-bottom .wall-empty") !== null,
          gateway: document.querySelector(".wall-link") !== null,
        },
      };
    });
    assert.equal(layout.horizontalOverflow, false, `${route} ${width}: horizontal overflow`);
    assert.ok(layout.attentionRows <= 5);
    if (layout.textSize !== null) assert.ok(Number.parseInt(layout.textSize) >= 14);
    if (route === "/wall") {
      assert.equal(layout.kpis, 7, "wall keeps 7 consolidated KPIs");
      assert.ok(layout.chartCount >= 6, `wall must keep the chart matrix (got ${layout.chartCount})`);
      assert.ok(layout.inkedCharts >= 4, `wall charts must render real pixels (got ${layout.inkedCharts})`);
      assert.deepEqual(layout.panels, { actions: true, channels: true, tasks: true, gateway: true });
    }
    if (route === "/wall" && width >= 1024) {
      // getComputedStyle 返回 matrix(a, b, c, d, e, f)：等比缩放下 a === d 且 0 < a <= 1。
      const matrix = /^matrix\(([-\d.]+),\s*[-\d.]+,\s*[-\d.]+,\s*([-\d.]+),/.exec(layout.stageTransform ?? "");
      assert.ok(matrix !== null, `desktop wall must be scaled (got ${layout.stageTransform})`);
      const scaleX = Number(matrix[1]);
      const scaleY = Number(matrix[2]);
      assert.equal(scaleX, scaleY, "desktop wall scale must be uniform");
      assert.ok(scaleX > 0 && scaleX <= 1, "desktop wall scale must fit the viewport");
      assert.equal(layout.wallScroll, 0, "desktop wall must fit one screen without scrolling");
    }
    if (route === "/wall" && width < 1024) {
      assert.ok(layout.stageTransform === "none" || layout.stageTransform === "", "mobile wall must not be scaled down");
      assert.ok(layout.bodyScrollHeight > height, "mobile wall must scroll vertically");
      assert.ok(Number.parseInt(layout.kpiFontSize) >= 24, "mobile KPI must stay readable");
    }
    if (route === "/dashboard" && width >= 1024) assert.ok(layout.tasksTop < height, "next task must be in first viewport");
    if (route === "/dashboard") assert.equal(layout.taskStats, "今日执行 12 次 · 失败任务 1 个");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `wall-${route.slice(1)}-${width}.png`), fullPage: false });
    results.push({ route, width, height, ...layout });
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
