import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface SkillsRouteOptions {
  proxy: ProxyHelpers;
  degradedSkills: () => unknown;
  parseSkillsStatus: (value: unknown) => unknown | null;
}

/**
 * 技能资产中心与 GitHub 令牌代理路由插件（Task 17）
 */
export async function registerSkillsRoutes(
  app: FastifyInstance,
  options: SkillsRouteOptions,
): Promise<void> {
  const { proxy, degradedSkills, parseSkillsStatus } = options;
  const { fetchWatch, proxyWatchGet, proxyWatchPost } = proxy;

  app.get("/api/skills", async (request) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["instanceId", "keyword", "limit"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    const res = await fetchWatch(`/api/skills${suffix}`);
    if (res === null || !res.ok) return degradedSkills();
    try {
      const parsed = parseSkillsStatus(await res.json());
      return parsed === null ? degradedSkills() : { watchReachable: true, ...(parsed as object) };
    } catch {
      return degradedSkills();
    }
  });

  // 技能资产中心代理：统计、生命周期、公开趋势和隔离安装均透传 Watch 语义。
  app.get("/api/skills/local", async (_request, reply) =>
    proxyWatchGet("/api/skills/local", reply, 15_000),
  );
  app.get("/api/skills/local/updates", async (_request, reply) =>
    proxyWatchGet("/api/skills/local/updates", reply, 30_000),
  );
  app.post("/api/skills/local/:name/remove", async (request, reply) => {
    const name = encodeURIComponent((request.params as { name?: string }).name ?? "");
    return proxyWatchPost(`/api/skills/local/${name}/remove`, request.body, reply, 30_000);
  });
  app.post("/api/skills/local/update", async (request, reply) =>
    proxyWatchPost("/api/skills/local/update", request.body, reply, 120_000),
  );
  app.post("/api/skills/git/stage", async (request, reply) =>
    proxyWatchPost("/api/skills/git/stage", request.body, reply, 90_000),
  );
  app.get("/api/skills/usage", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["range", "granularity"] as const) {
      if (typeof query[key] === "string") params.set(key, query[key] as string);
    }
    return proxyWatchGet("/api/skills/usage" + (params.size > 0 ? "?" + params.toString() : ""), reply);
  });
  app.post("/api/skills/:name/:action", async (request, reply) => {
    const params = request.params as { name?: string; action?: string };
    if (!["archive", "restore", "purge"].includes(params.action ?? "")) {
      return reply.status(404).send({ error: "not-found" });
    }
    return proxyWatchPost(
      "/api/skills/" + encodeURIComponent(params.name ?? "") + "/" + params.action,
      request.body,
      reply,
    );
  });
  app.get("/api/skills/github-trends", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["filter", "sort"] as const) {
      if (typeof query[key] === "string") params.set(key, query[key] as string);
    }
    return proxyWatchGet(
      "/api/skills/github-trends" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
    );
  });
  app.post("/api/skills/github-trends/refresh", async (_request, reply) =>
    proxyWatchPost("/api/skills/github-trends/refresh", {}, reply, 30_000),
  );
  app.get("/api/skills/recommendations", async (_request, reply) =>
    proxyWatchGet("/api/skills/recommendations", reply),
  );
  app.post("/api/skills/recommendations/:id/stage", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost("/api/skills/recommendations/" + id + "/stage", request.body, reply, 30_000);
  });
  app.post("/api/skills/staged/:id/install", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost("/api/skills/staged/" + id + "/install", request.body, reply, 30_000);
  });

  // SkillHub（skillhub.cn Open API）代理：分类/列表只读
  app.get("/api/skillhub/categories", async (_request, reply) =>
    proxyWatchGet("/api/skillhub/categories", reply, 15_000),
  );
  app.get("/api/skillhub/skills", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["keyword", "category", "sortBy", "order", "page", "pageSize"] as const) {
      if (typeof query[key] === "string") params.set(key, query[key] as string);
    }
    return proxyWatchGet(
      "/api/skillhub/skills" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
      20_000,
    );
  });
  app.post("/api/skillhub/skills/:slug/stage", async (request, reply) => {
    const slug = encodeURIComponent((request.params as { slug?: string }).slug ?? "");
    return proxyWatchPost(`/api/skillhub/skills/${slug}/stage`, request.body, reply, 60_000);
  });

  // 技能库管理器（skills-manager CLI）代理
  app.get("/api/skills-manager/status", async (_request, reply) => {
    const res = await fetchWatch("/api/skills-manager/status", 10_000);
    if (res === null) return reply.status(503).send({ available: false, reason: "watch-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ available: false })));
  });
  app.get("/api/skills-manager/updates", async (_request, reply) => {
    const res = await fetchWatch("/api/skills-manager/updates", 10_000);
    if (res === null) return reply.status(503).send({ available: false, reason: "watch-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ available: false })));
  });
  app.post("/api/skills-manager/install", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/install", request.body, reply, 120_000),
  );
  app.post("/api/skills-manager/deploy", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/deploy", request.body, reply, 120_000),
  );
  app.post("/api/skills-manager/undeploy", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/undeploy", request.body, reply, 120_000),
  );
  app.post("/api/skills-manager/update", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/update", request.body, reply, 120_000),
  );
  app.post("/api/skills-manager/adopt", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/adopt", request.body, reply, 120_000),
  );
  app.post("/api/skills-manager/remove", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/remove", request.body, reply, 120_000),
  );
  app.get("/api/skills-manager/search", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["query", "limit"] as const) {
      if (typeof query[key] === "string") params.set(key, query[key] as string);
    }
    return proxyWatchGet(
      "/api/skills-manager/search" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
      120_000,
    );
  });
  app.get("/api/skills-manager/skills/:name", async (request, reply) => {
    const name = encodeURIComponent((request.params as { name?: string }).name ?? "");
    return proxyWatchGet(`/api/skills-manager/skills/${name}`, reply, 30_000);
  });
  app.post("/api/skills-manager/tags", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/tags", request.body, reply, 30_000),
  );
  app.post("/api/skills-manager/set-source", async (request, reply) =>
    proxyWatchPost("/api/skills-manager/set-source", request.body, reply, 120_000),
  );

  // GitHub 访问令牌（设置页「安全」）
  app.get("/api/github-token", async (_request, reply) => {
    const res = await fetchWatch("/api/github-token", 10_000);
    if (res === null) return reply.status(503).send({ configured: false, reason: "watch-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ configured: false })));
  });
  app.post("/api/github-token", async (request, reply) =>
    proxyWatchPost("/api/github-token", request.body, reply, 15_000),
  );
}
