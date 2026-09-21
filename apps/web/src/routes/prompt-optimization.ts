import type { FastifyInstance } from "fastify";
import { isRecord, isNonNegativeNumber, type ProxyHelpers } from "../proxy-helpers.js";

/** M5 切片 1/2：提示词 Registry 与候选评估视图（不与消息热路径共享状态）。 */
export interface PromptOptimizationGateApiView {
  status: string;
  detail: string;
  checkedAt: string;
}

export interface PromptOptimizationTargetApiView {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: string;
  editableSections: string[];
  protectedClauseCount: number;
  protectedSha256: string;
  reloadMode: string;
  activeVersion: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
  gate: PromptOptimizationGateApiView;
}

export interface PromptOptimizationApiView {
  watchReachable: boolean;
  targets: PromptOptimizationTargetApiView[];
}

export function degradedPromptOptimization(): PromptOptimizationApiView {
  return { watchReachable: false, targets: [] };
}

export function parsePromptOptimization(
  value: unknown,
): Omit<PromptOptimizationApiView, "watchReachable"> | null {
  if (!isRecord(value) || !Array.isArray(value["targets"])) return null;
  const targets: PromptOptimizationTargetApiView[] = [];
  for (const item of value["targets"]) {
    if (
      !isRecord(item) ||
      typeof item["targetId"] !== "string" ||
      typeof item["instanceId"] !== "string" ||
      typeof item["frameworkId"] !== "string" ||
      typeof item["sourcePath"] !== "string" ||
      typeof item["format"] !== "string" ||
      !Array.isArray(item["editableSections"]) ||
      !item["editableSections"].every(
        (section): section is string => typeof section === "string",
      ) ||
      !isNonNegativeNumber(item["protectedClauseCount"]) ||
      typeof item["protectedSha256"] !== "string" ||
      typeof item["reloadMode"] !== "string" ||
      typeof item["activeVersion"] !== "string" ||
      typeof item["activeSha256"] !== "string" ||
      typeof item["createdAt"] !== "string" ||
      typeof item["updatedAt"] !== "string" ||
      !isRecord(item["gate"]) ||
      typeof item["gate"]["status"] !== "string" ||
      typeof item["gate"]["detail"] !== "string" ||
      typeof item["gate"]["checkedAt"] !== "string"
    ) {
      return null;
    }
    targets.push({
      targetId: item["targetId"],
      instanceId: item["instanceId"],
      frameworkId: item["frameworkId"],
      sourcePath: item["sourcePath"],
      format: item["format"],
      editableSections: item["editableSections"],
      protectedClauseCount: item["protectedClauseCount"],
      protectedSha256: item["protectedSha256"],
      reloadMode: item["reloadMode"],
      activeVersion: item["activeVersion"],
      activeSha256: item["activeSha256"],
      createdAt: item["createdAt"],
      updatedAt: item["updatedAt"],
      gate: {
        status: item["gate"]["status"],
        detail: item["gate"]["detail"],
        checkedAt: item["gate"]["checkedAt"],
      },
    });
  }
  return { targets };
}

export interface PromptOptimizationRouteOptions {
  proxy: ProxyHelpers;
}

/**
 * 提示词优化与候选评估代理路由插件（M5 切片 1/2）
 */
