/* Isolated browser smoke: mock message/settings reads and block all API writes. */
/* global document, window */
import { URL } from "node:url";
export async function checkProductSimplification(page, baseUrl) {
  let instanceCount = 1;
  let writes = 0;
  let blockedTickets = 0;
  const states = [];
  const bridge = {
    connected: true,
    running: true,
    attached: true,
    outboxWritable: true,
    inFlight: false,
    protocolVersion: 1,
    bridgeVersion: "test",
    instanceId: "test",
    policyVersion: "test",
    remotePolicyVersion: "test",
    channels: {},
    coverage: {},
    startedAt: null,
    lastCycleAt: null,
    lastError: null,
  };
  const message = (state) => ({
    messageId: state,
    instanceId: "test",
    adapterId: "hermes",
    channel: "weixin",
    chatId: "test",
    sessionId: "test",
    messageKind: "final",
    transport: "queued-push",
    priority: "normal",
    content: `${state === "delivery_unknown" ? "等待核实的消息" : state === "delivered" ? "已经送达的历史" : "发送失败的消息"} ${"测试正文".repeat(60)} 完整消息尾部`,
    metadata: {},
    capturedAt: "2026-09-15T00:00:00Z",
    sequence: 1,
    state,
    availableAt: null,
    attemptCount: 0,
    providerMessageId: null,
    deliveredAt: null,
    lastError: "RAW_ERROR /private/logs",
    transformTrace: [],
    lastPolicyError: null,
    updatedAt: "2026-09-15T00:00:00Z",
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      if (new URL(request.url()).pathname === "/api/ws-ticket") blockedTickets += 1;
      else writes += 1;
      return route.abort();
    }
    const url = new URL(request.url());
    const send = (body) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/messages/overview") {
      const state = url.searchParams.get("state");
      states.push(state);
      return send({
        reachable: true,
        status: { bridge, counts: {} },
        degraded: [],
        messages: {
          counts: { delivered: 1000, delivery_unknown: 1, dead_letter: 1 },
          items: state === "policy_error" ? [] : [message(state ?? "delivered")],
        },
      });
    }
    if (url.pathname === "/api/gateway")
      return send({
        watchReachable: true,
        patches: [],
        rateLimit: { overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] },
        alerts: { reachable: true, counts: {}, degradedChannels: [], items: [] },
      });
    if (url.pathname === "/api/approvals")
      return send({ items: [], summary: { pending: 0, escalated: 0, expired: 0 } });
    if (url.pathname === "/api/federation")
      return send({
        instances: Array.from({ length: instanceCount }, (_, index) => ({
          instanceId: String(index),
        })),
      });
    if (url.pathname === "/api/scheduled-tasks/status")
      return send({ supported: true, reachable: true, timezone: "Asia/Tokyo" });
    if (url.pathname === "/api/security-baseline") {
      return send({ listenHost: "127.0.0.1", loopback: true, auth: false, warnings: [] });
    }
    // Unrelated services stay explicitly unavailable; never contact the live deployment.
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ reason: "isolated-browser-fixture" }),
    });
  });
  const assert = (condition, text) => {
    if (!condition) throw new Error(text);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/gateway`);
  await page.getByText("等待核实的消息", { exact: false }).waitFor();
  assert(
    ["dead_letter", "policy_error", "delivery_unknown"].every((state) => states.includes(state)),
    "Pending state queries missing",
  );
  assert(
    (await page.getByText("已经送达的历史", { exact: false }).count()) === 0,
    "Delivered history leaked into inbox",
  );
  assert(
    (await page.getByText("完整消息尾部", { exact: false }).count()) === 0,
    "Full message visible before detail",
  );
  await page.getByRole("button", { name: /等待核实的消息/ }).click();
  const drawer = page.getByRole("dialog", { name: "消息详情" });
  await drawer.getByText("完整消息尾部", { exact: false }).waitFor();
  assert(
    (await drawer.getByRole("button", { name: "重新投递", exact: true }).count()) === 0,
    "Unknown message offers unsafe redelivery",
  );
  assert(
    (await drawer.getByText("RAW_ERROR", { exact: false }).count()) === 0,
    "Raw evidence expanded by default",
  );
  await page.screenshot({ path: "output/playwright/simplification-message-detail.png" });
  await drawer
    .getByRole("button", { name: "Close", exact: true })
    .or(drawer.getByRole("button", { name: "关闭", exact: true }))
    .click();
  await page.getByRole("tab", { name: "发送历史", exact: true }).click();
  await page.getByText("已经送达的历史", { exact: false }).waitFor();

  await page.goto(`${baseUrl}/settings?tab=advanced`);
  await page.getByRole("switch", { name: "实验功能", exact: true }).waitFor();
  if (
    (await page
      .getByRole("switch", { name: "实验功能", exact: true })
      .getAttribute("aria-checked")) === "true"
  ) {
    await page.getByRole("switch", { name: "实验功能", exact: true }).click();
  }
  assert(
    (await page.getByRole("link", { name: "自进化", exact: true }).count()) === 0,
    "Experiments visible without opt-in",
  );
  await page.getByText("专家工具 · 诊断与维护", { exact: true }).click();
  await page.getByRole("link", { name: "系统日志", exact: true }).waitFor();
  assert(
    (await page.getByRole("link", { name: "实例联邦", exact: true }).count()) === 0,
    "Single instance exposes federation",
  );
  await page.getByRole("switch", { name: "实验功能", exact: true }).click();
  await page.getByRole("link", { name: "自进化", exact: true }).waitFor();
  instanceCount = 2;
  await page.reload();
  await page.getByText("专家工具 · 诊断与维护", { exact: true }).click();
  await page.getByRole("link", { name: "实例联邦", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    (await page.getByRole("navigation", { name: "移动端主导航" }).getByRole("link").count()) === 4,
    "Mobile navigation is not four entries",
  );
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Settings has page-level horizontal overflow",
  );
  await page.screenshot({ path: "output/playwright/simplification-settings-mobile.png" });
  await page.goto(`${baseUrl}/settings?tab=tasks`);
  await page.getByText("调度时区：Asia/Tokyo", { exact: true }).waitFor();
  assert((await page.getByRole("textbox").count()) === 0, "Timezone unexpectedly editable");
  assert(writes === 0, "Unexpected API write attempted");
  return { pendingStateQueries: states, browserAssertions: 13, writes, blockedTickets };
}
