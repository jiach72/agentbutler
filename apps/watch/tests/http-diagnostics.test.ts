import { afterEach, describe, expect, it, vi } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { BackupService } from "../src/backup.js";

function makeDeps(renderDiagnostics?: () => Promise<string>): WatchHttpDeps {
  return {
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
    renderDiagnostics,
  };
}

describe("startWatchHttp 诊断报告端点", () => {
  let http: WatchHttp;
  let base: string;

  afterEach(() => http.close());

  it("未接线时返回 503", async () => {
    http = startWatchHttp(makeDeps(), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/diagnostics/report`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostics-unavailable" });
  });

  it("GET 返回 markdown 附件，POST 返回 405", async () => {
    http = startWatchHttp(
      makeDeps(async () => "# Agent Butler 诊断报告\n\n- 脱敏示例\n"),
      { port: 0 },
    );
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/diagnostics/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toContain("attachment; filename=\"agent-butler-diagnostic-");
    await expect(response.text()).resolves.toContain("# Agent Butler 诊断报告");

    const post = await fetch(`${base}/api/diagnostics/report`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});

describe("startWatchHttp 备份验证端点", () => {
  let http: WatchHttp;
  let base: string;

  afterEach(() => http.close());

  it("未接线时返回 503", async () => {
    http = startWatchHttp(makeDeps(), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/backups/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "backup-unavailable" });
  });

  it("拒绝非法 ID，且不会调用验证服务", async () => {
    const verify = vi.fn<BackupService["verify"]>();
    const backup = {
      list: () => [],
      run: vi.fn(),
      restore: vi.fn(),
      verify,
      status: () => ({
        enabled: true,
        lastFullAt: null,
        lastMemoryAt: null,
        lastFullVerification: null,
        hourlyTickMs: 3_600_000,
        retention: { full: 14, memory: 24, event: 10 },
      }),
      start: vi.fn(),
      stop: vi.fn(),
    } satisfies BackupService;
    http = startWatchHttp({ ...makeDeps().deps, backup }, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/backups/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "7" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid-backup-id" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("透传无备份与验证失败状态，并对成功验证返回 200", async () => {
    const verify = vi.fn<BackupService["verify"]>(async (id) => {
      if (id === 404) return { ok: false, backupId: null, error: "backup-not-found", checkedFiles: 0, checkedDatabases: 0 };
      if (id === 2) return { ok: false, backupId: 2, error: "backup-file-invalid", checkedFiles: 1, checkedDatabases: 0 };
      return { ok: true, backupId: id ?? 1, checkedFiles: 2, checkedDatabases: 1, checkedAt: "2026-08-23T04:00:00.000Z" };
    });
    const backup = {
      list: () => [],
      run: vi.fn(),
      restore: vi.fn(),
      verify,
      status: () => ({
        enabled: true,
        lastFullAt: null,
        lastMemoryAt: null,
        lastFullVerification: null,
        hourlyTickMs: 3_600_000,
        retention: { full: 14, memory: 24, event: 10 },
      }),
      start: vi.fn(),
      stop: vi.fn(),
    } satisfies BackupService;
    http = startWatchHttp({ ...makeDeps().deps, backup }, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    const missing = await fetch(`${base}/api/backups/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 404 }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "backup-not-found" });

    const failed = await fetch(`${base}/api/backups/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 2 }),
    });
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toMatchObject({ error: "backup-file-invalid", backupId: 2 });

    const success = await fetch(`${base}/api/backups/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toMatchObject({ ok: true, backupId: 1, checkedFiles: 2, checkedDatabases: 1 });
  });
});
