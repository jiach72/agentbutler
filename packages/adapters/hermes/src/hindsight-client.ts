/**
 * hindsight 本地服务的最小只读 HTTP 客户端（供记忆驱动与探针共用）。
 *
 * 服务地址与 bank 从实例根目录的 hindsight/config.json 解析（真实部署勘察：
 * local_embedded 模式，api_url 形如 http://127.0.0.1:9177，bank_id 形如 "hermes"）；
 * 显式覆盖项（BUTLER_HINDSIGHT_BASE_URL / BUTLER_HINDSIGHT_TOKEN）优先于标记文件。
 * 全部请求带超时，非 2xx 与连接失败统一转为 throws，由调用方决定降级语义。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface HindsightServiceEndpoint {
  baseUrl: string;
  bankId: string;
}

export interface ResolveHindsightServiceOptions {
  /** 服务地址覆盖（BUTLER_HINDSIGHT_BASE_URL）；缺省读 config.json 的 api_url。 */
  baseUrl?: string;
  /** bank 覆盖；缺省读 config.json 的 bank_id，再缺省 "default"。 */
  bankId?: string;
}

export type HindsightReadTextFile = (path: string) => string | null;

/** 从请求体里读 JSON 的最小 fetch 签名（Node 全局 fetch 天然满足）。 */
export type HindsightFetch = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function defaultReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 解析 hindsight 服务端点：显式覆盖 > <root>/hindsight/config.json > 缺省值。 */
export function resolveHindsightService(
  rootPath: string,
  options: ResolveHindsightServiceOptions = {},
  readTextFile: HindsightReadTextFile = defaultReadTextFile,
): HindsightServiceEndpoint | { error: string } {
  let baseUrl = options.baseUrl?.trim() ?? "";
  let bankId = options.bankId?.trim() ?? "";
  if (baseUrl === "" || bankId === "") {
    const raw = readTextFile(join(rootPath, "hindsight", "config.json"));
    if (raw !== null) {
      try {
        const config: unknown = JSON.parse(raw);
        if (config !== null && typeof config === "object") {
          const record = config as Record<string, unknown>;
          if (baseUrl === "" && typeof record["api_url"] === "string") baseUrl = record["api_url"];
          if (bankId === "" && typeof record["bank_id"] === "string") bankId = record["bank_id"];
        }
      } catch {
        // 配置损坏按缺省值继续。
      }
    }
  }
  if (baseUrl === "" || !/^https?:\/\//.test(baseUrl)) {
    return {
      error:
        "无法确定 hindsight 服务地址（<root>/hindsight/config.json 缺少 api_url，或未设置 BUTLER_HINDSIGHT_BASE_URL）",
    };
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), bankId: bankId === "" ? "default" : bankId };
}

export interface HindsightMemoryUnit {
  id: string;
  text: string;
  factType: string | null;
  /** ISO-8601（hindsight 返回 Python 风格微秒+offset，Date 可解析）。 */
  mentionedAt: string | null;
  documentId: string | null;
}

export interface HindsightListResult {
  items: HindsightMemoryUnit[];
  total: number;
}

export interface HindsightBankStats {
  totalNodes: number;
  totalDocuments: number;
  failedOperations: number;
  lastConsolidatedAt: string | null;
}

export interface HindsightTimeseriesBucket {
  /** 桶起始时间（ISO-8601，trunc=day 时为当日 0 点 UTC）。 */
  time: string;
  world: number;
  experience: number;
  observation: number;
}

export interface HindsightTimeseriesResult {
  period: string;
  trunc: string;
  buckets: HindsightTimeseriesBucket[];
}

