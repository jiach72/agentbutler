import type { FastifyInstance } from "fastify";
import {
  SCHEDULED_TASK_MAX_BODY,
  SCHEDULED_TASK_MAX_RESPONSE,
  scheduledTaskRouteRequest,
  parseScheduledTaskResponse,
  scheduledTaskFailure,
  scheduledTaskHttpStatus,
} from "@butler/contract";

export interface ScheduledTasksRouteOptions {
  doFetch: typeof fetch;
  watchUrl: string;
}

/**
 * 计划任务路由插件（Task 10）
 */
export async function registerScheduledTasksRoutes(
  app: FastifyInstance,
  options: ScheduledTasksRouteOptions,
): Promise<void> {
  const { doFetch, watchUrl } = options;

  for (const route of [
    { method: "GET" as const, url: "/api/scheduled-tasks" },
    { method: "GET" as const, url: "/api/scheduled-tasks/status" },
    { method: "GET" as const, url: "/api/scheduled-tasks/incidents" },
    { method: "GET" as const, url: "/api/scheduled-tasks/:id" },
    { method: "GET" as const, url: "/api/scheduled-tasks/:id/runs" },
    { method: "POST" as const, url: "/api/scheduled-tasks/preview" },
    { method: "POST" as const, url: "/api/scheduled-tasks" },
    { method: "PATCH" as const, url: "/api/scheduled-tasks/:id" },
    { method: "DELETE" as const, url: "/api/scheduled-tasks/:id" },
    { method: "POST" as const, url: "/api/scheduled-tasks/:id/:action" },
  ]) {
    app.route({
      ...route,
      bodyLimit: SCHEDULED_TASK_MAX_BODY,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const url = new URL(request.url, "http://butler-web.local");
        const query = scheduledTaskRouteRequest(request.method, url, request.body ?? {});
        if (!query) return reply.code(400).send({ error: "invalid_request" });
        let result;
        try {
          const upstream = await doFetch(`${watchUrl}${url.pathname}${url.search}`, {
            method: request.method,
            redirect: "error",
            headers: { "content-type": "application/json" },
            ...(request.method === "GET" ? {} : { body: JSON.stringify(request.body ?? {}) }),
            signal: AbortSignal.timeout(50_000),
          });
          if (!upstream.body) throw new Error("invalid_response");
          const reader = upstream.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > SCHEDULED_TASK_MAX_RESPONSE) {
                await reader.cancel();
                throw new Error("invalid_response");
              }
              chunks.push(value);
            }
            const parsed = parseScheduledTaskResponse(
              query.action,
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            result =
              parsed && (upstream.ok || parsed.reason)
                ? parsed
                : scheduledTaskFailure(query, "invalid_response");
            if (
              "requestId" in query &&
              (!("requestId" in result) || query.requestId !== result.requestId)
            ) {
              result = scheduledTaskFailure(query, "invalid_response");
            }
            if ("id" in query && "taskId" in result && result.taskId !== query.id) {
              result = scheduledTaskFailure(query, "invalid_response");
            }
          } finally {
            reader.releaseLock();
          }
        } catch {
          result = scheduledTaskFailure(query, "bridge_unreachable");
        }
        return reply.code(scheduledTaskHttpStatus(result)).send(result);
      },
    });
  }
}
