/**
 * butler-web Fastify 装配入口（ENG-01）：常量、安全头与 createWebServer。
 * 载荷解析见 api-parsers.ts，视图类型见 api-views.ts，鉴权纯函数见 http-auth.ts。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONTROL_API_SCHEMA_VERSION, CONTRACT_VERSION } from "@butler/contract";
import { resolveButlerHome, SqliteStore } from "@butler/core";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { recentEventsAscending, selectNewEvents } from "./events-pump.js";
import { OllamaUsageStore } from "./ollama-usage-store.js";
import { createProxyHelpers } from "./proxy-helpers.js";
import { registerRateLimiting } from "./rate-limiter.js";
import { registerBackupsRoutes } from "./routes/backups.js";
import { registerEvolutionRoutes } from "./routes/evolution.js";
import { registerGatewayRoutes } from "./routes/gateway.js";
import { registerLlmRoutes } from "./routes/llm.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerMarkdownRoutes } from "./routes/markdown.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerOllamaRoutes } from "./routes/ollama.js";
import { registerPromptOptimizationRoutes } from "./routes/prompt-optimization.js";
import { registerRecoveryRoutes } from "./routes/recovery.js";
import { registerScheduledTasksRoutes } from "./routes/scheduled-tasks.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerTrustLayerRoutes } from "./routes/trust-layer.js";
import { registerUpgradeRoutes } from "./routes/upgrade.js";
import {
  extractRequestTicket,
  extractRequestToken,
  isLoopbackConnection,
  isTrustedOrigin,
  pathOf,
  tokensMatch,
  WS_TICKET_TTL_MS,
} from "./http-auth.js";
import {
  clampLimit,
  defaultUiDist,
  degradedAlerts,
  degradedSkills,
  emptyMessageList,
  inspectionDailyMetricsHistory,
  isGatewayPatchView,
  isGatewayStatsView,
  isLoopback,
  isMessageTaskView,
  latestInspectionsPerInstance,
  openOllamaUsageStore,
  openStore,
  parseAlertsView,
  parseMessageList,
  parseMessageOptimizationHistory,
  parseMessageStatus,
  parseSkillsStatus,
  probeServiceHealth,
  readBundleVersion,
  readPositiveDuration,
  toInstanceViews,
  type AlertsView,
} from "./api-parsers.js";
import type {
  InstanceApiView,
  LatestInspectionView,
  MessageStatusView,
} from "./api-views.js";

export * from "./api-views.js";
export {
  inspectionDailyHistory,
  inspectionDailyMetricsHistory,
  isLoopback,
  latestInspectionsPerInstance,
  type InspectionDayPoint,
  type RemoteServiceHealth,
} from "./api-parsers.js";

export const WEB_VERSION = `web@1.0.0+${CONTRACT_VERSION}`;

/** 告警网关默认基址（butler-gateway 的固定回环端口）。 */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7532";

/** watch HTTP 控制通道默认基址（butler-watch 的固定回环端口）。 */
export const DEFAULT_WATCH_URL = "http://127.0.0.1:7533";

/** 本地 Ollama 服务默认基址（容器内 http://ollama:11434，宿主直跑 127.0.0.1:11434）。 */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface WebServerOptions {
  /** Butler 主目录；缺省 resolveButlerHome()（env BUTLER_HOME 优先）。 */
  home?: string;
  /** 告警网关基址；缺省 env BUTLER_GATEWAY_URL 或 http://127.0.0.1:7532。 */
  gatewayUrl?: string;
  /** watch 控制通道基址；缺省 env BUTLER_WATCH_URL 或 http://127.0.0.1:7533。 */
  watchUrl?: string;
  /** watch 控制通道代理使用的 fetch；缺省全局 fetch（测试可注入 fake）。 */
  fetchImpl?: typeof fetch;
  /** SPA 静态资源目录；缺省相对 apps/web 解析 ../../ui/dist。 */
  uiDist?: string;
  /**
   * 访问口令；缺省读 env BUTLER_ACCESS_TOKEN。
   * 为空串表示显式关闭口令校验（仅回环监听时允许，测试与本地免密场景使用）。
   */
  accessToken?: string;
  /**
   * 宿主机实际发布给浏览器的地址。Docker 容器内通常监听 0.0.0.0，
   * 但宿主机可能只发布到 127.0.0.1；安全基线必须使用这个地址。
   */
  publishHost?: string;
  /** 本地 Ollama 引擎基址；缺省 env BUTLER_OLLAMA_URL 或 http://127.0.0.1:11434。 */
  ollamaUrl?: string;
  /** Ollama 用量存储（测试显式注入用；生产缺省读 home/data/ollama_usage.db）。 */
  ollamaUsageStore?: OllamaUsageStore | null;
  /** updater 控制通道基址；缺省 env BUTLER_UPDATER_URL 或 http://butler-updater:7540。 */
  updaterUrl?: string;
  /** updater 控制通道口令；缺省 BUTLER_UPDATER_ACCESS_TOKEN || BUTLER_INTERNAL_TOKEN || BUTLER_ACCESS_TOKEN。 */
  updaterToken?: string;
}