export async function registerPromptOptimizationRoutes(
  app: FastifyInstance,
  options: PromptOptimizationRouteOptions,
): Promise<void> {
  const { proxy } = options;
  const { fetchWatch, proxyWatchPost } = proxy;

  const promptOptimizationFromWatch = async (): Promise<PromptOptimizationApiView> => {
    const res = await fetchWatch("/api/prompt-optimization/targets");
    if (res === null || !res.ok) return degradedPromptOptimization();
    try {
      const parsed = parsePromptOptimization(await res.json());
      return parsed === null ? degradedPromptOptimization() : { watchReachable: true, ...parsed };
    } catch {
      return degradedPromptOptimization();
    }
  };

  app.get("/api/prompt-optimization", async () => promptOptimizationFromWatch());
  app.get("/api/prompt-optimization/targets", async () => promptOptimizationFromWatch());

  app.get("/api/prompt-optimization/active/:targetId", async (request, reply) => {
    const targetId = encodeURIComponent(
      (request.params as { targetId?: string })["targetId"] ?? "",
    );
    const res = await fetchWatch(`/api/prompt-optimization/active/${targetId}`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw) as unknown);
      } catch {
        return reply.status(res.status).send({ error: "watch-invalid-response" });
      }
    }
    try {
      return reply.send(JSON.parse(raw) as unknown);
    } catch {
      return reply.status(502).send({ error: "watch-invalid-response" });
    }
  });

  app.get("/api/prompt-optimization/candidates", async (request) => {
    const targetId = (request.query as Record<string, unknown>)["targetId"];
    const suffix =
      typeof targetId === "string" && targetId !== ""
        ? `?targetId=${encodeURIComponent(targetId)}`
        : "";
    const res = await fetchWatch(`/api/prompt-optimization/candidates${suffix}`);
    if (res === null || !res.ok) {
      return { watchReachable: false, candidates: [] };
    }
    try {
      const parsed = (await res.json()) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed["candidates"])) {
        return { watchReachable: false, candidates: [] };
      }
      return { watchReachable: true, candidates: parsed["candidates"] };
    } catch {
      return { watchReachable: false, candidates: [] };
    }
  });

  app.post("/api/prompt-optimization/candidates", async (request, reply) =>
    proxyWatchPost("/api/prompt-optimization/candidates", request.body, reply),
  );

  app.get("/api/prompt-optimization/candidates/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    const res = await fetchWatch(`/api/prompt-optimization/candidates/${id}`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw) as unknown);
      } catch {
        return reply.status(res.status).send({ error: "watch-invalid-response" });
      }
    }
    try {
      return reply.send(JSON.parse(raw) as unknown);
    } catch {
      return reply.status(502).send({ error: "watch-invalid-response" });
    }
  });

  app.post("/api/prompt-optimization/candidates/:id/evaluate", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(
      `/api/prompt-optimization/candidates/${id}/evaluate`,
      request.body,
      reply,
    );
  });

  app.post("/api/prompt-optimization/candidates/:id/promote", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(
      `/api/prompt-optimization/candidates/${id}/promote`,
      request.body,
      reply,
    );
  });

  app.get("/api/prompt-optimization/candidates/:id/report", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    const res = await fetchWatch(`/api/prompt-optimization/candidates/${id}/report`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw) as unknown);
      } catch {
        return reply.status(res.status).send({ error: "watch-invalid-response" });
      }
    }
    try {
      return reply.send(JSON.parse(raw) as unknown);
    } catch {
      return reply.status(502).send({ error: "watch-invalid-response" });
    }
  });

  app.get("/api/prompt-optimization/promptfoo/suites", async (_request, reply) => {
    const res = await fetchWatch("/api/prompt-optimization/promptfoo/suites");
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw) as unknown);
      } catch {
        return reply.status(res.status).send({ error: "watch-invalid-response" });
      }
    }
    try {
      return reply.send(JSON.parse(raw) as unknown);
    } catch {
      return reply.status(502).send({ error: "watch-invalid-response" });
    }
  });

  app.post("/api/prompt-optimization/promptfoo/evaluate", async (request, reply) => {
    return proxyWatchPost(
      "/api/prompt-optimization/promptfoo/evaluate",
      request.body,
      reply,
      120_000,
    );
  });

  app.post("/api/prompt-optimization/promptfoo/optimize", async (request, reply) => {
    return proxyWatchPost(
      "/api/prompt-optimization/promptfoo/optimize",
      request.body,
      reply,
      120_000,
    );
  });
}
