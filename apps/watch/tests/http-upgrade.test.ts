/**
 * HTTP 控制通道升级端点测试（Task 13.1/13.2）：
 * - POST /api/upgrade/run（202/400/409/503 + instanceId/channel 透传）；
 * - GET  /api/upgrade/status（job: null | UpgradeJobView）；
 * - GET  /api/upgrade/versions（reachable 携带 source / 全败空列表不 5xx）；
 * - POST /api/snapshots/:id/rollback（200/400/404/503 + instanceId 透传）；
 * - 方法不符 405；尾斜杠归一。
 *
 * 升级服务全 fake 注入（HTTP 层只做状态码映射），回环真实端口验证。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpgradeJobView, VersionListEntry } from "@butler/adapter-hermes";
import type { JobStep } from "@butler/contract";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { RollbackSnapshotOutcome, UpgradeService, UpgradeStartOutcome } from "../src/upgrade.js";

const STEPS: JobStep[] = [{ id: "precheck", label: "环境预检", status: "passed" }];

const VIEW: UpgradeJobView = {
  jobId: "job-1",
  instanceId: "hermes-main",
  targetVersion: "0.21.0",
  channel: "stable",
  trigger: "manual",
  status: "running",
  steps: STEPS,
  snapshotId: "snap-1",
  startedAt: "2026-08-20T12:00:00.000Z",
};

interface UpgradeState {
  startOutcome: UpgradeStartOutcome;
  startCalls: Array<{ instanceId?: string; targetVersion: string; channel?: "stable" | "beta" }>;
  statusView: UpgradeJobView | null;
  versionsResult: { reachable: boolean; source?: string; versions: VersionListEntry[] };
  rollbackOutcome: RollbackSnapshotOutcome;
  rollbackCalls: Array<{ snapshotRowId: number; instanceId?: string }>;
}

function makeDeps(): { deps: WatchHttpDeps; state: UpgradeState } {
  const state: UpgradeState = {
    startOutcome: { status: "started", jobId: "job-1", instanceId: "hermes-main" },
    startCalls: [],
    statusView: null,
    versionsResult: { reachable: false, versions: [] },
    rollbackOutcome: { status: "snapshot-not-found" },
    rollbackCalls: [],
  };
  const upgrade: UpgradeService = {
    startUpgrade: (input) => {
      state.startCalls.push(input);
      return state.startOutcome;
    },
    status: () => state.statusView,
    listVersions: async () => state.versionsResult,
    rollbackSnapshot: async (snapshotRowId, instanceId) => {
      state.rollbackCalls.push({ snapshotRowId, instanceId });
      return state.rollbackOutcome;
    },
  };
  // 网关面板服务 stub（本文件不覆盖网关端点，仅满足 WatchHttpDeps.gateway；网关端点见 http-gateway.test.ts）。
  const gateway: GatewayPanelService = {
    stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
    patches: async () => [],
    applyPatch: async () => ({ status: "no-instance" }),
    reapplyPatch: async () => ({ status: "no-instance" }),
    detectPatch: async () => ({ status: "no-instance" }),
  };
  const deps: WatchHttpDeps = {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "no-servicing-instance" }),
    upgrade,
    gateway,
  };
  return { deps, state };
}

describe("startWatchHttp 升级端点（fake 升级服务，回环真实端口）", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    http.close();
  });

  it("POST /api/upgrade/run → 202 { started, jobId, instanceId }（instanceId/channel 透传）", async () => {
    const res = await fetch(`${base}/api/upgrade/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main", targetVersion: "0.21.0", channel: "beta" }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ started: true, jobId: "job-1", instanceId: "hermes-main" });
    expect(fake.state.startCalls).toEqual([
      { instanceId: "hermes-main", targetVersion: "0.21.0", channel: "beta" },
    ]);

    // 空 body → instanceId/channel 缺省（undefined 透传）
    const res2 = await fetch(`${base}/api/upgrade/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "0.22.0" }),
    });
    expect(res2.status).toBe(202);
    expect(fake.state.startCalls[1]).toEqual({ instanceId: undefined, targetVersion: "0.22.0", channel: undefined });
  });

  it("POST /api/upgrade/run 入参分支：缺/空/非字符串 targetVersion → 400 missing-target-version", async () => {
    for (const body of ["{}", '{"targetVersion":""}', '{"targetVersion":"   "}', '{"targetVersion":123}']) {
      const res = await fetch(`${base}/api/upgrade/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "missing-target-version" });
    }
    expect(fake.state.startCalls).toHaveLength(0);
  });

  it("POST /api/upgrade/run 服务分支：在飞 → 409；无 Serving 实例 → 503", async () => {
    fake.state.startOutcome = { status: "upgrade-in-flight" };
    const conflict = await fetch(`${base}/api/upgrade/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "0.21.0" }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "upgrade-in-flight" });

    fake.state.startOutcome = { status: "no-servicing-instance" };
    const unavailable = await fetch(`${base}/api/upgrade/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "0.21.0" }),
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "no-servicing-instance" });
  });

  it("GET /api/upgrade/status → { job: null } / { job: UpgradeJobView }（含尾斜杠归一）", async () => {
    const empty = await fetch(`${base}/api/upgrade/status`);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ job: null });

    fake.state.statusView = VIEW;
    const res = await fetch(`${base}/api/upgrade/status/`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ job: VIEW });
  });

  it("GET /api/upgrade/versions → reachable 携带 source 与版本列表；全败 → 空列表不 5xx", async () => {
    fake.state.versionsResult = {
      reachable: true,
      source: "github-releases",
      versions: [
        { version: "0.22.0-beta.1", channel: "beta" },
        { version: "0.21.0", channel: "stable" },
      ],
    };
    const ok = await fetch(`${base}/api/upgrade/versions`);
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      reachable: true,
      source: "github-releases",
      versions: [
        { version: "0.22.0-beta.1", channel: "beta" },
        { version: "0.21.0", channel: "stable" },
      ],
    });

    fake.state.versionsResult = { reachable: false, versions: [] };
    const down = await fetch(`${base}/api/upgrade/versions`);
    expect(down.status).toBe(200);
    await expect(down.json()).resolves.toEqual({ reachable: false, versions: [] });
  });

  it("POST /api/snapshots/:id/rollback → 200 { job }（:id 数值行 id + instanceId 透传）", async () => {
    fake.state.rollbackOutcome = { status: "ok", job: { jobId: "job-rb-1", kind: "rollback", steps: STEPS } };
    const res = await fetch(`${base}/api/snapshots/42/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      job: { jobId: "job-rb-1", kind: "rollback", steps: STEPS },
    });
    expect(fake.state.rollbackCalls).toEqual([{ snapshotRowId: 42, instanceId: "hermes-main" }]);

    // 空 body → instanceId 缺省
    const res2 = await fetch(`${base}/api/snapshots/43/rollback`, { method: "POST" });
    expect(res2.status).toBe(200);
    expect(fake.state.rollbackCalls[1]).toEqual({ snapshotRowId: 43, instanceId: undefined });
  });

  it("POST /api/snapshots/:id/rollback 分支：非数值 id → 400；不存在 → 404；无实例 → 503", async () => {
    for (const bad of ["abc", "12x", "-1"]) {
      const res = await fetch(`${base}/api/snapshots/${bad}/rollback`, { method: "POST" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid-snapshot-id" });
    }

    fake.state.rollbackOutcome = { status: "snapshot-not-found" };
    const notFound = await fetch(`${base}/api/snapshots/999/rollback`, { method: "POST" });
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toEqual({ error: "snapshot-not-found" });

    fake.state.rollbackOutcome = { status: "no-servicing-instance" };
    const unavailable = await fetch(`${base}/api/snapshots/999/rollback`, { method: "POST" });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "no-servicing-instance" });
  });

  it("方法不符 → 405（run/status/versions/rollback 四端点）", async () => {
    expect((await fetch(`${base}/api/upgrade/run`)).status).toBe(405);
    expect((await fetch(`${base}/api/upgrade/status`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/upgrade/versions`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/snapshots/1/rollback`)).status).toBe(405);
  });
});
