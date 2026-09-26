import type { FastifyInstance, FastifyReply } from "fastify";
import { isOutboxState } from "@butler/contract";
import { isRecord, type ProxyHelpers } from "../proxy-helpers.js";

export interface DeliveryHistoryDayView {
  date: string;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface DeliveryHistoryView {
  reachable: boolean;
  days: number;
  retentionDays: number;
  items: DeliveryHistoryDayView[];
}

export interface GatewayRouteOptions {
  proxy: ProxyHelpers;
  doFetch: typeof fetch;
  gatewayUrl: string;
  fetchGateway: (path: string, timeoutMs?: number) => Promise<Response | null>;
  proxyGatewayPost: (
    path: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
  proxyGatewayPut: (
    path: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
  gatewayAuthHeaders: () => Record<string, string>;
  alertsFromGateway: () => Promise<unknown>;
  parseMessageStatus: (value: unknown) => unknown;
  parseMessageList: (value: unknown) => unknown;
  emptyMessageList: () => unknown;
  parseMessageOptimizationHistory: (value: unknown) => unknown;
  isMessageTaskView: (value: unknown) => boolean;
  isGatewayPatchView: (value: unknown) => boolean;
  isGatewayStatsView: (value: unknown) => boolean;
}

/**
 * 消息网关、通道目录与补丁代理路由插件（Task 15.2 / M1 / M4 / M5）
 */
export async function registerGatewayRoutes(
  app: FastifyInstance,
  options: GatewayRouteOptions,
): Promise<void> {
  const {
    proxy,
    doFetch,
    gatewayUrl,
    fetchGateway,
    proxyGatewayPost,
    proxyGatewayPut,
    gatewayAuthHeaders,
    alertsFromGateway,
    parseMessageStatus,
    parseMessageList,
    emptyMessageList,
    parseMessageOptimizationHistory,
    isMessageTaskView,
    isGatewayPatchView,
    isGatewayStatsView,
  } = options;
  const { fetchWatch, proxyWatchPost } = proxy;

  // 告警代理：网关不可达/响应异常一律 200 + 降级载荷
  app.get("/api/alerts", async () => alertsFromGateway());
  app.post("/api/alerts/read-all", async (request, reply) =>
    proxyGatewayPost("/api/alerts/read-all", request.body, reply),
  );
  app.post("/api/alerts/:id/read", async (request, reply) => {
    const rawId = (request.params as Record<string, unknown>)["id"];
    if (typeof rawId !== "string" || !/^\d+$/.test(rawId)) {
      return reply.status(400).send({ error: "invalid-alert-id" });
    }
    return proxyGatewayPost(`/api/alerts/${encodeURIComponent(rawId)}/read`, request.body, reply);
  });

  // 消息网关状态轻量代理
  app.get("/api/messages/status", async () => {
    const response = await fetchGateway("/api/messages/status");
    if (response === null || !response.ok) return { reachable: false, status: null };
    try {
      const status = parseMessageStatus(await response.json());
      return { reachable: status !== null, status };
    } catch {
      return { reachable: false, status: null };
    }
  });

  // 通道目录代理
  app.get("/api/messages/channels", async (_request, reply) => {
    const res = await fetchGateway("/api/messages/channels");
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ channels: [] })));
  });
  app.post("/api/messages/reconnect", async (request, reply) =>
    proxyGatewayPost("/api/messages/reconnect", request.body, reply),
  );

  // 消息链路一键接管切换
  app.post("/api/messages/relay", async (request, reply) =>
    proxyGatewayPost("/api/messages/relay", request.body, reply),
  );

  // 死信重投
  app.post("/api/messages/:messageId/redeliver", async (request, reply) => {
    const rawMessageId = (request.params as Record<string, unknown>)["messageId"];
    if (typeof rawMessageId !== "string" || rawMessageId.trim() === "") {
      return reply.status(400).send({ error: "messageId is required" });
    }
    return proxyGatewayPost(
      `/api/messages/${encodeURIComponent(rawMessageId.trim())}/redeliver`,
      request.body ?? {},
      reply,
    );
  });

  // 立即发送（跳过节奏与免打扰等待）
  app.post("/api/messages/:messageId/expedite", async (request, reply) => {
    const rawMessageId = (request.params as Record<string, unknown>)["messageId"];
    if (typeof rawMessageId !== "string" || rawMessageId.trim() === "") {
      return reply.status(400).send({ error: "messageId is required" });
    }
    return proxyGatewayPost(
      `/api/messages/${encodeURIComponent(rawMessageId.trim())}/expedite`,
      request.body ?? {},
      reply,
    );
  });

  // 结果未知结案
  app.post("/api/messages/:messageId/resolve", async (request, reply) => {
    const rawMessageId = (request.params as Record<string, unknown>)["messageId"];
    if (typeof rawMessageId !== "string" || rawMessageId.trim() === "") {
      return reply.status(400).send({ error: "messageId is required" });
    }
    return proxyGatewayPost(
      `/api/messages/${encodeURIComponent(rawMessageId.trim())}/resolve`,
      request.body,
      reply,
    );
  });

  // 免打扰规则代理
  app.get("/api/messages/dnd", async (_request, reply) => {
    const res = await fetchGateway("/api/messages/dnd");
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ items: [] })));
  });
  app.put("/api/messages/dnd/:scope/:scopeKey", async (request, reply) => {
    const params = request.params as Record<string, string>;
    return proxyGatewayPut(
      `/api/messages/dnd/${encodeURIComponent(params["scope"] ?? "")}/${encodeURIComponent(params["scopeKey"] ?? "")}`,
      request.body,
      reply,
    );
  });
  app.delete("/api/messages/dnd/:ruleId", async (request, reply) => {
    const rawRuleId = String((request.params as Record<string, string>)["ruleId"] ?? "");
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/messages/dnd/${encodeURIComponent(rawRuleId)}`, {
        method: "DELETE",
        headers: gatewayAuthHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return reply.status(502).send({ error: "gateway-unreachable" });
    }
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });

  // 求助提示词转发给智能体
  app.post("/api/agent-message", async (request, reply) => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/agent-message`, {
        method: "POST",
        headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(200_000),
      });
    } catch {
      return reply.status(502).send({ error: "gateway-unreachable" });
    }
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
  app.get("/api/agent-message/status", async (_request, reply) => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/agent-message/status`, {
        headers: gatewayAuthHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return reply.status(502).send({ ready: false, error: "gateway-unreachable" });
    }
    const raw = await res.text();
    let parsed: unknown = { ready: false };
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { ready: false, raw };
      }
    }
    return reply.status(res.status).send(parsed);
  });

  // 提示词增强接口代理透传
  app.post("/api/messages/prompt-enhance", async (request, reply) => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/messages/prompt-enhance`, {
        method: "POST",
        headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(200_000),
      });
    } catch {
      return reply.status(502).send({ error: "gateway-unreachable" });
    }
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

  // Bot 名册与 Profile 代理
  app.get("/api/bots", async (_request, reply) => {
    const res = await fetchGateway("/api/bots", 5_000);
    if (!res) {
      return reply.status(502).send({ ok: false, error: "gateway-unreachable" });
    }
    return reply.status(res.status).send(await res.json().catch(() => ({ ok: false })));
  });

  // Bot 模板市场代理
  app.get("/api/bots/templates", async (_request, reply) => {
    const res = await fetchGateway("/api/bots/templates", 5_000);
    if (!res) {
      return reply.status(502).send({ ok: false, error: "gateway-unreachable" });
    }
    return reply.status(res.status).send(await res.json().catch(() => ({ ok: false })));
  });

  app.post("/api/bots/templates/:templateId/instantiate", async (request, reply) => {
    const templateId = String((request.params as Record<string, string>)["templateId"] ?? "");
    return proxyGatewayPost(`/api/bots/templates/${encodeURIComponent(templateId)}/instantiate`, request.body, reply);
  });

  app.post("/api/bots", async (request, reply) => {
    return proxyGatewayPost("/api/bots", request.body, reply);
  });

  app.delete("/api/bots/:id", async (request, reply) => {
    const rawId = String((request.params as Record<string, string>)["id"] ?? "");
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/bots/${encodeURIComponent(rawId)}`, {
        method: "DELETE",
        headers: gatewayAuthHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return reply.status(502).send({ error: "gateway-unreachable" });
    }
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });

  // Jev System One 辅助端点透传代理
  app.post("/api/bots/dispatch", async (request, reply) => {
    return proxyGatewayPost("/api/bots/dispatch", request.body, reply, 20_000);
  });

  app.post("/api/bots/handoff", async (request, reply) => {
    return proxyGatewayPost("/api/bots/handoff", request.body, reply, 20_000);
  });

  app.post("/api/bots/compliance", async (request, reply) => {
    return proxyGatewayPost("/api/bots/compliance", request.body, reply, 20_000);
  });

  // 通道通用扫码登录代理
  app.post("/api/messages/channels/:channel/login/start", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPost(`/api/messages/channels/${encodeURIComponent(channel)}/login/start`, request.body, reply);
  });
  app.get("/api/messages/channels/:channel/login/status", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const sessionId = query["sessionId"];
    if (sessionId === undefined || sessionId.trim() === "") {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const res = await fetchGateway(
      `/api/messages/channels/${encodeURIComponent(channel)}/login/status?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });
  app.post("/api/messages/channels/:channel/login/cancel", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPost(`/api/messages/channels/${encodeURIComponent(channel)}/login/cancel`, request.body, reply);
  });

  // 微信登录兼容路由
  app.post("/api/messages/channels/weixin/login/start", async (request, reply) =>
    proxyGatewayPost("/api/messages/channels/weixin/login/start", request.body, reply),
  );
  app.get("/api/messages/channels/weixin/login/status", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const sessionId = query["sessionId"];
    if (sessionId === undefined || sessionId.trim() === "") {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const res = await fetchGateway(
      `/api/messages/channels/weixin/login/status?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });
  app.post("/api/messages/channels/weixin/login/cancel", async (request, reply) =>
    proxyGatewayPost("/api/messages/channels/weixin/login/cancel", request.body, reply),
  );

  // 通道启停与首次接入代理
  app.get("/api/messages/channels/:channel/schema", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    const res = await fetchGateway(`/api/messages/channels/${encodeURIComponent(channel)}/schema`);
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({})));
  });
  app.put("/api/messages/channels/:channel/config", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPut(
      `/api/messages/channels/${encodeURIComponent(channel)}/config`,
      request.body,
      reply,
    );
  });
  app.post("/api/messages/channels/:channel/enable", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPost(
      `/api/messages/channels/${encodeURIComponent(channel)}/enable`,
      request.body,
      reply,
    );
  });
  app.post("/api/messages/channels/:channel/disable", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPost(
      `/api/messages/channels/${encodeURIComponent(channel)}/disable`,
      request.body,
      reply,
    );
  });
  app.post("/api/messages/channels/:channel/ping", async (request, reply) => {
    const channel = (request.params as Record<string, unknown>)["channel"];
    if (typeof channel !== "string" || channel.trim() === "") {
      return reply.status(400).send({ error: "channel is required" });
    }
    return proxyGatewayPost(
      `/api/messages/channels/${encodeURIComponent(channel)}/ping`,
      request.body,
      reply,
    );
  });

  const gatewayStatsFromWatch = async (): Promise<{
    watchOk: boolean;
    stats: unknown;
  }> => {
    const res = await fetchWatch("/api/gateway/stats");
    if (res === null || !res.ok) return { watchOk: false, stats: null };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const stats = body["stats"];
      return {
        watchOk: true,
        stats: isGatewayStatsView(stats) ? stats : null,
      };
    } catch {
      return { watchOk: true, stats: null };
    }
  };

  const gatewayPatchesFromWatch = async (): Promise<{
    watchOk: boolean;
    patches: unknown[];
  }> => {
    const res = await fetchWatch("/api/gateway/patches");
    if (res === null || !res.ok) return { watchOk: false, patches: [] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return {
        watchOk: true,
        patches: Array.isArray(body["patches"]) ? body["patches"].filter(isGatewayPatchView) : [],
      };
    } catch {
      return { watchOk: true, patches: [] };
    }
  };

  // 消息网关页一次聚合
  app.get("/api/gateway", async () => {
    const [stats, patches, alerts] = await Promise.all([
      gatewayStatsFromWatch(),
      gatewayPatchesFromWatch(),
      alertsFromGateway(),
    ]);
    return {
      watchReachable: stats.watchOk || patches.watchOk,
      rateLimit: stats.stats,
      patches: patches.patches,
      alerts,
    };
  });

  // Message data-plane overview
  app.get("/api/messages/overview", async (request) => {
    const query = request.query as Record<string, unknown>;
    const rawLimit = Number(query["limit"]);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 60;
    const rawState = typeof query["state"] === "string" ? query["state"] : undefined;
    const stateFilter = rawState !== undefined && isOutboxState(rawState) ? rawState : undefined;
    const [statusResponse, messagesResponse] = await Promise.all([
      fetchGateway("/api/messages/status"),
      fetchGateway(`/api/messages?limit=${String(limit)}${stateFilter ? `&state=${encodeURIComponent(stateFilter)}` : ""}`),
    ]);

    let status: unknown = null;
    let messages: unknown = null;
    const degraded: string[] = [];
    if (statusResponse?.ok === true) {
      try {
        status = parseMessageStatus(await statusResponse.json());
      } catch {
        status = null;
      }
    }
    if (status === null) degraded.push("messages:status-unavailable");

    if (messagesResponse?.ok === true) {
      try {
        messages = parseMessageList(await messagesResponse.json());
      } catch {
        messages = null;
      }
    }
    if (messages === null) degraded.push("messages:outbox-unavailable");

    return {
      reachable: statusResponse !== null || messagesResponse !== null,
      status,
      messages: messages ?? emptyMessageList(),
      degraded,
    };
  });

  app.get("/api/messages/tasks/:runId", async (request, reply) => {
    const rawRunId = (request.params as { runId?: string })["runId"] ?? "";
    if (rawRunId.trim() === "") return reply.status(400).send({ error: "runId-required" });
    const response = await fetchGateway(`/api/messages/tasks/${encodeURIComponent(rawRunId)}`);
    if (response === null) return reply.status(502).send({ error: "gateway-unreachable" });
    if (response.status === 404) return reply.status(404).send({ error: "task-not-found" });
    if (!response.ok) return reply.status(502).send({ error: "gateway-unavailable" });
    try {
      const body = await response.json();
      if (!isMessageTaskView(body)) {
        return reply.status(502).send({ error: "gateway-invalid-response" });
      }
      return body;
    } catch {
      return reply.status(502).send({ error: "gateway-invalid-response" });
    }
  });

  app.get("/api/messages/optimization-history", async (request) => {
    const query = request.query as Record<string, unknown>;
    const rawLimit = Number(query["limit"]);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;
    const response = await fetchGateway(`/api/messages/optimization-history?limit=${String(limit)}`);
    if (response === null || !response.ok) {
      return { reachable: false, items: [] };
    }
    try {
      return parseMessageOptimizationHistory(await response.json()) ?? { reachable: false, items: [] };
    } catch {
      return { reachable: false, items: [] };
    }
  });

  app.get("/api/messages/metrics", async (request) => {
    const query = request.query as Record<string, unknown>;
    const parsed = Number(query["days"] ?? "30");
    const days = Number.isFinite(parsed) ? Math.max(1, Math.min(365, Math.floor(parsed))) : 30;
    const response = await fetchGateway(`/api/messages/metrics?days=${String(days)}`);
    if (response === null || !response.ok) {
      return {
        reachable: false,
        days,
        retentionDays: 365,
        channels: [],
        daily: [],
        latency: { p50Ms: null, p95Ms: null, samples: 0, unknown: 0 },
        retries: null,
      };
    }
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const isValidChannelRow = (item: unknown): item is Record<string, number | string> => {
        if (item === null || typeof item !== "object") return false;
        const row = item as Record<string, unknown>;
        return (
          typeof row["channel"] === "string" &&
          typeof row["delivered"] === "number" &&
          typeof row["failed"] === "number" &&
          typeof row["uncertain"] === "number" &&
          (row["p50LatencyMs"] === undefined || row["p50LatencyMs"] === null || typeof row["p50LatencyMs"] === "number") &&
          (row["p95LatencyMs"] === undefined || row["p95LatencyMs"] === null || typeof row["p95LatencyMs"] === "number") &&
          (row["latencySamples"] === undefined || typeof row["latencySamples"] === "number") &&
          (row["retries"] === undefined || typeof row["retries"] === "number")
        );
      };
      const latency = body["latency"];
      return {
        reachable: true,
        days: typeof body["days"] === "number" ? body["days"] : days,
        retentionDays: typeof body["retentionDays"] === "number" ? body["retentionDays"] : 365,
        channels: Array.isArray(body["channels"]) ? body["channels"].filter(isValidChannelRow) : [],
        daily: Array.isArray(body["daily"]) ? body["daily"].filter(isValidChannelRow) : [],
        latency:
          isRecord(latency) &&
          (latency["p50Ms"] === null || typeof latency["p50Ms"] === "number") &&
          (latency["p95Ms"] === null || typeof latency["p95Ms"] === "number") &&
          typeof latency["samples"] === "number" &&
          typeof latency["unknown"] === "number"
            ? latency
            : { p50Ms: null, p95Ms: null, samples: 0, unknown: 0 },
        retries: typeof body["retries"] === "number" ? body["retries"] : null,
      };
    } catch {
      return {
        reachable: false,
        days,
        retentionDays: 365,
        channels: [],
        daily: [],
        latency: { p50Ms: null, p95Ms: null, samples: 0, unknown: 0 },
        retries: null,
      };
    }
  });

  app.get("/api/messages/delivery-history", async (request): Promise<DeliveryHistoryView> => {
    const query = request.query as Record<string, unknown>;
    const parsed = Number(query["days"] ?? "7");
    const days = Number.isFinite(parsed) ? Math.max(1, Math.min(365, Math.floor(parsed))) : 7;
    const response = await fetchGateway(`/api/messages/delivery-history?days=${String(days)}`);
    if (response === null || !response.ok) {
      return { reachable: false, days, retentionDays: 365, items: [] };
    }
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const items = Array.isArray(body["items"])
        ? body["items"].filter((item): item is DeliveryHistoryDayView => {
            if (item === null || typeof item !== "object") return false;
            const row = item as Record<string, unknown>;
            return (
              typeof row["date"] === "string" &&
              typeof row["delivered"] === "number" &&
              typeof row["failed"] === "number" &&
              typeof row["uncertain"] === "number"
            );
          })
        : [];
      return {
        reachable: true,
        days: typeof body["days"] === "number" ? body["days"] : days,
        retentionDays: typeof body["retentionDays"] === "number" ? body["retentionDays"] : 365,
        items,
      };
    } catch {
      return { reachable: false, days, retentionDays: 365, items: [] };
    }
  });

  // 单条消息明细代理
  app.get("/api/messages/:messageId", async (request, reply) => {
    const rawMessageId = (request.params as Record<string, unknown>)["messageId"];
    if (typeof rawMessageId !== "string" || rawMessageId.trim() === "") {
      return reply.status(400).send({ error: "messageId is required" });
    }
    const res = await fetchGateway(`/api/messages/${encodeURIComponent(rawMessageId.trim())}`);
    if (res === null) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ error: "gateway-invalid-response" })));
  });

  app.post("/api/gateway/patches/:id/apply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/apply`, request.body, reply);
  });

  app.post("/api/gateway/patches/:id/reapply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/reapply`, request.body, reply);
  });

  app.post("/api/gateway/patches/:id/detect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/detect`, request.body, reply);
  });

  app.post("/api/gateway/patches/:id/preview", async (request, reply) => {
    const id = encodeURIComponent((request.params as Record<string, string>)["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/preview`, request.body, reply);
  });
}