/** 会改变状态的请求方法；只有它们需要校验来源。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_EXEMPT_PATHS = new Set(["/api/health"]);
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};


export function createWebServer(options: WebServerOptions = {}): FastifyInstance {
  const home = options.home ?? resolveButlerHome();
  const gatewayUrl = options.gatewayUrl ?? process.env["BUTLER_GATEWAY_URL"] ?? DEFAULT_GATEWAY_URL;
  const watchUrl = options.watchUrl ?? process.env["BUTLER_WATCH_URL"] ?? DEFAULT_WATCH_URL;
  const ollamaUrl = options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? DEFAULT_OLLAMA_URL;
  const updaterUrl =
    options.updaterUrl ?? (process.env["BUTLER_UPDATER_URL"]?.trim() || "http://butler-updater:7540");
  const updaterToken = (
    options.updaterToken ??
    (process.env["BUTLER_UPDATER_ACCESS_TOKEN"] ||
      process.env["BUTLER_INTERNAL_TOKEN"] ||
      process.env["BUTLER_ACCESS_TOKEN"] ||
      "")
  ).trim();
  const doFetch = options.fetchImpl ?? fetch;
  const uiDist = path.resolve(options.uiDist ?? defaultUiDist());
  const bundleVersion = readBundleVersion(uiDist);
  const listenHost = process.env["BUTLER_WEB_HOST"]?.trim() || "127.0.0.1";
  const publishHost =
    options.publishHost?.trim() || process.env["BUTLER_WEB_PUBLISH_HOST"]?.trim() || listenHost;
  const accessToken = (options.accessToken ?? process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();

  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024, // 100MB 允许本地知识库/笔记库与文档批量上传
  });
  let store = openStore(home);
  let ollamaUsageStore =
    options.ollamaUsageStore !== undefined
      ? options.ollamaUsageStore
      : openOllamaUsageStore(home);

  // /ws 轮询定时器登记：连接断开或服务关闭时统一清理。
  const wsTimers = new Set<ReturnType<typeof setInterval>>();

  // WS 握手一次性 ticket：前端先 POST /api/ws-ticket 换短时凭据，再以 /ws?ticket=
  // 握手，避免真实访问口令出现在 URL（会进浏览器历史/代理/访问日志）。
  // 60 秒有效、一次性；未配置口令时 ticket 链路同样放行（便利通道语义不变）。
  const wsTickets = new Map<string, number>();
  const issueWsTicket = (): { ticket: string; expiresInSeconds: number } => {
    const now = Date.now();
    for (const [ticket, expiry] of wsTickets) if (expiry <= now) wsTickets.delete(ticket);
    const ticket = randomUUID();
    wsTickets.set(ticket, now + WS_TICKET_TTL_MS);
    return { ticket, expiresInSeconds: WS_TICKET_TTL_MS / 1000 };
  };
  const consumeWsTicket = (candidate: string): boolean => {
    if (candidate === "") return false;
    const expiry = wsTickets.get(candidate);
    if (expiry === undefined || expiry <= Date.now()) return false;
    wsTickets.delete(candidate); // 一次性：用后即焚
    return true;
  };

  // 安全响应头：对静态外壳与 API 一视同仁（onRequest 钩子对子作用域插件同样生效）。
  app.addHook("onRequest", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });

  // 兜底防线（审计 F-14）：正常构建的 ui/dist 不含 sourcemap（tsc 输出已隔离在
  // build-tsc/，镜像构建另有断言）；即便未来构建回归，也不把 .map 服务出去。
  app.addHook("onRequest", async (request, reply) => {
    if (pathOf(request.raw.url).endsWith(".map")) {
      reply.code(404);
      return reply.send({ error: "not-found" });
    }
  });

  /**
   * 访问口令校验：面板可执行重启实例、改配置、读写记忆等破坏性操作，
   * 一旦监听非回环地址就必须凭口令进入。健康检查放行，供容器 healthcheck 使用；
   * 静态外壳放行，否则未登录时连输入口令的页面都出不来。
   */
  app.addHook("onRequest", async (request, reply) => {
    if (accessToken === "") return;
    const url = request.raw.url ?? "/";
    const route = pathOf(url);
    if (AUTH_EXEMPT_PATHS.has(route)) return;
    if (!route.startsWith("/api/") && route !== "/ws") return;

    if (isLoopbackConnection(request.socket)) return;

    const presented = extractRequestToken(
      request as unknown as { headers: Record<string, unknown>; url: string },
    );
    if (tokensMatch(presented, accessToken)) return;

    // WS 握手一次性凭据：真实口令的替代物（POST /api/ws-ticket 签发）。
    if (consumeWsTicket(extractRequestTicket(request.raw.url))) return;

    reply.code(401);
    return reply.send({ error: "unauthorized", reason: "需要访问口令" });
  });

  // 统一错误处理：Fastify 默认 500 不留日志（logger:false）；这里记 stderr。
  // 4xx 保留原错误信息，5xx 返回脱敏的通用错误体（不向客户端泄露内部细节）。
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const route = pathOf(request.raw.url);
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (route === "/api/scheduled-tasks" || route.startsWith("/api/scheduled-tasks/")) {
      // JSON parser exceptions can contain a slice of an editor's prompt.
      void reply.code(status >= 500 ? 500 : status).header("cache-control", "no-store")
        .send({ error: status === 413 ? "body_too_large" : status >= 500 ? "internal_error" : "invalid_request" });
      return;
    }
    if (status >= 500) {
      process.stderr.write(
        `[web] request-error method=${request.method} url=${route}: ${error.message}\n${error.stack ?? ""}\n`,
      );
      void reply.code(500).send({ error: "internal-error" });
      return;
    }
    void reply.code(status).send({ error: error.message });
  });

  /**
   * 来源校验（CSRF 防线）。
   * 即使监听回环、无需口令，浏览器仍可能被任意网页驱动向 127.0.0.1:7531 发写请求。
   * 发布到局域网时，浏览器 Origin 会是局域网地址，因此允许与当前请求 Host
   * 相同的同源请求；非同源页面仍被拒绝。/ws 虽是 GET，也必须校验 Origin。
   */
  app.addHook("onRequest", async (request, reply) => {
    const route = pathOf(request.raw.url);
    if (!STATE_CHANGING_METHODS.has(request.method) && route !== "/ws") return;
    const origin = request.headers["origin"];
    if (typeof origin !== "string" || origin.trim() === "") return;
    if (isTrustedOrigin(origin, request.headers.host)) return;
    reply.code(403);
    return reply.send({ error: "origin-not-allowed" });
  });

  // 精准速率限制（ENG-04）：高危写操作严格限流，高频轮询宽容放行，静态与健康完全豁免
  registerRateLimiting(app);

  app.addHook("onClose", async () => {
    for (const timer of wsTimers) clearInterval(timer);
    wsTimers.clear();
    store?.close();
    store = null;
    ollamaUsageStore?.close();
    ollamaUsageStore = null;
  });

  const getStore = (): SqliteStore | null => {
    if (store === null) store = openStore(home); // db 缺失时每个 tick 静默重试
    return store;
  };

  /* ------------------------------ 静态 SPA 服务 ------------------------------ */

  const staticReady = fs.existsSync(uiDist);
  if (staticReady) {
    // 显式 no-cache 语义：index.html 与带 hash 的资源都要求浏览器每次重验证，
    // 防止启发式缓存/会话恢复的旧标签页长期滞留过期 bundle（症状：UI 与当前
    // 版本行为不一致，刷新后消失）。hashed 资源的重验证只花一个 304 往返。
    app.register(fastifyStatic, { root: uiDist, cacheControl: true, maxAge: 0 });
  }

  // SPA 回退：非 /api 前缀的未匹配路由回 index.html；/api 未知路由返回 404 JSON。
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "/";
    if (url === "/api" || url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not-found", path: url });
    }
    if (staticReady) {
      return reply.sendFile("index.html");
    }
    return reply
      .status(404)
      .send({ error: "ui-not-built", hint: "面板资源缺失：请先在 ui/ 目录执行 vite build" });
  });

  /* -------------------------------- API 路由 -------------------------------- */

  const serviceStatus = async () => {
    const [gatewayHealth, watchHealth] = await Promise.all([
      probeServiceHealth(doFetch, gatewayUrl),
      probeServiceHealth(doFetch, watchUrl),
    ]);
    return {
      ok: true,
      db: store !== null,
      gateway: gatewayHealth.reachable,
      watch: watchHealth.reachable,
      version: WEB_VERSION,
      serviceVersion: WEB_VERSION,
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      bundleVersion,
      gitCommit: process.env.BUTLER_GIT_COMMIT || null,
      services: {
        gateway: gatewayHealth,
        watch: watchHealth,
      },
    };
  };

  // /api/health 是容器 healthcheck 与免鉴权探测位（AUTH_EXEMPT_PATHS）；
  // /api/status 是同一份聚合的鉴权读取位，供统一入口的运维探测使用。
  app.get("/api/health", async () => serviceStatus());

  app.get("/api/status", async () => serviceStatus());

  /**
   * WS 握手凭据签发：鉴权与 /api/* 相同（口令或本机便利通道）。签发的 ticket
   * 只能用于 /ws?ticket=，60 秒有效、一次性——真实口令从此不出现在 URL 中。
   */
  app.post("/api/ws-ticket", async () => issueWsTicket());

  app.get("/api/instances", async () => {
    if (store === null) return { instances: [], degraded: ["db:unreachable"] };
    return { instances: toInstanceViews(store) };
  });

  app.get("/api/events", async (request) => {
    if (store === null) return { items: [], degraded: ["db:unreachable"] };
    const query = request.query as Record<string, unknown>;
    const type =
      typeof query["type"] === "string" && query["type"] !== "" ? query["type"] : undefined;
    const items = store.listEvents({ type, limit: clampLimit(query["limit"], 100) });
    return { items };
  });

  /** 巡检按日历史（近 N 天）：首页检查耗时 sparkline 数据源。 */
  app.get("/api/inspections/history", async (request) => {
    if (store === null) return { days: 14, degraded: ["db:unreachable"], items: [] };
    const query = request.query as Record<string, unknown>;
    const raw = typeof query["days"] === "string" ? Number(query["days"]) : NaN;
    const days = Number.isFinite(raw) ? Math.floor(raw) : 14;
    if (days < 1 || days > 90) {
      return { days: 14, degraded: ["inspections:invalid-days"], items: [] };
    }
    const now = new Date();
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    return {
      days,
      items: inspectionDailyMetricsHistory(store.dailyInspectionMetrics(since.toISOString()), days, now),
    };
  });

  app.get("/api/fingerprints", async (request) => {
    if (store === null) return { items: [], degraded: ["db:unreachable"] };
    const query = request.query as Record<string, unknown>;
    const items = store.listFingerprints(clampLimit(query["limit"], 100));
    return { items };
  });

  /** 网关告警直读（/api/alerts 路由与 /api/gateway 聚合共用）；不可达/响应异常一律降级载荷。 */
  const alertsFromGateway = async (): Promise<AlertsView> => {
    try {
      const res = await doFetch(`${gatewayUrl}/api/alerts`, {
        signal: AbortSignal.timeout(5000),
        headers: gatewayAuthHeaders(),
      });
      if (!res.ok) return degradedAlerts();
      return parseAlertsView(await res.json()) ?? degradedAlerts();
    } catch {
      return degradedAlerts();
    }
  };

  /** gateway 访问口令头：配置了 BUTLER_ACCESS_TOKEN 时网关侧校验（内网不等于可信）。
   *  另附内部操作口令 x-butler-internal-token（BUTLER_INTERNAL_TOKEN，审计 F-06）：
   *  未配置访问口令的部署里，gateway 的消息控制写路径靠它保护。 */
  const internalToken = (process.env["BUTLER_INTERNAL_TOKEN"] ?? "").trim();
  const gatewayAuthHeaders = (): Record<string, string> => ({
    ...(accessToken === "" ? {} : { "x-butler-token": accessToken }),
    ...(internalToken === "" ? {} : { "x-butler-internal-token": internalToken }),
  });

  /** Read-only gateway fetch with transport failures collapsed to null for partitioned degradation. */
  const fetchGateway = async (gatewayPath: string): Promise<Response | null> => {
    try {
      return await doFetch(`${gatewayUrl}${gatewayPath}`, {
        signal: AbortSignal.timeout(5000),
        headers: gatewayAuthHeaders(),
      });
    } catch {
      return null;
    }
  };

  const proxyGatewayPost = async (
    gatewayPath: string,
    body: unknown,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}${gatewayPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(5_000),
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
  };

  const proxyGatewayPut = async (
    gatewayPath: string,
    body: unknown,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}${gatewayPath}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(5_000),
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
  };

  const proxy = createProxyHelpers(doFetch, watchUrl);
  const { fetchWatch } = proxy;

  /** 巡检状态代理（/api/inspect/status 与 /api/dashboard 聚合共用）；不可达 → reachable:false。 */
  const inspectStatusFromWatch = async (): Promise<Record<string, unknown>> => {
    const res = await fetchWatch("/api/inspect/status");
    if (res === null || !res.ok) return { reachable: false };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return { reachable: false };
    }
  };

  /* ---------------------- 消息网关代理（Task 15.2 / M1 / M4 / M5） ---------------------- */
  void registerGatewayRoutes(app, {
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
  });

  /* ---------------------- 计划任务代理（Task 10） ---------------------- */
  void registerScheduledTasksRoutes(app, { doFetch, watchUrl });

  /* ---------------------- 故障自愈与连接管理（Task 10 / B11） ---------------------- */
  void registerRecoveryRoutes(app, { proxy, inspectStatusFromWatch });

  /* --------------------- 升级与快照代理（Task 13.3） --------------------- */
  void registerUpgradeRoutes(app, { proxy, getStore });

  /* --------------------------- 备份与安全基线（Task 18 / V1.7） --------------------------- */
  void registerBackupsRoutes(app, { proxy, getStore });

  /* --------------------------- 系统日志只读代理（V1.7） --------------------------- */
  void registerLogsRoutes(app, proxy);

  /* ---------------------- 核心 Markdown 文件代理 ---------------------- */
  void registerMarkdownRoutes(app, proxy);

  /* ---------------------- 记忆观察与管理动作代理（V1.7 / M6 / M7） ---------------------- */
  void registerMemoryRoutes(app, { proxy, doFetch, watchUrl });

  /* ------------------------ 技能资产中心（Task 17） ------------------------ */
  void registerSkillsRoutes(app, { proxy, degradedSkills, parseSkillsStatus });

  /* -------------------------- 进化守门代理（Task 16） -------------------------- */
  void registerEvolutionRoutes(app, { proxy });

  /* ---------------------- 信任层（Trust Layer）代理 ---------------------- */
  void registerTrustLayerRoutes(app, { proxy, doFetch, watchUrl });

  /* ---------------------- LLM 供应商画像与成本中枢 ---------------------- */
  void registerLlmRoutes(app, { proxy, doFetch, watchUrl });

  /* ---------------------- 提示词优化与候选评估代理（M5 切片 1/2） ---------------------- */
  void registerPromptOptimizationRoutes(app, { proxy });

  /* --------------------------- 大盘聚合（Task 10） --------------------------- */

  // 一次取齐面板首页数据（实例 + 每实例最新巡检 + 指纹 + 巡检控制状态 + 消息网关状态），
  // 减少前端多次往返；db 不可达时对应字段为空数组并附 degraded 标记。
  app.get("/api/dashboard", async () => {
    const instances: InstanceApiView[] = store === null ? [] : toInstanceViews(store);
    const latestInspections: LatestInspectionView[] =
      store === null
        ? []
        : latestInspectionsPerInstance(
            store.listEvents({ type: "inspection-completed", limit: 500 }),
          );
    const fingerprintWindowMs = readPositiveDuration(
      process.env["BUTLER_FINGERPRINT_WINDOW_MS"],
      5 * 60_000,
    );
    const fingerprints =
      store === null
        ? []
        : store.listFingerprints(10, new Date(Date.now() - fingerprintWindowMs).toISOString());
    const [inspectStatus, messageStatusResponse] = await Promise.all([
      inspectStatusFromWatch(),
      fetchGateway("/api/messages/status"),
    ]);
    let messageStatus: MessageStatusView | null = null;
    if (messageStatusResponse?.ok === true) {
      try {
        messageStatus = parseMessageStatus(await messageStatusResponse.json());
      } catch {
        messageStatus = null;
      }
    }
    return {
      instances,
      latestInspections,
      fingerprints,
      inspectStatus,
      messageStatus: {
        reachable: messageStatus !== null,
        status: messageStatus,
      },
      ...(store === null ? { degraded: ["db:unreachable"] } : {}),
    };
  });

  /**
   * 安全基线：如实汇报容器监听地址与宿主机发布地址，UI 侧据此渲染「仅本机访问」
   * 或「局域网可访问」。不再写死 auth:false，也不拿容器内的 0.0.0.0
   * 冒充宿主机实际暴露范围。
   */
  app.get("/api/security-baseline", async () => {
    const loopback = isLoopback(publishHost);
    const auth = accessToken !== "";
    const warnings: string[] = [];
    if (loopback && !auth) {
      warnings.push("当前只有本机可以访问，没有设置访问口令。");
    } else if (loopback && auth) {
      warnings.push("当前只有本机可以访问，并且已设置访问口令。");
    } else if (!loopback && auth) {
      warnings.push(`面板发布在 ${publishHost}，同一网络内的其他设备可以访问，已用访问口令保护。`);
      warnings.push("请确认你信任当前网络；口令泄露等同于把本机 AI 的控制权交出去。");
    } else {
      warnings.push(`面板发布在 ${publishHost}，建议配置访问口令保护。`);
    }
    return { listenHost, publishHost, loopback, auth, warnings };
  });

  /* ------------------------------ Ollama 本地模型与知识库管理 ------------------------------ */
  void registerOllamaRoutes(app, { ollamaUrl, ollamaUsageStore });
  void registerKnowledgeRoutes(app, {
    home,
    ollamaUrl,
    updaterUrl,
    updaterToken,
    fetchImpl: options.fetchImpl,
  });

  /* ------------------------------ WebSocket /ws ------------------------------ */

  // 注意：@fastify/websocket 通过插件作用域内的 onRoute 钩子改写 websocket 路由，
  // /ws 必须注册在插件之后的子作用域里（README 同款模式），否则会按普通 HTTP 处理。
  app.register(websocket);
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      let lastId = 0;

      // 连接建立：先推最近 50 条（升序），位点取末尾最大 id。
      const current = getStore();
      if (current !== null) {
        const recent = recentEventsAscending(current.listEvents({ limit: 50 }), 50);
        if (recent.length > 0) {
          lastId = recent[recent.length - 1]!.id;
          socket.send(JSON.stringify({ type: "events", items: recent }));
        }
      }

      // 每 2s 轮询共享 events 表的增量（id > lastId，SQL 端过滤，避免每连接
      // 每 2s 全量拉取 1000 行再在 JS 里丢弃）；db 缺失时静默等待。
      const timer = setInterval(() => {
        const s = getStore();
        if (s === null) return;
        const fresh = selectNewEvents(s.listEvents({ limit: 1000, afterId: lastId }), lastId);
        if (fresh.length === 0) return;
        lastId = fresh[fresh.length - 1]!.id;
        socket.send(JSON.stringify({ type: "events", items: fresh }));
      }, 2000);
      wsTimers.add(timer);

      socket.on("close", () => {
        clearInterval(timer);
        wsTimers.delete(timer);
      });
    });
  });

  return app;
}
