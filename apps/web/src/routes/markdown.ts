import type { FastifyInstance } from "fastify";
import type { ProxyHelpers } from "../proxy-helpers.js";

/**
 * 核心 Markdown 文件代理路由
 */
export async function registerMarkdownRoutes(
  app: FastifyInstance,
  proxy: ProxyHelpers,
): Promise<void> {
  const { fetchWatch, proxyWatchPost, proxyWatchGet } = proxy;

  app.get("/api/markdown/files", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["instanceId"] === "string" && query["instanceId"].trim() !== "") {
      params.set("instanceId", query["instanceId"].trim());
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return proxyWatchGet(`/api/markdown/files${suffix}`, reply);
  });

  app.get("/api/markdown/files/:fileId", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    return proxyWatchGet(`/api/markdown/files/${id}`, reply);
  });

  app.post("/api/markdown/files/:fileId/preview", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    return proxyWatchPost(`/api/markdown/files/${id}/preview`, request.body, reply, 15_000);
  });

  app.post("/api/markdown/files/:fileId/apply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    return proxyWatchPost(`/api/markdown/files/${id}/apply`, request.body, reply, 30_000);
  });

  app.get("/api/markdown/files/:fileId/revisions", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    return proxyWatchGet(`/api/markdown/files/${id}/revisions`, reply);
  });

  app.post("/api/markdown/files/:fileId/backup", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    return proxyWatchPost(`/api/markdown/files/${id}/backup`, request.body, reply, 15_000);
  });

  app.post("/api/markdown/files/:fileId/revisions/:revisionId/restore", async (request, reply) => {
    const params = request.params as { fileId?: string; revisionId?: string };
    return proxyWatchPost(
      `/api/markdown/files/${encodeURIComponent(params.fileId ?? "")}/revisions/${encodeURIComponent(params.revisionId ?? "")}/restore`,
      request.body,
      reply,
      30_000,
    );
  });

  app.get("/api/markdown/files/:fileId/download", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    const res = await fetchWatch(`/api/markdown/files/${id}/download`, 20_000);
    if (res === null) {
      return reply.status(502).send({
        error: "watch-unreachable",
        nextStep: "确认管家服务正在运行后重试。",
      });
    }
    const raw = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw.toString("utf8")) as unknown);
      } catch {
        return reply.status(res.status).send({
          error: "markdown-download-failed",
          nextStep: "重新读取文件后重试。",
        });
      }
    }
    const contentType = res.headers.get("content-type") ?? "text/markdown; charset=utf-8";
    const disposition = res.headers.get("content-disposition");
    if (disposition !== null) reply.header("content-disposition", disposition);
    return reply.type(contentType).send(raw);
  });
}
