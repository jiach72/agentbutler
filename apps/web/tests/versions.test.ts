import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer, type WebServerOptions } from "../src/server";
import { makeBlockedHome, makeTempDir, makeUiDist, rmTempDir } from "./helpers";

/** 网关探测一律指向必然连接拒绝的端口，保证测试确定性且快速。 */
const DEAD_GATEWAY = "http://127.0.0.1:1";

/** watch 控制通道基址（与 build() 注入一致）。 */
const WATCH_URL = "http://127.0.0.1:7533";

/** 模拟 watch 控制通道不可达的 fetch（注入后绝不触网）。 */
const unreachableFetch: typeof fetch = async () => {
  throw new Error("watch unreachable");
};

/** 模拟 watch 返回的五步升级 Job 视图。 */
const FAKE_JOB = {
  jobId: "job-up-1",
  instanceId: "hermes-main",
  targetVersion: "0.6.0",
  channel: "stable",
  trigger: "manual",
  status: "running",
  rolledBack: false,
  snapshotId: "7",
  steps: [
    { id: "precheck", label: "环境预检", status: "passed", detail: "ok" },
    { id: "snapshot", label: "快照", status: "running" },
    { id: "fetch", label: "拉取", status: "pending" },
    { id: "repatch", label: "补丁重打与冲突检测", status: "pending" },
    { id: "verify", label: "健康验收", status: "pending" },
  ],
  startedAt: "2026-08-20T00:00:00.000Z",
};

/** 模拟 watch /api/upgrade/versions 的可用版本载荷。 */
const FAKE_VERSIONS = {
  reachable: true,
  source: "official",
  versions: [
    { version: "0.6.0", channel: "stable" },
    { version: "0.7.0-beta", channel: "beta" },
  ],
};

