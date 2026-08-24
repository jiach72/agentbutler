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
    };
    const transport = makeFetch({
      [`GET ${WATCH_URL}/api/evolution/status`]: { status: 200, body: status },
    });
    const app = build(transport.fetch);

    const result = await app.inject({ method: "GET", url: "/api/evolution" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ watchReachable: true, ...status });

    const offline = makeFetch({ [`GET ${WATCH_URL}/api/evolution/status`]: "throw" });
    const offlineApp = build(offline.fetch);
    const degraded = await offlineApp.inject({ method: "GET", url: "/api/evolution" });
    expect(degraded.json()).toEqual({
      watchReachable: false,
      minHoldoutCount: 10,
      defaultDependencies: [],
      defaultEndpoint: "",
      ledger: [],
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
});
