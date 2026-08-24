import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ButlerSelfService } from "../src/self-upgrade.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

function makeDeps(): { deps: WatchHttpDeps; calls: Array<{ kind: string; input: unknown }> } {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const butlerSelf: ButlerSelfService = {
    status: () => ({
      reachable: true,
      source: "/srv/agent-butler",
      version: "0.1.0",
      branch: "main",
      commit: "fc0e992",
      tag: "v0.1.0",
      repository: "https://example.com/agent-butler.git",
      repoClean: true,
      remoteConfigured: true,
      prefs: { channel: "stable", locked: false },
      snapshots: [
        {
          id: "snap-1",
          at: "2026-08-22T08:00:00.000Z",
          version: "0.1.0",
          commit: "fc0e992",
          tag: "v0.1.0",
          channel: "stable",
          reason: "升级到 0.2.0",
          backupId: 7,
        },
      ],
      availableUpdates: [{ version: "0.2.0", channel: "stable", commit: "abc1234", tag: "v0.2.0" }],
      lastJob: null,
      checkedAt: "2026-08-23T00:00:00.000Z",
    }),
    startUpgrade: async (input) => {
      calls.push({ kind: "startUpgrade", input });
      if (input.confirmed !== true) return { status: "confirmation-required" };
      return { status: "started", jobId: "job-1", snapshotId: "snap-1" };
    },
    rollback: (input) => {
      calls.push({ kind: "rollback", input });
      if (input.confirmed !== true) return { status: "confirmation-required" };
      return input.snapshotId === "snap-1"
        ? { status: "started", jobId: "job-2" }
        : { status: "snapshot-not-found" };
    },
    updatePrefs: (input) => {
      calls.push({ kind: "updatePrefs", input });
      return { channel: input.channel ?? "stable", locked: input.locked ?? false };
    },
  };
  return {
    calls,
    deps: {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "no-servicing-instance" }),
      upgrade: {
        startUpgrade: () => ({ status: "missing-target-version" }),
        status: () => null,
        listVersions: async () => ({ reachable: false, versions: [] }),
        rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
      },
      gateway: {
        stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
        patches: async () => [],
        applyPatch: async () => ({ status: "unknown-patch" }),
        reapplyPatch: async () => ({ status: "unknown-patch" }),
        detectPatch: async () => ({ status: "unknown-patch" }),
      },
      butler: {
        version: () => ({
          version: "0.1.0",
          source: "/srv/agent-butler",
          branch: "main",
          commit: "fc0e992",
          tag: "v0.1.0",
          repository: "https://example.com/agent-butler.git",
          checkedAt: "2026-08-23T00:00:00.000Z",
        }),
      },
      butlerSelf,
    },
  };
}

describe("startWatchHttp 管家自身版本管理端点", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => http.close());

  it("GET /api/butler/self 返回状态", async () => {
    const response = await fetch(`${base}/api/butler/self`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string; availableUpdates: unknown[] };
    expect(body.version).toBe("0.1.0");
    expect(body.availableUpdates.length).toBe(1);
  });

  it("POST /api/butler/self/upgrade 未确认 400，确认后 202", async () => {
    const rejected = await fetch(`${base}/api/butler/self/upgrade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "v0.2.0", confirmed: false }),
    });
    expect(rejected.status).toBe(400);

    const accepted = await fetch(`${base}/api/butler/self/upgrade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as { started: boolean; jobId: string };
    expect(body.started).toBe(true);
    expect(body.jobId).toBe("job-1");
  });

  it("POST /api/butler/self/upgrade 备份失败返回 500 且不宣称已启动", async () => {
    fake.deps.butlerSelf = {
      ...fake.deps.butlerSelf!,
      startUpgrade: async () => ({ status: "backup-failed", error: "disk full" }),
    };
    const response = await fetch(`${base}/api/butler/self/upgrade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "v0.2.0", confirmed: true }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "backup-failed" });
  });

  it("POST /api/butler/self/rollback 确认后 202，未知快照 404", async () => {
    const ok = await fetch(`${base}/api/butler/self/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: "snap-1", confirmed: true }),
    });
    expect(ok.status).toBe(202);

    const missing = await fetch(`${base}/api/butler/self/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: "nope", confirmed: true }),
    });
    expect(missing.status).toBe(404);
  });

  it("POST /api/butler/self/prefs 保存偏好", async () => {
    const response = await fetch(`${base}/api/butler/self/prefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "beta", locked: true }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { channel: string; locked: boolean };
    expect(body.channel).toBe("beta");
    expect(body.locked).toBe(true);
  });

  it("未接线管家自身服务时返回 503", async () => {
    const without: WatchHttpDeps = { ...fake.deps, butlerSelf: undefined };
    const http2 = startWatchHttp(without, { port: 0 });
    const addr2 = await http2.start();
    try {
      const base2 = `http://127.0.0.1:${addr2.port}`;
      expect((await fetch(`${base2}/api/butler/self`)).status).toBe(503);
      expect((await fetch(`${base2}/api/butler/self/prefs`, { method: "POST" })).status).toBe(503);
    } finally {
      http2.close();
    }
  });
});
