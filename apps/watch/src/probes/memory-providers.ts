/**
 * 外部记忆系统探针 provider（hindsight / mem0）+ 按实例路由的工厂。
 *
 * 背景：Hermes 用户可能已把记忆迁移到外部系统（真实事故：hindsight 接管后，
 * 固定读写 memory_store.db 的默认探针失去对象/误报）。本模块为各后端实现
 * MemoryProbeProvider——语义与 SQLite 默认探针一致：写入带标记测试记忆 →
 * 召回校验 → 完整清理，绝不触碰用户记忆：
 * - hindsight：本地 HTTP API（真实部署 local_embedded，api_url 形如
 *   http://127.0.0.1:9177，OpenAPI v0.8.3 勘察）。探针在独立 bank
 *   （butler-probe）内完成 retain → recall → DELETE bank，整库删除零残留；
 *   这也真实贯穿「嵌入 → 召回」链路，能暴露「嵌入静默降级」类故障。
 * - mem0：mem0 Platform REST API（默认 https://api.mem0.ai，可自建网关覆盖）。
 *   以独立 user_id 写入测试记忆 → search 校验 → DELETE 单条，失败尽力清理。
 *
 * 路由工厂 createRoutedMemoryProbeProvider：按 InspectionContext.rootPath 逐实例
 * detectMemoryBackend（显式 env > 文件标记 > 默认），hindsight/mem0 走对应探针，
 * 默认 SQLite 回落 runSqliteMemoryProbe（auto 模式下同一 provider 可同时服务
 * 巡检与按需自检，removeOwn 语义随调用方透传）。provider 内部不抛异常，
 * 一律以 fail/skipped 结果表达，detail 携带可操作信息。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectMemoryBackend,
  resolveHindsightService,
  type MemoryBackendConfig,
} from "@butler/adapter-hermes";
import { defaultFetchLike, type FetchLike } from "../dashboard-signal.js";
import {
  MEMORY_PROBE_PREFIX,
  defaultSqliteOpener,
  runSqliteMemoryProbe,
  type MemoryProbeProvider,
  type SqliteOpener,
} from "./memory-probe.js";

/** hindsight 探针专用 bank：整库删除，与用户 bank（如 "hermes"）物理隔离。 */
export const HINDSIGHT_PROBE_BANK_ID = "butler-probe";
/** mem0 探针专用 user_id。 */
export const MEM0_PROBE_USER_ID = "butler-probe";
/** mem0 写入后索引可见存在延迟，召回校验做有限重试。 */
const MEM0_RECALL_ATTEMPTS = 3;
const MEM0_RECALL_RETRY_MS = 1_500;
/** hindsight retain 同步模式会做事实抽取，可能显著慢于普通 HTTP；给足预算。 */
const DEFAULT_HINDSIGHT_TIMEOUT_MS = 60_000;
const DEFAULT_MEM0_TIMEOUT_MS = 30_000;
/**
 * hindsight 探针内容与召回语。
 * 真机勘察（hindsight 0.8.3，2026-09-07）：retain 会经 LLM 做事实抽取，
 * 非自然语言内容（纯 uuid 标记）抽取产出 0 条 fact——「写入成功但库中无痕迹」。
 * 因此 content 必须是自然语句，标记词放 document_id：召回结果按 document_id
 * 精确归属，不依赖抽取后的改写文本是否保留原文。
 */
const HINDSIGHT_PROBE_CONTENT =
  "管家健康探针测试记忆：测试设备的操作系统已升级到最新版本，浏览器默认字体调整为思源黑体，" +
  "本次探针文档编号为 ";
const HINDSIGHT_RECALL_QUERY = "探针测试 设备操作系统升级 默认字体 思源黑体";

export interface HindsightProbeOptions {
  /** 服务地址；缺省读 <root>/hindsight/config.json 的 api_url 字段。 */
  baseUrl?: string;
  /** 可选 Bearer Token（本地 embedded 部署通常免鉴权）。 */
  token?: string;
  /** 探针 bank（默认 butler-probe）。 */
  bankId?: string;
  timeoutMs?: number;
}

export interface Mem0ProbeOptions {
  /** API 网关地址（默认 https://api.mem0.ai；自建/代理时覆盖）。 */
  baseUrl?: string;
  /** API Key；缺省读 <root>/mem0/config.json 的 api_key 字段。 */
  apiKey?: string;
  /** 探针 user_id（默认 butler-probe）。 */
  userId?: string;
  timeoutMs?: number;
}

