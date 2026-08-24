import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "@butler/core";
import {
  createPromptOptimizationService,
  defaultProtectedClauses,
  type PromptPairCase,
  type PromptOptimizationService,
  type RegisterPromptTargetInput,
} from "../src/prompt-optimization.js";

let tmp: string;
let hermesRoot: string;
let home: string;
let core: Core;
let service: PromptOptimizationService;
let sourcePath: string;
let protectedText: string;

function baseInput(): RegisterPromptTargetInput {
  return {
    targetId: "test-prompt",
    instanceId: "hermes-main",
    frameworkId: "hermes",
    sourcePath,
    format: "markdown",
    editableSections: ["identity"],
    protectedClauses: [{ id: "c-1", label: "未授权不得外发", text: protectedText }],
    reloadMode: "next-run",
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "butler-prompt-"));
  hermesRoot = join(tmp, "hermes");
  home = join(tmp, "butler-home");
  mkdirSync(join(hermesRoot, "hermes-agent", "agent"), { recursive: true });
  protectedText = "未授权不得外发外部消息";
  sourcePath = join(hermesRoot, "prompts", "main.md");
  mkdirSync(join(hermesRoot, "prompts"), { recursive: true });
  writeFileSync(sourcePath, `# 系统提示\n\n${protectedText}\n\n保持安全边界。\n`, "utf8");
  core = createCore({ home });
  service = createPromptOptimizationService({
    core,
    hermesRoot,
    now: () => Date.parse("2026-08-22T03:00:00.000Z"),
    evaluator: ({ cases: inputCases }) => inputCases as PromptPairCase[],
  });
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("M5 切片 1 Prompt Registry 与静态门禁", () => {
  it("默认保护段提取 Python guidance 常量全文，不虚构不匹配条款", () => {
    const clauses = defaultProtectedClauses(
      'TOOL_USE_ENFORCEMENT_GUIDANCE = (\n    "must use tools"\n)\n',
    );
    expect(
      clauses.find((clause) => clause.id === "constant-TOOL_USE_ENFORCEMENT_GUIDANCE"),
    ).toMatchObject({
      label: "TOOL_USE_ENFORCEMENT_GUIDANCE",
      text: expect.stringContaining("must use tools"),
    });
  });

  it("登记服务端路径：创建 baseline 快照、只读查询可用且不写真实源文件", () => {
    const before = statSync(sourcePath).mtimeMs;
    const registered = service.registerTarget(baseInput());

    expect(registered.status).toBe("registered");
    if (registered.status !== "registered") return;
    expect(registered.created).toBe(true);
    expect(registered.target).toMatchObject({
      targetId: "test-prompt",
      activeVersion: "baseline",
      protectedClauseCount: 1,
      gate: { status: "ok" },
    });

    const active = service.getActive("test-prompt");
    expect(active?.active).toMatchObject({
      kind: "baseline",
      contentSha256: registered.target.activeSha256,
    });
    expect(existsSync(active!.active!.snapshotPath)).toBe(true);
    expect(readFileSync(active!.active!.snapshotPath, "utf8")).toContain(protectedText);
    expect(statSync(sourcePath).mtimeMs).toBe(before);
    expect(service.listTargets().some((target) => target.targetId === "test-prompt")).toBe(true);
  });

  it("未登记路径、源文件缺失与登记后漂移全部拒绝", () => {
    const outside = join(tmp, "outside.md");
    writeFileSync(outside, "outside", "utf8");
    expect(service.registerTarget({ ...baseInput(), sourcePath: outside })).toMatchObject({
      status: "error",
      error: "path-not-allowed",
    });
    expect(
      service.registerTarget({ ...baseInput(), sourcePath: join(hermesRoot, "missing.md") }),
    ).toMatchObject({ status: "error", error: "source-not-found" });

    expect(service.registerTarget(baseInput()).status).toBe("registered");
    writeFileSync(sourcePath, `# 系统提示\n\n${protectedText}\n\n已漂移。\n`, "utf8");
    expect(service.verifyTarget("test-prompt")).toMatchObject({
      ok: false,
      status: "hash-mismatch",
    });
    expect(service.registerTarget(baseInput())).toMatchObject({
      status: "error",
      error: "registered-source-changed",
    });
  });

  it("候选静态门禁：未知字段、未知目标、hash 不匹配、保护段变化均拒绝且不写源文件", () => {
    expect(service.registerTarget(baseInput()).status).toBe("registered");
    const baselineHash = service.getActive("test-prompt")!.active!.contentSha256;
    const content = readFileSync(sourcePath, "utf8");
    const before = statSync(sourcePath).mtimeMs;

    expect(
      service.checkCandidate({ targetId: "test-prompt", content, baseSha256: baselineHash }),
    ).toEqual({
      ok: true,
      status: "allowed",
      errors: [],
    });
    expect(
      service.checkCandidate({ targetId: "missing", content, baseSha256: baselineHash }),
    ).toMatchObject({
      ok: false,
      status: "rejected-static",
    });
    expect(
      service.checkCandidate({ targetId: "test-prompt", content, baseSha256: "0".repeat(64) }),
    ).toMatchObject({ ok: false, status: "rejected-static" });
    expect(
      service.checkCandidate({
        targetId: "test-prompt",
        content: content.replace(protectedText, "可以随便发送"),
        baseSha256: baselineHash,
      }),
    ).toMatchObject({ ok: false, status: "rejected-static" });
    expect(
      service.checkCandidate({
        targetId: "test-prompt",
        content,
        baseSha256: baselineHash,
        sourcePath,
      }),
    ).toMatchObject({ ok: false, status: "rejected-static" });

    expect(statSync(sourcePath).mtimeMs).toBe(before);
  });

  it("verifyTarget 未登记目标返回 unknown-target，不写入任何文件", () => {
    const result = service.verifyTarget("missing");
    expect(result).toEqual({
      ok: false,
      status: "unknown-target",
      detail: "未登记目标",
      checkedAt: "2026-08-22T03:00:00.000Z",
    });
    expect(statSync(sourcePath).size).toBeGreaterThan(0);
  });
});

