import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type {
  PromptActiveView,
  PromptCandidateView,
  PromptEvaluationReportView,
  PromptOptimizationService,
  PromptTargetView,
} from "../src/prompt-optimization.js";

const TARGET: PromptTargetView = {
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

const ACTIVE: PromptActiveView = {
  target: TARGET,
  active: {
    version: "baseline",
    sourcePath: TARGET.sourcePath,
    contentSha256: TARGET.activeSha256,
    snapshotPath: "/home/jiach/.agent-butler/prompts/hermes-prompt-builder/baseline.txt",
    kind: "baseline",
    createdAt: "2026-08-22T00:00:00.000Z",
  },
};

const CANDIDATE: PromptCandidateView = {
  candidateId: "candidate-1",
  targetId: TARGET.targetId,
  contentSha256: "c".repeat(64),
  baseSha256: TARGET.activeSha256,
  snapshotPath: "/home/jiach/.agent-butler/prompts/hermes-prompt-builder/candidate.txt",
  source: "manual",
  description: "HTTP 路由候选",
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

const REPORT: PromptEvaluationReportView = {
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

const promptOptimization: PromptOptimizationService = {
  registerTarget: () => ({ status: "error", error: "invalid-input", detail: "not exposed" }),
  listTargets: () => [TARGET],
  getActive: (targetId) => (targetId === TARGET.targetId ? ACTIVE : null),
  verifyTarget: () => ({
    ok: true,
    status: "ok",
    detail: "ok",
    checkedAt: "2026-08-22T01:00:00.000Z",
  }),
  checkCandidate: () => ({ ok: false, status: "rejected-static", errors: ["not exposed"] }),
  createCandidate: () => ({ status: "created", candidate: CANDIDATE }),
  listCandidates: () => [CANDIDATE],
  getCandidate: (candidateId) => (candidateId === CANDIDATE.candidateId ? CANDIDATE : null),
  getCandidateReport: (candidateId) =>
    candidateId === CANDIDATE.candidateId ? { candidate: CANDIDATE, report: REPORT } : null,
  evaluateCandidate: async () => ({ status: "completed", report: REPORT }),
  promoteCandidate: () => ({
    status: "promoted",
    candidate: { ...CANDIDATE, status: "promoted" },
    active: ACTIVE,
    reloadRequired: false,
  }),
};

function makeDeps(includeService = true): WatchHttpDeps {
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
    ...(includeService ? { promptOptimization } : {}),
  };
}

describe("startWatchHttp M5 提示词只读端点", () => {
  let http: WatchHttp;
  let base: string;

  beforeEach(async () => {
    http = startWatchHttp(makeDeps(), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => http.close());

  it("提供 Registry 与 active 查询，未知目标 404", async () => {
    const targets = await fetch(`${base}/api/prompt-optimization/targets`);
    expect(targets.status).toBe(200);
    await expect(targets.json()).resolves.toEqual({ targets: [TARGET] });

    const active = await fetch(`${base}/api/prompt-optimization/active/hermes-prompt-builder`);
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toEqual(ACTIVE);

    const missing = await fetch(`${base}/api/prompt-optimization/active/missing`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "prompt-target-not-found" });
  });

  it("服务未接线时返回 503 且写方法被拒绝", async () => {
    http.close();
    http = startWatchHttp(makeDeps(false), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const targets = await fetch(`${base}/api/prompt-optimization/targets`);
    expect(targets.status).toBe(503);
    const write = await fetch(`${base}/api/prompt-optimization/targets`, { method: "POST" });
    expect(write.status).toBe(405);
  });

  it("候选列表、详情、评估、报告与创建端点走通", async () => {
    const candidates = await fetch(
      `${base}/api/prompt-optimization/candidates?targetId=${TARGET.targetId}`,
    );
    expect(candidates.status).toBe(200);
    await expect(candidates.json()).resolves.toEqual({ candidates: [CANDIDATE] });

    const detail = await fetch(
      `${base}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}`,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual({ candidate: CANDIDATE });

    const report = await fetch(
      `${base}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/report`,
    );
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toEqual({ candidate: CANDIDATE, report: REPORT });

    const create = await fetch(`${base}/api/prompt-optimization/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: TARGET.targetId,
        content: "prompt",
        baseSha256: TARGET.activeSha256,
      }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toEqual({ candidate: CANDIDATE });

    const evaluate = await fetch(
      `${base}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/evaluate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cases: [{ caseId: "case-1", baselineScore: 0.5, candidateScore: 0.8 }],
        }),
      },
    );
    expect(evaluate.status).toBe(201);
    await expect(evaluate.json()).resolves.toEqual({ report: REPORT });

    const promote = await fetch(
      `${base}/api/prompt-optimization/candidates/${CANDIDATE.candidateId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evaluationId: REPORT.evaluationId, confirmed: true }),
      },
    );
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({
      status: "promoted",
      candidate: { status: "promoted" },
    });

    const missing = await fetch(`${base}/api/prompt-optimization/candidates/missing`);
    expect(missing.status).toBe(404);
  });
});
