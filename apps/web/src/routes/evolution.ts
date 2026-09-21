import type { FastifyInstance } from "fastify";
import { CONTROL_API_SCHEMA_VERSION } from "@butler/contract";
import { isRecord, type ProxyHelpers } from "../proxy-helpers.js";

export interface EvolutionLedgerView {
  runId: string;
  updatedAt: string;
  instanceId: string | null;
  status: string;
  holdoutCount: number;
  baselineMetric?: number;
  candidateMetric?: number;
  delta?: number;
  conclusion: string;
  disposition: string;
}

export interface EvolutionApiView {
  watchReachable: boolean;
  connectionStatus:
    | "ready"
    | "watch-unreachable"
    | "watch-route-missing"
    | "watch-schema-mismatch"
    | "watch-version-mismatch";
  detail: string | null;
  schemaVersion: string | null;
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: EvolutionLedgerView[];
  hermes: {
    status: "ready" | "unavailable" | "unknown";
    root: string | null;
    detail: string;
  };
  endpointHealth: {
    status: "pass" | "fail" | "unknown";
    category: string;
    detail: string;
    checkedAt: string | null;
  };
  blocked: Array<{ category: string; detail: string; affectedRuns: string[] }>;
  tasks: unknown[];
  history: unknown[];
}

export function degradedEvolution(
  connectionStatus: Exclude<EvolutionApiView["connectionStatus"], "ready"> = "watch-unreachable",
  detail: string | null = "管家控制通道不可达",
): EvolutionApiView {
  return {
    watchReachable: false,
    connectionStatus,
    detail,
    schemaVersion: null,
    minHoldoutCount: 10,
    defaultDependencies: [],
    defaultEndpoint: "",
    ledger: [],
    hermes: { status: "unknown", root: null, detail: "尚未读取管家服务状态" },
    endpointHealth: {
      status: "unknown",
      category: "unknown",
      detail: "尚未执行带鉴权的 LLM 探针",
      checkedAt: null,
    },
    blocked: [],
    tasks: [],
    history: [],
  };
}

export function parseEvolutionStatus(
  value: unknown,
): Omit<EvolutionApiView, "watchReachable"> | null {
  if (
    !isRecord(value) ||
    typeof value["schemaVersion"] !== "string" ||
    typeof value["minHoldoutCount"] !== "number" ||
    !Number.isInteger(value["minHoldoutCount"]) ||
    !Array.isArray(value["defaultDependencies"]) ||
    !value["defaultDependencies"].every((item) => typeof item === "string") ||
    typeof value["defaultEndpoint"] !== "string" ||
    !Array.isArray(value["ledger"]) ||
    !isRecord(value["hermes"]) ||
    !isRecord(value["endpointHealth"]) ||
    !Array.isArray(value["blocked"]) ||
    !Array.isArray(value["tasks"]) ||
    !Array.isArray(value["history"])
  ) {
    return null;
  }
  const ledger = value["ledger"].filter(
    (item): item is EvolutionLedgerView =>
      isRecord(item) &&
      typeof item["runId"] === "string" &&
      typeof item["updatedAt"] === "string" &&
      (item["instanceId"] === null || typeof item["instanceId"] === "string") &&
      typeof item["status"] === "string" &&
      typeof item["holdoutCount"] === "number" &&
      typeof item["conclusion"] === "string" &&
      typeof item["disposition"] === "string",
  );
  if (ledger.length !== value["ledger"].length) return null;
  const hermes = value["hermes"];
  const endpointHealth = value["endpointHealth"];
  if (
    (hermes["status"] !== "ready" &&
      hermes["status"] !== "unavailable" &&
      hermes["status"] !== "unknown") ||
    !(typeof hermes["root"] === "string" || hermes["root"] === null) ||
    typeof hermes["detail"] !== "string" ||
    (endpointHealth["status"] !== "pass" &&
      endpointHealth["status"] !== "fail" &&
      endpointHealth["status"] !== "unknown") ||
    typeof endpointHealth["category"] !== "string" ||
    typeof endpointHealth["detail"] !== "string" ||
    !(typeof endpointHealth["checkedAt"] === "string" || endpointHealth["checkedAt"] === null)
  ) {
    return null;
  }
  const blocked = value["blocked"].filter(
    (item): item is EvolutionApiView["blocked"][number] =>
      isRecord(item) &&
      typeof item["category"] === "string" &&
      typeof item["detail"] === "string" &&
      Array.isArray(item["affectedRuns"]) &&
      item["affectedRuns"].every((runId) => typeof runId === "string"),
  );
  if (blocked.length !== value["blocked"].length) return null;
  return {
    connectionStatus: "ready",
    detail: null,
    schemaVersion: value["schemaVersion"],
    minHoldoutCount: value["minHoldoutCount"],
    defaultDependencies: value["defaultDependencies"] as string[],
    defaultEndpoint: value["defaultEndpoint"],
    ledger,
    hermes: {
      status: hermes["status"],
      root: hermes["root"],
      detail: hermes["detail"],
    },
    endpointHealth: {
      status: endpointHealth["status"],
      category: endpointHealth["category"],
      detail: endpointHealth["detail"],
      checkedAt: endpointHealth["checkedAt"],
    },
    blocked,
    tasks: value["tasks"],
    history: value["history"],
  };
}