/** 构造模拟 watch 的 fetch：按 "METHOD url" 精确路由，未命中一律 404；记录全部调用。 */
function makeWatchFetch(
  routes: Record<string, { status: number; body: unknown }>,
): { fetch: typeof fetch; calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = String(init?.body ?? "");
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: `no-route: ${method} ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake, calls };
}

describe("butler-web 版本页聚合与升级/回滚代理（Task 13.3，fastify inject）", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  // 与 server.test.ts 同因：/mnt/c 上首次 Fastify() 构造有秒级惰性开销，先预热。
  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(home: string, extra: Partial<WebServerOptions> = {}): FastifyInstance {
    const app = createWebServer({
      home,
      gatewayUrl: DEAD_GATEWAY,
      uiDist,
      watchUrl: WATCH_URL,
      ...extra,
    });
    apps.push(app);
    return app;
  }

  /** 预置两实例（其一 version 为 null）+ 两快照（ok 与 expired）。 */
  function seedVersionsStore(): void {
    const store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    const now = new Date().toISOString();
    const mkInstance = (instanceId: string, frameworkId: string, version: string | null) =>
      store.saveInstance({
        instanceId,
        frameworkId,
        state: instanceId === "hermes-main" ? "Serving" : "Stopped",
        runtime: instanceId === "hermes-main" ? "docker" : "host",
        rootPath: `/srv/${instanceId}`,
        version,
        confidence: 0.5,
        capabilityJson: null,
        detailJson: null,
        createdAt: now,
        updatedAt: now,
      });
    mkInstance("hermes-main", "hermes", "0.5.0");
    mkInstance("gemini-alt", "gemini-cli", null);

    store.insertSnapshot({
      instance: "hermes-main",
      scope: { include: ["code", "venv"] },
      label: "pre-upgrade",
      status: "ok",
    });
    store.insertSnapshot({ instance: "hermes-main", scope: {}, label: null, status: "expired" });
    store.close();
  }

  it("/api/versions：instances/snapshots 直读 db，upgradeJob/availableVersions 代理 watch", async () => {
    seedVersionsStore();
    const watch = makeWatchFetch({
      [`GET ${WATCH_URL}/api/upgrade/status`]: { status: 200, body: { job: FAKE_JOB } },
      [`GET ${WATCH_URL}/api/upgrade/versions`]: { status: 200, body: FAKE_VERSIONS },
    });
    const app = build(tmp, { fetchImpl: watch.fetch });
    const res = await app.inject({ method: "GET", url: "/api/versions" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instances: Array<{ instanceId: string; state: string; runtime: string; version: string | null }>;
      upgradeJob: unknown;
      availableVersions: unknown;
      snapshots: Array<{ id: number; instance: string; label: string | null; createdAt: string; status: string }>;
      watchReachable: boolean;
      degraded?: string[];
    };

    // 实例视图：仅 4 个摘要字段（无 rootPath/capability 等大盘字段）
    expect(body.instances).toHaveLength(2);
    expect(body.instances.find((i) => i.instanceId === "hermes-main")).toEqual({
      instanceId: "hermes-main",
      state: "Serving",
      runtime: "docker",
      version: "0.5.0",
    });
    expect(body.instances.find((i) => i.instanceId === "gemini-alt")).toEqual({
      instanceId: "gemini-alt",
      state: "Stopped",
      runtime: "host",
      version: null,
    });

    // 升级 Job 与可用版本来自 watch，原样透传
    expect(body.upgradeJob).toEqual(FAKE_JOB);
    expect(body.availableVersions).toEqual(FAKE_VERSIONS);
    expect(body.watchReachable).toBe(true);
    expect(body.degraded).toBeUndefined();

    // 快照来自 db（id 倒序，含 ok 与 expired）
    expect(body.snapshots).toHaveLength(2);
    const okSnap = body.snapshots.find((s) => s.status === "ok")!;
    expect(okSnap).toMatchObject({ instance: "hermes-main", label: "pre-upgrade" });
    expect(typeof okSnap.id).toBe("number");
    expect(typeof okSnap.createdAt).toBe("string");
    expect(body.snapshots.find((s) => s.status === "expired")!.label).toBeNull();

    // watch 侧恰好两路 GET（并发聚合）
    expect(watch.calls.map((c) => c.url).sort()).toEqual([
      `${WATCH_URL}/api/upgrade/status`,
      `${WATCH_URL}/api/upgrade/versions`,
    ]);
  });

  it("/api/versions：watch 不可达 → upgradeJob null、reachable false、watchReachable false，db 数据仍返回", async () => {
    seedVersionsStore();
    const app = build(tmp, { fetchImpl: unreachableFetch });
    const res = await app.inject({ method: "GET", url: "/api/versions" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instances: unknown[];
      upgradeJob: unknown;
      availableVersions: { reachable: boolean; versions: unknown[] };
      snapshots: unknown[];
      watchReachable: boolean;
      degraded?: string[];
    };
    expect(body.upgradeJob).toBeNull();
    expect(body.availableVersions).toEqual({ reachable: false, versions: [] });
    expect(body.watchReachable).toBe(false);
    expect(body.instances).toHaveLength(2);
    expect(body.snapshots).toHaveLength(2);
    expect(body.degraded).toBeUndefined();
  });

  it("/api/versions：db 不可达 → instances/snapshots 空数组并附 degraded，watch 部分仍正常", async () => {
    const watch = makeWatchFetch({
      [`GET ${WATCH_URL}/api/upgrade/status`]: { status: 200, body: { job: null } },
      [`GET ${WATCH_URL}/api/upgrade/versions`]: { status: 200, body: FAKE_VERSIONS },
    });
    const app = build(makeBlockedHome(tmp), { fetchImpl: watch.fetch });
    const res = await app.inject({ method: "GET", url: "/api/versions" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instances: unknown[];
      upgradeJob: unknown;
      availableVersions: { reachable: boolean };
      snapshots: unknown[];
      watchReachable: boolean;
      degraded?: string[];
    };
    expect(body.instances).toEqual([]);
    expect(body.snapshots).toEqual([]);
    expect(body.degraded).toEqual(["db:unreachable"]);
    expect(body.upgradeJob).toBeNull();
    expect(body.availableVersions.reachable).toBe(true);
    expect(body.watchReachable).toBe(true);
  });

  it("POST /api/upgrade/run：body 透传到 watch，202 原样透传（状态码+body）", async () => {
    const watch = makeWatchFetch({
      [`POST ${WATCH_URL}/api/upgrade/run`]: {
        status: 202,
        body: { started: true, jobId: "job-up-2" },
      },
    });
    const app = build(tmp, { fetchImpl: watch.fetch });

    const res = await app.inject({
      method: "POST",
      url: "/api/upgrade/run",
      payload: { instanceId: "hermes-main", targetVersion: "0.6.0", channel: "stable" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, jobId: "job-up-2" });
    expect(watch.calls).toHaveLength(1);
    expect(watch.calls[0]!.url).toBe(`${WATCH_URL}/api/upgrade/run`);
    expect(watch.calls[0]!.method).toBe("POST");
    expect(JSON.parse(watch.calls[0]!.body)).toEqual({
      instanceId: "hermes-main",
      targetVersion: "0.6.0",
      channel: "stable",
    });
  });

  it("POST /api/upgrade/run：409 原样透传；watch 不可达 → 502", async () => {
    const watch = makeWatchFetch({
      [`POST ${WATCH_URL}/api/upgrade/run`]: {
        status: 409,
        body: { error: "upgrade-in-flight" },
      },
    });
    const app = build(tmp, { fetchImpl: watch.fetch });

    const conflict = await app.inject({
      method: "POST",
      url: "/api/upgrade/run",
      payload: { targetVersion: "0.6.0" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "upgrade-in-flight" });

    const offline = build(tmp, { fetchImpl: unreachableFetch });
    const res = await offline.inject({
      method: "POST",
      url: "/api/upgrade/run",
      payload: { targetVersion: "0.6.0" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "watch-unreachable" });
  });

  it("POST /api/snapshots/:id/rollback：body 透传到 watch，200 原样透传（状态码+body）", async () => {
    const watch = makeWatchFetch({
      [`POST ${WATCH_URL}/api/snapshots/7/rollback`]: {
        status: 200,
        body: { job: { jobId: "rb-1", kind: "rollback", steps: [] } },
      },
    });
    const app = build(tmp, { fetchImpl: watch.fetch });

    const res = await app.inject({
      method: "POST",
      url: "/api/snapshots/7/rollback",
      payload: { instanceId: "hermes-main" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ job: { jobId: "rb-1", kind: "rollback", steps: [] } });
    expect(watch.calls).toHaveLength(1);
    expect(watch.calls[0]!.url).toBe(`${WATCH_URL}/api/snapshots/7/rollback`);
    expect(watch.calls[0]!.method).toBe("POST");
    expect(JSON.parse(watch.calls[0]!.body)).toEqual({ instanceId: "hermes-main" });
  });

  it("POST /api/snapshots/:id/rollback：404 原样透传；watch 不可达 → 502", async () => {
    const watch = makeWatchFetch({
      [`POST ${WATCH_URL}/api/snapshots/99/rollback`]: {
        status: 404,
        body: { error: "snapshot-not-found" },
      },
    });
    const app = build(tmp, { fetchImpl: watch.fetch });

    const missing = await app.inject({
      method: "POST",
      url: "/api/snapshots/99/rollback",
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "snapshot-not-found" });

    const offline = build(tmp, { fetchImpl: unreachableFetch });
    const res = await offline.inject({
      method: "POST",
      url: "/api/snapshots/99/rollback",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "watch-unreachable" });
  });
});
