import {
  SCHEDULED_TASK_MAX_BODY,
  parseScheduledTaskResponse,
  scheduledTaskFailure,
  scheduledTaskHttpStatus,
  scheduledTaskRouteRequest,
} from "@butler/contract";
import { type RequestContext, readJsonBody, sendJson } from "../http-common.js";

export async function handleTasks(ctx: RequestContext): Promise<boolean> {
  const { deps, req, res, url, path, method } = ctx;

  if (path === "/api/scheduled-tasks" || path.startsWith("/api/scheduled-tasks/")) {
    res.setHeader("cache-control", "no-store");
    const body = method === "GET" ? {} : await readJsonBody(req, res, SCHEDULED_TASK_MAX_BODY);
    if (body === null) return true;
    const query = scheduledTaskRouteRequest(method, url, body);
    if (!query) {
      sendJson(res, 400, { error: "invalid_request" });
      return true;
    }
    let result;
    try {
      result = deps.scheduledTasks
        ? parseScheduledTaskResponse(query.action, await deps.scheduledTasks.request(query))
        : scheduledTaskFailure(query, "bridge_not_configured");
    } catch {
      result = scheduledTaskFailure(query, "bridge_unreachable");
    }
    result ??= scheduledTaskFailure(query, "invalid_response");
    if (
      "requestId" in query &&
      (!("requestId" in result) || result.requestId !== query.requestId || ("id" in query && result.taskId !== query.id))
    ) {
      result = scheduledTaskFailure(query, "invalid_response");
    }
    sendJson(res, scheduledTaskHttpStatus(result), result);
    return true;
  }

  return false;
}
