import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  BUILTIN_PROMPTFOO_SUITES,
  type PromptfooSuite,
  optimizePromptWithPromptfoo,
  runPromptfooEvaluation,
} from "../promptfoo.js";
import {
  type RequestContext,
  createWatchModelExecutor,
  readJsonBody,
  sendJson,
} from "../http-common.js";

export async function handlePrompt(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/prompt-optimization/targets") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    sendJson(res, 200, { targets: deps.promptOptimization.listTargets() });
    return true;
  }

  const promptActiveMatch = /^\/api\/prompt-optimization\/active\/([^/]+)$/.exec(path);
  if (promptActiveMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    const active = deps.promptOptimization.getActive(decodeURIComponent(promptActiveMatch[1]!));
    if (active === null) {
      sendJson(res, 404, { error: "prompt-target-not-found" });
    } else {
      sendJson(res, 200, active);
    }
    return true;
  }

  if (path === "/api/prompt-optimization/candidates") {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method === "GET") {
      const targetId = url.searchParams.get("targetId")?.trim() || undefined;
      sendJson(res, 200, {
        candidates: deps.promptOptimization.listCandidates(targetId),
      });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const outcome = deps.promptOptimization.createCandidate(body);
      if (outcome.status === "error") {
        const status = outcome.error === "target-not-found" ? 404 : 400;
        sendJson(res, status, outcome);
        return true;
      }
      sendJson(res, 201, { candidate: outcome.candidate });
      return true;
    }
    sendJson(res, 405, { error: "method-not-allowed" });
    return true;
  }

  const promptEvaluateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/evaluate$/.exec(path);
  if (promptEvaluateMatch !== null) {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const candidateId = decodeURIComponent(promptEvaluateMatch[1]!);
    const outcome = await deps.promptOptimization.evaluateCandidate({
      ...body,
      candidateId,
    });
    if (outcome.status === "error") {
      const status = outcome.error === "candidate-not-found" ? 404 : 400;
      sendJson(res, status, outcome);
      return true;
    }
    sendJson(res, 201, { report: outcome.report });
    return true;
  }

  const promptPromoteMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/promote$/.exec(path);
  if (promptPromoteMatch !== null) {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const candidateId = decodeURIComponent(promptPromoteMatch[1]!);
    const outcome = deps.promptOptimization.promoteCandidate({ ...body, candidateId });
    if (outcome.status === "error") {
      const notFound = new Set([
        "candidate-not-found",
        "target-not-found",
        "evaluation-not-found",
      ]);
      const conflict = new Set([
        "confirmation-required",
        "evaluation-stale",
        "promotion-not-allowed",
        "source-changed",
        "candidate-tampered",
      ]);
      const status = notFound.has(outcome.error)
        ? 404
        : conflict.has(outcome.error)
          ? 409
          : outcome.error === "write-failed"
            ? 500
            : 400;
      sendJson(res, status, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const promptCandidateMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)$/.exec(path);
  if (promptCandidateMatch !== null) {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const candidate = deps.promptOptimization.getCandidate(
      decodeURIComponent(promptCandidateMatch[1]!),
    );
    if (candidate === null) {
      sendJson(res, 404, { error: "prompt-candidate-not-found" });
    } else {
      sendJson(res, 200, { candidate });
    }
    return true;
  }

  const promptCandidateReportMatch = /^\/api\/prompt-optimization\/candidates\/([^/]+)\/report$/.exec(path);
  if (promptCandidateReportMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    const outcome = deps.promptOptimization.getCandidateReport(
      decodeURIComponent(promptCandidateReportMatch[1]!),
    );
    if (outcome === null) {
      sendJson(res, 404, { error: "prompt-candidate-not-found" });
    } else {
      sendJson(res, 200, outcome);
    }
    return true;
  }

  if (path === "/api/prompt-optimization/promptfoo/suites") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 200, { suites: BUILTIN_PROMPTFOO_SUITES });
    return true;
  }

  if (path === "/api/prompt-optimization/promptfoo/evaluate") {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const candidateId = typeof body["candidateId"] === "string" ? body["candidateId"].trim() : "";
    if (!candidateId) {
      sendJson(res, 400, { error: "missing-candidate-id" });
      return true;
    }

    const candidate = deps.promptOptimization.getCandidate(candidateId);
    if (candidate === null) {
      sendJson(res, 404, { error: "candidate-not-found" });
      return true;
    }

    const activeView = deps.promptOptimization.getActive(candidate.targetId);
    if (activeView === null || !activeView.active) {
      sendJson(res, 400, { error: "missing-baseline-target" });
      return true;
    }

    let baselineContent = activeView.content ?? activeView.active.content ?? "";
    if (!baselineContent && activeView.active.snapshotPath && existsSync(activeView.active.snapshotPath)) {
      try {
        baselineContent = readFileSync(activeView.active.snapshotPath, "utf8");
      } catch { /* fallback */ }
    }

    let candidateContent = "";
    if (candidate.snapshotPath && existsSync(candidate.snapshotPath)) {
      try {
        candidateContent = readFileSync(candidate.snapshotPath, "utf8");
      } catch { /* fallback */ }
    }

    const suiteId = typeof body["suiteId"] === "string" ? body["suiteId"].trim() : "hermes-standard-30";
    const customSuite = body["customSuite"] as PromptfooSuite | undefined;
    const suite =
      customSuite ??
      BUILTIN_PROMPTFOO_SUITES.find((s) => s.suiteId === suiteId) ??
      BUILTIN_PROMPTFOO_SUITES[0]!;

    const modelName = typeof body["model"] === "string" ? body["model"].trim() : undefined;
    const executor = createWatchModelExecutor(modelName);

    try {
      const { pairs, details } = await runPromptfooEvaluation({
        suite,
        baselinePrompt: baselineContent,
        candidatePrompt: candidateContent,
        modelExecutor: executor,
      });

      const outcome = await deps.promptOptimization.evaluateCandidate({
        candidateId,
        cases: pairs,
        datasetHash: createHash("sha256").update(JSON.stringify(suite), "utf8").digest("hex"),
        datasetSchemaVersion: "promptfoo-v1",
        modelParams: { model: modelName || "default", suiteId: suite.suiteId },
      });

      if (outcome.status === "error") {
        sendJson(res, 400, outcome);
        return true;
      }

      sendJson(res, 201, {
        ok: true,
        report: outcome.report,
        details,
        suite: {
          suiteId: suite.suiteId,
          name: suite.name,
          tier: suite.tier,
          totalTests: suite.tests.length,
        },
      });
      return true;
    } catch (err) {
      sendJson(res, 500, {
        error: "promptfoo-eval-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  if (path === "/api/prompt-optimization/promptfoo/optimize") {
    if (deps.promptOptimization === undefined) {
      sendJson(res, 503, { error: "prompt-optimization-unavailable" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const targetId = typeof body["targetId"] === "string" ? body["targetId"].trim() : "";
    const instruction = typeof body["instruction"] === "string" ? body["instruction"].trim() : "";
    if (!targetId || !instruction) {
      sendJson(res, 400, { error: "missing-target-or-instruction" });
      return true;
    }

    const activeView = deps.promptOptimization.getActive(targetId);
    if (activeView === null || !activeView.active) {
      sendJson(res, 404, { error: "prompt-target-not-found" });
      return true;
    }

    let baselineContent = activeView.content ?? activeView.active.content ?? "";
    if (!baselineContent && activeView.active.snapshotPath && existsSync(activeView.active.snapshotPath)) {
      try {
        baselineContent = readFileSync(activeView.active.snapshotPath, "utf8");
      } catch { /* fallback */ }
    }

    const protectedClauses = deps.promptOptimization.getProtectedClauses(targetId);
    const modelName = typeof body["model"] === "string" ? body["model"].trim() : undefined;
    const executor = createWatchModelExecutor(modelName);

    try {
      const { optimizedPrompt, changes, preservedClauses } = await optimizePromptWithPromptfoo({
        baselinePrompt: baselineContent,
        targetId,
        instruction,
        protectedClauses,
        modelExecutor: executor,
      });

      // 静态门禁预检
      const check = deps.promptOptimization.checkCandidate({
        targetId,
        content: optimizedPrompt,
        baseSha256: activeView.target.activeSha256,
      });

      if (!check.ok) {
        sendJson(res, 400, {
          error: "static-check-failed",
          gateErrors: check.errors,
          optimizedPrompt,
        });
        return true;
      }

      const outcome = deps.promptOptimization.createCandidate({
        targetId,
        content: optimizedPrompt,
        baseSha256: activeView.target.activeSha256,
        source: "generator",
        description: `[Promptfoo 优化] ${instruction.slice(0, 24)}`,
      });

      if (outcome.status === "error") {
        sendJson(res, 400, outcome);
        return true;
      }

      const autoEvaluate = body["autoEvaluate"] !== false;
      let evalReport: unknown = null;
      let evalDetails: unknown = null;
      if (autoEvaluate) {
        const suite = BUILTIN_PROMPTFOO_SUITES[0]!;
        try {
          const { pairs, details } = await runPromptfooEvaluation({
            suite,
            baselinePrompt: baselineContent,
            candidatePrompt: optimizedPrompt,
            modelExecutor: executor,
          });
          const evalOutcome = await deps.promptOptimization.evaluateCandidate({
            candidateId: outcome.candidate.candidateId,
            cases: pairs,
            datasetHash: createHash("sha256").update(JSON.stringify(suite), "utf8").digest("hex"),
            datasetSchemaVersion: "promptfoo-v1",
            modelParams: { model: modelName || "default", suiteId: suite.suiteId },
          });
          if (evalOutcome.status !== "error") {
            evalReport = evalOutcome.report;
            evalDetails = details;
          }
        } catch {
          // non-fatal for candidate creation
        }
      }

      const refreshedCandidate = deps.promptOptimization.getCandidate(outcome.candidate.candidateId);
      sendJson(res, 201, {
        ok: true,
        candidate: refreshedCandidate ?? outcome.candidate,
        changes,
        preservedClauses,
        evalResult: evalReport
          ? {
              ok: true,
              report: evalReport,
              details: evalDetails,
              suite: {
                suiteId: BUILTIN_PROMPTFOO_SUITES[0]!.suiteId,
                name: BUILTIN_PROMPTFOO_SUITES[0]!.name,
                tier: BUILTIN_PROMPTFOO_SUITES[0]!.tier,
                totalTests: BUILTIN_PROMPTFOO_SUITES[0]!.tests.length,
              },
            }
          : undefined,
      });
      return true;
    } catch (err) {
      sendJson(res, 500, {
        error: "promptfoo-optimize-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  return false;
}
