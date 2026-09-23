/**
 * Web API 载荷解析、降级视图与视图投影（从 server.ts 抽出；ENG-01 parse 层）。
 * 只依赖 api-views / api-exports 类型与 node/core，不碰 Fastify 装配。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEMORY_PREVIEW_LIMIT,
  type CapabilityReport,
  type InboundDecision,
  type InboundHistoryEntry,
} from "@butler/contract";
import { ensureButlerHome, SqliteStore, type StoredEvent } from "@butler/core";
import {
  MESSAGE_OUTBOX_STATES,
  type AssetRiskStatus,
  type DirectoryInventoryView,
  type GatewayPatchView,
  type GatewayStatsView,
  type InspectionCheckView,
  type InstanceApiView,
  type LatestInspectionView,
  type MessageBridgeView,
  type MessageItemView,
  type MessageListView,
  type MessageOptimizationHistoryView,
  type MessageStatusView,
  type MessageTaskView,
  type SkillsApiView,
  type SkillsInventoryMode,
} from "./api-views.js";
import { hostNameOf } from "./http-auth.js";
import { OllamaUsageStore } from "./ollama-usage-store.js";

export interface AlertsView {

  reachable: boolean;
  counts: Record<string, number>;
  unreadCount: number;
  degradedChannels: string[];
  items: unknown[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** /api/alerts 网关不可达时的降级载荷（面板显示黄色横幅而非报错）。 */
export function degradedAlerts(): AlertsView {
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
export function parseAlertsView(value: unknown): AlertsView | null {
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


/** /api/instances 返回的实例视图（capability 为解析后的摘要，null 表示尚无扫描报告）。 */
export function degradedSkills(): SkillsApiView {
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
      backend: { id: "hermes", backend: "hermes", source: "default", detail: "watch 不可达，按默认记忆库处理" },
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

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isMemoryBackendId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isMemoryBackendSource(value: unknown): value is string {
  return value === "env" || value === "config" || value === "marker" || value === "default";
}

export function parseDirectoryInventory(value: unknown): DirectoryInventoryView | null {
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

export function isInventoryMode(value: unknown): value is SkillsInventoryMode {
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

export function isAssetRiskStatus(value: unknown): value is AssetRiskStatus {
  return value === "unscanned" || value === "clear" || value === "blocked";
}

export function parseMemoryHealth(value: unknown): SkillsApiView["memory"]["health"] {
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

export function parseSkillsStatus(value: unknown): Omit<SkillsApiView, "watchReachable"> | null {
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
    const detail = memory["backend"]["detail"];
    if (!isMemoryBackendId(rawId) || typeof detail !== "string") return null;

    const source = memory["backend"]["source"];
    if (!isMemoryBackendSource(source)) {
      const safeSource = typeof source === "string" && source.trim() !== "" ? source.trim() : "unknown";
      backend = {
        id: rawId,
        backend: rawId,
        source: safeSource,
        detail,
        degraded: true,
        degradedReason: `未知记忆后端来源: "${safeSource}"`,
      };
    } else {
      backend = {
        id: rawId,
        backend: rawId,
        source,
        detail,
      };
    }
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

export function isGatewayStatsView(value: unknown): value is GatewayStatsView {
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

export function isGatewayPatchView(value: unknown): value is GatewayPatchView {
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

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function parseStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  if (!Object.values(value).every((entry) => typeof entry === "string")) return null;
  return value as Record<string, string>;
}

export function parseMessageCounts(value: unknown): Record<string, number> | null {
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
export function parseRelayControl(value: unknown): { enabled: boolean; pending: boolean; updatedAt: string | null } | undefined {
  if (!isRecord(value) || typeof value["enabled"] !== "boolean" || typeof value["pending"] !== "boolean") {
    return undefined;
  }
  return {
    enabled: value["enabled"],
    pending: value["pending"],
    updatedAt: isNullableString(value["updatedAt"]) ? (value["updatedAt"] as string | null) : null,
  };
}

export function parseMessageStatus(value: unknown): MessageStatusView | null {
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

export function isMessageItemView(value: unknown): value is MessageItemView {
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

export function parseMessageList(value: unknown): MessageListView | null {
  if (!isRecord(value) || !Array.isArray(value["items"])) return null;
  const counts = parseMessageCounts(value["counts"]);
  if (counts === null || !value["items"].every(isMessageItemView)) return null;
  return { counts, items: value["items"] };
}

export function isMessageTaskView(value: unknown): value is MessageTaskView {
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

export function parseMessageOptimizationHistory(value: unknown): MessageOptimizationHistoryView | null {
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

export function emptyMessageList(): MessageListView {
  return {
    counts: Object.fromEntries(MESSAGE_OUTBOX_STATES.map((state) => [state, 0])),
    items: [],
  };
}

/** 打开共享 SQLite（web 只读语义）；任何失败（目录不可建/文件不可开）返回 null 走降级。 */
export function openStore(home: string): SqliteStore | null {
  try {
    const paths = ensureButlerHome(home);
    return new SqliteStore(paths.dbFile);
  } catch {
    return null;
  }
}

/** 打开 Ollama 用量 SQLite；任何失败（目录不可建/文件不可开）返回 null 走降级。 */
export function openOllamaUsageStore(home: string): OllamaUsageStore | null {
  try {
    const dataDir = path.join(home, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    return new OllamaUsageStore(path.join(dataDir, "ollama_usage.db"));
  } catch {
    return null;
  }
}

/** ui/dist 默认路径：src/ 与 dist/ 同为 apps/web 下一级，向上三级即仓库根。 */
export function defaultUiDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "ui", "dist");
}

/** 从当前 index.html 读取实际被 Web 静态服务引用的入口 bundle，而非猜测构建产物。 */
export function readBundleVersion(uiDist: string): string | null {
  try {
    const html = fs.readFileSync(path.join(uiDist, "index.html"), "utf8");
    return /(?:src=|href=)["']\/?assets\/(index-[A-Za-z0-9_-]+\.js)["']/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** query 里的 limit 归一化：非法值回落默认，上限 1000。 */
export function clampLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 1000);
}

export function parseCapability(raw: string | null): CapabilityReport | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as CapabilityReport;
  } catch {
    return null;
  }
}

/** instances 表原始行 → 面板视图（/api/instances 与 /api/dashboard 共用）。 */
export function toInstanceViews(store: SqliteStore): InstanceApiView[] {
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
export function toLatestInspection(event: StoredEvent): LatestInspectionView | null {
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

export function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
}

export function inspectionWindow(days: number, now: Date): Map<string, { count: number; totalMs: number; timed: number; errors: number }> {
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

export interface RemoteServiceHealth {
  reachable: boolean;
  serviceVersion: string | null;
  schemaVersion: string | null;
  /** /healthz 往返耗时（毫秒）；探测失败（不可达/畸形响应）为 null。 */
  latencyMs: number | null;
}

/** 探测本地服务健康与控制面版本。畸形响应也视为不可用，避免伪造同步状态。 */
export async function probeServiceHealth(
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

export function readPositiveDuration(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 60 * 60_000) : fallback;
}

/**
 * 组装 butler-web 服务：静态 SPA + 只读 API + /ws 事件流。
 * 返回 Fastify 实例但不 listen —— 由 main.ts（或测试 inject）驱动。
 */

