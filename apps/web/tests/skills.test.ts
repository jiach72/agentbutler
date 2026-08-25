import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

function makeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake, calls };
}

const WATCH_VIEW = {
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
        category: "research",
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
        ref: { name: "hermes-lcm", version: "0.14.0", source: "user" },
        name: "hermes-lcm",
        version: "0.14.0",
        source: "user",
        enabled: true,
        description: "Lossless Context Management plugin",
      },
    ],
    directory: {
      roots: ["plugins"],
      fileCount: 120,
      directoryCount: 29,
      sizeBytes: 8881250,
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
      archivedEntries: 0,
      probeEntries: 1,
      lastWriteAt: "2026-08-21T06:00:00.000Z",
    },
    preview: [
      { entryId: "1", writtenAt: "2026-08-21T06:00:00.000Z", content: "agent memory", cold: false },
    ],
    previewLimit: 50,
    health: {
      score: 85,
      checkedAt: "2026-08-23T08:25:47.626Z",
      signals: [
        {
          id: "integrity",
          label: "数据库完整性",
          status: "ok",
          detail: "SQLite quick_check 通过",
        },
      ],
      suggestions: [],
    },
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

describe("butler-web 技能与记忆代理", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30_000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(fetchImpl: typeof fetch): FastifyInstance {
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("GET /api/skills 转发只读检索参数并返回结构校验后的视图", async () => {
    const transport = makeFetch(WATCH_VIEW);
    const app = build(transport.fetch);

    const response = await app.inject({
      method: "GET",
      url: "/api/skills?instanceId=hermes-main&keyword=agent&limit=50",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ watchReachable: true, ...WATCH_VIEW });
    expect(transport.calls).toEqual([
      `${WATCH_URL}/api/skills?instanceId=hermes-main&keyword=agent&limit=50`,
    ]);
  });

  it("POST /api/memory/self-check 透传 watch 探针结果", async () => {
    const transport = makeFetch({
      ok: true,
      instanceId: "hermes-main",
      result: { id: "memory-probe", status: "pass", detail: "写入并召回一条测试记忆，随后已清理" },
    });
    const app = build(transport.fetch);
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/self-check",
      payload: { instanceId: "hermes-main" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      instanceId: "hermes-main",
      result: { id: "memory-probe", status: "pass", detail: "写入并召回一条测试记忆，随后已清理" },
    });
    expect(transport.calls).toEqual(["http://127.0.0.1:7533/api/memory/self-check"]);
  });

  it("watch 不可达或载荷畸形时返回稳定的降级结构", async () => {
    const malformed = makeFetch({ ...WATCH_VIEW, skills: { items: "bad" } });
    const malformedApp = build(malformed.fetch);
    const malformedResponse = await malformedApp.inject({ method: "GET", url: "/api/skills" });
    expect(malformedResponse.json()).toMatchObject({
      watchReachable: false,
      instance: null,
      skills: { mode: "unavailable", items: [] },
      memory: { mode: "unavailable", stats: null, preview: [] },
    });

    const offlineFetch: typeof fetch = async () => {
      throw new Error("watch offline");
    };
    const offlineApp = build(offlineFetch);
    const offlineResponse = await offlineApp.inject({ method: "GET", url: "/api/skills" });
    expect(offlineResponse.json()).toMatchObject({ watchReachable: false, instance: null });
  });

  it("风险字段只接受受控枚举并透传合法状态", async () => {
    const transport = makeFetch({
      ...WATCH_VIEW,
      skills: {
        ...WATCH_VIEW.skills,
        items: [
          {
            ...WATCH_VIEW.skills.items[0],
            riskStatus: "unscanned",
            riskDetail: "尚未执行风险扫描",
          },
        ],
      },
      plugins: {
        ...WATCH_VIEW.plugins,
        items: [
          {
            ...WATCH_VIEW.plugins.items[0],
            riskStatus: "blocked",
            riskDetail: "清单解析失败，暂不把它当作可信资产",
          },
        ],
      },
    });
    const app = build(transport.fetch);
    const response = await app.inject({ method: "GET", url: "/api/skills" });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills.items[0]).toMatchObject({
      riskStatus: "unscanned",
      riskDetail: "尚未执行风险扫描",
    });
    expect(response.json().plugins.items[0]).toMatchObject({
      riskStatus: "blocked",
      riskDetail: "清单解析失败，暂不把它当作可信资产",
    });

    const malformed = makeFetch({
      ...WATCH_VIEW,
      skills: {
        ...WATCH_VIEW.skills,
        items: [{ ...WATCH_VIEW.skills.items[0], riskStatus: "unsafe" }],
      },
    });
    const malformedApp = build(malformed.fetch);
    const malformedResponse = await malformedApp.inject({ method: "GET", url: "/api/skills" });
    expect(malformedResponse.json()).toMatchObject({
      watchReachable: false,
      skills: { mode: "unavailable", items: [] },
    });
  });
});
