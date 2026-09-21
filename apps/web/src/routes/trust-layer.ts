import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface TrustLayerRouteOptions {
  proxy: ProxyHelpers;
  doFetch: typeof fetch;
  watchUrl: string;
}

/**
 * 信任层（Trust Layer）代理路由插件
 */
export async function registerTrustLayerRoutes(
  app: FastifyInstance,
  options: TrustLayerRouteOptions,
): Promise<void> {
  const { proxy, doFetch, watchUrl } = options;
  const { proxyWatchPost, proxyWatchGet } = proxy;

  // 预算引擎（M1.1）：状态 + 手动核算（正常节奏 15 分钟一轮，按钮即时刷新）。
  app.get("/api/budget", async (_request, reply) => proxyWatchGet("/api/budget", reply));
  app.post("/api/budget", async (request, reply) =>
    proxyWatchPost("/api/budget", request.body, reply, 15_000),
  );
  app.post("/api/budget/check", async (request, reply) =>
    proxyWatchPost("/api/budget/check", request.body, reply, 15_000),
  );

  // 记忆探针频率设置（GET 读当前值，POST 设置并持久化）。
  app.get("/api/memory-probe/config", async (_request, reply) =>
    proxyWatchGet("/api/memory-probe/config", reply),
  );
  app.post("/api/memory-probe/config", async (request, reply) =>
    proxyWatchPost("/api/memory-probe/config", request.body, reply, 15_000),
  );

  // 行为审计流（M1.2）：动作时间线 + 汇总（query 原样透传）。
  const forwardAuditQuery = (request: { query?: unknown }, watchPath: string): string => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["hours", "kind", "severity", "limit"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return watchPath + (params.size > 0 ? "?" + params.toString() : "");
  };
  app.get("/api/audit/actions", async (request, reply) =>
    proxyWatchGet(forwardAuditQuery(request, "/api/audit/actions"), reply),
  );
  app.get("/api/audit/summary", async (request, reply) =>
    proxyWatchGet(forwardAuditQuery(request, "/api/audit/summary"), reply),
  );

  // 全局急停（M1.3）：engage/release 可能涉及停/启多个实例，放宽到 70s。
  app.get("/api/killswitch", async (_request, reply) => proxyWatchGet("/api/killswitch", reply));
  app.post("/api/killswitch/engage", async (request, reply) =>
    proxyWatchPost("/api/killswitch/engage", request.body, reply, 70_000),
  );
  app.post("/api/killswitch/release", async (request, reply) =>
    proxyWatchPost("/api/killswitch/release", request.body, reply, 70_000),
  );

  // 事件中心（M2.2）：列表 + 详情 + 状态流转。
  app.get("/api/trust/events", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["status", "severity", "limit"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return proxyWatchGet("/api/trust/events" + (params.size > 0 ? "?" + params.toString() : ""), reply);
  });
  app.get("/api/trust/events/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/trust/events/${id}`, reply);
  });
  app.post("/api/trust/events/:id/status", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/trust/events/${id}/status`, request.body, reply);
  });

  // M2.1 Agent 周报：本周实时视图 / 历史存档 / 详情 / 手动生成。
  app.get("/api/trust/report", async (_request, reply) =>
    proxyWatchGet("/api/trust/report", reply, 60_000),
  );
  app.get("/api/trust/report/history", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["limit"] === "string" && query["limit"] !== "") {
      params.set("limit", query["limit"]);
    }
    return proxyWatchGet(
      "/api/trust/report/history" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
    );
  });
  app.get("/api/trust/report/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/trust/report/${id}`, reply);
  });
  app.post("/api/trust/report/run", async (request, reply) =>
    proxyWatchPost("/api/trust/report/run", request.body, reply, 60_000),
  );

  // M2.3 会话索引：列表 / 详情时间线 / 手动重建。
  app.get("/api/sessions", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["limit", "offset", "anomalyOnly", "outcome", "windowDays"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return proxyWatchGet(
      "/api/sessions" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
      30_000,
    );
  });
  app.get("/api/sessions/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/sessions/${id}`, reply, 30_000);
  });
  app.post("/api/sessions/reindex", async (_request, reply) =>
    proxyWatchPost("/api/sessions/reindex", {}, reply, 60_000),
  );

  // M3.1 通知即操作：审批单列表 / 详情 / 显式登记 / 批准-拒绝决策。
  app.get("/api/approvals", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["status", "escalateOnly", "limit", "offset"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return proxyWatchGet(
      "/api/approvals" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
      30_000,
    );
  });
  app.get("/api/approvals/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/approvals/${id}`, reply, 30_000);
  });
  app.post("/api/approvals", async (request, reply) =>
    proxyWatchPost("/api/approvals", request.body, reply, 30_000),
  );
  app.post("/api/approvals/:id/decide", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    const body = {
      ...((request.body as Record<string, unknown> | undefined) ?? {}),
      source: "panel",
    };
    return proxyWatchPost(`/api/approvals/${id}/decide`, body, reply, 30_000);
  });
  app.post("/api/approvals/bulk-decide", async (request, reply) =>
    proxyWatchPost("/api/approvals/bulk-decide", request.body, reply, 30_000),
  );
  app.get("/api/approvals/rules", async (_request, reply) =>
    proxyWatchGet("/api/approvals/rules", reply, 30_000),
  );
  app.post("/api/approvals/rules", async (request, reply) =>
    proxyWatchPost("/api/approvals/rules", request.body, reply, 30_000),
  );
  app.delete("/api/approvals/rules/:fingerprint", async (request, reply) => {
    const rawFp = String((request.params as Record<string, string>)["fingerprint"] ?? "");
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}/api/approvals/rules/${encodeURIComponent(rawFp)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });

  // M3.2 升级金丝雀：列表 / 详情 / 抽样计划 / 执行 / 策略读写 / 手动巡检。
  app.get("/api/canary", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["status", "limit"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return proxyWatchGet("/api/canary" + (params.size > 0 ? "?" + params.toString() : ""), reply, 30_000);
  });
  app.get("/api/canary/policy", async (_request, reply) =>
    proxyWatchGet("/api/canary/policy", reply),
  );
  app.post("/api/canary/policy", async (request, reply) =>
    proxyWatchPost("/api/canary/policy", request.body, reply, 30_000),
  );
  app.post("/api/canary/plan", async (request, reply) =>
    proxyWatchPost("/api/canary/plan", request.body, reply, 60_000),
  );
  app.post("/api/canary/start", async (request, reply) =>
    proxyWatchPost("/api/canary/start", request.body, reply, 120_000),
  );
  app.post("/api/canary/tick", async (_request, reply) =>
    proxyWatchPost("/api/canary/tick", {}, reply, 60_000),
  );
  app.get("/api/canary/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string } | undefined)?.["id"] ?? "");
    return proxyWatchGet(`/api/canary/${id}`, reply, 30_000);
  });

  // M3.3 假进度检测：概览 / 会话级核实 / 手动采集。
  app.get("/api/progress", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["windowDays", "verdict", "limit"]) {
      if (typeof query[key] === "string" && query[key] !== "") {
        params.set(key, query[key] as string);
      }
    }
    return proxyWatchGet("/api/progress" + (params.size > 0 ? "?" + params.toString() : ""), reply, 30_000);
  });
  app.get("/api/progress/sessions/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string } | undefined)?.["id"] ?? "");
    return proxyWatchGet(`/api/progress/sessions/${id}`, reply, 30_000);
  });
  app.post("/api/progress/scan", async (_request, reply) =>
    proxyWatchPost("/api/progress/scan", {}, reply, 60_000),
  );

  // M4.4 多实例联邦：聚合视图与分组。
  app.get("/api/federation", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["windowDays"] === "string" && query["windowDays"] !== "") {
      params.set("windowDays", query["windowDays"]);
    }
    return proxyWatchGet("/api/federation" + (params.size > 0 ? "?" + params.toString() : ""), reply, 30_000);
  });
  app.post("/api/federation/group", async (request, reply) =>
    proxyWatchPost("/api/federation/group", request.body, reply, 30_000),
  );

  // M4.3 记忆变更流。
  app.get("/api/memory-diff", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["windowDays"] === "string" && query["windowDays"] !== "") {
      params.set("windowDays", query["windowDays"]);
    }
    return proxyWatchGet("/api/memory-diff" + (params.size > 0 ? "?" + params.toString() : ""), reply, 30_000);
  });
}