export interface RoutedMemoryProbeOptions {
  /** BUTLER_MEMORY_BACKEND 归一化值（来自 WatchConfig.memoryBackend）。 */
  configured?: MemoryBackendConfig;
  hindsight?: HindsightProbeOptions;
  mem0?: Mem0ProbeOptions;
  /** 检测为默认 SQLite 后端时的回落探针（缺省接 runSqliteMemoryProbe）。 */
  fallbackSqlite?: MemoryProbeProvider;
  /** SQLite 回落探针的打开器（透传给 runSqliteMemoryProbe；测试注入）。 */
  sqlite?: SqliteOpener;
  fetchFn?: FetchLike;
  /** 文件读取注入（读 hindsight/mem0 标记配置；默认 readFileSync utf8）。 */
  readTextFile?: (path: string) => string | null;
  exists?: (path: string) => boolean;
  now?: () => number;
  /** 重试等待注入（测试免真等）。 */
  delay?: (ms: number) => Promise<void>;
}

/* ------------------------------- 共用工具 ------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 标记词：与 SQLite 探针同一前缀，识别/清理口径一致。 */
function newMarker(): string {
  return `${MEMORY_PROBE_PREFIX}${randomUUID()}`;
}

function readConfigJson(
  rootPath: string,
  file: string,
  readTextFile: (path: string) => string | null,
): Record<string, unknown> | null {
  const raw = readTextFile(join(rootPath, file));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 带超时的一次 JSON 请求；连接失败/非 2xx 统一返回 { ok:false }（调用方决定文案）。 */
async function requestJson(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: init.method,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // 空响应体/非 JSON：ok 判定不依赖 body。
    }
    return response.ok
      ? { ok: true, data }
      : { ok: false, status: response.status, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, reason: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/* ------------------------------ hindsight ------------------------------ */

/** 解析 hindsight 服务地址：显式覆盖 > <root>/hindsight/config.json 的 api_url。 */
export function resolveHindsightBaseUrl(
  rootPath: string,
  options: HindsightProbeOptions,
  readTextFile: (path: string) => string | null,
): { baseUrl: string } | { error: string } {
  // 与记忆驱动共用同一解析实现（adapter-hermes hindsight-client），避免两处漂移。
  const resolved = resolveHindsightService(
    rootPath,
    { baseUrl: options.baseUrl },
    readTextFile,
  );
  if ("error" in resolved) {
    return {
      error:
        "无法确定 hindsight 服务地址（<root>/hindsight/config.json 缺少 api_url，或未设置 BUTLER_HINDSIGHT_BASE_URL），记忆探针降级跳过",
    };
  }
  return { baseUrl: resolved.baseUrl };
}

/**
 * hindsight 记忆探针：独立 bank 内 retain → recall → 删除整库。
 * 全程不触碰用户 bank；bank 删除放在 finally，召回失败也保证清理。
 */
export function createHindsightMemoryProbe(
  options: HindsightProbeOptions & { fetchFn?: FetchLike; readTextFile?: (path: string) => string | null } = {},
): MemoryProbeProvider {
  const fetchFn = options.fetchFn ?? defaultFetchLike;
  const readTextFile =
    options.readTextFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_HINDSIGHT_TIMEOUT_MS;
  return async (ctx) => {
    const resolved = resolveHindsightBaseUrl(ctx.rootPath, options, readTextFile);
    if ("error" in resolved) {
      return { status: "skipped", detail: resolved.error };
    }
    const base = resolved.baseUrl;
    const bankId = options.bankId ?? HINDSIGHT_PROBE_BANK_ID;
    const bank = `${base}/v1/default/banks/${encodeURIComponent(bankId)}`;
    const headers: Record<string, string> =
      options.token !== undefined && options.token !== "" ? { authorization: `Bearer ${options.token}` } : {};
    // 标记记入 document_id（召回结果可精确归属），不依赖 LLM 抽取后的文本。
    const documentId = `butler-probe-${randomUUID()}`;
    let bankReady = false;
    try {
      // 1. 健康检查：连接失败单独给容器场景的可操作提示。
      const health = await requestJson(fetchFn, `${base}/health`, { method: "GET", headers, timeoutMs: 5_000 });
      if (!health.ok) {
        return {
          status: "fail",
          detail:
            `hindsight 服务不可达（${base}）：${health.reason}。` +
            "若管家在容器内而 hindsight 在宿主机，localhost 指向容器自身，请设置 BUTLER_HINDSIGHT_BASE_URL=http://host.docker.internal:<端口>",
        };
      }
      // 2. 幂等创建探针 bank（PUT = create or update，不污染既有 bank）。
      const created = await requestJson(fetchFn, bank, {
        method: "PUT",
        headers,
        body: JSON.stringify({}),
        timeoutMs: 10_000,
      });
      if (!created.ok) {
        return { status: "fail", detail: `hindsight 探针 bank 创建失败（${bankId}）：${created.reason}` };
      }
      bankReady = true;
      // 3. retain：同步模式写入自然语句（真实走「LLM 抽取 → 嵌入」链路）。
      const retained = await requestJson(fetchFn, `${bank}/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: [{ content: `${HINDSIGHT_PROBE_CONTENT}${documentId}。`, document_id: documentId, tags: ["butler-probe"] }],
          async: false,
        }),
        timeoutMs,
      });
      if (!retained.ok) {
        return { status: "fail", detail: `hindsight 测试记忆写入失败：${retained.reason}` };
      }
      const retainedData = asRecord(retained.data);
      if (retainedData?.["success"] !== true) {
        return { status: "fail", detail: "hindsight retain 返回 success=false（嵌入/抽取链路异常）" };
      }
      // 4. recall：语义召回刚写入的内容，按 document_id 归属校验（budget=low 控制开销）。
      const recalled = await requestJson(fetchFn, `${bank}/memories/recall`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: HINDSIGHT_RECALL_QUERY, budget: "low" }),
        timeoutMs,
      });
      if (!recalled.ok) {
        return { status: "fail", detail: `hindsight 召回查询失败：${recalled.reason}` };
      }
      const results = asRecord(recalled.data)?.["results"];
      const hit =
        Array.isArray(results) &&
        results.some((item) => {
          const record = asRecord(item);
          return (
            record?.["document_id"] === documentId ||
            (typeof record?.["text"] === "string" && record["text"].includes(documentId))
          );
        });
      if (!hit) {
        return {
          status: "fail",
          detail: `hindsight 未能召回刚写入的探针记忆（document_id=${documentId}，抽取/嵌入/索引链路静默降级）`,
        };
      }
      return { status: "pass", detail: `写入并召回成功（hindsight bank=${bankId}，document_id=${documentId}），探针 bank 已删除` };
    } finally {
      // 5. 清理：整库删除探针 bank（仅在确认创建成功后执行，避免误删同名既有库）。
      if (bankReady) {
        await requestJson(fetchFn, bank, { method: "DELETE", headers, timeoutMs: 10_000 });
      }
    }
  };
}

/* -------------------------------- mem0 -------------------------------- */

/** 解析 mem0 API Key：显式覆盖 > <root>/mem0/config.json 的 api_key 字段。 */
export function resolveMem0ApiKey(
  rootPath: string,
  options: Mem0ProbeOptions,
  readTextFile: (path: string) => string | null,
): { apiKey: string } | { error: string } {
  if (options.apiKey !== undefined && options.apiKey !== "") {
    return { apiKey: options.apiKey };
  }
  const config = readConfigJson(rootPath, "mem0/config.json", readTextFile);
  const apiKey = config?.["api_key"];
  if (typeof apiKey === "string" && apiKey !== "") {
    return { apiKey };
  }
  return {
    error:
      "未配置 mem0 API Key（BUTLER_MEM0_API_KEY 或 <root>/mem0/config.json 的 api_key），记忆探针降级跳过",
  };
}

/** 从 add 响应中取记忆 id（mem0 不同版本返回对象或单元素数组）。 */
function mem0IdOf(data: unknown): string | null {
  const candidate = Array.isArray(data) ? data[0] : data;
  const id = asRecord(candidate)?.["id"];
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * mem0 记忆探针：独立 user_id 写入 → search 召回（有限重试）→ 删除测试记忆。
 * mem0 add/search 为计费 API；每轮探针仅 1 写 + ≤3 查 + 1 删。
 */
export function createMem0MemoryProbe(
  options: Mem0ProbeOptions & { fetchFn?: FetchLike; readTextFile?: (path: string) => string | null; delay?: (ms: number) => Promise<void> } = {},
): MemoryProbeProvider {
  const fetchFn = options.fetchFn ?? defaultFetchLike;
  const readTextFile =
    options.readTextFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEM0_TIMEOUT_MS;
  return async (ctx) => {
    const resolved = resolveMem0ApiKey(ctx.rootPath, options, readTextFile);
    if ("error" in resolved) {
      return { status: "skipped", detail: resolved.error };
    }
    const base = (options.baseUrl ?? "https://api.mem0.ai").replace(/\/+$/, "");
    const userId = options.userId ?? MEM0_PROBE_USER_ID;
    const headers = { authorization: `Token ${resolved.apiKey}` };
    const marker = newMarker();
    let memoryId: string | null = null;
    try {
      // 1. 写入测试记忆（v1 add；同步返回已建档记忆）。
      const added = await requestJson(fetchFn, `${base}/v1/memories/`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: `${marker} 写入召回测试`, user_id: userId }),
        timeoutMs,
      });
      if (!added.ok) {
        return { status: "fail", detail: `mem0 测试记忆写入失败：${added.reason}` };
      }
      memoryId = mem0IdOf(added.data);
      // 2. 召回校验（v2 search）：索引可见有延迟，有限重试。
      let hit = false;
      for (let attempt = 0; attempt < MEM0_RECALL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(MEM0_RECALL_RETRY_MS);
        const searched = await requestJson(fetchFn, `${base}/v2/memories/search/`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: marker, filters: { user_id: userId } }),
          timeoutMs,
        });
        if (!searched.ok) {
          return { status: "fail", detail: `mem0 召回查询失败：${searched.reason}` };
        }
        const results = searched.data;
        hit =
          Array.isArray(results) &&
          results.some((item) => {
            const record = asRecord(item);
            const text = record?.["memory"] ?? record?.["text"];
            return typeof text === "string" && text.includes(marker);
          });
        if (hit) break;
      }
      if (!hit) {
        return {
          status: "fail",
          detail: `mem0 未能召回刚写入的标记 ${marker}（索引延迟或检索链路异常）`,
        };
      }
      return {
        status: "pass",
        detail: `写入并召回成功（mem0 user_id=${userId}，标记 ${marker}），测试记忆将自动清理`,
      };
    } finally {
      // 3. 清理测试记忆：无 id 时按标记搜索兜底（仅删除内容确含标记的结果，
      // 防止误删同 user_id 下的无关记忆）；清理失败不改变探针结论。
      if (memoryId === null) {
        const searched = await requestJson(fetchFn, `${base}/v2/memories/search/`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: marker, filters: { user_id: userId } }),
          timeoutMs,
        });
        if (searched.ok && Array.isArray(searched.data)) {
          const hit = searched.data.find((item) => {
            const text = asRecord(item)?.["memory"] ?? asRecord(item)?.["text"];
            return typeof text === "string" && text.includes(marker);
          });
          memoryId = hit === undefined ? null : mem0IdOf(hit);
        }
      }
      if (memoryId !== null) {
        await requestJson(fetchFn, `${base}/v1/memories/${encodeURIComponent(memoryId)}/`, {
          method: "DELETE",
          headers,
          timeoutMs: 10_000,
        });
      }
    }
  };
}

/* ------------------------------- 路由工厂 ------------------------------- */

/**
 * 按实例路由的记忆探针 provider：每个 ctx.rootPath 现场检测后端后分发。
 * - hindsight / mem0 → 对应 API 探针；
 * - hermes（默认）→ fallbackSqlite（缺省 runSqliteMemoryProbe，open/now 可注入，
 *   removeOwn 随调用方透传——巡检路径走 24h 保留，按需自检路径即时清理）。
 * provider 自身不抛异常；异常一律转 fail（createMemoryProbeStage 亦兜底）。
 */
export function createRoutedMemoryProbeProvider(options: RoutedMemoryProbeOptions = {}): MemoryProbeProvider {
  const configured = options.configured ?? "auto";
  const readTextFile =
    options.readTextFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const hindsightProbe = createHindsightMemoryProbe({
    ...(options.hindsight ?? {}),
    fetchFn: options.fetchFn,
    readTextFile,
  });
  const mem0Probe = createMem0MemoryProbe({
    ...(options.mem0 ?? {}),
    fetchFn: options.fetchFn,
    readTextFile,
    delay: options.delay,
  });
  const now = options.now ?? Date.now;
  const fallbackSqlite: MemoryProbeProvider =
    options.fallbackSqlite ??
    ((ctx, providerOptions) =>
      runSqliteMemoryProbe(ctx, {
        // 与 createMemoryProbeStage 无 provider 路径一致：未注入时用 node:sqlite 真实打开。
        open: options.sqlite ?? defaultSqliteOpener(),
        now,
        removeOwn: providerOptions.removeOwn,
        contentTable: "facts",
        ftsTable: "facts_fts",
      }));
  return async (ctx, providerOptions) => {
    const detection = detectMemoryBackend(ctx.rootPath, { configured, exists: options.exists });
    try {
      switch (detection.backend) {
        case "hindsight":
          return await hindsightProbe(ctx, providerOptions);
        case "mem0":
          return await mem0Probe(ctx, providerOptions);
        default:
          // 只读挂载在容器部署是常态（BUTLER_HERMES_READ_ONLY=true）：默认 SQLite
          // 路径必须保持 skipped，不因路由改写为写失败。外部 API 探针不落本地盘，
          // 不受只读约束。
          if (process.env["BUTLER_HERMES_READ_ONLY"] === "true") {
            return {
              status: "skipped",
              detail: "Hermes 数据目录以只读方式挂载，跳过写入型记忆探针",
            };
          }
          return await fallbackSqlite(ctx, providerOptions);
      }
    } catch (error) {
      return {
        status: "fail",
        detail: `记忆探针（${detection.backend}）异常: ${describeError(error)}`,
      };
    }
  };
}
