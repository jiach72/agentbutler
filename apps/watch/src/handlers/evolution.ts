import { CONTROL_API_SCHEMA_VERSION } from "@butler/contract";
import type {
  EvolutionExpandInput,
  EvolutionPreflightInput,
  EvolutionPromoteInput,
  EvolutionResultInput,
} from "../evolution.js";
import {
  type RequestContext,
  isRecord,
  isStringArray,
  readJsonBody,
  sendJson,
  sendMarkdown,
} from "../http-common.js";

export async function handleEvolution(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/evolution/status") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    sendJson(res, 200, {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      ...deps.evolution.status(),
    });
    return true;
  }

  if (
    [
      "/api/evolution/overview",
      "/api/evolution/metrics",
      "/api/evolution/failures",
      "/api/evolution/datasets",
      "/api/evolution/action-items",
    ].includes(path)
  ) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolutionAnalytics === undefined) {
      sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    const rawRange = url.searchParams.get("range") ?? "7d";
    if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") {
      sendJson(res, 400, { error: "invalid-range" });
      return true;
    }
    if (path === "/api/evolution/overview") {
      sendJson(res, 200, await deps.evolutionAnalytics.overview(instanceId, rawRange));
      return true;
    }
    if (path === "/api/evolution/metrics") {
      sendJson(res, 200, await deps.evolutionAnalytics.metrics(instanceId, rawRange));
      return true;
    }
    if (path === "/api/evolution/failures") {
      sendJson(res, 200, await deps.evolutionAnalytics.failures(instanceId, rawRange));
      return true;
    }
    if (path === "/api/evolution/datasets") {
      sendJson(res, 200, await deps.evolutionAnalytics.datasets(instanceId));
      return true;
    }
    sendJson(res, 200, await deps.evolutionAnalytics.actionItems(instanceId));
    return true;
  }

  const evolutionActionRecheck = /^\/api\/evolution\/action-items\/([^/]+)\/recheck$/.exec(path);
  if (evolutionActionRecheck !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolutionAnalytics === undefined) {
      sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      return true;
    }
    const result = await deps.evolutionAnalytics.recheck(decodeURIComponent(evolutionActionRecheck[1]!));
    sendJson(res, "error" in result ? 404 : 200, result);
    return true;
  }

  if (path === "/api/evolution/analyze") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolutionAnalytics === undefined) {
      sendJson(res, 503, { error: "evolution-analytics-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") {
      sendJson(res, 400, { error: "invalid-instanceId" });
      return true;
    }
    const rawRange = body["range"] ?? "7d";
    if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") {
      sendJson(res, 400, { error: "invalid-range" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.evolutionAnalytics.analyze(
        typeof body["instanceId"] === "string" ? body["instanceId"] : undefined,
        rawRange,
      ),
    );
    return true;
  }

  if (path === "/api/evolution/insights") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolutionInsights === undefined) {
      sendJson(res, 503, { error: "evolution-insights-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    const rawRange = url.searchParams.get("range") ?? "7d";
    if (rawRange !== "24h" && rawRange !== "7d" && rawRange !== "30d") {
      sendJson(res, 400, { error: "invalid-range" });
      return true;
    }
    sendJson(res, 200, await deps.evolutionInsights.analyze(instanceId, rawRange));
    return true;
  }

  const directionAction = /^\/api\/evolution\/directions\/([^/]+)\/(summarize|confirm|start)$/.exec(path);
  if (directionAction !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolutionInsights === undefined) {
      sendJson(res, 503, { error: "evolution-insights-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const id = decodeURIComponent(directionAction[1]!);
    const action = directionAction[2]!;
    if (action === "summarize") {
      if (body["profileId"] !== undefined && typeof body["profileId"] !== "string") {
        sendJson(res, 400, { error: "invalid-profileId" });
        return true;
      }
      const result = await deps.evolutionInsights.summarize(
        id,
        typeof body["profileId"] === "string" ? body["profileId"] : undefined,
      );
      sendJson(res, "error" in result ? 404 : 200, result);
      return true;
    }
    if (action === "confirm") {
      if (body["targetRef"] !== undefined && typeof body["targetRef"] !== "string") {
        sendJson(res, 400, { error: "invalid-target-ref" });
        return true;
      }
      const result = deps.evolutionInsights.confirm(
        id,
        typeof body["targetRef"] === "string" ? body["targetRef"] : undefined,
      );
      sendJson(res, "error" in result ? 409 : 200, result);
      return true;
    }
    if (body["mode"] !== "hermes" && body["mode"] !== "manual") {
      sendJson(res, 400, { error: "invalid-execution-mode" });
      return true;
    }
    const result = await deps.evolutionInsights.start(id, {
      mode: body["mode"],
      ...(typeof body["targetRef"] === "string" ? { targetRef: body["targetRef"] } : {}),
      ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}),
      ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
    });
    sendJson(res, "error" in result ? 409 : 200, result);
    return true;
  }

  if (path === "/api/evolution/targets") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.externalEvolution === undefined) {
      sendJson(res, 503, { error: "external-evolution-unavailable" });
      return true;
    }
    sendJson(res, 200, { targets: await deps.externalEvolution.targets() });
    return true;
  }

  if (path === "/api/evolution/proposals") {
    if (deps.externalEvolution === undefined) {
      sendJson(res, 503, { error: "external-evolution-unavailable" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { proposals: deps.externalEvolution.list() });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (typeof body["targetRef"] !== "string" || typeof body["problem"] !== "string") {
      sendJson(res, 400, { error: "invalid-proposal" });
      return true;
    }
    const result = await deps.externalEvolution.create({
      targetRef: body["targetRef"],
      problem: body["problem"],
      ...(Array.isArray(body["evidence"])
        ? { evidence: body["evidence"].filter((item): item is string => typeof item === "string") }
        : {}),
      ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}),
    });
    sendJson(res, "error" in result ? 400 : 201, result);
    return true;
  }

  const proposalMatch = /^\/api\/evolution\/proposals\/([^/]+)$/.exec(path);
  if (proposalMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.externalEvolution === undefined) {
      sendJson(res, 503, { error: "external-evolution-unavailable" });
      return true;
    }
    const proposal = deps.externalEvolution.get(decodeURIComponent(proposalMatch[1]!));
    if (proposal === null) {
      sendJson(res, 404, { error: "proposal-not-found" });
    } else {
      sendJson(res, 200, proposal);
    }
    return true;
  }

  const validateMatch = /^\/api\/evolution\/proposals\/([^/]+)\/validate$/.exec(path);
  if (validateMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.externalEvolution === undefined) {
      sendJson(res, 503, { error: "external-evolution-unavailable" });
      return true;
    }
    const result = await deps.externalEvolution.validate(decodeURIComponent(validateMatch[1]!));
    sendJson(res, "error" in result ? 404 : 200, result);
    return true;
  }

  const applyMatch = /^\/api\/evolution\/proposals\/([^/]+)\/apply$/.exec(path);
  if (applyMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.externalEvolution === undefined) {
      sendJson(res, 503, { error: "external-evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const result = await deps.externalEvolution.apply(decodeURIComponent(applyMatch[1]!), body["confirmed"] === true);
    sendJson(res, "error" in result ? 409 : 200, result);
    return true;
  }

  if (path === "/api/evolution/diagnose") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") {
      sendJson(res, 400, { error: "invalid-instanceId" });
      return true;
    }
    const analyzed = await deps.analyzeLogs?.(typeof body["instanceId"] === "string" ? body["instanceId"] : undefined);
    sendJson(res, 200, deps.evolution.diagnose(analyzed));
    return true;
  }

  if (path === "/api/evolution/runs") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (body["targetType"] !== "skill" && body["targetType"] !== "prompt" && body["targetType"] !== "config") {
      sendJson(res, 400, { error: "invalid-target-type" });
      return true;
    }
    if (typeof body["targetRef"] !== "string" || body["targetRef"].trim() === "") {
      sendJson(res, 400, { error: "invalid-target-ref" });
      return true;
    }
    if (body["instanceId"] !== undefined && typeof body["instanceId"] !== "string") {
      sendJson(res, 400, { error: "invalid-instanceId" });
      return true;
    }
    if (body["profileId"] !== undefined && typeof body["profileId"] !== "string") {
      sendJson(res, 400, { error: "invalid-profileId" });
      return true;
    }
    if (body["endpoint"] !== undefined && typeof body["endpoint"] !== "string") {
      sendJson(res, 400, { error: "invalid-endpoint" });
      return true;
    }
    if (body["datasetPath"] !== undefined && typeof body["datasetPath"] !== "string") {
      sendJson(res, 400, { error: "invalid-dataset-path" });
      return true;
    }
    if (body["holdoutCount"] !== undefined && (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0)) {
      sendJson(res, 400, { error: "invalid-holdout-count" });
      return true;
    }
    if (
      body["iterations"] !== undefined &&
      (!Number.isInteger(body["iterations"]) || (body["iterations"] as number) < 1 || (body["iterations"] as number) > 100)
    ) {
      sendJson(res, 400, { error: "invalid-iterations" });
      return true;
    }
    if (body["dryRun"] !== undefined && typeof body["dryRun"] !== "boolean") {
      sendJson(res, 400, { error: "invalid-dry-run" });
      return true;
    }
    const run = await deps.evolution.createRun({
      targetType: body["targetType"],
      targetRef: body["targetRef"],
      ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
      ...(typeof body["profileId"] === "string" ? { profileId: body["profileId"] } : {}),
      ...(typeof body["endpoint"] === "string" ? { endpoint: body["endpoint"] } : {}),
      ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
      ...(typeof body["holdoutCount"] === "number" ? { holdoutCount: body["holdoutCount"] } : {}),
      ...(typeof body["iterations"] === "number" ? { iterations: body["iterations"] } : {}),
      ...(typeof body["dryRun"] === "boolean" ? { dryRun: body["dryRun"] } : {}),
    });
    sendJson(res, run.status === "ready" ? 201 : 409, run);
    return true;
  }

  const evolutionRunMatch = /^\/api\/evolution\/runs\/([^/]+)$/.exec(path);
  if (evolutionRunMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const run = await deps.evolution.getRun(decodeURIComponent(evolutionRunMatch[1]!));
    if (run === null) {
      sendJson(res, 404, { error: "run-not-found" });
    } else {
      sendJson(res, 200, run);
    }
    return true;
  }

  const evolutionStartMatch = /^\/api\/evolution\/runs\/([^/]+)\/start$/.exec(path);
  if (evolutionStartMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const outcome = await deps.evolution.startRun(decodeURIComponent(evolutionStartMatch[1]!));
    if ("error" in outcome) {
      sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return true;
    }
    sendJson(res, 202, outcome);
    return true;
  }

  if (path === "/api/evolution/preflight") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
      sendJson(res, 400, { error: "invalid-holdout-count" });
      return true;
    }
    if (body["dependencies"] !== undefined && !isStringArray(body["dependencies"])) {
      sendJson(res, 400, { error: "invalid-dependencies" });
      return true;
    }
    if (body["config"] !== undefined && !isRecord(body["config"])) {
      sendJson(res, 400, { error: "invalid-config" });
      return true;
    }
    if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
      sendJson(res, 400, { error: "invalid-errors" });
      return true;
    }
    if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
      sendJson(res, 400, { error: "invalid-fixes" });
      return true;
    }
    for (const field of ["instanceId", "endpoint", "datasetPath", "rootCause"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        sendJson(res, 400, { error: `invalid-${field}` });
        return true;
      }
    }
    const input: EvolutionPreflightInput = {
      holdoutCount: body["holdoutCount"] as number,
      ...(typeof body["instanceId"] === "string" ? { instanceId: body["instanceId"] } : {}),
      ...(isStringArray(body["dependencies"]) ? { dependencies: body["dependencies"] } : {}),
      ...(typeof body["endpoint"] === "string" ? { endpoint: body["endpoint"] } : {}),
      ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
      ...(isRecord(body["config"]) ? { config: body["config"] } : {}),
      ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
      ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
      ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
    };
    sendJson(res, 200, await deps.evolution.preflight(input));
    return true;
  }

  const evolutionEvaluateMatch = /^\/api\/evolution\/runs\/([^/]+)\/evaluate$/.exec(path);
  if (evolutionEvaluateMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const runId = decodeURIComponent(evolutionEvaluateMatch[1]!);
    const outcome = await deps.evolution.evaluateRun(runId);
    if (outcome.status === "error") {
      sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const evolutionExpandMatch = /^\/api\/evolution\/runs\/([^/]+)\/expand$/.exec(path);
  if (evolutionExpandMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (!Number.isInteger(body["holdoutCount"]) || (body["holdoutCount"] as number) < 0) {
      sendJson(res, 400, { error: "invalid-holdout-count" });
      return true;
    }
    if (
      body["targetCount"] !== undefined &&
      (!Number.isInteger(body["targetCount"]) || (body["targetCount"] as number) < 1)
    ) {
      sendJson(res, 400, { error: "invalid-target-count" });
      return true;
    }
    if (body["datasetPath"] !== undefined && typeof body["datasetPath"] !== "string") {
      sendJson(res, 400, { error: "invalid-dataset-path" });
      return true;
    }
    if (body["seedExamples"] !== undefined && !Array.isArray(body["seedExamples"])) {
      sendJson(res, 400, { error: "invalid-seed-examples" });
      return true;
    }
    const runId = decodeURIComponent(evolutionExpandMatch[1]!);
    const input: EvolutionExpandInput = {
      runId,
      holdoutCount: body["holdoutCount"] as number,
      ...(typeof body["targetCount"] === "number" ? { targetCount: body["targetCount"] } : {}),
      ...(typeof body["datasetPath"] === "string" ? { datasetPath: body["datasetPath"] } : {}),
      ...(Array.isArray(body["seedExamples"]) ? { seedExamples: body["seedExamples"] } : {}),
    };
    const outcome = await deps.evolution.expandDataset(input);
    if (outcome.error === "run-not-found") {
      sendJson(res, 404, outcome);
      return true;
    }
    if (outcome.status === "error") {
      sendJson(res, 400, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const evolutionResultMatch = /^\/api\/evolution\/runs\/([^/]+)\/result$/.exec(path);
  if (evolutionResultMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (
      typeof body["baselineMetric"] !== "number" ||
      !Number.isFinite(body["baselineMetric"]) ||
      typeof body["candidateMetric"] !== "number" ||
      !Number.isFinite(body["candidateMetric"]) ||
      typeof body["significant"] !== "boolean"
    ) {
      sendJson(res, 400, { error: "invalid-result" });
      return true;
    }
    if (body["errors"] !== undefined && !isStringArray(body["errors"])) {
      sendJson(res, 400, { error: "invalid-errors" });
      return true;
    }
    if (body["fixes"] !== undefined && !isStringArray(body["fixes"])) {
      sendJson(res, 400, { error: "invalid-fixes" });
      return true;
    }
    if (body["rootCause"] !== undefined && typeof body["rootCause"] !== "string") {
      sendJson(res, 400, { error: "invalid-rootCause" });
      return true;
    }
    for (const field of ["targetPath", "candidatePath"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        sendJson(res, 400, { error: `invalid-${field}` });
        return true;
      }
    }
    const input: EvolutionResultInput = {
      runId: decodeURIComponent(evolutionResultMatch[1]!),
      baselineMetric: body["baselineMetric"],
      candidateMetric: body["candidateMetric"],
      significant: body["significant"],
      ...(isStringArray(body["errors"]) ? { errors: body["errors"] } : {}),
      ...(typeof body["rootCause"] === "string" ? { rootCause: body["rootCause"] } : {}),
      ...(isStringArray(body["fixes"]) ? { fixes: body["fixes"] } : {}),
      ...(typeof body["targetPath"] === "string" ? { targetPath: body["targetPath"] } : {}),
      ...(typeof body["candidatePath"] === "string"
        ? { candidatePath: body["candidatePath"] }
        : {}),
    };
    const outcome = await deps.evolution.recordResult(input);
    if (outcome.error === "run-not-found") {
      sendJson(res, 404, outcome);
      return true;
    }
    if (outcome.error === "run-not-ready") {
      sendJson(res, 409, outcome);
      return true;
    }
    if (outcome.status === "error") {
      sendJson(res, 400, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const evolutionPromoteMatch = /^\/api\/evolution\/runs\/([^/]+)\/promote$/.exec(path);
  if (evolutionPromoteMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (typeof body["token"] !== "string" || body["token"] === "") {
      sendJson(res, 400, { error: "invalid-token" });
      return true;
    }
    for (const field of ["targetPath", "candidatePath"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        sendJson(res, 400, { error: `invalid-${field}` });
        return true;
      }
    }
    const input: EvolutionPromoteInput = {
      runId: decodeURIComponent(evolutionPromoteMatch[1]!),
      token: body["token"],
      ...(typeof body["targetPath"] === "string" ? { targetPath: body["targetPath"] } : {}),
      ...(typeof body["candidatePath"] === "string"
        ? { candidatePath: body["candidatePath"] }
        : {}),
    };
    const outcome = await deps.evolution.promoteRun(input);
    if (outcome.status === "error") {
      const notFound = new Set(["run-not-found", "authority-not-found"]);
      const conflict = new Set([
        "authority-used",
        "path-not-allowed",
        "target-changed",
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

  const evolutionCancelMatch = /^\/api\/evolution\/runs\/([^/]+)\/cancel$/.exec(path);
  if (evolutionCancelMatch !== null) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const outcome = await deps.evolution.cancelRun(decodeURIComponent(evolutionCancelMatch[1]!));
    if ("error" in outcome) {
      sendJson(res, outcome.error === "run-not-found" ? 404 : 409, outcome);
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  const evolutionExportMatch = /^\/api\/evolution\/ledger\/([^/]+)\/export$/.exec(path);
  if (evolutionExportMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.evolution === undefined) {
      sendJson(res, 503, { error: "evolution-unavailable" });
      return true;
    }
    const exported = deps.evolution.exportLedger(decodeURIComponent(evolutionExportMatch[1]!));
    if (exported === null) {
      sendJson(res, 404, { error: "ledger-not-found" });
      return true;
    }
    sendMarkdown(res, exported.filename, exported.markdown);
    return true;
  }

  return false;
}
