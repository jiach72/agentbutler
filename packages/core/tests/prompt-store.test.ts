import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteStore,
  type PromptCandidateRow,
  type PromptEvaluationRow,
  type PromptTargetRow,
  type PromptVersionRow,
} from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

describe("SqliteStore prompt optimization tables", () => {
  let tmp: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "data", "butler.db"));
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it("prompt_targets / prompt_versions：登记、查询、active 更新与 JSON 回程", () => {
    const row: PromptTargetRow = {
      targetId: "hermes-system-prompt",
      instanceId: "hermes-main",
      frameworkId: "hermes",
      sourcePath: "/home/jiach/.hermes/hermes-agent/agent/system_prompt.py",
      format: "plain",
      editableSections: ["prompt-content"],
      protectedClauses: [{ id: "clause-1", label: "未授权不得外发", text: "未授权不得外发" }],
      protectedSha256: "a".repeat(64),
      reloadMode: "next-run",
      activeVersion: "baseline",
      activeSha256: "b".repeat(64),
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    };
    store.savePromptTarget(row);
    const version: PromptVersionRow = store.insertPromptVersion({
      targetId: row.targetId,
      version: "baseline",
      sourcePath: row.sourcePath,
      contentSha256: row.activeSha256,
      snapshotPath: "/tmp/butler/prompts/hermes-system-prompt/baseline.txt",
      kind: "baseline",
    });

    expect(store.getPromptTarget(row.targetId)).toMatchObject({
      format: "plain",
      editableSections: ["prompt-content"],
      protectedClauses: [{ id: "clause-1", label: "未授权不得外发", text: "未授权不得外发" }],
    });
    expect(store.listPromptTargets()).toHaveLength(1);
    expect(store.getPromptVersion(row.targetId, "baseline")).toEqual(version);
    expect(store.listPromptVersions(row.targetId)).toHaveLength(1);
    expect(store.updatePromptTargetActive(row.targetId, "v2", "c".repeat(64))).toBe(true);
    expect(store.getPromptTarget(row.targetId)).toMatchObject({
      activeVersion: "v2",
      activeSha256: "c".repeat(64),
    });
    expect(store.updatePromptTargetActive("missing", "v2", "c".repeat(64))).toBe(false);
    expect(store.getPromptVersion("missing", "baseline")).toBeUndefined();
  });

  it("prompt_candidates / prompt_evaluations：持久化、更新与最新报告回程", () => {
    const candidate: PromptCandidateRow = store.savePromptCandidate({
      candidateId: "candidate-1",
      targetId: "hermes-system-prompt",
      contentSha256: "c".repeat(64),
      baseSha256: "b".repeat(64),
      snapshotPath: "/tmp/butler/prompts/hermes-system-prompt/candidate.txt",
      source: "manual",
      description: "手工候选",
      status: "pending-evaluation",
      gateErrors: [],
    });
    expect(candidate).toMatchObject({
      candidateId: "candidate-1",
      status: "pending-evaluation",
      gateErrors: [],
    });

    const evaluation: PromptEvaluationRow = store.savePromptEvaluation({
      evaluationId: "evaluation-1",
      candidateId: "candidate-1",
      targetId: "hermes-system-prompt",
      status: "approval-pending",
      tier: "formal",
      holdoutCount: 30,
      datasetPath: "/tmp/butler/prompts/datasets/holdout.jsonl",
      datasetHash: "d".repeat(64),
      baselineSha256: "b".repeat(64),
      candidateSha256: "c".repeat(64),
      casesPath: "/tmp/butler/prompts/.../evaluation-cases.jsonl",
      reportPath: "/tmp/butler/prompts/.../evaluation.json",
      metrics: { canPromote: true, baselineMean: 0.5, candidateMean: 0.8 },
      confidence: null,
      failures: [],
    });
    expect(store.getPromptCandidate("candidate-1")).toMatchObject({
      status: "pending-evaluation",
    });
    expect(store.listPromptCandidates("hermes-system-prompt")).toHaveLength(1);
    expect(store.getLatestPromptEvaluation("candidate-1")).toEqual(evaluation);
    expect(store.listPromptEvaluations("candidate-1")).toHaveLength(1);
    store.savePromptEvaluationCases({
      evaluationId: evaluation.evaluationId,
      cases: [
        { caseId: "case-1", baselineScore: 0.5, candidateScore: 0.8 },
        { caseId: "case-2", baselineScore: 1, candidateScore: 1 },
      ],
    });
    expect(store.listPromptEvaluationCases(evaluation.evaluationId)).toHaveLength(2);
    expect(store.getPromptEvaluationCase(evaluation.evaluationId, "case-1")).toMatchObject({
      caseId: "case-1",
      raw: { caseId: "case-1", baselineScore: 0.5, candidateScore: 0.8 },
    });

    const updated = store.savePromptCandidate({
      ...candidate,
      status: "approval-pending",
      updatedAt: "2026-08-22T01:00:00.000Z",
    });
    expect(updated.status).toBe("approval-pending");
    expect(updated.createdAt).toBe(candidate.createdAt);
    expect(store.getPromptCandidate("missing")).toBeUndefined();
  });
});