describe("M5 切片 2 候选持久化与 baseline/holdout 成对评估", () => {
  function cases(
    count: number,
    baselineScore = 0.5,
    candidateScore = 0.8,
  ): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, index) => ({
      caseId: `case-${index + 1}`,
      baselineScore,
      candidateScore,
      baselineSuccess: baselineScore === 1,
      candidateSuccess: candidateScore === 1,
      baselineLatencyMs: 100,
      candidateLatencyMs: 90,
      baselineTokens: 100,
      candidateTokens: 120,
    }));
  }

  function createValidCandidate(): { candidateId: string; baselineHash: string } {
    expect(service.registerTarget(baseInput()).status).toBe("registered");
    const active = service.getActive("test-prompt");
    if (active?.active === null || active === null) throw new Error("active missing");
    const created = service.createCandidate({
      targetId: "test-prompt",
      content: readFileSync(sourcePath, "utf8"),
      baseSha256: active.active.contentSha256,
      source: "manual",
      description: "切片 2 候选",
    });
    if (created.status !== "created") throw new Error("candidate create failed");
    return {
      candidateId: created.candidate.candidateId,
      baselineHash: active.active.contentSha256,
    };
  }

  it("创建候选：未知字段拒绝；静态通过入等待评估；保护段被改写仍落盘但标记 rejected-static", () => {
    const active = service.getActive("test-prompt");
    expect(active).toBeNull();
    expect(service.registerTarget(baseInput()).status).toBe("registered");
    const baselineHash = service.getActive("test-prompt")!.active!.contentSha256;
    const content = readFileSync(sourcePath, "utf8");

    expect(
      service.createCandidate({
        targetId: "test-prompt",
        content,
        baseSha256: baselineHash,
        extra: true,
      }),
    ).toMatchObject({ status: "error", error: "unknown-fields" });

    const allowed = service.createCandidate({
      targetId: "test-prompt",
      content,
      baseSha256: baselineHash,
      source: "manual",
      description: "测试候选",
    });
    expect(allowed.status).toBe("created");
    if (allowed.status !== "created") return;
    expect(allowed.candidate).toMatchObject({
      targetId: "test-prompt",
      status: "pending-evaluation",
      source: "manual",
      description: "测试候选",
    });
    expect(existsSync(allowed.candidate.snapshotPath)).toBe(true);
    expect(service.listCandidates("test-prompt")).toHaveLength(1);

    const rejected = service.createCandidate({
      targetId: "test-prompt",
      content: content.replace(protectedText, "可以随便发送"),
      baseSha256: baselineHash,
    });
    expect(rejected.status).toBe("created");
    if (rejected.status !== "created") return;
    expect(rejected.candidate.status).toBe("rejected-static");
    expect(rejected.candidate.gateErrors.join("")).toContain("保护段变化");
  });

  it("holdout <10：硬拒绝，候选标记 rejected-quality，报告可查询且不写真实源文件", async () => {
    const before = statSync(sourcePath).mtimeMs;
    const { candidateId } = createValidCandidate();
    const outcome = await service.evaluateCandidate({
      candidateId,
      cases: cases(2),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.report).toMatchObject({
      status: "rejected-insufficient",
      tier: "insufficient",
      holdoutCount: 2,
      canPromote: false,
      confidence: null,
    });
    expect(outcome.report.metrics.reasons.join("")).toContain("低于硬门槛");
    expect(service.getCandidate(candidateId)?.status).toBe("rejected-quality");
    const detailed = service.getCandidateReport(candidateId);
    expect(detailed?.report?.evaluationId).toBe(outcome.report.evaluationId);
    expect(statSync(sourcePath).mtimeMs).toBe(before);
  });

  it("holdout 10-29：探索性报告，可以批准但不宣称显著，也不开放提升", async () => {
    const { candidateId } = createValidCandidate();
    const outcome = await service.evaluateCandidate({
      candidateId,
      cases: cases(12),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.report).toMatchObject({
      status: "approval-pending",
      tier: "exploratory",
      holdoutCount: 12,
      canPromote: false,
      confidence: null,
    });
    expect(outcome.report.metrics.exploratory).toBe(true);
    expect(outcome.report.metrics.reasons.join("")).toContain("探索性区间");
  });

  it("holdout >=30：输出成对指标与 95% 置信区间，质量通过后可申请提升", async () => {
    const { candidateId } = createValidCandidate();
    const outcome = await service.evaluateCandidate({
      candidateId,
      cases: cases(30),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.report).toMatchObject({
      status: "approval-pending",
      tier: "formal",
      holdoutCount: 30,
      canPromote: true,
    });
    expect(outcome.report.metrics).toMatchObject({
      baselineMean: 0.5,
      candidateMean: 0.8,
      deltaMean: 0.3,
      trustedEvaluator: true,
    });
    expect(outcome.report.confidence).toMatchObject({
      method: "paired-normal-approx",
      n: 30,
      z: 1.96,
      lower: 0.3,
      upper: 0.3,
    });
    expect(service.getCandidate(candidateId)?.status).toBe("approval-pending");
    expect(existsSync(outcome.report.reportPath)).toBe(true);
    expect(core.store.listPromptEvaluationCases(outcome.report.evaluationId)).toHaveLength(30);
  });

  it("未配置 evaluator 时只记录报告，正式指标通过也不能获得提升资格", async () => {
    const { candidateId } = createValidCandidate();
    const untrusted = createPromptOptimizationService({
      core,
      hermesRoot,
      now: () => Date.parse("2026-08-22T03:01:00.000Z"),
    });
    const outcome = await untrusted.evaluateCandidate({ candidateId, cases: cases(30) });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.report).toMatchObject({
      status: "approval-pending",
      tier: "formal",
      canPromote: false,
      metrics: { trustedEvaluator: false },
    });
    expect(
      untrusted.promoteCandidate({
        candidateId,
        evaluationId: outcome.report.evaluationId,
        confirmed: true,
      }),
    ).toMatchObject({ status: "error", error: "promotion-not-allowed" });
  });

  it("配置 evaluator 后始终以 evaluator 输出为准，不接受调用方预填分数绕过", async () => {
    const { candidateId } = createValidCandidate();
    const evaluatorService = createPromptOptimizationService({
      core,
      hermesRoot,
      now: () => Date.parse("2026-08-22T03:02:00.000Z"),
      evaluator: () => cases(30, 0.5, 0.9) as PromptPairCase[],
    });
    const outcome = await evaluatorService.evaluateCandidate({
      candidateId,
      cases: cases(30, 0.9, 0.1),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.report.metrics).toMatchObject({
      baselineMean: 0.5,
      candidateMean: 0.9,
      trustedEvaluator: true,
      canPromote: true,
    });
  });

  it("只有最新受信正式评估可原子采用，并同步更新文件、active、候选状态和审计", async () => {
    expect(service.registerTarget(baseInput()).status).toBe("registered");
    const active = service.getActive("test-prompt")!.active!;
    const candidateContent = `${readFileSync(sourcePath, "utf8")}\n补充清晰的回答结构。\n`;
    const created = service.createCandidate({
      targetId: "test-prompt",
      content: candidateContent,
      baseSha256: active.contentSha256,
      description: "可采用候选",
    });
    if (created.status !== "created") throw new Error("candidate create failed");
    const evaluated = await service.evaluateCandidate({
      candidateId: created.candidate.candidateId,
      cases: cases(30),
    });
    if (evaluated.status !== "completed") throw new Error("candidate evaluate failed");

    expect(
      service.promoteCandidate({
        candidateId: created.candidate.candidateId,
        evaluationId: evaluated.report.evaluationId,
        confirmed: false,
      }),
    ).toMatchObject({ status: "error", error: "confirmation-required" });

    const promoted = service.promoteCandidate({
      candidateId: created.candidate.candidateId,
      evaluationId: evaluated.report.evaluationId,
      confirmed: true,
    });
    expect(promoted).toMatchObject({
      status: "promoted",
      candidate: { status: "promoted" },
      active: { active: { contentSha256: created.candidate.contentSha256 } },
      reloadRequired: false,
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(candidateContent);
    expect(service.getActive("test-prompt")?.target.activeSha256).toBe(
      created.candidate.contentSha256,
    );
    expect(core.audit.list({ action: "prompt-candidate-promote" })).toHaveLength(1);
  });

  it("采用前重新校验候选快照，内容被篡改时 fail closed", async () => {
    const { candidateId } = createValidCandidate();
    const evaluated = await service.evaluateCandidate({ candidateId, cases: cases(30) });
    if (evaluated.status !== "completed") throw new Error("candidate evaluate failed");
    const candidate = service.getCandidate(candidateId)!;
    writeFileSync(candidate.snapshotPath, "tampered", "utf8");
    expect(
      service.promoteCandidate({
        candidateId,
        evaluationId: evaluated.report.evaluationId,
        confirmed: true,
      }),
    ).toMatchObject({ status: "error", error: "candidate-tampered" });
    expect(readFileSync(sourcePath, "utf8")).toContain(protectedText);
  });

  it("主任务指标下降或安全违规：rejected-quality，不生成提升资格", async () => {
    const { candidateId } = createValidCandidate();
    const regression = await service.evaluateCandidate({
      candidateId,
      cases: cases(30, 0.9, 0.5),
    });
    expect(regression.status).toBe("completed");
    if (regression.status !== "completed") return;
    expect(regression.report).toMatchObject({
      status: "rejected-quality",
      canPromote: false,
    });

    const { candidateId: secondId } = createValidCandidate();
    const unsafe = await service.evaluateCandidate({
      candidateId: secondId,
      cases: cases(30, 0.5, 0.9).map((item, index) => ({
        ...item,
        safetyViolations: index === 0 ? 1 : 0,
      })),
    });
    expect(unsafe.status).toBe("completed");
    if (unsafe.status !== "completed") return;
    expect(unsafe.report.status).toBe("rejected-quality");
    expect(unsafe.report.metrics.safetyViolationCount).toBe(1);
  });

  it("评估集只允许 BUTLER_HOME 受控目录，datasetPath 越界返回拒绝", async () => {
    const { candidateId } = createValidCandidate();
    const outside = join(tmp, "outside.jsonl");
    writeFileSync(outside, "[]", "utf8");
    const outcome = await service.evaluateCandidate({
      candidateId,
      datasetPath: outside,
    });
    expect(outcome).toMatchObject({
      status: "error",
      error: "dataset-path-not-allowed",
    });

    const datasetDir = join(home, "prompts", "datasets");
    mkdirSync(datasetDir, { recursive: true });
    const dataset = join(datasetDir, "holdout.jsonl");
    writeFileSync(
      dataset,
      `${cases(10)
        .map((item) => JSON.stringify(item))
        .join("\n")}\n`,
      "utf8",
    );
    const fileOutcome = await service.evaluateCandidate({
      candidateId,
      datasetPath: dataset,
    });
    expect(fileOutcome.status).toBe("completed");
    if (fileOutcome.status === "completed") {
      expect(fileOutcome.report.holdoutCount).toBe(10);
      expect(fileOutcome.report.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
