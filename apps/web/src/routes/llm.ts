import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface LlmRouteOptions {
  proxy: ProxyHelpers;
  doFetch: typeof fetch;
  watchUrl: string;
}

/**
 * LLM 供应商画像、绑定、用量与成本中枢代理路由插件
 */
export async function registerLlmRoutes(
  app: FastifyInstance,
  options: LlmRouteOptions,
): Promise<void> {
  const { proxy, doFetch, watchUrl } = options;
  const { proxyWatchGet, proxyWatchPost } = proxy;

  app.get("/api/llm/profiles", async (_request, reply) => proxyWatchGet("/api/llm/profiles", reply));

  // 大屏 Token 三件套：Watch 只读聚合 Hermes session_model_usage。
  app.get("/api/llm/usage", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["days"] === "string") params.set("days", query["days"]);
    return proxyWatchGet("/api/llm/usage" + (params.size > 0 ? "?" + params.toString() : ""), reply);
  });

  // 成本中枢（M1.1）：task×model×day 聚合 + 最贵会话 TOP10 透传。
  app.get("/api/llm/cost/summary", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["days"] === "string") params.set("days", query["days"]);
    return proxyWatchGet(
      "/api/llm/cost/summary" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
    );
  });

  app.post("/api/llm/profiles", async (request, reply) =>
    proxyWatchPost("/api/llm/profiles", request.body, reply, 30_000),
  );

  app.get("/api/llm/bindings", async (_request, reply) => proxyWatchGet("/api/llm/bindings", reply));

  app.post("/api/llm/bindings", async (request, reply) =>
    proxyWatchPost("/api/llm/bindings", request.body, reply),
  );

  app.get("/api/llm/status", async (_request, reply) => proxyWatchGet("/api/llm/status", reply));

  app.get("/api/llm/discovered", async (_request, reply) =>
    proxyWatchGet("/api/llm/discovered", reply),
  );

  app.post("/api/llm/discovered/:id/import", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/llm/discovered/${id}/import`, request.body, reply, 30_000);
  });

  app.post("/api/llm/profiles/:id/:action", async (request, reply) => {
    const params = request.params as { id?: string; action?: string };
    if (!["rotate", "probe", "disable", "enable"].includes(params.action ?? "")) {
      return reply.status(404).send({ error: "not-found" });
    }
    return proxyWatchPost(
      `/api/llm/profiles/${encodeURIComponent(params.id ?? "")}/${params.action}`,
      request.body,
      reply,
      30_000,
    );
  });

  app.delete("/api/llm/profiles/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    let res: Response;
    const accessToken = (process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();
    const internalToken = (process.env["BUTLER_INTERNAL_TOKEN"] ?? "").trim();
    try {
      res = await doFetch(`${watchUrl}/api/llm/profiles/${id}`, {
        method: "DELETE",
        headers: {
          origin: "http://127.0.0.1:7531",
          ...(accessToken === "" ? {} : { "x-butler-token": accessToken }),
          ...(internalToken === "" ? {} : { "x-butler-internal-token": internalToken }),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    if (res.status === 204) return reply.status(204).send();
    const raw = await res.text();
    let parsed: unknown = {};
    try {
      parsed = raw === "" ? {} : (JSON.parse(raw) as unknown);
    } catch {
      parsed = { raw };
    }
    return reply.status(res.status).send(parsed);
  });

  app.delete("/api/llm/bindings/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}/api/llm/bindings/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    const raw = await res.text();
    if (raw === "") return reply.status(res.status).send();
    try {
      return reply.status(res.status).send(JSON.parse(raw));
    } catch {
      return reply.status(502).send({ error: "watch-invalid-response" });
    }
  });

  // 统一 API 密钥与服务中心代理路由
  app.get("/api/credentials", async (_request, reply) => proxyWatchGet("/api/credentials", reply));
  app.post("/api/credentials", async (request, reply) =>
    proxyWatchPost("/api/credentials", request.body, reply, 30_000),
  );
  app.post("/api/credentials/test", async (request, reply) =>
    proxyWatchPost("/api/credentials/test", request.body, reply, 15_000),
  );
  app.post("/api/credentials/sync", async (request, reply) =>
    proxyWatchPost("/api/credentials/sync", request.body, reply, 30_000),
  );
  app.post("/api/credentials/:id/probe", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/credentials/${id}/probe`, request.body, reply, 30_000);
  });
  app.delete("/api/credentials/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}/api/credentials/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    if (res.status === 204) return reply.status(204).send();
    const raw = await res.text();
    let parsed: unknown = {};
    try {
      parsed = raw === "" ? {} : (JSON.parse(raw) as unknown);
    } catch {
      parsed = { raw };
    }
    return reply.status(res.status).send(parsed);
  });
}
