import type { FastifyInstance } from "fastify";
import { isRecord, type ProxyHelpers } from "../proxy-helpers.js";

export interface ConnectionApiView {
  id: string;
  kind: string;
  name: string;
  connected: boolean;
  endpoint?: string;
  detail?: string;
  checkedAt?: string;
}

export interface RecoveryRouteOptions {
  proxy: ProxyHelpers;
  inspectStatusFromWatch: () => Promise<Record<string, unknown>>;
}

/**
 * 故障自愈、运行手册、巡检与连接管理代理路由插件（Task 10 / B11）
 */
export async function registerRecoveryRoutes(
  app: FastifyInstance,
  options: RecoveryRouteOptions,
): Promise<void> {
  const { proxy, inspectStatusFromWatch } = options;
  const { fetchWatch, proxyWatchGet, proxyWatchPost } = proxy;

  app.get("/api/runtime", async (_request, reply) => {
    const res = await fetchWatch("/api/runtime");
    if (res === null) return reply.status(503).send({ kind: "unknown", detail: "管家控制通道不可达" });
    return reply.status(res.status).send(await res.json().catch(() => ({ kind: "unknown", detail: "运行时响应无效" })));
  });

  // 主机指标透传（就绪度「Agent 主机状态」卡）
  app.get("/api/host/metrics", async (_request, reply) => {
    const res = await fetchWatch("/api/host/metrics", 10_000);
    if (res === null || !res.ok) return reply.status(503).send({ reachable: false });
    return reply.status(200).send(await res.json().catch(() => ({ reachable: false })));
  });

  // 巡检状态
  app.get("/api/inspect/status", async () => inspectStatusFromWatch());

  // 立即巡检
  app.post("/api/inspect/run", async (_request, reply) =>
    proxyWatchPost("/api/inspect/run", {}, reply),
  );

  // runbook 列表
  app.get("/api/runbooks", async () => {
    const res = await fetchWatch("/api/runbooks");
    if (res === null || !res.ok) return { reachable: false, runbooks: [] as unknown[] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, runbooks: (body["runbooks"] as unknown[] | undefined) ?? [] };
    } catch {
      return { reachable: false, runbooks: [] as unknown[] };
    }
  });

  // runbook 执行
  app.post("/api/runbooks/:id/execute", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/runbooks/${id}/execute`, request.body, reply);
  });

  // 熔断人工解除
  app.post("/api/runbooks/:id/reset", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/runbooks/${id}/reset`, request.body, reply);
  });

  // 首次使用向导状态
  app.get("/api/setup/status", async () => {
    const res = await fetchWatch("/api/connections");
    if (res === null || !res.ok) {
      return { reachable: false, configured: false, connections: [] as unknown[] };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const connections = Array.isArray(body["connections"]) ? body["connections"] : [];
      return {
        reachable: true,
        configured: connections.some((item) => isRecord(item) && item["connected"] === true),
        connections,
      };
    } catch {
      return { reachable: false, configured: false, connections: [] as unknown[] };
    }
  });

  app.post("/api/recovery/diagnose", async (request, reply) =>
    proxyWatchPost("/api/recovery/diagnose", request.body, reply),
  );

  app.get("/api/recovery/diagnose", async (request, reply) => {
    const instanceId = (request.query as { instanceId?: string })["instanceId"] ?? "";
    const suffix = instanceId.trim() !== "" ? `?instanceId=${encodeURIComponent(instanceId.trim())}` : "";
    return proxyWatchGet(`/api/recovery/diagnose${suffix}`, reply);
  });

  app.post("/api/recovery/sessions", async (request, reply) =>
    proxyWatchPost("/api/recovery/sessions", request.body, reply),
  );

  app.get("/api/recovery/sessions/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/recovery/sessions/${id}`, reply);
  });

  app.post("/api/recovery/sessions/:id/approve", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/recovery/sessions/${id}/approve`, request.body, reply);
  });

  app.post("/api/recovery/actions/:id/execute", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/recovery/actions/${id}/execute`, request.body, reply, 70_000);
  });

  app.get("/api/recovery/jobs/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/recovery/jobs/${id}`, reply);
  });

  /** 连接管理视图 */
  app.get("/api/connections", async () => {
    const res = await fetchWatch("/api/connections");
    if (res === null || !res.ok) return { reachable: false, connections: [] as ConnectionApiView[] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const connections = Array.isArray(body["connections"]) ? body["connections"] : [];
      return {
        reachable: true,
        checkedAt: typeof body["checkedAt"] === "string" ? body["checkedAt"] : new Date().toISOString(),
        connections: connections as ConnectionApiView[],
      };
    } catch {
      return { reachable: false, connections: [] as ConnectionApiView[] };
    }
  });

  app.post("/api/connections/check", async (request, reply) =>
    proxyWatchPost("/api/connections/check", request.body, reply),
  );

  app.post("/api/connections/:id/connect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/connections/${id}/connect`, request.body, reply, 70_000);
  });

  app.post("/api/connections/:id/disconnect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/connections/${id}/disconnect`, request.body, reply, 70_000);
  });

  app.get("/api/openclaw/status", async (_request, reply) => {
    const res = await fetchWatch("/api/openclaw/status");
    if (res === null) return reply.status(503).send({ error: "openclaw-status-unavailable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ error: "invalid-response" })));
  });
}
