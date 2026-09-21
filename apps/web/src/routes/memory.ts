import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface MemoryRouteOptions {
  proxy: ProxyHelpers;
  doFetch: typeof fetch;
  watchUrl: string;
}

/**
 * 记忆观察、管理动作与诊断报告代理路由插件（V1.7 / M6 / M7）
 */
export async function registerMemoryRoutes(
  app: FastifyInstance,
  options: MemoryRouteOptions,
): Promise<void> {
  const { proxy, doFetch, watchUrl } = options;
  const { fetchWatch, proxyWatchGet, proxyWatchPost } = proxy;

  // 记忆系统中心：引擎列表、Jev 选型顾问与配置受控预览/生效
  app.get("/api/memory/systems", async (_request, reply) =>
    proxyWatchGet("/api/memory/systems", reply),
  );

  app.post("/api/memory/advisor", async (request, reply) =>
    proxyWatchPost("/api/memory/advisor", request.body, reply, 20_000),
  );

  app.post("/api/memory/config/preview", async (request, reply) =>
    proxyWatchPost("/api/memory/config/preview", request.body, reply),
  );

  app.post("/api/memory/config/apply", async (request, reply) =>
    proxyWatchPost("/api/memory/config/apply", request.body, reply, 30_000),
  );

  // 记忆面板读取：GET /api/memory 透传给 watch（instanceId 查询参数原样跟随）。
  app.get("/api/memory", async (request, reply) => {
    const query = (request.raw.url ?? "").split("?")[1] ?? "";
    return proxyWatchGet(`/api/memory${query ? `?${query}` : ""}`, reply);
  });

  app.post("/api/memory/archive", async (request, reply) =>
    proxyWatchPost("/api/memory/archive", request.body, reply),
  );

  app.post("/api/memory/restore", async (request, reply) =>
    proxyWatchPost("/api/memory/restore", request.body, reply),
  );

  app.post("/api/memory/purge", async (request, reply) =>
    proxyWatchPost("/api/memory/purge", request.body, reply),
  );

  // 记忆 FTS 索引重建（V1.7 优化动作；body 透传，watch 的 200/400/409/500 原样透传）。
  app.post("/api/memory/rebuild-index", async (request, reply) =>
    proxyWatchPost("/api/memory/rebuild-index", request.body, reply, 90_000),
  );

  // 记忆加密导出（PRD M6）：watch 返回 application/octet-stream，原样透传附件头。
  app.post("/api/memory/export", async (request, reply) => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}/api/memory/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    const raw = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const disposition = res.headers.get("content-disposition");
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw.toString("utf8")) as unknown);
      } catch {
        return reply.status(res.status).type(contentType).send(raw);
      }
    }
    if (disposition !== null) reply.header("content-disposition", disposition);
    return reply.type(contentType).send(raw);
  });

  // 记忆按需自检（memory-probe 单阶段；结果透传，无实例/未接线 → 503）。
  app.post("/api/memory/self-check", async (request, reply) =>
    proxyWatchPost("/api/memory/self-check", request.body, reply),
  );

  // 诊断报告（M7）：默认 Markdown，format=zip 时透传脱敏 ZIP；不可达 → 502。
  app.get("/api/diagnostics/report", async (request, reply) => {
    const format = (request.query as { format?: string } | undefined)?.format;
    const res = await fetchWatch(
      format === "zip" ? "/api/diagnostics/report?format=zip" : "/api/diagnostics/report",
    );
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = format === "zip" ? Buffer.from(await res.arrayBuffer()) : await res.text();
    if (!res.ok) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        parsed = { raw: typeof raw === "string" ? raw : raw.toString("utf8") };
      }
      return reply.status(res.status).send(parsed);
    }
    const disposition =
      res.headers.get("content-disposition") ??
      (format === "zip"
        ? 'attachment; filename="agent-butler-diagnostic.zip"'
        : 'attachment; filename="agent-butler-diagnostic.md"');
    return reply
      .type(format === "zip" ? "application/zip" : "text/markdown; charset=utf-8")
      .header("content-disposition", disposition)
      .send(raw);
  });

  app.get("/api/diagnostics/summary", async (_request, reply) => {
    const res = await fetchWatch("/api/diagnostics/summary");
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ error: "watch-invalid-response" })));
  });
}
