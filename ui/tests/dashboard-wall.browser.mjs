/* global document, innerWidth, getComputedStyle */
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
const payloads = {
  "/api/setup/status": { configured: true },
  "/api/alerts": { reachable: true, counts: {}, items: [{ id: 1, status: "active", severity: "warning", title: "待核对提醒" }], unreadCount: 0, degradedChannels: [] },
  "/api/approvals": { summary: { pending: 2, escalated: 0, expired: 15, total: 17 }, items: [] },
  "/api/dashboard": {
    instances: [{ instanceId: "hermes-main", frameworkId: "hermes", state: "Serving", runtime: "process", version: "1.0", confidence: 1 }],
    latestInspections: [{ instanceId: "hermes-main", ts: now, overall: "degraded", confidence: 1, checks: [
      { id: "memory", status: "fail", detail: "fixture", durationMs: 4 },
      { id: "llm-probe", status: "pass", detail: "fixture", durationMs: 4 },
    ] }],
  },
  "/api/connections": { reachable: true, connections: [{ instanceId: "hermes-main", frameworkId: "hermes", displayName: "Hermes 主实例", state: "Serving", connected: true }] },
  "/api/messages/status": { reachable: true, status: { bridge: { connected: true, running: true, attached: true, outboxWritable: true }, counts: { delivery_unknown: 3, failed: 1 }, relay: { enabled: true, pending: false } } },
  "/api/scheduled-tasks/status": { schemaVersion: 1, supported: true, reachable: true, schedulerRunning: true, activeCount: 2, todayRunCount: 12, failedTaskCount: 1, nextRunAt: future, heartbeatAgeSeconds: 3, timezone: "Asia/Shanghai", writesSupported: false, runSupported: false },
  "/api/scheduled-tasks": { schemaVersion: 1, supported: true, reachable: true, items: [
    { id: "daily", name: "每日项目进展与待处理事项汇总", enabled: true, scheduleLabel: "每日", nextRunAt: future, lastRunAt: null, lastStatus: "success", failureStreak: 0, deliveryEnabled: true, editable: false },
  ] },
  "/api/messages/metrics": { days: 7, channels: [], retries: 0, latency: { p95Ms: 1250, samples: 10, unknown: 0, p50Ms: 500 }, daily: [
    { date: "2026-09-13", channel: "test", delivered: 10, failed: 1, uncertain: 0 },
    { date: "2026-09-14", channel: "test", delivered: 12, failed: 0, uncertain: 0 },
    { date: "2026-09-15", channel: "test", delivered: 8, failed: 2, uncertain: 0 },
  ] },
  "/api/host/metrics": { machine: { capturedAt: now, cpuPercent: 18, memTotalBytes: 1000, memFreeBytes: 550, diskTotalBytes: 1000, diskUsedBytes: 380 }, agents: [], samples: [] },
};
const results = [];
try {
  for (const [route, width, height] of [
    ["/dashboard", 1440, 1000], ["/wall", 1920, 1080], ["/wall", 1365, 768],
    ["/wall", 390, 844], ["/dashboard", 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (request) => {
      const pathname = new URL(request.request().url()).pathname;
      await request.fulfill({ json: payloads[pathname] ?? { ok: true, configured: true, enabled: false, items: [], counts: {} } });
    });
    await page.goto(`http://127.0.0.1:5173${route}`);
    await page.getByRole("heading", { name: "有事项需要你处理", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const wall = document.querySelector(".wall-root");
      const page = document.querySelector(".dashboard-simple");
      const root = wall ?? page;
      const visible = (element) => element.getBoundingClientRect().height > 0;
      return {
        viewport: innerWidth,
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, root.scrollWidth) > innerWidth,
        kpis: document.querySelectorAll(".wall-kpi").length,
        attentionRows: [...document.querySelectorAll(".health-attention li")].filter(visible).length,
        textSize: getComputedStyle(document.querySelector(".health-attention strong")).fontSize,
        tasksTop: document.querySelector(".health-tasks").getBoundingClientRect().top,
        taskStats: document.querySelector(".health-task-stats")?.textContent ?? null,
        wallScroll: wall ? wall.scrollHeight - wall.clientHeight : 0,
        canvasInk: [...document.querySelectorAll(".wall-chart canvas")].filter(visible).map((canvas) => {
          const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) ink++;
          return ink;
        }),
      };
    });
    assert.equal(layout.horizontalOverflow, false, `${route} ${width}: horizontal overflow`);
    assert.ok(layout.attentionRows <= 5);
    assert.ok(Number.parseInt(layout.textSize) >= 14);
    if (route === "/wall") assert.equal(layout.kpis, 6);
    if (route === "/wall" && width >= 1024) assert.equal(layout.wallScroll, 0, "desktop wall must fit");
    if (route === "/wall" && width >= 1024) assert.ok(layout.canvasInk.some((ink) => ink > 100), "chart must render real pixels");
    if (route === "/dashboard" && width >= 1024) assert.ok(layout.tasksTop < height, "next task must be in first viewport");
    if (route === "/dashboard") assert.equal(layout.taskStats, "今日执行 12 次 · 失败任务 1 个");
    if (route === "/wall") assert.equal(layout.taskStats, null);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `phase-a-${route.slice(1)}-${width}.png`), fullPage: false });
    results.push({ route, width, height, ...layout });
    if (route === "/wall" && width === 390) {
      assert.equal(await page.getByRole("link", { name: "打开首页" }).getAttribute("href"), "/dashboard");
      await page.getByRole("button", { name: "切换浅色" }).click();
      assert.equal(await page.locator(".wall-root").getAttribute("data-wall-theme"), "light");
    }
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
