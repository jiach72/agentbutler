/**
 * butler-web Fastify 服务（Task 9）：
 *
 * - 默认仅监听回环地址 127.0.0.1:7531（env BUTLER_WEB_HOST / BUTLER_WEB_PORT 可覆盖）；
 * - SPA 静态服务：以 ui/dist 为根，非 /api 前缀的未匹配路由回退 index.html；
 * - 只读 API：健康/实例/事件/指纹直读共享 SQLite（<home>/data/butler.db），
 *   告警走网关代理（默认 http://127.0.0.1:7532，5s 超时）；
 * - Task 10：runbook / 巡检控制代理到 watch HTTP 控制通道（默认
 *   http://127.0.0.1:7533，5s 超时）；/api/dashboard 一次聚合大盘首页数据；
 * - Task 13.3：/api/versions 一次聚合版本页数据（实例当前版本 / 升级 Job /
 *   可用版本源 / 快照历史）；升级发起与快照回滚按 watch 代理透传；
 * - Task 15.2：/api/gateway 一次聚合消息网关数据（限流统计 / Hermes 形态补丁 /
 *   告警队列），补丁 apply/reapply/detect 三动作代理透传 watch 控制通道；
 * - M1 一键接管：/api/messages/relay 代理透传 gateway 切换接口，
 *   /api/messages/status 与 /api/messages/overview 透传 relay 控制块；
 * - M4 通道启停与首次接入：/api/messages/channels/:channel 的 schema/config/
 *   enable/disable 同名代理透传 gateway（配置响应含 secret 掩码回显）；
 * - M5 切片 1/2：/api/prompt-optimization 与 /targets 只读聚合 Prompt Registry，
 *   /active/:targetId 代理 baseline/version 快照查询，/candidates 代理候选与成对
 *   评估报告；批准/canary/提升/回滚写入口不暴露；
 * - db 或网关不可达时各 API 返回降级载荷（200），而非 500 —— 面板据此显示降级横幅；
 * - WebSocket /ws：事件流推送（连接首推最近 50 条，之后每 2s 轮询 id > lastId 的增量）。
 *
 * web 不写业务数据；SqliteStore 构造的幂等建表被视为可接受的副作用。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CONTROL_API_SCHEMA_VERSION,
  CONTRACT_VERSION,
  MEMORY_PREVIEW_LIMIT,
  SCHEDULED_TASK_MAX_BODY,
  SCHEDULED_TASK_MAX_RESPONSE,
  scheduledTaskRouteRequest,
  parseScheduledTaskResponse,
  scheduledTaskFailure,
  scheduledTaskHttpStatus,
  isOutboxState,
  type CapabilityReport,
  type InboundDecision,
  type InboundHistoryEntry,
  type JobStep,
} from "@butler/contract";
import { ensureButlerHome, resolveButlerHome, SqliteStore, type StoredEvent } from "@butler/core";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { recentEventsAscending, selectNewEvents } from "./events-pump.js";
import {
  defaultOllamaService,
  detectHardwareProfile,
  evaluateHardwareTier,
} from "./ollama-service.js";
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
import { registerOllamaRoutes } from "./routes/ollama.js";
import { registerPromptOptimizationRoutes } from "./routes/prompt-optimization.js";
import { registerRecoveryRoutes } from "./routes/recovery.js";
import { registerScheduledTasksRoutes } from "./routes/scheduled-tasks.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerTrustLayerRoutes } from "./routes/trust-layer.js";
import { registerUpgradeRoutes } from "./routes/upgrade.js";

export const WEB_VERSION = `web@0.1.0-beta.260918.1+${CONTRACT_VERSION}`;

/** 告警网关默认基址（butler-gateway 的固定回环端口）。 */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7532";

/** watch HTTP 控制通道默认基址（butler-watch 的固定回环端口）。 */
export const DEFAULT_WATCH_URL = "http://127.0.0.1:7533";

/** 本地 Ollama 服务默认基址（容器内 http://ollama:11434，宿主直跑 127.0.0.1:11434）。 */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** 告警队列视图（/api/alerts 路由与 /api/gateway 聚合共用；reachable=false 表示网关不可达）。 */
interface AlertsView {
  reachable: boolean;
  counts: Record<string, number>;
  unreadCount: number;
  degradedChannels: string[];
  items: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** /api/alerts 网关不可达时的降级载荷（面板显示黄色横幅而非报错）。 */
function degradedAlerts(): AlertsView {
  return {
    reachable: false,
    // 不可达兜底不经过 parseAlertsView，且与 UI 当前展示的 4 个状态对齐；
    // 若后续面板要展示 resolved，再与 gateway counts() 一起补齐。
    counts: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
    unreadCount: 0,
    degradedChannels: ["gateway:unreachable"],
    items: [],
  };
}

/** gateway /api/alerts 外部响应结构校验；畸形响应视为不可达，避免异常值进入 React。 */
function parseAlertsView(value: unknown): AlertsView | null {
  if (!isRecord(value) || !isRecord(value["counts"])) return null;
  const counts: Record<string, number> = {};
  for (const key of ["pending", "delivering", "delivered", "failed", "resolved"] as const) {
    const count = value["counts"][key];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
    counts[key] = count;
  }
  if (!Array.isArray(value["degradedChannels"]) || !Array.isArray(value["items"])) return null;
  const degradedChannels = value["degradedChannels"];
  if (!degradedChannels.every((item): item is string => typeof item === "string")) return null;
  const items = value["items"].filter(
    (item) =>
      isRecord(item) &&
      typeof item["id"] === "number" &&
      typeof item["severity"] === "string" &&
      typeof item["title"] === "string" &&
      typeof item["body"] === "string" &&
      typeof item["source"] === "string" &&
      typeof item["status"] === "string" &&
      typeof item["attempts"] === "number" &&
      typeof item["mergedCount"] === "number" &&
      typeof item["createdAt"] === "string",
  );
  const unreadCount = value["unreadCount"];
  return {
    reachable: true,
    counts,
    unreadCount:
      typeof unreadCount === "number" && Number.isFinite(unreadCount) && unreadCount >= 0
        ? unreadCount
        : items.filter((item) => {
            const readAt = (item as Record<string, unknown>)["readAt"];
            return readAt === null || readAt === undefined;
          }).length,
    degradedChannels,
    items,
  };
}

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
}

/** 受保护前缀：口令校验覆盖所有数据面接口与事件流，健康检查与静态外壳放行。 */
const AUTH_EXEMPT_PATHS = new Set(["/api/health"]);

/** 会改变状态的请求方法；只有它们需要校验来源。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 来源是否指向本机；解析失败按不受信任处理。 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** 从 Host / URL 中提取可比较的主机名。 */
function hostNameOf(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  const raw = value.trim();
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
    if (bracketed?.[1] !== undefined) return bracketed[1].toLowerCase();
    const hostWithPort = /^([^:]+):\d+$/.exec(raw);
    if (hostWithPort?.[1] !== undefined) return hostWithPort[1].toLowerCase();
    return raw.toLowerCase();
  }
}

