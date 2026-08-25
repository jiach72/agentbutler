import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EvolutionExpandInput,
  EvolutionExpandOutcome,
  EvolutionGateOutcome,
  EvolutionPreflightInput,
  EvolutionPreflightOutcome,
  EvolutionPromoteInput,
  EvolutionPromoteOutcome,
  EvolutionResultInput,
  EvolutionService,
} from "../src/evolution.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

const READY: EvolutionPreflightOutcome = {
  runId: "run-16",
  status: "ready",
  allowRun: true,
  instanceId: "hermes-main",
  checks: [
    { id: "dependencies", label: "技能依赖", status: "pass", detail: "依赖可用" },
    { id: "endpoint", label: "模型端点", status: "pass", detail: "端点可达" },
    { id: "dataset", label: "评估集规模", status: "pass", detail: "holdout 10 条" },
    { id: "snapshot", label: "运行前快照", status: "pass", detail: "snapshot-16" },
  ],
  snapshotId: "snapshot-16",
  ledgerPath: "/ledger/run-16.md",
};

interface EvolutionFakeState {
  preflightCalls: EvolutionPreflightInput[];
  expandCalls: EvolutionExpandInput[];
  resultCalls: EvolutionResultInput[];
  expandOutcome: EvolutionExpandOutcome;
  resultOutcome: EvolutionGateOutcome;
  promoteCalls: EvolutionPromoteInput[];
  promoteOutcome: EvolutionPromoteOutcome;
}

function makeDeps(): { deps: WatchHttpDeps; state: EvolutionFakeState } {
  const state: EvolutionFakeState = {
    preflightCalls: [],
    expandCalls: [],
    resultCalls: [],
    expandOutcome: {
      status: "ready",
      beforeCount: 2,
      afterCount: 10,
      syntheticCount: 8,
      datasetPath: "/datasets/run-16-expanded.jsonl",
      recheck: READY,
    },
    resultOutcome: {
      status: "accepted",
      allowWrite: false,
      baselinePreserved: true,
      delta: 0.08,
      ledgerPath: "/ledger/run-16.md",
    },
    promoteCalls: [],
    promoteOutcome: {
      status: "promoted",
      runId: "run-16",
      targetPath: "/hermes/skills/target.md",
      candidatePath: "/hermes/skills/candidate.md",
      baselineSha256: "a".repeat(64),
      candidateSha256: "b".repeat(64),
      ledgerPath: "/ledger/run-16.md",
    },
  };
  const evolution: EvolutionService = {
    status: () => ({
      minHoldoutCount: 10,
      defaultDependencies: ["dspy", "gepa", "optuna"],
      defaultEndpoint: "https://llm.example/v1",
      ledger: [],
    }),
    preflight: async (input) => {
      state.preflightCalls.push(input);
      return READY;
    },
    expandDataset: async (input) => {
      state.expandCalls.push(input);
      return state.expandOutcome;
    },
    recordResult: async (input) => {
      state.resultCalls.push(input);
      return state.resultOutcome;
    },
    promoteArtifact: (input) => {
      state.promoteCalls.push(input);
      return state.promoteOutcome;
    },
    exportLedger: (runId) =>
      runId === "run-16"
        ? { filename: "evolution-run-16.md", markdown: "# 进化实验台账\n\n- 结论：显著提升\n" }
        : null,
  };
  return {
    state,
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
      evolution,
    },
  };
}

describe("startWatchHttp 进化守门端点", () => {
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

  it("提供状态、预检、扩集、结果守门与 Markdown 导出", async () => {
    const status = await fetch(`${base}/api/evolution/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      minHoldoutCount: 10,
      defaultDependencies: ["dspy", "gepa", "optuna"],
    });

    const preflight = await fetch(`${base}/api/evolution/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "hermes-main",
        dependencies: ["dspy"],
        endpoint: "https://llm.example/v1",
        holdoutCount: 10,
      }),
    });
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toEqual(READY);
    expect(fake.state.preflightCalls).toEqual([
      {
        instanceId: "hermes-main",
        dependencies: ["dspy"],
        endpoint: "https://llm.example/v1",
        holdoutCount: 10,
      },
    ]);

    const expand = await fetch(`${base}/api/evolution/runs/run-16/expand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdoutCount: 2, seedExamples: [{ prompt: "seed" }] }),
    });
    expect(expand.status).toBe(200);
    await expect(expand.json()).resolves.toMatchObject({ status: "ready", afterCount: 10 });
    expect(fake.state.expandCalls[0]).toMatchObject({ runId: "run-16", holdoutCount: 2 });

    const result = await fetch(`${base}/api/evolution/runs/run-16/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baselineMetric: 0.5, candidateMetric: 0.58, significant: true }),
    });
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "accepted",
      allowWrite: false,
      baselinePreserved: true,
    });
    expect(fake.state.resultCalls[0]).toEqual({
      runId: "run-16",
      baselineMetric: 0.5,
      candidateMetric: 0.58,
      significant: true,
    });

    const promote = await fetch(`${base}/api/evolution/runs/run-16/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "authority-1" }),
    });
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({ status: "promoted", runId: "run-16" });
    expect(fake.state.promoteCalls).toEqual([{ runId: "run-16", token: "authority-1" }]);

    const exported = await fetch(`${base}/api/evolution/ledger/run-16/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    expect(exported.headers.get("content-disposition")).toContain("evolution-run-16.md");
    await expect(exported.text()).resolves.toContain("进化实验台账");
  });

  it("校验非法输入并映射缺失运行、非 ready 运行与缺失台账", async () => {
    const invalidPreflight = await fetch(`${base}/api/evolution/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdoutCount: -1 }),
    });
    expect(invalidPreflight.status).toBe(400);

    fake.state.expandOutcome = {
      status: "error",
      error: "run-not-found",
      beforeCount: 2,
      afterCount: 2,
      syntheticCount: 0,
      datasetPath: "",
      recheck: { ...READY, status: "rejected-preflight", allowRun: false },
    };
    const missingRun = await fetch(`${base}/api/evolution/runs/missing/expand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdoutCount: 2, seedExamples: [{}] }),
    });
    expect(missingRun.status).toBe(404);

    fake.state.resultOutcome = {
      status: "error",
      error: "run-not-ready",
      allowWrite: false,
      baselinePreserved: true,
      delta: null,
      ledgerPath: "/ledger/run-16.md",
    };
    const notReady = await fetch(`${base}/api/evolution/runs/run-16/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baselineMetric: 0.5, candidateMetric: 0.5, significant: false }),
    });
    expect(notReady.status).toBe(409);

    const invalidResult = await fetch(`${base}/api/evolution/runs/run-16/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baselineMetric: "0.5", candidateMetric: 0.5, significant: false }),
    });
    expect(invalidResult.status).toBe(400);

    expect((await fetch(`${base}/api/evolution/ledger/missing/export`)).status).toBe(404);
  });

  it("校验采用令牌并映射受控替换冲突", async () => {
    const invalid = await fetch(`${base}/api/evolution/runs/run-16/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
    fake.state.promoteOutcome = {
      status: "error",
      error: "target-changed",
      detail: "baseline 文件已变化",
      ledgerPath: "/ledger/run-16.md",
    };
    const conflict = await fetch(`${base}/api/evolution/runs/run-16/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "authority-1" }),
    });
    expect(conflict.status).toBe(409);
  });
});
