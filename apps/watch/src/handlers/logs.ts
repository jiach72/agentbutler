import {
  type RequestContext,
  readJsonBody,
  recoveryTracker,
  sendJson,
} from "../http-common.js";

export async function handleLogs(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/logs/analyze") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.analyzeLogs === undefined) {
      sendJson(res, 503, { error: "log-analyzer-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    sendJson(res, 200, await deps.analyzeLogs(instanceId));
    return true;
  }

  if (path === "/api/logs/fix") {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (body["confirmed"] !== true) {
      sendJson(res, 400, {
        error: "confirmation-required",
        userHint: "修复会重启或重连服务，必须先确认影响范围。",
      });
      return true;
    }
    const action = body["action"];
    if (action !== "rb-restart" && action !== "rb-reconnect") {
      sendJson(res, 400, { error: "unknown-action" });
      return true;
    }
    const instanceId =
      typeof body["instanceId"] === "string" && body["instanceId"] !== ""
        ? body["instanceId"]
        : undefined;
    const actionLabel = action === "rb-reconnect" ? "重新连接消息通道" : "重启 AI 实例";
    const job = recoveryTracker.start(action, actionLabel, action === "rb-reconnect" ? 20 : 90, instanceId, true);
    const beforeRunAt = deps.runbooks().find((item) => item.id === action)?.lastRun?.at ?? null;
    const outcome = await deps.executeRunbook(action, instanceId);
    if (outcome.status === "started") {
      recoveryTracker.monitorRunbook(job.jobId, () => deps.runbooks(), action, beforeRunAt);
      sendJson(res, 202, { started: true, jobId: job.jobId, status: "running" });
      return true;
    }
    recoveryTracker.finish(
      job.jobId,
      "failed",
      outcome.status === "circuit-breaker-tripped"
        ? "保护机制暂时阻止了执行"
        : "没有可用的 Hermes 实例",
    );
    if (outcome.status === "unknown-runbook") {
      sendJson(res, 404, { error: `unknown-runbook: ${action}` });
      return true;
    }
    if (outcome.status === "circuit-breaker-tripped") {
      sendJson(res, 409, { error: "circuit-breaker-tripped" });
      return true;
    }
    sendJson(res, 503, { error: "no-servicing-instance" });
    return true;
  }

  const logFixJobMatch = /^\/api\/logs\/fix\/([^/]+)$/.exec(path);
  if (logFixJobMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const job = recoveryTracker.get(decodeURIComponent(logFixJobMatch[1]!));
    if (!job) {
      sendJson(res, 404, { error: "log-fix-job-not-found" });
      return true;
    }
    sendJson(res, 200, job);
    return true;
  }

  if (path === "/api/logs" || path.startsWith("/api/logs/")) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    if (deps.logs === undefined) {
      sendJson(res, 503, { error: "logs-unavailable" });
      return true;
    }
    const instanceId = url.searchParams.get("instanceId")?.trim() || undefined;
    if (path === "/api/logs") {
      sendJson(res, 200, {
        sources: deps.logs.listSources(instanceId),
        instanceId: instanceId ?? null,
      });
      return true;
    }
    const sourceId = decodeURIComponent(path.slice("/api/logs/".length));
    if (sourceId === "") {
      sendJson(res, 400, { error: "invalid-source-id" });
      return true;
    }
    const limitRaw = url.searchParams.get("limit");
    let limit = 200;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 2_000) {
        sendJson(res, 400, { error: "invalid-limit" });
        return true;
      }
    }
    const beforeRaw = url.searchParams.get("before");
    let before: number | null = null;
    if (beforeRaw !== null && beforeRaw !== "") {
      before = Number(beforeRaw);
      if (!Number.isInteger(before) || before < 0) {
        sendJson(res, 400, { error: "invalid-before" });
        return true;
      }
    }
    const view = await deps.logs.readTail(sourceId, instanceId, limit, before);
    if (view === null) {
      sendJson(res, 404, { error: "log-source-not-found" });
      return true;
    }
    sendJson(res, 200, view);
    return true;
  }

  return false;
}
