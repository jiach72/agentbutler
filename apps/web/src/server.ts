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
import { fileURLToPath } from "node:url";
import {
  CONTROL_API_SCHEMA_VERSION,
  CONTRACT_VERSION,
  MEMORY_PREVIEW_LIMIT,
  type CapabilityReport,
  type InboundDecision,
  type InboundHistoryEntry,
  type JobStep,
} from "@butler/contract";
import { ensureButlerHome, resolveButlerHome, SqliteStore, type StoredEvent } from "@butler/core";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { recentEventsAscending, selectNewEvents } from "./events-pump.js";

export const WEB_VERSION = `web@1.0.0-beta.21+${CONTRACT_VERSION}`;

/** 告警网关默认基址（butler-gateway 的固定回环端口）。 */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7532";

/** watch HTTP 控制通道默认基址（butler-watch 的固定回环端口）。 */
export const DEFAULT_WATCH_URL = "http://127.0.0.1:7533";

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
  for (const key of ["pending", "delivering", "delivered", "failed"] as const) {
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
 * 首次使用便利通道：从本机浏览器打开 127.0.0.1/localhost 时无需查找口令。
 * 局域网请求仍必须携带口令；Origin 存在时还要求它也是本机来源，
 * 没有 Origin 时要求浏览器 Fetch Metadata 标记为同源，避免普通请求伪造本机 Host。
 */
function isLocalBrowserRequest(request: {
  headers: Record<string, unknown>;
}): boolean {
  const host = typeof request.headers.host === "string" ? hostNameOf(request.headers.host) : "";
  if (!isLoopback(host)) return false;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.trim() !== "") return isLoopbackOrigin(origin);
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite === "same-origin" || fetchSite === "none";
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
  detail: string | null = "Watch 控制通道不可达",
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
    hermes: { status: "unknown", root: null, detail: "尚未读取 Watch 状态" },
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
}

