import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer, type WebServerOptions } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

/** 网关探测一律指向必然连接拒绝的端口，保证测试确定性且快速。 */
const DEAD_GATEWAY = "http://127.0.0.1:1";

/** 模拟 watch 控制通道不可达的 fetch（注入后绝不触网）。 */
const unreachableFetch: typeof fetch = async () => {
  throw new Error("watch unreachable");
};

describe("butler-web 大盘聚合与 watch 代理（Task 10，fastify inject）", () => {
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
      watchUrl: "http://127.0.0.1:7533",
      ...extra,
    });
    apps.push(app);
    return app;
  }

  /** 预置两实例（各 2 条 inspection-completed，run=2 为最新）+ 两条指纹。 */
  function seedDashboardStore(): void {
    const store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    const now = new Date().toISOString();
    const mkInstance = (instanceId: string, frameworkId: string) =>
      store.saveInstance({
        instanceId,
        frameworkId,
        state: "Serving",
        runtime: "docker",
        rootPath: `/srv/${instanceId}`,
        version: "1.0.0",
        confidence: 0.5,
        capabilityJson: null,
        detailJson: null,
        createdAt: now,
        updatedAt: now,
      });
    mkInstance("hermes-main", "hermes");
    mkInstance("gemini-alt", "gemini-cli");

    const mkInspection = (instanceId: string, run: number, overall: string) =>
      store.insertEvent({
        type: "inspection-completed",
        source: "watch",
        payload: {
          instanceId,
          run,
          overall,
          confidence: overall === "healthy" ? 0.95 : 0.6,
          checks: [
            {
              id: "memory-probe",
              status: overall === "healthy" ? "pass" : "warn",
              detail: `run-${run}`,
              durationMs: 10 + run,
            },
            { id: "llm-probe", status: "pass", detail: "ok", durationMs: 200 },
          ],
        },
      });
    // 先插入 run=1 再插入 run=2（id 递增），聚合应取每实例的 run=2
    mkInspection("hermes-main", 1, "degraded");
    mkInspection("gemini-alt", 1, "down");
    mkInspection("hermes-main", 2, "healthy");
    mkInspection("gemini-alt", 2, "degraded");

    store.upsertFingerprint("sig-a", "sample-a");
    store.upsertFingerprint("sig-a", "sample-a2");
    store.upsertFingerprint("sig-b", "sample-b");
    store.close();
  }

  it("/api/dashboard：两实例各取最新一条巡检、指纹返回、watch 不可达时 inspectStatus 降级", async () => {
    seedDashboardStore();
    const app = build(tmp, { fetchImpl: unreachableFetch });
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      instances: Array<{ instanceId: string }>;
      latestInspections: Array<{
        instanceId: string;
        overall: string | null;
        confidence: number | null;
        checks: Array<{ id: string; status: string; detail: unknown; durationMs: number | null }>;
      }>;
      fingerprints: Array<{ signature: string; count: number }>;
      inspectStatus: { reachable: boolean };
    };

    expect(body.instances.map((i) => i.instanceId).sort()).toEqual(["gemini-alt", "hermes-main"]);

    // 每实例取最新一条（run=2）：hermes → healthy、gemini → degraded
    expect(body.latestInspections).toHaveLength(2);
    const hermes = body.latestInspections.find((i) => i.instanceId === "hermes-main")!;
    expect(hermes.overall).toBe("healthy");
    expect(hermes.confidence).toBe(0.95);
    expect(hermes.checks).toHaveLength(2);
    expect(hermes.checks[0]).toMatchObject({
      id: "memory-probe",
      status: "pass",
      detail: "run-2",
      durationMs: 12,
    });
    const gemini = body.latestInspections.find((i) => i.instanceId === "gemini-alt")!;
    expect(gemini.overall).toBe("degraded");
    expect(gemini.checks[0]).toMatchObject({ status: "warn" });

    expect(body.fingerprints).toHaveLength(2);
    expect(body.fingerprints.find((f) => f.signature === "sig-a")!.count).toBe(2);

    expect(body.inspectStatus).toEqual({ reachable: false });
  });

  it("/api/runbooks：watch 不可达 → 200 降级载荷 reachable=false；execute 不可达 → 502", async () => {
    const app = build(tmp, { fetchImpl: unreachableFetch });

    const list = await app.inject({ method: "GET", url: "/api/runbooks" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ reachable: false, runbooks: [] });

    const exec = await app.inject({
      method: "POST",
      url: "/api/runbooks/restart-main/execute",
      payload: { instanceId: "hermes-main" },
    });
    expect(exec.statusCode).toBe(502);
    expect(exec.json()).toEqual({ error: "watch-unreachable" });
  });

  it("POST /api/runbooks/:id/execute：透传 body 到 watch，watch 的 409 原样透传（状态码+body）", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fetch409: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ error: "already-running" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    };
    const app = build(tmp, { fetchImpl: fetch409 });

    const res = await app.inject({
      method: "POST",
      url: "/api/runbooks/restart-main/execute",
      payload: { instanceId: "hermes-main" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "already-running" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:7533/api/runbooks/restart-main/execute");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({ instanceId: "hermes-main" });
  });

  it("POST /api/runbooks/:id/reset：透传人工解除请求与 watch 响应", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchReset: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ status: "reset", keys: ["rb-restart:hermes-main"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const app = build(tmp, { fetchImpl: fetchReset });

    const res = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-restart/reset",
      payload: { instanceId: "hermes-main" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "reset", keys: ["rb-restart:hermes-main"] });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7533/api/runbooks/rb-restart/reset",
        body: JSON.stringify({ instanceId: "hermes-main" }),
      },
    ]);
  });

  it("/api/inspect/status 不可达 → 200 reachable:false；/api/inspect/run 不可达 → 502", async () => {
    const app = build(tmp, { fetchImpl: unreachableFetch });

    const status = await app.inject({ method: "GET", url: "/api/inspect/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ reachable: false });

    const run = await app.inject({ method: "POST", url: "/api/inspect/run" });
    expect(run.statusCode).toBe(502);
    expect(run.json()).toEqual({ error: "watch-unreachable" });
  });
});
