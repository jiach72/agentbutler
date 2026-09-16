/* Run with playwright-cli run-code --filename. All cron requests are intercepted. */
/* global document, window */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const base = { schemaVersion: 1, supported: true, reachable: true };
  const task = {
    id: "qa-task", name: "每日摘要", enabled: true, scheduleLabel: "每天 09:00",
    nextRunAt: "2026-09-17T09:00:00+08:00", lastRunAt: null, lastStatus: "never",
    failureStreak: 0, deliveryEnabled: false, editable: true,
  };
  let items = [task];
  const creates = [];
  const actions = [];
  let saveAttempts = 0;
  await page.unroute("**/api/**");
  await page.route("**/api/**", async (route) => {
    const path = route.request().url().split("/api/")[1]?.split("?")[0] ?? "";
    if (route.request().method() !== "GET") return route.abort();
    const defaults = {
      "setup/status": { configured: true },
      killswitch: { available: false },
      alerts: { reachable: true, counts: {}, items: [] },
      approvals: { items: [], summary: { pending: 0, escalated: 0, expired: 0 } },
      "security-baseline": { listenHost: "127.0.0.1", loopback: true, auth: false, warnings: [] },
      "ws-ticket": { ticket: "fixture" },
    };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(defaults[path] ?? {}) });
  });
  await page.unroute("**/api/scheduled-tasks**");
  await page.route("**/api/scheduled-tasks**", async (route) => {
    const request = route.request();
    const path = request.url().split("/api/scheduled-tasks")[1].split("?")[0];
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const send = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/status") return send({ ...base, schedulerRunning: true, activeCount: items.filter((item) => item.enabled).length,
      nextRunAt: task.nextRunAt, heartbeatAgeSeconds: 4, timezone: "Asia/Shanghai", writesSupported: true, runSupported: false });
    if (path === "/incidents") return send({ ...base, items: [] });
    if (path === "/preview") return send({ ...base, scheduleLabel: "每天 09:00", nextRunAt: task.nextRunAt, timezone: "Asia/Shanghai" });
    if (!path && request.method() === "GET") return send({ ...base, items });
    if (!path && request.method() === "POST") {
      creates.push(body);
      saveAttempts += 1;
      if (saveAttempts === 1) return send({ ...base, reason: "outcome_unknown", outcome: "unknown", requestId: body.requestId, taskId: null }, 503);
      items = [...items, { ...task, id: "qa-created", name: body.draft.name }];
      return send({ ...base, requestId: body.requestId, taskId: "qa-created", outcome: "succeeded" });
    }
    if (path.endsWith("/runs")) return send({ ...base, items: [
      { id: "qa-run", taskId: task.id, status: "completed", claimedAt: task.nextRunAt,
        startedAt: task.nextRunAt, finishedAt: task.nextRunAt },
    ] });
    if (request.method() === "GET") return send({ ...base, editable: true, draft: {
      name: task.name, prompt: "生成摘要", schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
      delivery: { enabled: false },
    } });
    actions.push({ path, method: request.method(), body });
    if (path.endsWith("/pause")) items = items.map((item) => item.id === task.id ? { ...item, enabled: false } : item);
    if (request.method() === "DELETE") items = items.filter((item) => path !== `/${item.id}`);
    return send({ ...base, outcome: "succeeded", requestId: body.requestId, taskId: path.split("/")[1] });
  });
  await page.goto("http://127.0.0.1:5181/tasks");
  await page.getByRole("heading", { name: task.name, exact: true }).waitFor();
  if (await page.getByRole("button", { name: `立即运行${task.name}`, exact: true }).isEnabled()) throw new Error("Unsafe run action exposed");
  await page.getByRole("button", { name: "新建任务", exact: false }).click();
  await page.getByLabel("任务名称", { exact: true }).fill("验收草稿");
  await page.getByLabel("任务内容", { exact: true }).fill("仅用于隔离的浏览器测试");
  await page.getByRole("button", { name: "保存任务", exact: false }).click();
  await page.getByText("上一次操作结果尚未确认", { exact: false }).waitFor();
  if (await page.getByLabel("任务内容", { exact: true }).inputValue() !== "仅用于隔离的浏览器测试") throw new Error("Failed save discarded draft");
  await page.getByRole("button", { name: "核对并重试保存", exact: false }).click();
  await page.getByRole("heading", { name: "验收草稿", exact: true }).waitFor();
  if (creates.length !== 2 || creates[0].requestId !== creates[1].requestId) throw new Error("Retry changed idempotency key");
  await page.getByRole("switch", { name: `${task.name}启用`, exact: true }).click();
  await page.getByRole("button", { name: "暂停任务", exact: false }).click();
  await page.getByText("任务已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: `查看${task.name}执行历史`, exact: true }).click();
  await page.getByText("执行成功", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "删除验收草稿", exact: true }).click();
  const confirmDelete = page.getByRole("button", { name: "删除任务", exact: true });
  if (await confirmDelete.isEnabled()) throw new Error("Delete lacks name confirmation");
  await page.getByRole("textbox", { name: "确认删除任务名称", exact: true }).fill("验收草稿");
  await confirmDelete.click();
  await page.getByText("任务已删除", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error("Task page has horizontal overflow");
  await page.screenshot({ path: "output/playwright/tasks-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "output/playwright/tasks-desktop.png", fullPage: true });
  return { assertions: 7, createAttempts: creates.length, uniqueCreateRequests: new Set(creates.map((item) => item.requestId)).size,
    actions: actions.map((item) => ({ method: item.method, path: item.path })), horizontalOverflow: overflow, liveCronWrites: 0 };
}