export interface HindsightRequestInit {
  fetchFn?: HindsightFetch;
  token?: string;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function hindsightRequest(
  endpoint: HindsightServiceEndpoint,
  path: string,
  init: HindsightRequestInit & { method?: string } = {},
): Promise<unknown> {
  const fetchFn = init.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8_000);
  try {
    const headers: Record<string, string> = {};
    if (init.token !== undefined && init.token !== "") headers["authorization"] = `Bearer ${init.token}`;
    const response = await fetchFn(`${endpoint.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取记忆清单（按 mentioned_at 倒序）；q 为全文检索词，state 只保留 valid 条目。 */
export async function hindsightListMemories(
  endpoint: HindsightServiceEndpoint,
  query: { q?: string; limit?: number; offset?: number } = {},
  init: HindsightRequestInit = {},
): Promise<HindsightListResult> {
  const params = new URLSearchParams();
  if (query.q !== undefined && query.q !== "") params.set("q", query.q);
  params.set("limit", String(Math.max(1, Math.min(200, query.limit ?? 50))));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const data = asRecord(await hindsightRequest(endpoint, `/v1/default/banks/${encodeURIComponent(endpoint.bankId)}/memories/list?${params.toString()}`, init));
  const rawItems = Array.isArray(data?.["items"]) ? data["items"] : [];
  const items: HindsightMemoryUnit[] = [];
  for (const raw of rawItems) {
    const record = asRecord(raw);
    if (record === null) continue;
    // state 缺省视为有效；显式非 valid（如被后续记忆取代）不进预览。
    const state = typeof record["state"] === "string" ? record["state"] : "valid";
    if (state !== "valid") continue;
    const id = typeof record["id"] === "string" ? record["id"] : "";
    const text = typeof record["text"] === "string" ? record["text"] : "";
    if (id === "" || text === "") continue;
    items.push({
      id,
      text,
      factType: typeof record["fact_type"] === "string" ? record["fact_type"] : null,
      mentionedAt: typeof record["mentioned_at"] === "string" ? record["mentioned_at"] : null,
      documentId: typeof record["document_id"] === "string" ? record["document_id"] : null,
    });
  }
  const total = typeof data?.["total"] === "number" ? data["total"] : items.length;
  return { items, total };
}

/** 拉取 bank 统计（nodes = 记忆单元总数）。 */
export async function hindsightBankStats(
  endpoint: HindsightServiceEndpoint,
  init: HindsightRequestInit = {},
): Promise<HindsightBankStats> {
  const data = asRecord(
    await hindsightRequest(endpoint, `/v1/default/banks/${encodeURIComponent(endpoint.bankId)}/stats`, init),
  );
  const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    totalNodes: numberOf(data?.["total_nodes"]),
    totalDocuments: numberOf(data?.["total_documents"]),
    failedOperations: numberOf(data?.["failed_operations"]),
    lastConsolidatedAt: typeof data?.["last_consolidated_at"] === "string" ? data["last_consolidated_at"] : null,
  };
}

/**
 * 拉取记忆写入时间序列（按 fact_type 分桶）。period 上限实测 90d（更大值回落
 * 默认 7d）；time_field=created_at 为入库时间，适合"按月写入"趋势。
 */
export async function hindsightMemoriesTimeseries(
  endpoint: HindsightServiceEndpoint,
  query: { period?: string; timeField?: string } = {},
  init: HindsightRequestInit = {},
): Promise<HindsightTimeseriesResult> {
  const params = new URLSearchParams();
  if (query.period !== undefined && query.period !== "") params.set("period", query.period);
  if (query.timeField !== undefined && query.timeField !== "") params.set("time_field", query.timeField);
  const data = asRecord(
    await hindsightRequest(
      endpoint,
      `/v1/default/banks/${encodeURIComponent(endpoint.bankId)}/stats/memories-timeseries?${params.toString()}`,
      init,
    ),
  );
  const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const buckets: HindsightTimeseriesBucket[] = [];
  if (Array.isArray(data?.["buckets"])) {
    for (const raw of data["buckets"]) {
      const record = asRecord(raw);
      if (record === null || typeof record["time"] !== "string") continue;
      buckets.push({
        time: record["time"],
        world: numberOf(record["world"]),
        experience: numberOf(record["experience"]),
        observation: numberOf(record["observation"]),
      });
    }
  }
  return {
    period: typeof data?.["period"] === "string" ? data["period"] : "",
    trunc: typeof data?.["trunc"] === "string" ? data["trunc"] : "",
    buckets,
  };
}
