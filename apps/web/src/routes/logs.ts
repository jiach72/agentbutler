import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

/**
 * 系统日志只读代理路由（V1.7）
 */
export async function registerLogsRoutes(
  app: FastifyInstance,
  proxy: ProxyHelpers,
): Promise<void> {
  const { fetchWatch, proxyWatchPost, proxyWatchGet } = proxy;

  app.get("/api/logs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["instanceId"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    const res = await fetchWatch(`/api/logs${suffix}`);
    if (res === null || !res.ok) return { reachable: false, sources: [] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return { reachable: false, sources: [] };
    }
  });

  app.get("/api/logs/analyze", async (request) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["instanceId"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    const res = await fetchWatch(`/api/logs/analyze${suffix}`);
    if (res === null || !res.ok) {
      return {
        reachable: false,
        issues: [],
        scannedSources: 0,
        scannedLines: 0,
        analyzedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        issues: [],
        scannedSources: 0,
        scannedLines: 0,
        analyzedAt: null,
      };
    }
  });

  app.post("/api/logs/fix", async (request, reply) =>
    proxyWatchPost("/api/logs/fix", request.body, reply),
  );

  app.get("/api/logs/fix/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/logs/fix/${id}`, reply);
  });

  app.get("/api/logs/:sourceId", async (request, reply) => {
    const params = request.params as { sourceId?: string };
    const query = request.query as Record<string, unknown>;
    const search = new URLSearchParams();
    for (const key of ["instanceId", "limit"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") search.set(key, value);
    }
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    const id = encodeURIComponent(params["sourceId"] ?? "");
    const res = await fetchWatch(`/api/logs/${id}${suffix}`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    let parsed: unknown = {};
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }
    return reply.status(res.status).send(parsed);
  });
}
