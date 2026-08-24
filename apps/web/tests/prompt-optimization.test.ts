import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

const TARGET = {
  targetId: "hermes-prompt-builder",
  instanceId: "hermes-main",
  frameworkId: "hermes",
  sourcePath: "/home/jiach/.hermes/hermes-agent/agent/prompt_builder.py",
  format: "plain",
  editableSections: ["guidance-content"],
  protectedClauseCount: 2,
  protectedSha256: "a".repeat(64),
  reloadMode: "next-run",
  activeVersion: "baseline",
  activeSha256: "b".repeat(64),
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  gate: { status: "ok", detail: "通过", checkedAt: "2026-08-22T01:00:00.000Z" },
};

const CANDIDATE = {
  candidateId: "candidate-1",
  targetId: "hermes-prompt-builder",
  contentSha256: "c".repeat(64),
  baseSha256: "b".repeat(64),
  snapshotPath: "/home/jiach/.agent-butler/prompts/hermes-prompt-builder/candidate.txt",
  source: "manual",
  description: "Web 代理候选",
  status: "approval-pending",
  gateErrors: [],
  createdAt: "2026-08-22T02:00:00.000Z",
  updatedAt: "2026-08-22T02:01:00.000Z",
  latestEvaluation: {
    evaluationId: "evaluation-1",
    status: "approval-pending",
    tier: "formal",
    holdoutCount: 30,
    canPromote: true,
    confidence: null,
    createdAt: "2026-08-22T02:01:00.000Z",
  },
};

const REPORT = {
  evaluationId: "evaluation-1",
  candidateId: CANDIDATE.candidateId,
  targetId: TARGET.targetId,
  status: "approval-pending",
  tier: "formal",
  holdoutCount: 30,
  canPromote: true,
  confidence: null,
  createdAt: "2026-08-22T02:01:00.000Z",
  datasetPath: "",
  datasetHash: "d".repeat(64),
  baselineSha256: TARGET.activeSha256,
  candidateSha256: CANDIDATE.contentSha256,
  metrics: {
    baselineMean: 0.5,
    candidateMean: 0.8,
    deltaMean: 0.3,
    trustedEvaluator: true,
    canPromote: true,
    exploratory: false,
    reasons: ["候选通过成对质量门禁"],
    datasetSchemaVersion: "pair-v1",
    modelParams: {},
    seed: null,
  },
  failures: [],
  casesPath:
    "/home/jiach/.agent-butler/prompts/hermes-prompt-builder/evaluations/evaluation-1-cases.jsonl",
  reportPath:
    "/home/jiach/.agent-butler/prompts/hermes-prompt-builder/evaluations/evaluation-1.json",
};

interface FakeRoute {
  status: number;
  body: unknown;
}

type MethodRoutes = Record<string, FakeRoute>;

function makeFetch(routes: Record<string, FakeRoute | MethodRoutes | "throw">): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const routeUrl = url.split("?")[0]!;
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
    const raw = routes[routeUrl];
    if (raw === "throw") throw new Error(`unreachable: ${url}`);
    if (raw === undefined)
      return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
    const method = init && init.method ? init.method : "GET";
    const route =
      typeof raw === "object" && !("status" in raw) ? (raw as MethodRoutes)[method] : raw;
    if (route === undefined)
      return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return { fetch: fake, calls };
}