/** 探测本地服务健康与控制面版本。畸形响应也视为不可用，避免伪造同步状态。 */
async function probeServiceHealth(
  doFetch: typeof fetch,
  serviceUrl: string,
): Promise<RemoteServiceHealth> {
  try {
    const res = await doFetch(`${serviceUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false, serviceVersion: null, schemaVersion: null };
    const body = (await res.json()) as unknown;
    if (!isRecord(body) || body["ok"] !== true) {
      return { reachable: false, serviceVersion: null, schemaVersion: null };
    }
    return {
      reachable: true,
      serviceVersion: typeof body["serviceVersion"] === "string" ? body["serviceVersion"] : null,
      schemaVersion: typeof body["schemaVersion"] === "string" ? body["schemaVersion"] : null,
    };
  } catch {
    return { reachable: false, serviceVersion: null, schemaVersion: null };
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
  const doFetch = options.fetchImpl ?? fetch;
  const uiDist = path.resolve(options.uiDist ?? defaultUiDist());
  const bundleVersion = readBundleVersion(uiDist);
  const listenHost = process.env["BUTLER_WEB_HOST"]?.trim() || "127.0.0.1";
  const publishHost =
    options.publishHost?.trim() || process.env["BUTLER_WEB_PUBLISH_HOST"]?.trim() || listenHost;
  const accessToken = (options.accessToken ?? process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();

  const app = Fastify({ logger: false });
  let store = openStore(home);

  // /ws 轮询定时器登记：连接断开或服务关闭时统一清理。
  const wsTimers = new Set<ReturnType<typeof setInterval>>();

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

    if (isLocalBrowserRequest(request as unknown as { headers: Record<string, unknown> })) return;

    const presented = extractRequestToken(
      request as unknown as { headers: Record<string, unknown>; url: string },
    );
    if (presented === accessToken) return;

    reply.code(401);
    return reply.send({ error: "unauthorized", reason: "需要访问口令" });
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

  app.addHook("onClose", async () => {
    for (const timer of wsTimers) clearInterval(timer);
    wsTimers.clear();
    store?.close();
    store = null;
  });

  const getStore = (): SqliteStore | null => {
    if (store === null) store = openStore(home); // db 缺失时每个 tick 静默重试
    return store;
  };

  /* ------------------------------ 静态 SPA 服务 ------------------------------ */

  const staticReady = fs.existsSync(uiDist);
  if (staticReady) {
    app.register(fastifyStatic, { root: uiDist });
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

  app.get("/api/health", async () => {
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
      services: {
        gateway: gatewayHealth,
        watch: watchHealth,
      },
    };
  });

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
      const res = await doFetch(`${gatewayUrl}/api/alerts`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return degradedAlerts();
      return parseAlertsView(await res.json()) ?? degradedAlerts();
    } catch {
      return degradedAlerts();
    }
  };

  /** Read-only gateway fetch with transport failures collapsed to null for partitioned degradation. */
  const fetchGateway = async (gatewayPath: string): Promise<Response | null> => {
    try {
      return await doFetch(`${gatewayUrl}${gatewayPath}`, { signal: AbortSignal.timeout(5000) });
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
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

  // 告警代理：网关不可达/响应异常一律 200 + 降级载荷（面板显示"告警通道不可达"黄条）。
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

  // 消息网关状态轻量代理：首页高频轮询此接口，避免把历史未送达告警误判成 Bridge 离线。
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
  // 通道目录代理：国内 IM 通道的登录态与健康一览（gateway 不可达/非 2xx 一律 502 降级）。
  app.get("/api/messages/channels", async (_request, reply) => {
    const res = await fetchGateway("/api/messages/channels");
    if (res === null || !res.ok) return reply.status(502).send({ error: "gateway-unreachable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ channels: [] })));
  });
  app.post("/api/messages/reconnect", async (request, reply) =>
    proxyGatewayPost("/api/messages/reconnect", request.body, reply),
  );
  // 消息链路一键接管切换：响应体与状态码原样透传 gateway（含离线 pending 语义）。
  app.post("/api/messages/relay", async (request, reply) =>
    proxyGatewayPost("/api/messages/relay", request.body, reply),
  );
  // 求助提示词转发给智能体：gateway 侧调 Hermes api_server 聊天接口（LLM 回合可能
  // 需要数十秒到数分钟），代理超时放宽到 200s。
  app.post("/api/agent-message", async (request, reply) => {
    let res: Response;
    try {
      res = await doFetch(`${gatewayUrl}/api/agent-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
  // 微信扫码登录代理：POST 动作原样透传 gateway；GET status 携带 sessionId 查询透传
  // （不可达/非 2xx 一律 502 降级，模式同 GET /api/messages/channels）。
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
  // 通道启停与首次接入代理：schema/配置/启停四路由同名透传 gateway
  // （响应体含掩码回显与 restarting 标记，原样转发；不可达/非 2xx 一律 502 降级）。
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

  /* ---------------------- watch 控制通道代理（Task 10） ---------------------- */

  /** GET watch 控制通道；不可达/超时返回 null（调用方走各自降级策略）。 */
  const fetchWatch = async (watchPath: string, timeoutMs = 5_000): Promise<Response | null> => {
    try {
      return await doFetch(`${watchUrl}${watchPath}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return null;
    }
  };

  app.get("/api/runtime", async (_request, reply) => {
    const res = await fetchWatch("/api/runtime");
    if (res === null) return reply.status(503).send({ kind: "unknown", detail: "管家控制通道不可达" });
    return reply.status(res.status).send(await res.json().catch(() => ({ kind: "unknown", detail: "运行时响应无效" })));
  });

  /**
   * POST 转发 watch 控制通道，响应（状态码 + body）原样透传；
   * 不可达/超时 → 502 { error: "watch-unreachable" }（面板提示控制通道离线）。
   */
  const proxyWatchPost = async (
    watchPath: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs = 5_000,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
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

  /** GET 代理与 POST 代理保持同样的错误语义，供进化任务详情等控制面读取使用。 */
  const proxyWatchGet = async (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs = 5_000,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
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

  // runbook 列表：watch 不可达/异常一律 200 + 降级载荷（面板显示"watch 控制通道离线"提示条）。
  app.get("/api/runbooks", async () => {
    const res = await fetchWatch("/api/runbooks");
    if (res === null || !res.ok) return { reachable: false, runbooks: [] as unknown[] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, runbooks: (body["runbooks"] as unknown[] | undefined) ?? [] };
    } catch {
      return { reachable: false, runbooks: [] as unknown[] };
    }
  });

  /** 首次使用向导状态：只返回可操作的连接摘要，不把宿主路径当成主界面文案。 */
  app.get("/api/setup/status", async () => {
    const res = await fetchWatch("/api/connections");
    if (res === null || !res.ok) {
      return { reachable: false, configured: false, connections: [] as unknown[] };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const connections = Array.isArray(body["connections"]) ? body["connections"] : [];
      return {
        reachable: true,
        configured: connections.some((item) => isRecord(item) && item["connected"] === true),
        connections,
      };
    } catch {
      return { reachable: false, configured: false, connections: [] as unknown[] };
    }
  });

  // runbook 执行：body 透传转发；watch 的 202/404/409/503 原样透传（状态码+body）。
  app.post("/api/runbooks/:id/execute", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/runbooks/${id}/execute`, request.body, reply);
  });

  // 熔断人工解除：透传 watch 的 200/404/409/503，解除动作由 watch 追加审计记录。
  app.post("/api/runbooks/:id/reset", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/runbooks/${id}/reset`, request.body, reply);
  });

  // 巡检状态：不可达 → 200 { reachable: false }（巡检控制卡显示离线态）。
  app.get("/api/inspect/status", async () => inspectStatusFromWatch());

  // 立即巡检：透传 watch 的 202/409 等；不可达 → 502。
  app.post("/api/inspect/run", async (_request, reply) =>
    proxyWatchPost("/api/inspect/run", {}, reply),
  );

  app.post("/api/recovery/diagnose", async (request, reply) =>
    proxyWatchPost("/api/recovery/diagnose", request.body, reply),
  );

  app.post("/api/recovery/actions/:id/execute", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/recovery/actions/${id}/execute`, request.body, reply, 70_000);
  });

  app.get("/api/recovery/jobs/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/recovery/jobs/${id}`, reply);
  });

  /** 连接管理视图：watch 不可达时保留明确的降级标记，不伪造实例已连接。 */
  app.get("/api/connections", async () => {
    const res = await fetchWatch("/api/connections");
    if (res === null || !res.ok) return { reachable: false, connections: [] as ConnectionApiView[] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const connections = Array.isArray(body["connections"]) ? body["connections"] : [];
      return {
        reachable: true,
        checkedAt: typeof body["checkedAt"] === "string" ? body["checkedAt"] : new Date().toISOString(),
        connections: connections as ConnectionApiView[],
      };
    } catch {
      return { reachable: false, connections: [] as ConnectionApiView[] };
    }
  });

  app.post("/api/connections/check", async (request, reply) =>
    proxyWatchPost("/api/connections/check", request.body, reply),
  );

  app.post("/api/connections/:id/connect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/connections/${id}/connect`, request.body, reply, 70_000);
  });

  app.post("/api/connections/:id/disconnect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/connections/${id}/disconnect`, request.body, reply, 70_000);
  });

  app.get("/api/openclaw/status", async (_request, reply) => {
    const res = await fetchWatch("/api/openclaw/status");
    if (res === null) return reply.status(503).send({ error: "openclaw-status-unavailable" });
    return reply.status(res.status).send(await res.json().catch(() => ({ error: "invalid-response" })));
  });

  /* --------------------- 升级与快照代理（Task 13.3） --------------------- */

  /** 代理 watch /api/upgrade/status；不可达/响应异常 → job:null。 */
  const upgradeStatusFromWatch = async (): Promise<{
    watchOk: boolean;
    job: UpgradeJobView | null;
  }> => {
    const res = await fetchWatch("/api/upgrade/status");
    if (res === null || !res.ok) return { watchOk: false, job: null };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const job = body["job"];
      return {
        watchOk: true,
        job: job !== null && typeof job === "object" ? (job as UpgradeJobView) : null,
      };
    } catch {
      return { watchOk: true, job: null };
    }
  };

  /** 代理 watch /api/upgrade/versions；不可达/响应异常 → reachable:false 空列表。 */
  const availableVersionsFromWatch = async (): Promise<{
    watchOk: boolean;
    view: AvailableVersionsView;
  }> => {
    const res = await fetchWatch("/api/upgrade/versions");
    if (res === null || !res.ok)
      return { watchOk: false, view: { reachable: false, versions: [] } };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const view: AvailableVersionsView = {
        reachable: body["reachable"] === true,
        versions: Array.isArray(body["versions"])
          ? (body["versions"] as AvailableVersionsView["versions"])
          : [],
      };
      if (typeof body["source"] === "string" && body["source"] !== "") view.source = body["source"];
      if (typeof body["checkedAt"] === "string") view.checkedAt = body["checkedAt"];
      if (Array.isArray(body["attempts"])) view.attempts = body["attempts"] as AvailableVersionsView["attempts"];
      return { watchOk: true, view };
    } catch {
      return { watchOk: true, view: { reachable: false, versions: [] } };
    }
  };

  // 版本页一次聚合：实例当前版本与快照历史直读共享 SQLite，升级 Job 与可用版本源代理
  // watch（两路并发）；db 不可达时 instances/snapshots 为空数组并附 degraded 标记。
  app.get("/api/versions", async () => {
    const instances: VersionsApiView["instances"] =
      store === null
        ? []
        : store.listInstances().map((row) => ({
            instanceId: row.instanceId,
            state: row.state,
            runtime: row.runtime,
            version: row.version,
          }));
    const snapshots: VersionsApiView["snapshots"] =
      store === null
        ? []
        : store.listSnapshots().map((row) => ({
            id: row.id,
            instance: row.instance,
            label: row.label,
            createdAt: row.createdAt,
            status: row.status,
          }));
    const [status, versions] = await Promise.all([
      upgradeStatusFromWatch(),
      availableVersionsFromWatch(),
    ]);
    return {
      instances,
      upgradeJob: status.job,
      availableVersions: versions.view,
      snapshots,
      watchReachable: status.watchOk || versions.watchOk,
      ...(store === null ? { degraded: ["db:unreachable"] } : {}),
    };
  });

  // 发起升级包含升级前备份，可能超过普通控制请求的 5 秒；必须给备份和流水线
  // 足够时间完成登记，否则 Web 会误报“未执行”，而 watch 仍在后台继续升级。
  app.post("/api/upgrade/run", async (request, reply) =>
    proxyWatchPost("/api/upgrade/run", request.body, reply, 120_000),
  );
  app.post("/api/upgrade/compatibility", async (request, reply) =>
    proxyWatchPost("/api/upgrade/compatibility", request.body, reply),
  );

  // 快照回滚：:id 为 snapshots 表行 id；watch 的 200/404/503 原样透传，不可达 → 502。
  app.post("/api/snapshots/:id/rollback", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/snapshots/${id}/rollback`, request.body, reply);
  });

  /* --------------------- 消息网关聚合与补丁代理（Task 15.2） --------------------- */

  /** 代理 watch /api/gateway/stats；不可达/响应异常 → stats null（面板显示 watch 离线横幅）。 */
  const gatewayStatsFromWatch = async (): Promise<{
    watchOk: boolean;
    stats: GatewayStatsView | null;
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

  /** 代理 watch /api/gateway/patches；不可达/响应异常 → 空列表。 */
  const gatewayPatchesFromWatch = async (): Promise<{
    watchOk: boolean;
    patches: GatewayPatchView[];
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

  // 消息网关页一次聚合：限流统计与补丁清单代理 watch，告警队列直连网关（三路并发）；
  // watch 不可达/响应异常时对应字段降级（rateLimit null / patches 空数组），不 5xx。
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

  // Message data-plane overview. Status and outbox projection are read concurrently and validated
  // independently so one malformed upstream partition cannot inject arbitrary values into React.
  app.get("/api/messages/overview", async (request): Promise<MessageOverviewApiView> => {
    const query = request.query as Record<string, unknown>;
    const rawLimit = Number(query["limit"]);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 60;
    const [statusResponse, messagesResponse] = await Promise.all([
      fetchGateway("/api/messages/status"),
      fetchGateway(`/api/messages?limit=${String(limit)}`),
    ]);

    let status: MessageStatusView | null = null;
    let messages: MessageListView | null = null;
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

  // 补丁应用：body（参数草稿）透传转发；watch 的 200/400/404/409/503 原样透传，不可达 → 502。
  // M5 入站消息优化对照历史：网关不可达/响应异常 → 降级空载荷（面板显示离线横幅）。
  app.get("/api/messages/optimization-history", async (request): Promise<MessageOptimizationHistoryView> => {
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

  /** 送达历史代理：网关独立历史表保留 365 天，端点原样返回空档补零后的序列。 */
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

  app.post("/api/gateway/patches/:id/apply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/apply`, request.body, reply);
  });

  // 补丁重打（升级覆盖目标文件后恢复补丁）：透传语义同 apply。
  app.post("/api/gateway/patches/:id/reapply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/reapply`, request.body, reply);
  });

  // 补丁漂移检测（watch 侧为 POST）：200 漂移报告 / 404 / 503 原样透传，不可达 → 502。
  app.post("/api/gateway/patches/:id/detect", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/detect`, request.body, reply);
  });
  app.post("/api/gateway/patches/:id/preview", async (request, reply) => {
    const id = encodeURIComponent((request.params as Record<string, string>)["id"] ?? "");
    return proxyWatchPost(`/api/gateway/patches/${id}/preview`, request.body, reply);
  });

  /* ------------------------ 技能与记忆只读代理（Task 17） ------------------------ */

  app.get("/api/skills", async (request): Promise<SkillsApiView> => {
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
      return parsed === null ? degradedSkills() : { watchReachable: true, ...parsed };
    } catch {
      return degradedSkills();
    }
  });

  app.get("/api/butler/version", async () => {
    const res = await fetchWatch("/api/butler/version");
    if (res === null || !res.ok) {
      return {
        reachable: false,
        version: null,
        source: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repositoryConfigured: false,
        repositorySource: "configured-default",
        changelog: null,
        checkedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        version: null,
        source: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repositoryConfigured: false,
        repositorySource: "configured-default",
        changelog: null,
        checkedAt: null,
      };
    }
  });

  // 管家自身版本管理（V1.7）：状态 / 一键升级 / 回滚 / 更新偏好（透传 watch）。
  app.get("/api/butler/self", async () => {
    // Watch 刷新状态时会访问 Updater/GitHub，允许网络探测有更长的尾延迟。
    const res = await fetchWatch("/api/butler/self", 30_000);
    if (res === null || !res.ok) {
      return {
        reachable: false,
        source: null,
        version: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repoClean: true,
        remoteConfigured: false,
        prefs: { channel: "stable", locked: false },
        snapshots: [],
        availableUpdates: [],
        lastJob: null,
        checkedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        source: null,
        version: null,
        branch: null,
        commit: null,
        tag: null,
        repository: null,
        repoClean: true,
        remoteConfigured: false,
        prefs: { channel: "stable", locked: false },
        snapshots: [],
        availableUpdates: [],
        lastJob: null,
        checkedAt: null,
      };
    }
  });

  app.post("/api/butler/self/upgrade", async (request, reply) =>
    proxyWatchPost("/api/butler/self/upgrade", request.body, reply, 10 * 60_000),
  );

  app.post("/api/butler/self/rollback", async (request, reply) =>
    proxyWatchPost("/api/butler/self/rollback", request.body, reply),
  );

  app.post("/api/butler/self/prefs", async (request, reply) =>
    proxyWatchPost("/api/butler/self/prefs", request.body, reply),
  );

  /* --------------------------- M7 备份 / 安全 / 审计（Task 18） --------------------------- */

  // 备份时间线 + 状态（watch 不可达 → 降级空列表，不 5xx）。
  app.get("/api/backups", async () => {
    const res = await fetchWatch("/api/backups");
    if (res === null || !res.ok) {
      return { items: [], status: null, watchReachable: false };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { watchReachable: true, ...body };
    } catch {
      return { items: [], status: null, watchReachable: false };
    }
  });

  // 手动备份（立即备份）。
  app.post("/api/backups", async (request, reply) =>
    proxyWatchPost("/api/backups", request.body, reply),
  );

  // 还原备份（先做当前态快照；确认词由前端二次确认承载）。
  app.post("/api/backups/:id/restore", async (request, reply) =>
    proxyWatchPost(`/api/backups/${(request.params as Record<string, string>)["id"]}/restore`, request.body, reply),
  );

  // 安全基线：三条配置不变式 + 密钥文件权限扫描。
  app.get("/api/security", async () => {
    const res = await fetchWatch("/api/security");
    if (res === null || !res.ok) {
      return {
        watchReachable: false,
        checkedAt: null,
        invariants: [],
        secrets: [],
        totalSecretFiles: 0,
        insecureSecretFiles: 0,
        message: "管家服务暂时连不上，安全检查稍后再试。",
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { watchReachable: true, ...body };
    } catch {
      return {
        watchReachable: false,
        checkedAt: null,
        invariants: [],
        secrets: [],
        totalSecretFiles: 0,
        insecureSecretFiles: 0,
        message: "安全检查结果暂时读不到。",
      };
    }
  });

  // 追加式审计日志（只读，只增不改；直接读共享 SQLite）。
  app.get("/api/audit", async (request) => {
    if (store === null) return { items: [], degraded: ["db:unreachable"] };
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query["limit"] === "string" ? query["limit"] : "100";
    const limit = Math.min(Math.max(1, Number(limitRaw) || 100), 500);
    return { items: store.listAudit({ limit }) };
  });

    /* --------------------------- 系统日志只读代理（V1.7） --------------------------- */

  app.get("/api/logs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["instanceId"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    const res = await fetchWatch(`/api/logs${suffix}`);
    if (res === null || !res.ok) return { reachable: false, sources: [] };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return { reachable: false, sources: [] };
    }
  });

  app.get("/api/logs/analyze", async (request) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["instanceId"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    const res = await fetchWatch(`/api/logs/analyze${suffix}`);
    if (res === null || !res.ok) {
      return {
        reachable: false,
        issues: [],
        scannedSources: 0,
        scannedLines: 0,
        analyzedAt: null,
      };
    }
    try {
      const body = (await res.json()) as Record<string, unknown>;
      return { reachable: true, ...body };
    } catch {
      return {
        reachable: false,
        issues: [],
        scannedSources: 0,
        scannedLines: 0,
        analyzedAt: null,
      };
    }
  });

  app.post("/api/logs/fix", async (request, reply) =>
    proxyWatchPost("/api/logs/fix", request.body, reply),
  );

  app.get("/api/logs/fix/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string })["id"] ?? "");
    return proxyWatchGet(`/api/logs/fix/${id}`, reply);
  });
  app.get("/api/logs/:sourceId", async (request, reply) => {
    const params = request.params as { sourceId?: string };
    const query = request.query as Record<string, unknown>;
    const search = new URLSearchParams();
    for (const key of ["instanceId", "limit"] as const) {
      const value = query[key];
      if (typeof value === "string" && value !== "") search.set(key, value);
    }
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    const id = encodeURIComponent(params["sourceId"] ?? "");
    const res = await fetchWatch(`/api/logs/${id}${suffix}`);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable" });
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

  /* ---------------------- 核心 Markdown 文件代理 ---------------------- */
  app.get("/api/markdown/files", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["instanceId"] === "string" && query["instanceId"].trim() !== "") params.set("instanceId", query["instanceId"].trim());
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
    return proxyWatchPost(`/api/markdown/files/${encodeURIComponent(params.fileId ?? "")}/revisions/${encodeURIComponent(params.revisionId ?? "")}/restore`, request.body, reply, 30_000);
  });
  app.get("/api/markdown/files/:fileId/download", async (request, reply) => {
    const id = encodeURIComponent((request.params as { fileId?: string })["fileId"] ?? "");
    const res = await fetchWatch(`/api/markdown/files/${id}/download`, 20_000);
    if (res === null) return reply.status(502).send({ error: "watch-unreachable", nextStep: "确认管家服务正在运行后重试。" });
    const raw = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      try { return reply.status(res.status).send(JSON.parse(raw.toString("utf8")) as unknown); }
      catch { return reply.status(res.status).send({ error: "markdown-download-failed", nextStep: "重新读取文件后重试。" }); }
    }
    const contentType = res.headers.get("content-type") ?? "text/markdown; charset=utf-8";
    const disposition = res.headers.get("content-disposition");
    if (disposition !== null) reply.header("content-disposition", disposition);
    return reply.type(contentType).send(raw);
  });

  /* ---------------------- 记忆观察与管理动作代理（V1.7） ---------------------- */

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
    proxyWatchPost("/api/memory/rebuild-index", request.body, reply),
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
    const res = await fetchWatch(format === "zip" ? "/api/diagnostics/report?format=zip" : "/api/diagnostics/report");
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
      res.headers.get("content-disposition") ?? (format === "zip" ? 'attachment; filename="agent-butler-diagnostic.zip"' : 'attachment; filename="agent-butler-diagnostic.md"');
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

  /* -------------------------- 进化守门代理（Task 16） -------------------------- */

  const evolutionStatusHandler = async (): Promise<EvolutionApiView> => {
    const res = await fetchWatch("/api/evolution/status");
    if (res === null) return degradedEvolution("watch-unreachable", "Watch 控制通道不可达");
    if (res.status === 404)
      return degradedEvolution("watch-route-missing", "当前 Watch 实例未提供进化状态接口，请同步部署 Watch");
    if (!res.ok)
      return degradedEvolution("watch-unreachable", `Watch 返回 HTTP ${String(res.status)}，无法读取进化状态`);
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
      if (typeof query["instanceId"] === "string") params.set("instanceId", query["instanceId"] as string);
      if (typeof query["range"] === "string") params.set("range", query["range"] as string);
      return proxyWatchGet(`/api/evolution/${path}` + (params.size > 0 ? `?${params.toString()}` : ""), reply, 30_000);
    });
  }
  app.post("/api/evolution/analyze", async (request, reply) => proxyWatchPost("/api/evolution/analyze", request.body, reply, 30_000));
  app.post("/api/evolution/action-items/:id/recheck", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/action-items/${id}/recheck`, request.body, reply, 30_000);
  });

  app.get("/api/evolution/insights", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    if (typeof query["instanceId"] === "string") params.set("instanceId", query["instanceId"] as string);
    if (typeof query["range"] === "string") params.set("range", query["range"] as string);
    return proxyWatchGet("/api/evolution/insights" + (params.size > 0 ? "?" + params.toString() : ""), reply, 30_000);
  });
  app.post("/api/evolution/directions/:id/:action", async (request, reply) => {
    const params = request.params as { id?: string; action?: string };
    if (!["summarize", "confirm", "start"].includes(params.action ?? "")) return reply.status(404).send({ error: "not-found" });
    const id = encodeURIComponent(params.id ?? "");
    return proxyWatchPost(`/api/evolution/directions/${id}/${params.action}`, request.body, reply, 70_000);
  });

  // 外部协助 Hermes 改进工作台（与旧 self-evolution CLI 兼容并存）。
  app.get("/api/evolution/targets", async (_request, reply) => proxyWatchGet("/api/evolution/targets", reply));
  app.get("/api/evolution/proposals", async (_request, reply) => proxyWatchGet("/api/evolution/proposals", reply));
  app.post("/api/evolution/proposals", async (request, reply) => proxyWatchPost("/api/evolution/proposals", request.body, reply, 30_000));
  app.get("/api/evolution/proposals/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchGet(`/api/evolution/proposals/${id}`, reply);
  });

  // 技能资产中心代理：统计、生命周期、公开趋势和隔离安装均透传 Watch 语义。
  app.get("/api/skills/usage", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["range", "granularity"] as const) if (typeof query[key] === "string") params.set(key, query[key] as string);
    return proxyWatchGet("/api/skills/usage" + (params.size > 0 ? "?" + params.toString() : ""), reply);
  });
  app.post("/api/skills/:name/:action", async (request, reply) => {
    const params = request.params as { name?: string; action?: string };
    if (!["archive", "restore", "purge"].includes(params.action ?? "")) return reply.status(404).send({ error: "not-found" });
    return proxyWatchPost("/api/skills/" + encodeURIComponent(params.name ?? "") + "/" + params.action, request.body, reply);
  });
  app.get("/api/skills/github-trends", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const key of ["filter", "sort"] as const) if (typeof query[key] === "string") params.set(key, query[key] as string);
    return proxyWatchGet("/api/skills/github-trends" + (params.size > 0 ? "?" + params.toString() : ""), reply);
  });
  app.post("/api/skills/github-trends/refresh", async (_request, reply) => proxyWatchPost("/api/skills/github-trends/refresh", {}, reply, 30_000));
  app.get("/api/skills/recommendations", async (_request, reply) => proxyWatchGet("/api/skills/recommendations", reply));
  app.post("/api/skills/recommendations/:id/stage", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost("/api/skills/recommendations/" + id + "/stage", request.body, reply, 30_000);
  });
  app.post("/api/skills/staged/:id/install", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost("/api/skills/staged/" + id + "/install", request.body, reply, 30_000);
  });
  app.post("/api/evolution/proposals/:id/validate", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/proposals/${id}/validate`, request.body, reply, 30_000);
  });
  app.post("/api/evolution/proposals/:id/apply", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/evolution/proposals/${id}/apply`, request.body, reply, 30_000);
  });

  app.get("/api/llm/profiles", async (_request, reply) => proxyWatchGet("/api/llm/profiles", reply));
  app.post("/api/llm/profiles", async (request, reply) => proxyWatchPost("/api/llm/profiles", request.body, reply, 30_000));
  app.get("/api/llm/bindings", async (_request, reply) => proxyWatchGet("/api/llm/bindings", reply));
  app.post("/api/llm/bindings", async (request, reply) => proxyWatchPost("/api/llm/bindings", request.body, reply));
  app.get("/api/llm/status", async (_request, reply) => proxyWatchGet("/api/llm/status", reply));
  app.get("/api/llm/discovered", async (_request, reply) => proxyWatchGet("/api/llm/discovered", reply));
  app.post("/api/llm/discovered/:id/import", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    return proxyWatchPost(`/api/llm/discovered/${id}/import`, request.body, reply, 30_000);
  });
  app.post("/api/llm/profiles/:id/:action", async (request, reply) => {
    const params = request.params as { id?: string; action?: string };
    if (!["rotate", "probe", "disable"].includes(params.action ?? "")) return reply.status(404).send({ error: "not-found" });
    return proxyWatchPost(`/api/llm/profiles/${encodeURIComponent(params.id ?? "")}/${params.action}`, request.body, reply, 30_000);
  });
  app.delete("/api/llm/bindings/:id", async (request, reply) => {
    const id = encodeURIComponent((request.params as { id?: string }).id ?? "");
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}/api/llm/bindings/${id}`, { method: "DELETE", signal: AbortSignal.timeout(5_000) });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    const raw = await res.text();
    if (raw === "") return reply.status(res.status).send();
    try { return reply.status(res.status).send(JSON.parse(raw)); }
    catch { return reply.status(502).send({ error: "watch-invalid-response" }); }
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

  /* ---------------------- 提示词优化代理（M5 切片 1/2） ---------------------- */

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

  /* ---------------------- 候选与成对评估代理（M5 切片 2） ---------------------- */

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

      // 每 2s 轮询共享 events 表的增量（id > lastId）；db 缺失时静默等待。
      const timer = setInterval(() => {
        const s = getStore();
        if (s === null) return;
        const fresh = selectNewEvents(s.listEvents({ limit: 1000 }), lastId);
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
