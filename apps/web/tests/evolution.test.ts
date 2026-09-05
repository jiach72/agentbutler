import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

interface FakeRoute {
  status: number;
  body: unknown;
  contentType?: string;
  disposition?: string;
}

function makeFetch(routes: Record<string, FakeRoute | "throw">): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string; body: string }>;
} {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = String(init?.body ?? "");
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (route === "throw") throw new Error(`unreachable: ${url}`);
    if (route === undefined)
      return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
    const headers = new Headers({ "content-type": route.contentType ?? "application/json" });
    if (route.disposition !== undefined) headers.set("content-disposition", route.disposition);
    return new Response(
      route.contentType?.startsWith("text/") ? String(route.body) : JSON.stringify(route.body),
      { status: route.status, headers },
    );
  };
  return { fetch: fake, calls };
}

describe("butler-web 进化守门代理", () => {
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

  it("GET /api/evolution 返回已校验的守门状态，watch 失败时固定降级", async () => {
    const status = {
      schemaVersion: "evolution-v2-charts-v1",
      minHoldoutCount: 10,
      defaultDependencies: ["dspy", "gepa", "optuna"],
      defaultEndpoint: "https://llm.example/v1",
      ledger: [
        {
          runId: "run-16",
          updatedAt: "2026-08-21T08:00:00.000Z",
          instanceId: "hermes-main",
          status: "accepted",
          holdoutCount: 10,
          baselineMetric: 0.5,
          candidateMetric: 0.58,
          delta: 0.08,
          conclusion: "显著提升",
          disposition: "允许引擎替换 baseline",
        },
      ],
      hermes: {
        status: "ready",
        root: "/home/jiach/.hermes",
        detail: "WSL Hermes 已就绪",
      },
      endpointHealth: {
        status: "pass",
        category: "ok",
        detail: "带鉴权探针通过",
        checkedAt: "2026-08-27T08:00:00.000Z",
      },
      blocked: [],
      tasks: [],
      history: [
        {
          baselineQuality: 0.5,
          candidateQuality: 0.58,
          successRate: 1,
          failureRate: 0,
          elapsedSeconds: 12.3,
        },
      ],
    };
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/status`]: { status: 200, body: status },
    });
    const app = build(transport.fetch);

    const result = await app.inject({ method: "GET", url: "/api/evolution" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      watchReachable: true,
      connectionStatus: "ready",
      detail: null,
      ...status,
    });

    const statusAlias = await app.inject({ method: "GET", url: "/api/evolution/status" });
    expect(statusAlias.statusCode).toBe(200);
    expect(statusAlias.json()).toEqual(result.json());

    const offline = makeFetch({ [`GET ${WATCH_URL}/api/evolution/status`]: "throw" });
    const offlineApp = build(offline.fetch);
    const degraded = await offlineApp.inject({ method: "GET", url: "/api/evolution" });
    expect(degraded.json()).toEqual({
      watchReachable: false,
      connectionStatus: "watch-unreachable",
      detail: "管家控制通道不可达",
      schemaVersion: null,
      minHoldoutCount: 10,
      defaultDependencies: [],
      defaultEndpoint: "",
      ledger: [],
      hermes: { status: "unknown", root: null, detail: "尚未读取管家服务状态" },
      endpointHealth: {
        status: "unknown",
        category: "unknown",
        detail: "尚未执行带鉴权的 LLM 探针",
        checkedAt: null,
      },
      blocked: [],
      tasks: [],
      history: [],
    });
  });

  it("预检、扩集、结果与 Markdown 导出均透传 watch", async () => {
    const transport = makeFetch({
      [`POST ${WATCH_URL}/api/evolution/preflight`]: {
        status: 200,
        body: { runId: "run-16", status: "rejected-preflight", allowRun: false },
      },
      [`POST ${WATCH_URL}/api/evolution/runs/run-16/expand`]: {
        status: 200,
        body: { status: "ready", afterCount: 10 },
      },
      [`POST ${WATCH_URL}/api/evolution/runs/run-16/result`]: {
        status: 409,
        body: { status: "error", error: "run-not-ready" },
      },
      [`GET ${WATCH_URL}/api/evolution/ledger/run-16/export`]: {
        status: 200,
        body: "# 进化实验台账\n",
        contentType: "text/markdown; charset=utf-8",
        disposition: 'attachment; filename="evolution-run-16.md"',
      },
    });
    const app = build(transport.fetch);

    const preflight = await app.inject({
      method: "POST",
      url: "/api/evolution/preflight",
      payload: { holdoutCount: 2 },
    });
    expect(preflight.statusCode).toBe(200);

    const expand = await app.inject({
      method: "POST",
      url: "/api/evolution/runs/run-16/expand",
      payload: { holdoutCount: 2, seedExamples: [{}] },
    });
    expect(expand.json()).toMatchObject({ status: "ready", afterCount: 10 });

    const result = await app.inject({
      method: "POST",
      url: "/api/evolution/runs/run-16/result",
      payload: { baselineMetric: 0.5, candidateMetric: 0.5, significant: false },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toEqual({ status: "error", error: "run-not-ready" });

    const exported = await app.inject({
      method: "GET",
      url: "/api/evolution/ledger/run-16/export",
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/markdown");
    expect(exported.headers["content-disposition"]).toContain("evolution-run-16.md");
    expect(exported.body).toContain("进化实验台账");

    expect(JSON.parse(transport.calls[0]!.body)).toEqual({ holdoutCount: 2 });
    expect(transport.calls[1]!.url).toBe(`${WATCH_URL}/api/evolution/runs/run-16/expand`);
  });

  it("watch 不可达时动作与导出返回 502", async () => {
    const transport = makeFetch({
      [`POST ${WATCH_URL}/api/evolution/preflight`]: "throw",
      [`GET ${WATCH_URL}/api/evolution/ledger/run-16/export`]: "throw",
    });
    const app = build(transport.fetch);

    const action = await app.inject({
      method: "POST",
      url: "/api/evolution/preflight",
      payload: { holdoutCount: 10 },
    });
    expect(action.statusCode).toBe(502);
    expect(action.json()).toEqual({ error: "watch-unreachable" });

    const exported = await app.inject({
      method: "GET",
      url: "/api/evolution/ledger/run-16/export",
    });
    expect(exported.statusCode).toBe(502);
    expect(exported.json()).toEqual({ error: "watch-unreachable" });
  });

  it("旧 Watch 没有新接口或返回旧 schema 时，页面能明确显示同步状态", async () => {
    const missing = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/status`]: { status: 404, body: { error: "not-found" } },
    });
    const missingApp = build(missing.fetch);
    expect((await missingApp.inject({ method: "GET", url: "/api/evolution" })).json()).toMatchObject({
      watchReachable: false,
      connectionStatus: "watch-route-missing",
    });

    const mismatched = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/status`]: {
        status: 200,
        body: {
          schemaVersion: "evolution-v1",
          minHoldoutCount: 10,
          defaultDependencies: [],
          defaultEndpoint: "",
          ledger: [],
          hermes: { status: "unknown", root: null, detail: "旧 Watch" },
          endpointHealth: { status: "unknown", category: "unknown", detail: "", checkedAt: null },
          blocked: [],
          tasks: [],
          history: [],
        },
      },
    });
    const mismatchApp = build(mismatched.fetch);
    expect((await mismatchApp.inject({ method: "GET", url: "/api/evolution" })).json()).toMatchObject({
      watchReachable: true,
      connectionStatus: "watch-version-mismatch",
      schemaVersion: "evolution-v1",
    });

    const malformed = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/status`]: { status: 200, body: { schemaVersion: "evolution-v2-charts-v1" } },
    });
    const malformedApp = build(malformed.fetch);
    expect((await malformedApp.inject({ method: "GET", url: "/api/evolution" })).json()).toMatchObject({
      watchReachable: true,
      connectionStatus: "watch-schema-mismatch",
    });
  });

  it("透传新进化诊断、任务详情、启动、评估、采用和取消接口", async () => {
    const routes: Record<string, FakeRoute> = {
      [`POST ${WATCH_URL}/api/evolution/diagnose`]: { status: 200, body: { recommendations: [] } },
      [`POST ${WATCH_URL}/api/evolution/runs`]: { status: 201, body: { runId: "run/16", status: "ready" } },
      [`GET ${WATCH_URL}/api/evolution/runs/run%2F16`]: { status: 200, body: { runId: "run/16", status: "ready" } },
      [`POST ${WATCH_URL}/api/evolution/runs/run%2F16/start`]: { status: 202, body: { runId: "run/16", status: "running" } },
      [`POST ${WATCH_URL}/api/evolution/runs/run%2F16/evaluate`]: { status: 200, body: { status: "accepted" } },
      [`POST ${WATCH_URL}/api/evolution/runs/run%2F16/promote`]: { status: 200, body: { status: "promoted" } },
      [`POST ${WATCH_URL}/api/evolution/runs/run%2F16/cancel`]: { status: 200, body: { runId: "run/16", status: "cancelled" } },
    };
    const transport = makeFetch(routes);
    const app = build(transport.fetch);
    expect((await app.inject({ method: "POST", url: "/api/evolution/diagnose", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/runs", payload: { targetType: "skill", targetRef: "demo" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/evolution/runs/run%2F16" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/runs/run%2F16/start", payload: {} })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/evolution/runs/run%2F16/evaluate", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/runs/run%2F16/promote", payload: { token: "redacted" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/runs/run%2F16/cancel", payload: {} })).statusCode).toBe(200);
    expect(transport.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /api/evolution/diagnose",
      "POST /api/evolution/runs",
      "GET /api/evolution/runs/run%2F16",
      "POST /api/evolution/runs/run%2F16/start",
      "POST /api/evolution/runs/run%2F16/evaluate",
      "POST /api/evolution/runs/run%2F16/promote",
      "POST /api/evolution/runs/run%2F16/cancel",
    ]);
  });

  it("代理结构化自进化总览、分析和行动复核接口", async () => {
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/overview`]: { status: 200, body: { schemaVersion: "evolution-analytics.v1", status: "insufficient" } },
      [`GET ${WATCH_URL}/api/evolution/metrics`]: { status: 200, body: { totals: { toolCalls: 4 } } },
      [`GET ${WATCH_URL}/api/evolution/failures`]: { status: 200, body: { items: [] } },
      [`GET ${WATCH_URL}/api/evolution/datasets`]: { status: 200, body: { items: [] } },
      [`GET ${WATCH_URL}/api/evolution/action-items`]: { status: 200, body: { items: [] } },
      [`POST ${WATCH_URL}/api/evolution/analyze`]: { status: 200, body: { analyzedAt: "2026-08-30T00:00:00.000Z" } },
      [`POST ${WATCH_URL}/api/evolution/action-items/action-1/recheck`]: { status: 200, body: { actionId: "action-1", status: "resolved" } },
    });
    const app = build(transport.fetch);
    expect((await app.inject({ method: "GET", url: "/api/evolution/overview" })).json()).toMatchObject({ schemaVersion: "evolution-analytics.v1" });
    expect((await app.inject({ method: "GET", url: "/api/evolution/metrics" })).json()).toMatchObject({ totals: { toolCalls: 4 } });
    expect((await app.inject({ method: "GET", url: "/api/evolution/failures" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/evolution/datasets" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/evolution/action-items" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/analyze", payload: { range: "7d" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/evolution/action-items/action-1/recheck", payload: {} })).json()).toMatchObject({ actionId: "action-1", status: "resolved" });
  });
});
