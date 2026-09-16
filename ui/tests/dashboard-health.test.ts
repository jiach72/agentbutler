import { describe, expect, it } from "vitest";
import { buildUserHealthInput, deriveHealthView, type HealthSources } from "../src/pages/dashboard/userHealth.js";
import { deriveTaskPreview, type PreviewTask, type PreviewTaskList, type PreviewTaskStatus } from "../src/pages/dashboard/taskPreview.js";
import { deriveWallView, type WallData } from "../src/pages/wall/useWallData.js";

const sources: HealthSources = {
  observedAt: "2026-09-15T10:00:00.000Z",
  connections: { reachable: true, connections: [{ instanceId: "hermes-main", state: "Serving", connected: true }] },
  dashboard: {
    instances: [{ instanceId: "hermes-main", state: "Serving", frameworkId: "hermes", runtime: "process", confidence: 1, version: null }],
    latestInspections: [{ instanceId: "hermes-main", ts: "2026-09-15T10:00:00.000Z", overall: "healthy", confidence: 1,
      checks: [{ id: "memory", status: "pass", durationMs: 3, detail: null }, { id: "llm-probe", status: "pass", durationMs: 3, detail: null }] }],
  },
  messageStatus: { reachable: true, status: { bridge: { connected: true, running: true, attached: true, outboxWritable: true }, counts: {} } },
  alerts: { reachable: true, items: [{ status: "delivered", severity: "critical" }, { status: "expired" }] },
  approvals: { summary: { pending: 0 }, items: [{ status: "expired" }] },
};

describe("dashboard and wall share factual health", () => {
  it("Serving and connected is 1/1 online; delivered and expired do not poison health", () => {
    expect(deriveHealthView(sources)).toMatchObject({ onlineInstances: 1, totalInstances: 1, health: { status: "healthy", attention: [] } });
  });
  it("unreadable connections and missing model probes are unknown", () => {
    expect(buildUserHealthInput({ ...sources, connections: null }).instances).toBeNull();
    expect(buildUserHealthInput({ ...sources, dashboard: { instances: sources.dashboard!.instances } }).model).toBe("unknown");
  });
  it("one verified instance cannot certify another instance with no probe", () => {
    const second = { ...sources.dashboard!.instances![0], instanceId: "second" };
    const view = deriveHealthView({ ...sources, dashboard: { ...sources.dashboard, instances: [...sources.dashboard!.instances!, second] },
      connections: { reachable: true, connections: [...sources.connections!.connections!, { instanceId: "second", connected: true, state: "Serving" }] } });
    expect(view.input.model).toBe("unknown");
    expect(view.input.memory).toBe("unknown");
  });
  it("memory failure and unknown message outcomes cannot be hidden by healthy process state", () => {
    const failing = structuredClone(sources);
    failing.dashboard!.latestInspections![0].checks[0].status = "fail";
    failing.messageStatus!.status!.counts = { delivery_unknown: 2 };
    expect(deriveHealthView(failing).health).toMatchObject({ status: "action_required" });
    expect(deriveHealthView(failing).health.attention.map((item) => item.id)).toEqual(["memory", "messages-unknown"]);
  });
  it("dashboard and wall produce exactly the same health, online count and attention", () => {
    const dashboard = deriveHealthView(sources);
    const wall = deriveWallView({
      dashboard: sources.dashboard, connections: sources.connections!.connections,
      alerts: sources.alerts, messageStatus: sources.messageStatus, approvals: sources.approvals,
      lastRefreshAt: new Date(sources.observedAt), metrics: null, hostMetrics: null, health: null,
      skillUsage: null, proposals: null, llmUsage: null, costSummary: null, budget: null, versions: null, backups: null,
    } as WallData);
    expect(wall.healthSummary).toEqual(dashboard.health);
    expect(wall.onlineInstances).toBe(dashboard.onlineInstances);
    expect(wall.openAlerts).toBe(0);
  });
});

describe("Hermes task preview", () => {
  const now = Date.parse(sources.observedAt);
  const status: PreviewTaskStatus = { supported: true, reachable: true, schedulerRunning: true, activeCount: 3,
    todayRunCount: 5, failedTaskCount: 2, nextRunAt: null };
  const task = (id: string, nextRunAt: string | null, enabled = true): PreviewTask => ({ id, name: id, enabled, nextRunAt, lastStatus: "never" });
  const list = (items: PreviewTask[]): PreviewTaskList => ({ supported: true, reachable: true, items });
  it("uses Hermes timestamps and excludes paused, past and >24h tasks from the wall window", () => {
    const preview = deriveTaskPreview(status, list([
      task("tomorrow", "2026-09-17T00:00:00Z"), task("soon", "2026-09-15T11:00:00Z"),
      task("past", "2026-09-15T01:00:00Z"), task("paused", "2026-09-15T10:30:00Z", false),
    ]), now);
    expect(preview.next?.id).toBe("soon");
    expect(preview.upcoming.map((item) => item.id)).toEqual(["soon"]);
    expect(preview.label).toBe("有任务时间待更新");
  });
  it("does not turn unavailable or unsupported data into an empty successful schedule", () => {
    expect(deriveTaskPreview(null, null, now)).toMatchObject({ known: false, label: "任务状态暂不可用" });
    expect(deriveTaskPreview({ ...status, supported: false, reason: "unsupported_framework" }, list([]), now).label).toBe("当前仅 Hermes 支持");
    expect(deriveTaskPreview({ ...status, schedulerRunning: null }, list([]), now).label).toBe("任务调度状态待确认");
    expect(deriveTaskPreview(status, { ...list([]), reachable: false }, now).known).toBe(false);
  });
  it("passes Hermes execution counts through and never invents them for unknown data", () => {
    expect(deriveTaskPreview(status, list([]), now)).toMatchObject({ todayRunCount: 5, failedTaskCount: 2 });
    expect(deriveTaskPreview(null, list([]), now)).toMatchObject({ todayRunCount: 0, failedTaskCount: 0 });
    // Counts come from Hermes status alone; the renderer only shows them once the list is known.
    expect(deriveTaskPreview(status, null, now)).toMatchObject({ known: false, todayRunCount: 5, failedTaskCount: 2 });
  });
});