describe("butler-web 提示词优化只读代理", () => {
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

  it("校验后的 Registry 与 active 代理可用，watch 不可达时降级", async () => {
    const transport = makeFetch({
      [`${WATCH_URL}/api/prompt-optimization/targets`]: {
        status: 200,
        body: { targets: [TARGET] },
      },
      [`${WATCH_URL}/api/prompt-optimization/active/hermes-prompt-builder`]: {
        status: 200,
        body: { target: TARGET, active: null },
      },
      ["http://127.0.0.1:7533/api/prompt-optimization/candidates"]: {
        GET: { status: 200, body: { candidates: [CANDIDATE] } },
        POST: { status: 201, body: { candidate: CANDIDATE } },
      },
      [`${WATCH_URL}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}`]: {
        status: 200,
        body: { candidate: CANDIDATE },
      },
      [`${WATCH_URL}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/report`]: {
        status: 200,
        body: { candidate: CANDIDATE, report: REPORT },
      },
      ["http://127.0.0.1:7533/api/prompt-optimization/candidates/candidate-1/evaluate"]: {
        POST: { status: 201, body: { report: REPORT } },
      },
      ["http://127.0.0.1:7533/api/prompt-optimization/candidates/candidate-1/promote"]: {
        POST: {
          status: 200,
          body: { status: "promoted", candidate: { ...CANDIDATE, status: "promoted" } },
        },
      },
    });
    const app = build(transport.fetch);

    const aggregate = await app.inject({ method: "GET", url: "/api/prompt-optimization" });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).toEqual({ watchReachable: true, targets: [TARGET] });

    const targets = await app.inject({ method: "GET", url: "/api/prompt-optimization/targets" });
    expect(targets.json()).toEqual({ watchReachable: true, targets: [TARGET] });

    const active = await app.inject({
      method: "GET",
      url: "/api/prompt-optimization/active/hermes-prompt-builder",
    });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toEqual({ target: TARGET, active: null });

    const list = await app.inject({
      method: "GET",
      url: `/api/prompt-optimization/candidates?targetId=${TARGET.targetId}`,
    });
    expect(list.json()).toEqual({ watchReachable: true, candidates: [CANDIDATE] });

    const detail = await app.inject({
      method: "GET",
      url: `/api/prompt-optimization/candidates/${CANDIDATE.candidateId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ candidate: CANDIDATE });

    const report = await app.inject({
      method: "GET",
      url: `/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/report`,
    });
    expect(report.json()).toEqual({ candidate: CANDIDATE, report: REPORT });

    const create = await app.inject({
      method: "POST",
      url: "/api/prompt-optimization/candidates",
      payload: { targetId: TARGET.targetId, content: "prompt", baseSha256: TARGET.activeSha256 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ candidate: CANDIDATE });

    const evaluate = await app.inject({
      method: "POST",
      url: `/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/evaluate`,
      payload: { cases: [{ caseId: "case-1", baselineScore: 0.5, candidateScore: 0.8 }] },
    });
    expect(evaluate.statusCode).toBe(201);
    expect(evaluate.json()).toEqual({ report: REPORT });

    const promote = await app.inject({
      method: "POST",
      url: `/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/promote`,
      payload: { evaluationId: REPORT.evaluationId, confirmed: true },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({
      status: "promoted",
      candidate: { status: "promoted" },
    });

    const offline = makeFetch({ [`${WATCH_URL}/api/prompt-optimization/targets`]: "throw" });
    const offlineApp = build(offline.fetch);
    const degraded = await offlineApp.inject({ method: "GET", url: "/api/prompt-optimization" });
    expect(degraded.json()).toEqual({ watchReachable: false, targets: [] });
  });

  it("畸形 Registry 响应也走降级，active watch 不可达返回 502", async () => {
    const transport = makeFetch({
      [`${WATCH_URL}/api/prompt-optimization/targets`]: {
        status: 200,
        body: { targets: [{ targetId: 1 }] },
      },
      [`${WATCH_URL}/api/prompt-optimization/active/missing`]: "throw",
    });
    const app = build(transport.fetch);

    const malformed = await app.inject({ method: "GET", url: "/api/prompt-optimization" });
    expect(malformed.json()).toEqual({ watchReachable: false, targets: [] });

    const missing = await app.inject({
      method: "GET",
      url: "/api/prompt-optimization/active/missing",
    });
    expect(missing.statusCode).toBe(502);
    expect(missing.json()).toEqual({ error: "watch-unreachable" });

    const offlineCandidates = await app.inject({
      method: "GET",
      url: "/api/prompt-optimization/candidates",
    });
    expect(offlineCandidates.json()).toEqual({ watchReachable: false, candidates: [] });
  });
});
