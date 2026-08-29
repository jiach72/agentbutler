import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillsMemoryQuery, SkillsMemoryService, SkillsMemoryView } from "../src/skills.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

const VIEW: SkillsMemoryView = {
  instance: {
    instanceId: "hermes-main",
    frameworkId: "hermes",
    state: "Serving",
    version: "0.20.4",
  },
  skills: {
    mode: "driver",
    driverId: "hermes-skill",
    total: 1,
    items: [
      {
        ref: { name: "arxiv", version: "1.0.0", source: "builtin" },
        name: "arxiv",
        version: "1.0.0",
        source: "builtin",
        enabled: true,
      },
    ],
    directory: {
      roots: ["skills"],
      fileCount: 1,
      directoryCount: 1,
      sizeBytes: 100,
      truncated: false,
    },
    notice: "只读解析",
  },
  plugins: {
    mode: "driver",
    driverId: "hermes-plugin",
    total: 1,
    items: [
      {
        ref: { name: "a2a", version: "1.0.0", source: "builtin" },
        name: "a2a",
        version: "1.0.0",
        source: "builtin",
        enabled: true,
        category: "A2A 协议",
      },
    ],
    directory: {
      roots: ["plugins"],
      fileCount: 1,
      directoryCount: 1,
      sizeBytes: 200,
      truncated: false,
    },
    notice: "只读解析",
  },
  memory: {
    mode: "driver",
    driverId: "sqlite-fts5",
    stats: {
      totalEntries: 1,
      byMonth: [{ month: "2026-08", count: 1 }],
      coldCandidates: 0,
      lastWriteAt: "2026-08-21T06:00:00.000Z",
      archivedEntries: 0,
      probeEntries: 0,
    },
    health: null,
    preview: [{ entryId: "1", writtenAt: "2026-08-21T06:00:00.000Z", content: "agent memory" }],
    previewLimit: 50,
    writeActivity: { status: "active", detail: "最近有写入" },
    directory: {
      roots: ["memory_store.db"],
      fileCount: 1,
      directoryCount: 0,
      sizeBytes: 4096,
      truncated: false,
    },
    notice: "只读检索",
  },
};

function makeDeps(): { deps: WatchHttpDeps; calls: SkillsMemoryQuery[] } {
  const calls: SkillsMemoryQuery[] = [];
  const skills: SkillsMemoryService = {
    status: async (query) => {
      calls.push(query);
      return VIEW;
    },
    analyze: async () => ({ ok: true, instanceId: "hermes-main" }),
    archiveCold: async () => ({
      ok: true,
      instanceId: "hermes-main",
      report: { archived: 1, freedBytes: 10, dryRun: false, errors: [] },
    }),
    restoreCold: async () => ({
      ok: true,
      instanceId: "hermes-main",
      report: { restored: 1, errors: [] },
    }),
    purge: async () => ({
      ok: true,
      instanceId: "hermes-main",
      report: { purged: 1, freedBytes: 10, errors: [] },
    }),
    rebuildIndex: async () => ({
      ok: true,
      instanceId: "hermes-main",
      report: { rebuilt: true, rowsBefore: 1, rowsAfter: 1, errors: [] },
    }),
    exportEncrypted: async () => ({
      ok: true,
      instanceId: "hermes-main",
      filename: "butler-memory-export-test.abmem",
      data: new Uint8Array([1, 2, 3]),
      sizeBytes: 3,
    }),
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
      skills,
    },
  };
}

describe("startWatchHttp 技能与记忆端点", () => {
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

  it("GET /api/skills 透传实例、关键词与上限参数", async () => {
    const response = await fetch(
      `${base}/api/skills?instanceId=hermes-main&keyword=agent&limit=50`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(VIEW);
    expect(fake.calls).toEqual([{ instanceId: "hermes-main", keyword: "agent", limit: 50 }]);
  });

  it("拒绝非正整数 limit，未接线服务时返回 503", async () => {
    expect((await fetch(`${base}/api/skills?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/skills?limit=abc`)).status).toBe(400);

    http.close();
    const withoutSkills: WatchHttpDeps = { ...fake.deps, skills: undefined };
    http = startWatchHttp(withoutSkills, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/skills`)).status).toBe(503);
  });

  it("透传技能资产统计，并保留未知字段语义", async () => {
    http.close();
    const assets = {
      usage: async (_range?: number, granularity = "day") => ({
        rangeDays: 180,
        granularity: granularity as "day" | "week" | "month",
        coverage: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", days: 1, source: "Hermes 日志", complete: true },
        series: [{ date: "2026-08-01", calls: 2 }],
        skills: [{ name: "arxiv", calls: 2, lastUsedAt: "2026-08-02T00:00:00.000Z", successRate: null, avgDurationMs: null, status: "known" as const }],
        notice: "成功率和耗时只有在日志明确记录时展示，否则为未知。",
      }),
      archive: async () => ({ ok: true }),
      restore: async () => ({ ok: true }),
      purge: async () => ({ ok: true }),
      githubTrends: async () => ({ items: [] }),
      refreshGithubTrends: async () => ({ items: [] }),
      recommendations: async () => ({ items: [] }),
      stageRecommendation: async () => ({ ok: true }),
      installStaged: async () => ({ ok: true }),
    };
    http = startWatchHttp({ ...fake.deps, skillAssets: assets }, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const status = await fetch(`${base}/api/skills`);
    expect(status.status).toBe(200);
    expect((await status.json()).skills.items[0]).toMatchObject({ usage: 2, successRate: null, avgDurationMs: null });
    expect((await fetch(`${base}/api/skills/usage?range=30d&granularity=week`)).status).toBe(200);
  });
});