export interface EvolutionRouteOptions {
  proxy: ProxyHelpers;
}

/**
 * 进化守门与改进工作台代理路由插件（Task 16）
 */
export async function registerEvolutionRoutes(
  app: FastifyInstance,
  options: EvolutionRouteOptions,
): Promise<void> {
  const { proxy } = options;
  const { fetchWatch, proxyWatchPost, proxyWatchGet } = proxy;

  const evolutionStatusHandler = async (): Promise<EvolutionApiView> => {
    const res = await fetchWatch("/api/evolution/status");
    if (res === null) return degradedEvolution("watch-unreachable", "管家控制通道不可达");
    if (res.status === 404) {
      return degradedEvolution(
        "watch-route-missing",
        "当前管家实例未提供进化状态接口，请同步部署管家服务",
      );
    }
    if (!res.ok) {
      return degradedEvolution(
        "watch-unreachable",
        `管家服务返回 HTTP ${String(res.status)}，无法读取进化状态`,
      );
    }
    try {
      const parsed = parseEvolutionStatus(await res.json());
      if (parsed === null) {
        return {
          ...degradedEvolution(
            "watch-schema-mismatch",
            "Watch 返回的进化状态不符合当前页面需要的 schema，请同步部署 Watch",
          ),
          watchReachable: true,
        };
      }
      if (parsed.schemaVersion !== CONTROL_API_SCHEMA_VERSION) {
        return {
          watchReachable: true,
          ...parsed,
          connectionStatus: "watch-version-mismatch",
          detail: `Web schema ${CONTROL_API_SCHEMA_VERSION} 与 Watch schema ${parsed.schemaVersion} 不一致`,
        };
      }
      return { watchReachable: true, ...parsed };
    } catch {
      return {
        ...degradedEvolution(
          "watch-schema-mismatch",
          "Watch 返回的进化状态无法解析，请同步部署 Watch",
        ),
        watchReachable: true,
      };
    }
  };

  app.get("/api/evolution", evolutionStatusHandler);
  // 对外保留与 Watch 一致的显式 status 路径，便于探针和运维脚本直接验收。
  app.get("/api/evolution/status", evolutionStatusHandler);

  for (const path of ["overview", "metrics", "failures", "datasets", "action-items"] as const) {
    app.get(`/api/evolution/${path}`, async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const params = new URLSearchParams();
      if (typeof query["instanceId"] === "string") {
        params.set("instanceId", query["instanceId"] as string);
      }
      if (typeof query["range"] === "string") {
        params.set("range", query["range"] as string);
      }
      return proxyWatchGet(
        `/api/evolution/${path}` + (params.size > 0 ? `?${params.toString()}` : ""),
        reply,
        30_000,
      );
    });
  }
  app.post("/api/evolution/analyze", async (request, reply) =>
    proxyWatchPost("/api/evolution/analyze", request.body, reply, 30_000),
  );
  app.post("/api/evolution/action-items/:id/recheck", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/action-items/${id}/recheck`, request.body, reply, 30_000);
  });

  app.get("/api/evolution/insights", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["instanceId"] === "string") {
      params.set("instanceId", query["instanceId"] as string);
    }
    if (typeof query["range"] === "string") {
      params.set("range", query["range"] as string);
    }
    return proxyWatchGet(
      "/api/evolution/insights" + (params.size > 0 ? "?" + params.toString() : ""),
      reply,
      30_000,
    );
  });
  app.post("/api/evolution/directions/:id/:action", async (request, reply) => {
    const params = request.params as { id?: string; action?: string };
    if (!["summarize", "confirm", "start"].includes(params.action ?? "")) {
      return reply.status(404).send({ error: "not-found" });
    }
    const id = encodeURIComponent(params.id ?? "");
    return proxyWatchPost(
      `/api/evolution/directions/${id}/${params.action}`,
      request.body,
      reply,
      70_000,
    );
  });

  // 外部协助 Hermes 改进工作台（与旧 self-evolution CLI 兼容并存）。
  app.get("/api/evolution/targets", async (_request, reply) =>
    proxyWatchGet("/api/evolution/targets", reply),
  );
  app.get("/api/evolution/proposals", async (_request, reply) =>
    proxyWatchGet("/api/evolution/proposals", reply),
  );
  app.post("/api/evolution/proposals", async (request, reply) =>
    proxyWatchPost("/api/evolution/proposals", request.body, reply, 30_000),
  );
  app.get("/api/evolution/proposals/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchGet(`/api/evolution/proposals/${id}`, reply);
  });

  app.post("/api/evolution/proposals/:id/validate", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/proposals/${id}/validate`, request.body, reply, 30_000);
  });
  app.post("/api/evolution/proposals/:id/apply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/proposals/${id}/apply`, request.body, reply, 30_000);
  });

  app.post("/api/evolution/diagnose", async (request, reply) =>
    proxyWatchPost("/api/evolution/diagnose", request.body, reply, 30_000),
  );

  app.post("/api/evolution/runs", async (request, reply) =>
    proxyWatchPost("/api/evolution/runs", request.body, reply, 70_000),
  );

  app.get("/api/evolution/runs/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/evolution/runs/${id}`, reply, 15_000);
  });

  app.post("/api/evolution/runs/:id/start", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/start`, request.body, reply, 30_000);
  });

  app.post("/api/evolution/preflight", async (request, reply) =>
    proxyWatchPost("/api/evolution/preflight", request.body, reply),
  );

  app.post("/api/evolution/runs/:id/evaluate", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/evaluate`, request.body, reply, 70_000);
  });

  app.post("/api/evolution/runs/:id/promote", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/promote`, request.body, reply, 30_000);
  });

  app.post("/api/evolution/runs/:id/cancel", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/cancel`, request.body, reply, 30_000);
  });

  app.post("/api/evolution/runs/:id/expand", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/expand`, request.body, reply);
  });

  app.post("/api/evolution/runs/:id/result", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/evolution/runs/${id}/result`, request.body, reply);
  });

  app.get("/api/evolution/ledger/:id/export", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    const res = await fetchWatch(`/api/evolution/ledger/${id}/export`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
    const raw = await res.text();
    if (!res.ok) {
      try {
        return reply.status(res.status).send(JSON.parse(raw) as unknown);
      } catch {
        return reply.status(res.status).send({ error: "watch-invalid-response" });
      }
    }
    const disposition = res.headers.get("content-disposition");
    if (disposition !== null) reply.header("content-disposition", disposition);
    return reply.type("text/markdown; charset=utf-8").send(raw);
  });
}
