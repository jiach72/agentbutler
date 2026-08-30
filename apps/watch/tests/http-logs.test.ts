import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

function makeDeps(): WatchHttpDeps {
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
      stats: async () => ({
        overall: "ok",
        totalEvents: 0,
        last24h: 0,
        matched: [],
        suggestions: [],
      }),
      patches: async () => [],
      applyPatch: async () => ({ status: "unknown-patch" }),
      reapplyPatch: async () => ({ status: "unknown-patch" }),
      detectPatch: async () => ({ status: "unknown-patch" }),
    },
    logs: {
      listSources: () => [
        {
          id: "hermes:logs:hermes.log",
          path: "/tmp/hermes/logs/hermes.log",
          format: "text",
          modifiedAt: "2026-08-23T00:00:00.000Z",
          sizeBytes: 128,
        },
      ],
      readTail: (sourceId, _instanceId, limit, before) =>
        sourceId === "hermes:logs:hermes.log"
          ? {
              sourceId,
              path: "/tmp/hermes/logs/hermes.log",
              format: "text",
              lines: ["line-1", "line-2"],
              truncated: false,
              limit: limit ?? 200,
              totalLines: 2,
              pageStart: 64,
              hasOlder: true,
              hasNewer: before !== null,
            }
          : null,
    },
    analyzeLogs: () => ({
      issues: [
        {
          id: "fp-1",
          kind: "rate-limit",
          severity: "warn",
          title: "消息限流",
          detail: "通道被限流",
          count: 3,
          sources: ["hermes:logs:hermes.log"],
          examples: ["ERROR rate limit exceeded"],
          suggestedAction: "rb-reconnect",
          actionLabel: "重连消息通道",
        },
      ],
      scannedSources: 1,
      scannedLines: 3,
      analyzedAt: "2026-08-23T00:00:00.000Z",
    }),
    butler: {
      version: () => ({
        version: "0.1.0",
        source: "/tmp/butler",
        branch: "main",
        commit: "abc1234",
        tag: "v0.1.0",
        repository: "https://example.com/agent-butler.git",
        changelog: [
          { hash: "abc1234", subject: "Add log analyzer", at: "2026-08-22" },
          { hash: "def5678", subject: "Memory health", at: "2026-08-21" },
        ],
        checkedAt: "2026-08-23T00:00:00.000Z",
      }),
    },
  };
}

describe("startWatchHttp 系统日志与管家版本端点", () => {
  let http: WatchHttp;
  let base: string;
  let deps: WatchHttpDeps;

  beforeEach(async () => {
    deps = makeDeps();
    http = startWatchHttp(deps, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => http.close());

  it("GET /api/logs 返回日志源清单", async () => {
    const response = await fetch(`${base}/api/logs`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sources: [
        {
          id: "hermes:logs:hermes.log",
          path: "/tmp/hermes/logs/hermes.log",
          format: "text",
          modifiedAt: "2026-08-23T00:00:00.000Z",
          sizeBytes: 128,
        },
      ],
      instanceId: null,
    });
  });

  it("GET /api/logs/:id 返回尾部行并校验 limit", async () => {
    const response = await fetch(
      `${base}/api/logs/${encodeURIComponent("hermes:logs:hermes.log")}?limit=2`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sourceId: "hermes:logs:hermes.log",
      lines: ["line-1", "line-2"],
      truncated: false,
      limit: 2,
      totalLines: 2,
    });
    expect((await fetch(`${base}/api/logs/${encodeURIComponent("missing")}`)).status).toBe(404);
    expect((await fetch(`${base}/api/logs/${encodeURIComponent("x")}?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/logs/${encodeURIComponent("x")}?limit=9999`)).status).toBe(400);
  });

  it("GET /api/logs/:id 支持 before 游标分页，非法游标返回 400", async () => {
    const paged = await fetch(
      `${base}/api/logs/${encodeURIComponent("hermes:logs:hermes.log")}?limit=2&before=64`,
    );
    expect(paged.status).toBe(200);
    await expect(paged.json()).resolves.toMatchObject({
      sourceId: "hermes:logs:hermes.log",
      pageStart: 64,
      hasOlder: true,
      hasNewer: true,
    });
    expect(
      (await fetch(`${base}/api/logs/${encodeURIComponent("hermes:logs:hermes.log")}?before=abc`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/api/logs/${encodeURIComponent("hermes:logs:hermes.log")}?before=-1`))
        .status,
    ).toBe(400);
  });

  it("GET /api/butler/version 返回管家自身版本与仓库信息", async () => {
    const response = await fetch(`${base}/api/butler/version`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "0.1.0",
      source: "/tmp/butler",
      branch: "main",
      commit: "abc1234",
      tag: "v0.1.0",
      repository: "https://example.com/agent-butler.git",
      changelog: [
        { hash: "abc1234", subject: "Add log analyzer", at: "2026-08-22" },
        { hash: "def5678", subject: "Memory health", at: "2026-08-21" },
      ],
      checkedAt: "2026-08-23T00:00:00.000Z",
    });
  });

  it("GET /api/logs/analyze 返回日志体检结果", async () => {
    const response = await fetch(`${base}/api/logs/analyze`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issues: Array<{ kind: string; suggestedAction: string | null }>;
    };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      kind: "rate-limit",
      suggestedAction: "rb-reconnect",
    });
  });

  it("POST /api/logs/fix 强制二次确认并校验动作", async () => {
    const missingConfirm = await fetch(`${base}/api/logs/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rb-restart" }),
    });
    expect(missingConfirm.status).toBe(400);
    await expect(missingConfirm.json()).resolves.toMatchObject({
      error: "confirmation-required",
    });

    const unknownAction = await fetch(`${base}/api/logs/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rm -rf", confirmed: true }),
    });
    expect(unknownAction.status).toBe(400);
    await expect(unknownAction.json()).resolves.toMatchObject({ error: "unknown-action" });

    const noInstance = await fetch(`${base}/api/logs/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rb-restart", confirmed: true }),
    });
    expect(noInstance.status).toBe(503);
  });

  it("POST /api/logs/fix 确认后启动 runbook", async () => {
    http.close();
    deps = { ...makeDeps(), executeRunbook: async () => ({ status: "started", instanceId: "hermes-main" }) };
    http = startWatchHttp(deps, { port: 0 });
    const address = await http.start();
    const localBase = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${localBase}/api/logs/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rb-reconnect", confirmed: true }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      started: true,
      status: "running",
      jobId: expect.any(String),
    });
  });

  it("未接线日志/管家服务时返回 503", async () => {
    http.close();
    const without: WatchHttpDeps = { ...deps, logs: undefined, butler: undefined };
    http = startWatchHttp(without, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/logs`)).status).toBe(503);
    expect((await fetch(`${base}/api/butler/version`)).status).toBe(503);
  });
});