/**
 * 首次使用便利通道：从本机发起的连接（TCP 对端为 loopback）无需查找口令。
 * 信任源是连接层对端地址而非 Host / Sec-Fetch 等客户端可控头——后者可被
 * 局域网攻击者伪造（审计 F-03：`Host: 127.0.0.1` + `Sec-Fetch-Site: same-origin`
 * 即可绕过口令）。跨设备访问（portproxy/反代）的对端不是 loopback，仍须凭口令。
 */
function isLoopbackConnection(socket: { remoteAddress?: string } | undefined): boolean {
  const raw = socket?.remoteAddress ?? "";
  // IPv4-mapped IPv6（::ffff:127.0.0.1）归一化为 IPv4 loopback。
  const normalized = raw.replace(/^::ffff:/i, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** Origin 与当前请求 Host 相同即为同源请求，允许受口令保护的局域网面板正常写入。 */
function isSameRequestOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") return false;
  try {
    return new URL(origin).host.toLowerCase() === new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return false;
  }
}

/** 额外可信 Origin 仅用于反向代理等 Host 不可直接比较的部署。 */
function hasAllowedOrigin(origin: string): boolean {
  return (process.env["BUTLER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .includes(origin);
}

function isTrustedOrigin(origin: string, hostHeader: string | undefined): boolean {
  return isLoopbackOrigin(origin) || isSameRequestOrigin(origin, hostHeader) || hasAllowedOrigin(origin);
}

function pathOf(rawUrl: string | undefined): string {
  const url = rawUrl ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** 从请求中提取访问口令：Authorization 头 > x-butler-token 头 > query（WS 握手只能用 query）。 */
function extractRequestToken(request: { headers: Record<string, unknown>; url: string }): string {
  const auth = request.headers["authorization"];
  if (typeof auth === "string" && auth.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const headerToken = request.headers["x-butler-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) return headerToken.trim();
  const raw = request.url;
  const q = raw.indexOf("?");
  if (q !== -1) {
    const token = new URLSearchParams(raw.slice(q + 1)).get("token");
    if (token) return token.trim();
  }
  return "";
}

/** /ws 握手专用一次性短时凭据的 query 参数名与有效期。 */
const WS_TICKET_TTL_MS = 60_000;

/** 从 URL 提取 /ws 握手 ticket（?ticket=）。 */
function extractRequestTicket(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  if (q === -1) return "";
  return new URLSearchParams(raw.slice(q + 1)).get("ticket")?.trim() ?? "";
}

/** 常量时间口令比较（对齐 gateway/updater，避免短路比较泄露前缀/长度信息）。 */
function tokensMatch(presented: string, expected: string): boolean {
  if (expected === "") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // 长度不同时也执行一次等价开销的比较，抹平错误路径的时序差异。
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 安全响应头（纵深防御）：
 * - CSP 锁死资源来源：脚本/字体/图片仅本源（index.html 的主题引导已外置为本源
 *   theme-boot.js，无需 'unsafe-inline'）；style 允许 inline（antd 运行时注入样式）；
 *   connect 允许本源与 ws/wss（事件流）；
 * - frame-ancestors 'none' + X-Frame-Options 防点击劫持（面板含急停/重启按钮）；
 * - nosniff / Referrer-Policy 收窄浏览器默认行为。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** /api/instances 返回的实例视图（capability 为解析后的摘要，null 表示尚无扫描报告）。 */
export interface InstanceApiView {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  capability: CapabilityReport | null;
  createdAt: string;
  updatedAt: string;
}

/** /api/dashboard 返回的单个巡检检查项视图（来自 inspection-completed 事件 payload.checks）。 */
export interface InspectionCheckView {
  id: string;
  status: string;
  detail: unknown;
  durationMs: number | null;
}

/** /api/dashboard 返回的单实例最新巡检视图。 */
export interface LatestInspectionView {
  instanceId: string;
  ts: string;
  overall: string | null;
  confidence: number | null;
  checks: InspectionCheckView[];
}

/** watch /api/upgrade/status 返回的升级 Job 视图（五步流水线的当前状态，Task 13.3）。 */
export interface UpgradeJobView {
  jobId: string;
  instanceId: string;
  targetVersion: string;
  channel?: string;
  trigger?: string;
  status: "running" | "done" | "failed";
  rolledBack?: boolean;
  snapshotId?: string;
  steps: JobStep[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** /api/versions 返回的版本源视图（reachable=false 表示版本源不可用）。 */
export interface AvailableVersionsView {
  reachable: boolean;
  source?: string;
  versions: Array<{ version: string; channel?: string }>;
  checkedAt?: string;
  attempts?: Array<{ id: string; url: string | null; status: string; error?: string; durationMs: number }>;
}

/** /api/versions 返回的快照历史视图（snapshots 表行摘要）。 */
export interface SnapshotApiView {
  id: number;
  instance: string;
  label: string | null;
  createdAt: string;
  status: string;
}

/** /api/versions 一次聚合载荷（db 不可达时附 degraded 标记）。 */
export interface VersionsApiView {
  instances: Array<{ instanceId: string; state: string; runtime: string; version: string | null }>;
  upgradeJob: UpgradeJobView | null;
  availableVersions: AvailableVersionsView;
  snapshots: SnapshotApiView[];
  watchReachable: boolean;
  degraded?: string[];
}

/** watch /api/gateway/stats 返回的限流统计视图（Task 15.2，指纹画像的聚合口径）。 */
export interface GatewayStatsView {
  overall: string;
  totalEvents: number;
  last24h: number;
  matched: Array<{
    signature: string;
    template: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    status: string;
  }>;
  suggestions: Array<{
    patchId: string;
    param: string;
    current: number;
    suggested: number;
    level: "warn" | "critical";
    reason: string;
  }>;
}

/** watch /api/gateway/patches 返回的 Hermes 形态补丁视图（Task 15.2）。 */
export interface GatewayPatchView {
  id: string;
  title: string;
  description: string;
  target: string;
  requires?: string[];
  params: Record<string, { default: number; min?: number; max?: number; integer?: boolean }>;
  applied: null | { params: Record<string, number>; appliedAt: string; targetPath: string };
  observed?: null | { params: Record<string, number>; checkedAt: string; targetPath: string };
}

const MESSAGE_OUTBOX_STATES = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "absorbed",
  "policy_error",
  "dead_letter",
  "cancelled",
] as const;

export interface MessageBridgeView {
  connected: boolean;
  running: boolean;
  inFlight: boolean;
  attached: boolean;
  outboxWritable: boolean;
  protocolVersion: number | null;
  bridgeVersion: string | null;
  instanceId: string | null;
  policyVersion: string | null;
  policyHash: string | null;
  remotePolicyVersion: string | null;
  channels: Record<string, string>;
  channelDetails?: Record<string, { status: string; unavailableReason: string | null; unavailableFix: string | null; retryable: boolean; loginState?: string; account?: string | null }>;
  coverage: Record<string, string>;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  /** 任务执行汇总（旧 Bridge 无此字段时缺省）：failed = 执行失败的 run 数。 */
  runs?: { total: number; failed: number; active: number };
}

export interface MessageStatusView {
  bridge: MessageBridgeView;
  counts: Record<string, number>;
  /** 消息链路一键接管开关视图（旧 gateway 无此字段时缺省）。 */
  relay?: { enabled: boolean; pending: boolean; updatedAt: string | null };
}

export interface MessageItemView {
  messageId: string;
  instanceId: string;
  adapterId: string;
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  runId?: string | null;
  inboundMessageId?: string | null;
  messageKind: string;
  transport: string;
  priority: string;
  content: string;
  contentSha256: string;
  replyTo?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
  sequence: number;
  state: string;
  availableAt: string | null;
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  transformTrace: string[];
  decisionId: string | null;
  lastPolicyError: string | null;
  updatedAt: string;
}

export interface MessageListView {
  counts: Record<string, number>;
  items: MessageItemView[];
}

export interface MessageOverviewApiView {
  reachable: boolean;
  status: MessageStatusView | null;
  messages: MessageListView;
  degraded: string[];
}

export interface MessageOptimizationHistoryView {
  reachable: boolean;
  items: InboundHistoryEntry[];
}

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

export interface MessageTaskView {
  runId: string;
  sessionId: string;
  state: string;
  lastEventSequence: number;
  updatedAt: string;
  events: Array<{
    runId: string;
    sequence: number;
    sessionId: string;
    kind: string;
    summary?: string;
    etaSec?: number;
    occurredAt: string;
  }>;
}

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

export type SkillsInventoryMode = "driver" | "directory-fallback" | "unavailable";
export type AssetRiskStatus = "unscanned" | "clear" | "blocked";

export interface DirectoryInventoryView {
  roots: string[];
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillsApiView {
  watchReachable: boolean;
  instance: null | {
    instanceId: string;
    frameworkId: string;
    state: string;
    version: string | null;
  };
  skills: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    total: number;
    items: Array<{
      ref: { name: string; version?: string; source?: string };
      name: string;
      version: string;
      source: string;
      enabled: boolean;
      category?: string;
      description?: string;
      usage?: number;
      lastUsedAt?: string | null;
      successRate?: number | null;
      avgDurationMs?: number | null;
      usageCoverage?: { from: string | null; to: string | null; days: number; source: string; complete: boolean };
      riskStatus?: AssetRiskStatus;
      riskDetail?: string;
    }>;
    directory: DirectoryInventoryView;
    notice: string;
  };
  plugins: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    total: number;
    items: Array<{
      ref: { name: string; version?: string; source?: string };
      name: string;
      version: string;
      source: string;
      enabled: boolean;
      category?: string;
      description?: string;
      riskStatus?: AssetRiskStatus;
      riskDetail?: string;
    }>;
    directory: DirectoryInventoryView;
    notice: string;
  };
  memory: {
    mode: SkillsInventoryMode;
    driverId: string | null;
    /** watch 检测到的记忆后端（hermes|hindsight|mem0；env 声明 > 目录标记 > 默认）。 */
    backend: { id: string; source: string; detail: string };
    stats: null | {
      totalEntries: number;
      byMonth: Array<{ month: string; count: number }>;
      coldCandidates: number;
      lastWriteAt: string | null;
      archivedEntries: number;
      probeEntries: number;
    };
    health: null | {
      score: number;
      checkedAt: string;
      signals: Array<{ id: string; label: string; status: string; detail: string }>;
      suggestions: Array<{
        id: string;
        kind: string;
        title: string;
        detail: string;
        action?: string;
      }>;
    };
    preview: Array<{
      entryId: string;
      writtenAt: string;
      content: string;
      channel?: string;
      sessionId?: string;
      sizeBytes?: number;
      cold?: boolean;
    }>;
    previewLimit: number;
    writeActivity: { status: string; detail: string };
    directory: DirectoryInventoryView;
    notice: string;
  };
}

function degradedSkills(): SkillsApiView {
  const directory: DirectoryInventoryView = {
    roots: [],
    fileCount: 0,
    directoryCount: 0,
    sizeBytes: 0,
    truncated: false,
  };
  return {
    watchReachable: false,
    instance: null,
    skills: {
      mode: "unavailable",
      driverId: null,
      total: 0,
      items: [],
      directory,
      notice: "watch 不可达，无法读取技能清单",
    },
    plugins: {
      mode: "unavailable",
      driverId: null,
      total: 0,
      items: [],
      directory,
      notice: "watch 不可达，无法读取插件清单",
    },
    memory: {
      mode: "unavailable",
      driverId: null,
      backend: { id: "hermes", source: "default", detail: "watch 不可达，按默认记忆库处理" },
      stats: null,
      health: null,
      preview: [],
      previewLimit: MEMORY_PREVIEW_LIMIT,
      writeActivity: { status: "unknown", detail: "watch 不可达" },
      directory,
      notice: "watch 不可达，无法读取记忆统计",
    },
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMemoryBackendId(value: unknown): value is string {
  return value === "hermes" || value === "hindsight" || value === "mem0";
}

function isMemoryBackendSource(value: unknown): value is string {
  return value === "env" || value === "marker" || value === "default";
}

function parseDirectoryInventory(value: unknown): DirectoryInventoryView | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value["roots"]) ||
    !value["roots"].every((item): item is string => typeof item === "string") ||
    !isNonNegativeNumber(value["fileCount"]) ||
    !isNonNegativeNumber(value["directoryCount"]) ||
    !isNonNegativeNumber(value["sizeBytes"]) ||
    typeof value["truncated"] !== "boolean"
  ) {
    return null;
  }
  return {
    roots: value["roots"],
    fileCount: value["fileCount"],
    directoryCount: value["directoryCount"],
    sizeBytes: value["sizeBytes"],
    truncated: value["truncated"],
  };
}

function isInventoryMode(value: unknown): value is SkillsInventoryMode {
  return value === "driver" || value === "directory-fallback" || value === "unavailable";
}

/** /api/connections 返回的 Hermes/OpenClaw 连接视图。 */
export interface ConnectionApiView {
  instanceId: string;
  frameworkId: string;
  displayName: string;
  state: string;
  connectionState: "connected" | "disconnected" | "checking" | "error" | "unknown" | string;
  connected: boolean;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  effectiveLevel: number | null;
  capabilities: Record<string, string>;
  checks: Array<{ id: string; label: string; status: string; detail: string; durationMs: number | null }>;
  anomalies: string[];
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  lastAction: string | null;
  latencyMs: number | null;
  lastError: string | null;
}

function isAssetRiskStatus(value: unknown): value is AssetRiskStatus {
  return value === "unscanned" || value === "clear" || value === "blocked";
}

function parseMemoryHealth(value: unknown): SkillsApiView["memory"]["health"] {
  type MemoryHealthView = NonNullable<SkillsApiView["memory"]["health"]>;
  if (
    !isRecord(value) ||
    !isNonNegativeNumber(value["score"]) ||
    typeof value["checkedAt"] !== "string" ||
    !Array.isArray(value["signals"]) ||
    !Array.isArray(value["suggestions"])
  ) {
    return null;
  }
  const signals = value["signals"].filter(
    (signal) =>
      isRecord(signal) &&
      typeof signal["id"] === "string" &&
      typeof signal["label"] === "string" &&
      typeof signal["status"] === "string" &&
      typeof signal["detail"] === "string",
  ) as MemoryHealthView["signals"];
  if (signals.length !== value["signals"].length) return null;
  const suggestions = value["suggestions"]
    .filter(
      (item) =>
        isRecord(item) &&
        typeof item["id"] === "string" &&
        typeof item["kind"] === "string" &&
        typeof item["title"] === "string" &&
        typeof item["detail"] === "string" &&
        (item["action"] === undefined || typeof item["action"] === "string"),
    )
    .map((item) => ({
      id: String(item["id"]),
      kind: String(item["kind"]),
      title: String(item["title"]),
      detail: String(item["detail"]),
      ...(item["action"] === undefined ? {} : { action: String(item["action"]) }),
    })) as MemoryHealthView["suggestions"];
  if (suggestions.length !== value["suggestions"].length) return null;
  return {
    score: value["score"],
    checkedAt: value["checkedAt"],
    signals,
    suggestions,
  };
}

function parseSkillsStatus(value: unknown): Omit<SkillsApiView, "watchReachable"> | null {
  if (
    !isRecord(value) ||
    !isRecord(value["skills"]) ||
    !isRecord(value["plugins"]) ||
    !isRecord(value["memory"])
  )
    return null;
  const skills = value["skills"];
  const plugins = value["plugins"];
  const memory = value["memory"];
  const skillDirectory = parseDirectoryInventory(skills["directory"]);
  const pluginsDirectory = parseDirectoryInventory(plugins["directory"]);
  const memoryDirectory = parseDirectoryInventory(memory["directory"]);
  if (
    !isInventoryMode(skills["mode"]) ||
    !isInventoryMode(plugins["mode"]) ||
    !isInventoryMode(memory["mode"]) ||
    !(typeof skills["driverId"] === "string" || skills["driverId"] === null) ||
    !(typeof plugins["driverId"] === "string" || plugins["driverId"] === null) ||
    !(typeof memory["driverId"] === "string" || memory["driverId"] === null) ||
    !isNonNegativeNumber(skills["total"]) ||
    !isNonNegativeNumber(plugins["total"]) ||
    !Array.isArray(skills["items"]) ||
    !Array.isArray(plugins["items"]) ||
    typeof skills["notice"] !== "string" ||
    typeof plugins["notice"] !== "string" ||
    typeof memory["notice"] !== "string" ||
    !isNonNegativeNumber(memory["previewLimit"]) ||
    !Array.isArray(memory["preview"]) ||
    !isRecord(memory["writeActivity"]) ||
    typeof memory["writeActivity"]["status"] !== "string" ||
    typeof memory["writeActivity"]["detail"] !== "string" ||
    skillDirectory === null ||
    pluginsDirectory === null ||
    memoryDirectory === null
  ) {
    return null;
  }

  const items = skills["items"].filter(
    (item) =>
      isRecord(item) &&
      isRecord(item["ref"]) &&
      typeof item["ref"]["name"] === "string" &&
      typeof item["name"] === "string" &&
      typeof item["version"] === "string" &&
      typeof item["source"] === "string" &&
      typeof item["enabled"] === "boolean" &&
      (item["category"] === undefined || typeof item["category"] === "string") &&
      (item["description"] === undefined || typeof item["description"] === "string") &&
      (item["usage"] === undefined || isNonNegativeNumber(item["usage"])) &&
      (item["lastUsedAt"] === undefined || item["lastUsedAt"] === null || typeof item["lastUsedAt"] === "string") &&
      (item["successRate"] === undefined || item["successRate"] === null || typeof item["successRate"] === "number") &&
      (item["avgDurationMs"] === undefined || item["avgDurationMs"] === null || typeof item["avgDurationMs"] === "number") &&
      (item["usageCoverage"] === undefined || isRecord(item["usageCoverage"])) &&
      (item["riskStatus"] === undefined || isAssetRiskStatus(item["riskStatus"])) &&
      (item["riskDetail"] === undefined || typeof item["riskDetail"] === "string"),
  ).map((item) => ({
    ref: item["ref"] as { name: string; version?: string; source?: string },
    name: String(item["name"]),
    version: String(item["version"]),
    source: String(item["source"]),
    enabled: Boolean(item["enabled"]),
    ...(item["category"] === undefined ? {} : { category: String(item["category"]) }),
    ...(item["description"] === undefined ? {} : { description: String(item["description"]) }),
    ...(item["usage"] === undefined ? {} : { usage: Number(item["usage"]) }),
    ...(item["lastUsedAt"] === undefined ? {} : { lastUsedAt: item["lastUsedAt"] === null ? null : String(item["lastUsedAt"]) }),
    ...(item["successRate"] === undefined ? {} : { successRate: item["successRate"] === null ? null : Number(item["successRate"]) }),
    ...(item["avgDurationMs"] === undefined ? {} : { avgDurationMs: item["avgDurationMs"] === null ? null : Number(item["avgDurationMs"]) }),
    ...(item["usageCoverage"] === undefined ? {} : { usageCoverage: item["usageCoverage"] as SkillsApiView["skills"]["items"][number]["usageCoverage"] }),
    ...(item["riskStatus"] === undefined ? {} : { riskStatus: item["riskStatus"] as AssetRiskStatus }),
    ...(item["riskDetail"] === undefined ? {} : { riskDetail: String(item["riskDetail"]) }),
  })) as SkillsApiView["skills"]["items"];
  if (items.length !== skills["items"].length) return null;

  const pluginItems = plugins["items"].filter(
    (item) =>
      isRecord(item) &&
      isRecord(item["ref"]) &&
      typeof item["ref"]["name"] === "string" &&
      typeof item["name"] === "string" &&
      typeof item["version"] === "string" &&
      typeof item["source"] === "string" &&
      typeof item["enabled"] === "boolean" &&
      (item["category"] === undefined || typeof item["category"] === "string") &&
      (item["description"] === undefined || typeof item["description"] === "string") &&
      (item["riskStatus"] === undefined || isAssetRiskStatus(item["riskStatus"])) &&
      (item["riskDetail"] === undefined || typeof item["riskDetail"] === "string"),
  ).map((item) => ({
    ref: item["ref"] as { name: string; version?: string; source?: string },
    name: String(item["name"]),
    version: String(item["version"]),
    source: String(item["source"]),
    enabled: Boolean(item["enabled"]),
    ...(item["category"] === undefined ? {} : { category: String(item["category"]) }),
    ...(item["description"] === undefined ? {} : { description: String(item["description"]) }),
    ...(item["riskStatus"] === undefined ? {} : { riskStatus: item["riskStatus"] as AssetRiskStatus }),
    ...(item["riskDetail"] === undefined ? {} : { riskDetail: String(item["riskDetail"]) }),
  })) as SkillsApiView["plugins"]["items"];
  if (pluginItems.length !== plugins["items"].length) return null;

  let instance: SkillsApiView["instance"] = null;
  if (value["instance"] !== null) {
    if (
      !isRecord(value["instance"]) ||
      typeof value["instance"]["instanceId"] !== "string" ||
      typeof value["instance"]["frameworkId"] !== "string" ||
      typeof value["instance"]["state"] !== "string" ||
      !(typeof value["instance"]["version"] === "string" || value["instance"]["version"] === null)
    ) {
      return null;
    }
    instance = {
      instanceId: value["instance"]["instanceId"],
      frameworkId: value["instance"]["frameworkId"],
      state: value["instance"]["state"],
      version: value["instance"]["version"],
    };
  }

  let stats: SkillsApiView["memory"]["stats"] = null;
  if (memory["stats"] !== null) {
    if (
      !isRecord(memory["stats"]) ||
      !isNonNegativeNumber(memory["stats"]["totalEntries"]) ||
      !Array.isArray(memory["stats"]["byMonth"]) ||
      !isNonNegativeNumber(memory["stats"]["coldCandidates"]) ||
      !isNonNegativeNumber(memory["stats"]["archivedEntries"]) ||
      !isNonNegativeNumber(memory["stats"]["probeEntries"]) ||
      !(
        typeof memory["stats"]["lastWriteAt"] === "string" ||
        memory["stats"]["lastWriteAt"] === null
      )
    ) {
      return null;
    }
    const byMonth = memory["stats"]["byMonth"].filter(
      (row) =>
        isRecord(row) && typeof row["month"] === "string" && isNonNegativeNumber(row["count"]),
    ) as Array<{ month: string; count: number }>;
    if (byMonth.length !== memory["stats"]["byMonth"].length) return null;
    stats = {
      totalEntries: memory["stats"]["totalEntries"],
      byMonth,
      coldCandidates: memory["stats"]["coldCandidates"],
      lastWriteAt: memory["stats"]["lastWriteAt"],
      archivedEntries: memory["stats"]["archivedEntries"],
      probeEntries: memory["stats"]["probeEntries"],
    };
  }

  const preview = memory["preview"]
    .filter(
      (entry) =>
        isRecord(entry) &&
        typeof entry["entryId"] === "string" &&
        typeof entry["writtenAt"] === "string" &&
        typeof entry["content"] === "string",
    )
    .slice(0, MEMORY_PREVIEW_LIMIT) as SkillsApiView["memory"]["preview"];
  if (preview.length !== Math.min(memory["preview"].length, MEMORY_PREVIEW_LIMIT)) return null;

  // 记忆后端：新 watch 才上报；缺失（滚动升级中的旧版 watch）回落默认值，不判降级。
  // watch 的原始形状是 MemoryBackendDetection（{backend, source, detail}），此处
  // 统一归一为 {id, source, detail}；同时兼容直接携带 id 的形状。
  let backend: SkillsApiView["memory"]["backend"] = {
    id: "hermes",
    source: "default",
    detail: "watch 版本较旧，未上报记忆后端检测",
  };
  if (memory["backend"] !== undefined) {
    if (!isRecord(memory["backend"])) return null;
    const rawId =
      typeof memory["backend"]["backend"] === "string"
        ? memory["backend"]["backend"]
        : memory["backend"]["id"];
    if (
      !isMemoryBackendId(rawId) ||
      !isMemoryBackendSource(memory["backend"]["source"]) ||
      typeof memory["backend"]["detail"] !== "string"
    ) {
      return null;
    }
    backend = {
      id: rawId,
      source: memory["backend"]["source"],
      detail: memory["backend"]["detail"],
    };
  }

  return {
    instance,
    skills: {
      mode: skills["mode"],
      driverId: skills["driverId"],
      total: skills["total"],
      items,
      directory: skillDirectory,
      notice: skills["notice"],
    },
    plugins: {
      mode: plugins["mode"],
      driverId: plugins["driverId"],
      total: plugins["total"],
      items: pluginItems,
      directory: pluginsDirectory,
      notice: plugins["notice"],
    },
    memory: {
      mode: memory["mode"],
      driverId: memory["driverId"],
      backend,
      stats,
      health: memory["health"] === null ? null : parseMemoryHealth(memory["health"]),
      preview,
      previewLimit: Math.min(memory["previewLimit"], MEMORY_PREVIEW_LIMIT),
      writeActivity: {
        status: memory["writeActivity"]["status"],
        detail: memory["writeActivity"]["detail"],
      },
      directory: memoryDirectory,
      notice: memory["notice"],
    },
  };
}

function degradedEvolution(
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

function degradedPromptOptimization(): PromptOptimizationApiView {
  return { watchReachable: false, targets: [] };
}

function parsePromptOptimization(
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

function parseEvolutionStatus(value: unknown): Omit<EvolutionApiView, "watchReachable"> | null {
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
    (hermes["status"] !== "ready" && hermes["status"] !== "unavailable" && hermes["status"] !== "unknown") ||
    !(typeof hermes["root"] === "string" || hermes["root"] === null) ||
    typeof hermes["detail"] !== "string" ||
    (endpointHealth["status"] !== "pass" && endpointHealth["status"] !== "fail" && endpointHealth["status"] !== "unknown") ||
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

function isGatewayStatsView(value: unknown): value is GatewayStatsView {
  if (
    !isRecord(value) ||
    typeof value["overall"] !== "string" ||
    typeof value["totalEvents"] !== "number" ||
    typeof value["last24h"] !== "number" ||
    !Array.isArray(value["matched"]) ||
    !Array.isArray(value["suggestions"])
  ) {
    return false;
  }
  return (
    value["matched"].every(
      (item) =>
        isRecord(item) &&
        typeof item["signature"] === "string" &&
        typeof item["template"] === "string" &&
        typeof item["count"] === "number" &&
        typeof item["firstSeen"] === "string" &&
        typeof item["lastSeen"] === "string" &&
        typeof item["status"] === "string",
    ) &&
    value["suggestions"].every(
      (item) =>
        isRecord(item) &&
        typeof item["patchId"] === "string" &&
        typeof item["param"] === "string" &&
        typeof item["current"] === "number" &&
        typeof item["suggested"] === "number" &&
        (item["level"] === "warn" || item["level"] === "critical") &&
        typeof item["reason"] === "string",
    )
  );
}

function isGatewayPatchView(value: unknown): value is GatewayPatchView {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["title"] !== "string" ||
    typeof value["description"] !== "string" ||
    typeof value["target"] !== "string" ||
    !isRecord(value["params"])
  ) {
    return false;
  }
  if (
    value["requires"] !== undefined &&
    (!Array.isArray(value["requires"]) ||
      !value["requires"].every((item) => typeof item === "string"))
  ) {
    return false;
  }
  for (const schema of Object.values(value["params"])) {
    if (!isRecord(schema) || typeof schema["default"] !== "number") return false;
    if (schema["min"] !== undefined && typeof schema["min"] !== "number") return false;
    if (schema["max"] !== undefined && typeof schema["max"] !== "number") return false;
    if (schema["integer"] !== undefined && typeof schema["integer"] !== "boolean") return false;
  }
  const applied = value["applied"];
  if (applied !== null) {
    if (
      !isRecord(applied) ||
      !isRecord(applied["params"]) ||
      typeof applied["appliedAt"] !== "string" ||
      typeof applied["targetPath"] !== "string" ||
      !Object.values(applied["params"]).every((param) => typeof param === "number")
    ) {
      return false;
    }
  }
  const observed = value["observed"];
  if (observed === undefined || observed === null) return true;
  return (
    isRecord(observed) &&
    isRecord(observed["params"]) &&
    typeof observed["checkedAt"] === "string" &&
    typeof observed["targetPath"] === "string" &&
    Object.values(observed["params"]).every((param) => typeof param === "number")
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  if (!Object.values(value).every((entry) => typeof entry === "string")) return null;
  return value as Record<string, string>;
}

function parseMessageCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const state of MESSAGE_OUTBOX_STATES) {
    const count = value[state];
    if (!isNonNegativeNumber(count)) return null;
    counts[state] = count;
  }
  return counts;
}

/** 消息链路一键接管开关视图结构校验；缺字段或畸形一律视为旧 gateway（undefined）。 */
function parseRelayControl(value: unknown): { enabled: boolean; pending: boolean; updatedAt: string | null } | undefined {
  if (!isRecord(value) || typeof value["enabled"] !== "boolean" || typeof value["pending"] !== "boolean") {
    return undefined;
  }
  return {
    enabled: value["enabled"],
    pending: value["pending"],
    updatedAt: isNullableString(value["updatedAt"]) ? (value["updatedAt"] as string | null) : null,
  };
}

function parseMessageStatus(value: unknown): MessageStatusView | null {
  if (!isRecord(value) || !isRecord(value["bridge"])) return null;
  const bridge = value["bridge"];
  const counts = parseMessageCounts(value["counts"]);
  if (counts === null) {
    return null;
  }
  // Native Hermes mode intentionally has no Bridge metadata. Normalize the
  // compact native payload to the richer shape expected by existing pages.
  const booleanField = (name: string): boolean => bridge[name] === undefined ? false : bridge[name] as boolean;
  const nullableString = (name: string): string | null => bridge[name] === undefined ? null : bridge[name] as string | null;
  const protocolVersion = bridge["protocolVersion"] === undefined ? null : bridge["protocolVersion"];
  const channels = bridge["channels"] === undefined ? {} : parseStringRecord(bridge["channels"]);
  const channelDetails: MessageBridgeView["channelDetails"] = {};
  const channelDetailsRaw = bridge["channelDetails"];
  if (channelDetailsRaw !== undefined) {
    if (!isRecord(channelDetailsRaw)) return null;
    for (const [channel, value] of Object.entries(channelDetailsRaw)) {
      if (!isRecord(value) || typeof value["status"] !== "string" || typeof value["retryable"] !== "boolean" || !isNullableString(value["unavailableReason"]) || !isNullableString(value["unavailableFix"])) return null;
      const loginState = typeof value["loginState"] === "string" ? (value["loginState"] as string) : undefined;
      const account = isNullableString(value["account"]) ? (value["account"] as string | null) : undefined;
      channelDetails[channel] = {
        status: value["status"],
        retryable: value["retryable"],
        unavailableReason: value["unavailableReason"] as string | null,
        unavailableFix: value["unavailableFix"] as string | null,
        ...(loginState === undefined ? {} : { loginState }),
        ...(account === undefined ? {} : { account }),
      };
    }
  }
  const coverage = bridge["coverage"] === undefined ? {} : parseStringRecord(bridge["coverage"]);
  let runs: MessageBridgeView["runs"] | undefined;
  const runsRaw = bridge["runs"];
  if (runsRaw !== undefined) {
    if (
      !isRecord(runsRaw) ||
      !isNonNegativeNumber(runsRaw["total"]) ||
      !isNonNegativeNumber(runsRaw["failed"]) ||
      !isNonNegativeNumber(runsRaw["active"])
    ) {
      return null;
    }
    runs = { total: runsRaw["total"], failed: runsRaw["failed"], active: runsRaw["active"] };
  }
  if (
    !["connected", "running", "inFlight", "attached", "outboxWritable"].every((name) => bridge[name] === undefined || typeof bridge[name] === "boolean") ||
    !(protocolVersion === null || typeof protocolVersion === "number") ||
    channels === null ||
    coverage === null ||
    !["bridgeVersion", "instanceId", "policyVersion", "policyHash", "remotePolicyVersion", "startedAt", "lastCycleAt", "lastError"].every((name) => bridge[name] === undefined || isNullableString(bridge[name]))
  ) return null;
  return {
    bridge: {
      connected: booleanField("connected"),
      running: booleanField("running"),
      inFlight: booleanField("inFlight"),
      attached: booleanField("attached"),
      outboxWritable: booleanField("outboxWritable"),
      protocolVersion: protocolVersion as number | null,
      bridgeVersion: nullableString("bridgeVersion"),
      instanceId: nullableString("instanceId"),
      policyVersion: nullableString("policyVersion"),
      policyHash: nullableString("policyHash"),
      remotePolicyVersion: nullableString("remotePolicyVersion"),
      channels,
      ...(Object.keys(channelDetails).length > 0 ? { channelDetails } : {}),
      coverage,
      ...(runs === undefined ? {} : { runs }),
      startedAt: nullableString("startedAt"),
      lastCycleAt: nullableString("lastCycleAt"),
      lastError: nullableString("lastError"),
    },
    relay: parseRelayControl(value["relay"]),
    counts,
  };
}

function isMessageItemView(value: unknown): value is MessageItemView {
  return (
    isRecord(value) &&
    typeof value["messageId"] === "string" &&
    typeof value["instanceId"] === "string" &&
    typeof value["adapterId"] === "string" &&
    typeof value["channel"] === "string" &&
    isOptionalNullableString(value["accountId"]) &&
    typeof value["chatId"] === "string" &&
    isOptionalNullableString(value["threadId"]) &&
    typeof value["sessionId"] === "string" &&
    isOptionalNullableString(value["runId"]) &&
    isOptionalNullableString(value["inboundMessageId"]) &&
    typeof value["messageKind"] === "string" &&
    typeof value["transport"] === "string" &&
    typeof value["priority"] === "string" &&
    typeof value["content"] === "string" &&
    typeof value["contentSha256"] === "string" &&
    isOptionalNullableString(value["replyTo"]) &&
    isRecord(value["metadata"]) &&
    typeof value["capturedAt"] === "string" &&
    isNonNegativeNumber(value["sequence"]) &&
    typeof value["state"] === "string" &&
    isNullableString(value["availableAt"]) &&
    isNonNegativeNumber(value["attemptCount"]) &&
    isNullableString(value["providerMessageId"]) &&
    isNullableString(value["deliveredAt"]) &&
    isNullableString(value["lastError"]) &&
    Array.isArray(value["transformTrace"]) &&
    value["transformTrace"].every((entry) => typeof entry === "string") &&
    isNullableString(value["decisionId"]) &&
    isNullableString(value["lastPolicyError"]) &&
    typeof value["updatedAt"] === "string"
  );
}

function parseMessageList(value: unknown): MessageListView | null {
  if (!isRecord(value) || !Array.isArray(value["items"])) return null;
  const counts = parseMessageCounts(value["counts"]);
  if (counts === null || !value["items"].every(isMessageItemView)) return null;
  return { counts, items: value["items"] };
}

function isMessageTaskView(value: unknown): value is MessageTaskView {
  return (
    isRecord(value) &&
    typeof value["runId"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["state"] === "string" &&
    isNonNegativeNumber(value["lastEventSequence"]) &&
    typeof value["updatedAt"] === "string" &&
    Array.isArray(value["events"]) &&
    value["events"].every(
      (event) =>
        isRecord(event) &&
        typeof event["runId"] === "string" &&
        isNonNegativeNumber(event["sequence"]) &&
        typeof event["sessionId"] === "string" &&
        typeof event["kind"] === "string" &&
        isOptionalString(event["summary"]) &&
        (event["etaSec"] === undefined || isNonNegativeNumber(event["etaSec"])) &&
        typeof event["occurredAt"] === "string",
    )
  );
}

function parseMessageOptimizationHistory(value: unknown): MessageOptimizationHistoryView | null {
  if (!isRecord(value) || typeof value["reachable"] !== "boolean" || !Array.isArray(value["items"])) {
    return null;
  }
  const items: InboundHistoryEntry[] = [];
  for (const raw of value["items"]) {
    if (!isRecord(raw) || typeof raw["inboundMessageId"] !== "string") return null;
    const inbound = raw["inbound"];
    if (!isRecord(inbound) || typeof inbound["content"] !== "string") return null;
    const decision = raw["decision"];
    if (
      decision !== null &&
      (!isRecord(decision) ||
        typeof decision["optimizedText"] !== "string" ||
        !Array.isArray(decision["transformTrace"]) ||
        !decision["transformTrace"].every((entry) => typeof entry === "string") ||
        (decision["mode"] !== undefined && typeof decision["mode"] !== "string") ||
        (decision["changes"] !== undefined &&
          (!Array.isArray(decision["changes"]) ||
            !decision["changes"].every((entry) => typeof entry === "string"))))
    ) {
      return null;
    }
    const decisionView: InboundDecision | null =
      decision === null
        ? null
        : {
            inboundMessageId: raw["inboundMessageId"],
            action: decision["action"] === "consume-command" ? "consume-command" : "forward",
            optimizedText: decision["optimizedText"] as string,
            transformTrace: decision["transformTrace"] as string[],
            ...(decision["mode"] === undefined
              ? {}
              : { mode: decision["mode"] as "pass-through" | "quick" | "rule" | "llm" }),
            ...(decision["changes"] === undefined
              ? {}
              : { changes: decision["changes"] as string[] }),
          };
    items.push({
      inboundMessageId: raw["inboundMessageId"],
      inbound: inbound as unknown as InboundHistoryEntry["inbound"],
      decision: decisionView,
      decidedAt:
        typeof raw["decidedAt"] === "string" || raw["decidedAt"] === null
          ? raw["decidedAt"]
          : null,
    });
  }
  return { reachable: value["reachable"], items };
}

function emptyMessageList(): MessageListView {
  return {
    counts: Object.fromEntries(MESSAGE_OUTBOX_STATES.map((state) => [state, 0])),
    items: [],
  };
}

/** 打开共享 SQLite（web 只读语义）；任何失败（目录不可建/文件不可开）返回 null 走降级。 */
function openStore(home: string): SqliteStore | null {
  try {
    const paths = ensureButlerHome(home);
    return new SqliteStore(paths.dbFile);
  } catch {
    return null;
  }
}

/** 打开 Ollama 用量 SQLite；任何失败（目录不可建/文件不可开）返回 null 走降级。 */
function openOllamaUsageStore(home: string): OllamaUsageStore | null {
  try {
    const dataDir = path.join(home, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    return new OllamaUsageStore(path.join(dataDir, "ollama_usage.db"));
  } catch {
    return null;
  }
}

/** ui/dist 默认路径：src/ 与 dist/ 同为 apps/web 下一级，向上三级即仓库根。 */
function defaultUiDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "ui", "dist");
}

/** 从当前 index.html 读取实际被 Web 静态服务引用的入口 bundle，而非猜测构建产物。 */
function readBundleVersion(uiDist: string): string | null {
  try {
    const html = fs.readFileSync(path.join(uiDist, "index.html"), "utf8");
    return /(?:src=|href=)["']\/?assets\/(index-[A-Za-z0-9_-]+\.js)["']/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** query 里的 limit 归一化：非法值回落默认，上限 1000。 */
function clampLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 1000);
}

function parseCapability(raw: string | null): CapabilityReport | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as CapabilityReport;
  } catch {
    return null;
  }
}

/** instances 表原始行 → 面板视图（/api/instances 与 /api/dashboard 共用）。 */
function toInstanceViews(store: SqliteStore): InstanceApiView[] {
  return store.listInstances().map((row) => ({
    instanceId: row.instanceId,
    frameworkId: row.frameworkId,
    state: row.state,
    runtime: row.runtime,
    rootPath: row.rootPath,
    version: row.version,
    confidence: row.confidence,
    capability: parseCapability(row.capabilityJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/** 从单条 inspection-completed 事件提取巡检视图；payload 非对象或缺 instanceId 返回 null。 */
function toLatestInspection(event: StoredEvent): LatestInspectionView | null {
  if (event.payload === null || typeof event.payload !== "object") return null;
  const payload = event.payload as Record<string, unknown>;
  const instanceId = payload["instanceId"];
  if (typeof instanceId !== "string" || instanceId === "") return null;

  const checks: InspectionCheckView[] = [];
  if (Array.isArray(payload["checks"])) {
    for (const item of payload["checks"]) {
      if (item === null || typeof item !== "object") continue;
      const check = item as Record<string, unknown>;
      if (typeof check["id"] !== "string") continue;
      checks.push({
        id: check["id"],
        status: typeof check["status"] === "string" ? check["status"] : "unknown",
        detail: check["detail"] ?? null,
        durationMs: typeof check["durationMs"] === "number" ? check["durationMs"] : null,
      });
    }
  }

  return {
    instanceId,
    ts: event.ts,
    overall: typeof payload["overall"] === "string" ? payload["overall"] : null,
    confidence: typeof payload["confidence"] === "number" ? payload["confidence"] : null,
    checks,
  };
}

/**
 * 取每实例最新一条巡检结果（Task 10 纯函数）：
 * 传入 listEvents({ type: "inspection-completed" }) 的新在前列表，逐条扫描，
 * 每个 instanceId 只保留首个命中（即最新）；payload 异常的条目被跳过。
 */
export function latestInspectionsPerInstance(events: StoredEvent[]): LatestInspectionView[] {
  const byInstance = new Map<string, LatestInspectionView>();
  for (const event of events) {
    const view = toLatestInspection(event);
    if (view === null || byInstance.has(view.instanceId)) continue;
    byInstance.set(view.instanceId, view);
  }
  return [...byInstance.values()];
}

/** 巡检历史单日聚合行：次数 / 平均耗时 / 异常（overall 非 ok）次数。 */
export interface InspectionDayPoint {
  date: string;
  count: number;
  avgDurationMs: number | null;
  errorCount: number;
}

type InspectionAggregateRow = Pick<InspectionDayPoint, "date" | "count" | "avgDurationMs" | "errorCount">;

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
}

function inspectionWindow(days: number, now: Date): Map<string, { count: number; totalMs: number; timed: number; errors: number }> {
  const start = new Date(now.getTime());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const buckets = new Map<string, { count: number; totalMs: number; timed: number; errors: number }>();
  for (let i = 0; i < days; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    buckets.set(localDateKey(day), { count: 0, totalMs: 0, timed: 0, errors: 0 });
  }
  return buckets;
}

/** 将 SQLite 聚合行补齐为连续的本地日窗口。 */
export function inspectionDailyMetricsHistory(
  rows: InspectionAggregateRow[],
  days: number,
  now = new Date(),
): InspectionDayPoint[] {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("inspection history days must be an integer from 1 through 90");
  }
  const buckets = inspectionWindow(days, now);
  for (const row of rows) {
    const bucket = buckets.get(row.date);
    if (bucket === undefined) continue;
    bucket.count = row.count;
    bucket.errors = row.errorCount;
    if (row.avgDurationMs !== null) {
      bucket.totalMs = row.avgDurationMs;
      bucket.timed = 1;
    }
  }
  return [...buckets.entries()].map(([date, value]) => ({
    date,
    count: value.count,
    avgDurationMs: value.timed > 0 ? Math.round(value.totalMs / value.timed) : null,
    errorCount: value.errors,
  }));
}

/**
 * 近 N 天巡检按日聚合（本地时区）。传入新在前的 inspection-completed 事件列表；
 * payload 缺 durationMs 的条目只计入次数不参与均值。
 */
export function inspectionDailyHistory(events: StoredEvent[], days: number): InspectionDayPoint[] {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("inspection history days must be an integer from 1 through 90");
  }
  const buckets = inspectionWindow(days, new Date());
  for (const event of events) {
    const time = Date.parse(event.ts);
    if (Number.isNaN(time)) continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") continue;
    const day = new Date(time);
    const key = localDateKey(day);
    const bucket = buckets.get(key);
    if (bucket === undefined) continue;
    bucket.count += 1;
    if (
      typeof payload["overall"] === "string" &&
      payload["overall"] !== "ok" &&
      payload["overall"] !== "healthy"
    ) {
      bucket.errors += 1;
    }
    // 全部 check 的可计时部分取平均作为本次巡检耗时；无法计时的巡检不参与均值。
    if (Array.isArray(payload["checks"])) {
      let sumMs = 0;
      let timed = 0;
      for (const check of payload["checks"] as Array<unknown>) {
        if (
          check !== null &&
          typeof check === "object" &&
          typeof (check as Record<string, unknown>)["durationMs"] === "number"
        ) {
          sumMs += (check as Record<string, unknown>)["durationMs"] as number;
          timed += 1;
        }
      }
      if (timed > 0) {
        bucket.totalMs += sumMs / timed;
        bucket.timed += 1;
      }
    }
  }
  return [...buckets.entries()].map(([date, value]) => ({
    date,
    count: value.count,
    avgDurationMs: value.timed > 0 ? Math.round(value.totalMs / value.timed) : null,
    errorCount: value.errors,
  }));
}

interface RemoteServiceHealth {
  reachable: boolean;
  serviceVersion: string | null;
  schemaVersion: string | null;
  /** /healthz 往返耗时（毫秒）；探测失败（不可达/畸形响应）为 null。 */
  latencyMs: number | null;
}

/** 探测本地服务健康与控制面版本。畸形响应也视为不可用，避免伪造同步状态。 */
async function probeServiceHealth(
  doFetch: typeof fetch,
  serviceUrl: string,
): Promise<RemoteServiceHealth> {
  const startedAt = Date.now();
  try {
    const res = await doFetch(`${serviceUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false, serviceVersion: null, schemaVersion: null, latencyMs: null };
    const body = (await res.json()) as unknown;
    if (!isRecord(body) || body["ok"] !== true) {
      return { reachable: false, serviceVersion: null, schemaVersion: null, latencyMs: null };
    }
    return {
      reachable: true,
      serviceVersion: typeof body["serviceVersion"] === "string" ? body["serviceVersion"] : null,
      schemaVersion: typeof body["schemaVersion"] === "string" ? body["schemaVersion"] : null,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return { reachable: false, serviceVersion: null, schemaVersion: null, latencyMs: null };
  }
}

/**
 * 监听地址是否为本机回环（IPv4/IPv6 与 localhost 别名）。
 * 导出的原因：main.ts 启动自检需要同样的判定，两处口径必须一致。
 */
export function isLoopback(host: string): boolean {
  const value = hostNameOf(host);
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value === "::ffff:127.0.0.1") return true;
  return value.startsWith("127.");
}

function readPositiveDuration(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 60 * 60_000) : fallback;
}

/**
 * 组装 butler-web 服务：静态 SPA + 只读 API + /ws 事件流。
 * 返回 Fastify 实例但不 listen —— 由 main.ts（或测试 inject）驱动。
 */
export function createWebServer(options: WebServerOptions = {}): FastifyInstance {
  const home = options.home ?? resolveButlerHome();
  const gatewayUrl = options.gatewayUrl ?? process.env["BUTLER_GATEWAY_URL"] ?? DEFAULT_GATEWAY_URL;
  const watchUrl = options.watchUrl ?? process.env["BUTLER_WATCH_URL"] ?? DEFAULT_WATCH_URL;
  const ollamaUrl = options.ollamaUrl ?? process.env["BUTLER_OLLAMA_URL"] ?? DEFAULT_OLLAMA_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const uiDist = path.resolve(options.uiDist ?? defaultUiDist());
  const bundleVersion = readBundleVersion(uiDist);
  const listenHost = process.env["BUTLER_WEB_HOST"]?.trim() || "127.0.0.1";
  const publishHost =
    options.publishHost?.trim() || process.env["BUTLER_WEB_PUBLISH_HOST"]?.trim() || listenHost;
  const accessToken = (options.accessToken ?? process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();

  const app = Fastify({ logger: false });
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
  const { fetchWatch, proxyWatchPost, proxyWatchGet } = proxy;

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
      warnings.push(`面板发布在 ${publishHost} 且没有访问口令，同一网络内的任何人都能操作你的 AI，请立即处理。`);
    }
    return { listenHost, publishHost, loopback, auth, warnings };
  });

  /* ------------------------------ Ollama 本地模型管理 ------------------------------ */
  void registerOllamaRoutes(app, { ollamaUrl, ollamaUsageStore });

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
