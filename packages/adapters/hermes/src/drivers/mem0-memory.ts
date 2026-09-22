/**
 * Mem0 只读记忆驱动（id: mem0-rest-readonly）。
 *
 * 把 Mem0（本地自托管或 Mem0 Platform）的记忆检索与列表映射到 MemoryDriver 契约：
 * stats / preview / verifyIntegrity / analyze；
 * 归档、恢复、物理删除等写操作一律安全返回 E403（记忆由 Mem0 外部托管）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_PREVIEW_LIMIT,
  fail,
  ok,
  type ArchiveReport,
  type DriverScope,
  type IntegrityReport,
  type MemoryDriver,
  type MemoryEntry,
  type MemoryHealth,
  type MemoryQuery,
  type MemoryStats,
  type PurgeReport,
  type RebuildIndexReport,
  type RestoreReport,
  type Result,
} from "@butler/contract";

export type Mem0Fetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export interface Mem0MemoryDriverOptions {
  /** 服务地址覆盖（BUTLER_MEM0_BASE_URL）。 */
  baseUrl?: string;
  /** API Key 覆盖；缺省从 mem0.json 或 .env 读取。 */
  apiKey?: string;
  fetchFn?: Mem0Fetch;
  readTextFile?: (path: string) => string | null;
  now?: () => number;
  /** 单请求超时（毫秒，默认 10s）。 */
  timeoutMs?: number;
}

function readonlyWrite<T>(): Result<T> {
  return fail("E403", "Mem0 记忆由外部服务管理，管家 V1 不支持从面板直接修改", {
    userHint: "记忆内容与生命周期由 Mem0 自己维护；面板仅提供查看与检索",
  });
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

interface ResolvedMem0Endpoint {
  baseUrl: string;
  apiKey?: string;
}

export function resolveMem0Endpoint(
  rootPath: string,
  options: { baseUrl?: string; apiKey?: string } = {},
  readTextFile?: (path: string) => string | null,
): ResolvedMem0Endpoint {
  const read =
    readTextFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });

  let baseUrl = options.baseUrl ?? process.env.BUTLER_MEM0_BASE_URL;
  let apiKey = options.apiKey ?? process.env.BUTLER_MEM0_API_KEY ?? process.env.MEM0_API_KEY;

  // 1. 尝试从 mem0.json 读取
  const mem0JsonPath = join(rootPath, "mem0.json");
  const rawJson = read(mem0JsonPath);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (!baseUrl) {
        if (typeof parsed["host"] === "string" && parsed["host"]) {
          baseUrl = parsed["host"];
        } else if (typeof parsed["url"] === "string" && parsed["url"]) {
          baseUrl = parsed["url"];
        } else if (parsed["mode"] === "selfhosted") {
          baseUrl = "http://127.0.0.1:8888";
        }
      }
      if (!apiKey && typeof parsed["api_key"] === "string") {
        apiKey = parsed["api_key"];
      }
    } catch {
      // ignore
    }
  }

  // 2. 尝试从 .env 读取
  if (!apiKey) {
    const envPath = join(rootPath, ".env");
    const rawEnv = read(envPath);
    if (rawEnv) {
      const m = rawEnv.match(/^MEM0_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (m?.[1]) apiKey = m[1].trim();
    }
  }

  return {
    baseUrl: (baseUrl || "https://api.mem0.ai").replace(/\/+$/, ""),
    apiKey,
  };
}

export function createMem0MemoryDriver(options: Mem0MemoryDriverOptions = {}): MemoryDriver {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 10_000);
  const fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));

  const resolve = (scope: DriverScope) =>
    resolveMem0Endpoint(scope.rootPath, { baseUrl: options.baseUrl, apiKey: options.apiKey }, options.readTextFile);

  async function requestMem0(
    endpoint: ResolvedMem0Endpoint,
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<Result<unknown>> {
    const url = `${endpoint.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (endpoint.apiKey) {
      headers["authorization"] = `Token ${endpoint.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return fail("E302", `Mem0 接口返回 HTTP ${res.status}: ${res.statusText ?? "error"}`);
      }
      const data = await res.json();
      return ok(data);
    } catch (err) {
      return fail("E302", `Mem0 请求失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "mem0-rest-readonly",

    async stats(scope: DriverScope): Promise<Result<MemoryStats>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);

      // 查询最近记忆以推导总数与最近写入
      const searchRes = await requestMem0(endpoint, "/v2/memories/search/", {
        method: "POST",
        body: JSON.stringify({ query: "工作与交互记忆", limit: 50 }),
      });

      if (!searchRes.ok) {
        // 尝试退回 v1 memories
        const listRes = await requestMem0(endpoint, "/v1/memories/?limit=50");
        if (!listRes.ok) {
          return fail("E302", `Mem0 服务不可达: ${searchRes.error?.message ?? "服务不可达"}`, {
            userHint: "请确认 Mem0 服务运行中，且已配置正确的端口或 API Key",
          });
        }
      }

      const rawItems = (searchRes.ok ? searchRes.data : []) as Array<Record<string, unknown>>;
      const items = Array.isArray(rawItems) ? rawItems : [];

      let latestTs: string | null = null;
      const byMonth = new Map<string, number>();

      for (const item of items) {
        const rawDate = (item["updated_at"] ?? item["created_at"]) as string | undefined;
        const iso = toIso(rawDate);
        if (iso) {
          if (!latestTs || iso > latestTs) latestTs = iso;
          const m = iso.slice(0, 7);
          if (/^\d{4}-\d{2}$/.test(m)) {
            byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
          }
        }
      }

      const data: MemoryStats = {
        totalEntries: items.length,
        byMonth: [...byMonth.entries()]
          .map(([month, count]) => ({ month, count }))
          .sort((a, b) => a.month.localeCompare(b.month)),
        coldCandidates: 0,
        lastWriteAt: latestTs,
        archivedEntries: 0,
        probeEntries: 0,
        recalledEntries: 0,
        cumulativeRecalls: 0,
        probeWriteAttempts: 0,
        probeWriteFailures: 0,
        probeRecallAttempts: 0,
        probeRecallHits: 0,
      };

      return ok(data, startedAt);
    },

    async preview(scope: DriverScope, query: MemoryQuery): Promise<Result<MemoryEntry[]>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      const limit = Math.min(MEMORY_PREVIEW_LIMIT, query.limit ?? MEMORY_PREVIEW_LIMIT);
      const q = query.keyword?.trim() || "记忆";

      const res = await requestMem0(endpoint, "/v2/memories/search/", {
        method: "POST",
        body: JSON.stringify({ query: q, limit }),
      });

      let items: Array<Record<string, unknown>> = [];
      if (res.ok && Array.isArray(res.data)) {
        items = res.data as Array<Record<string, unknown>>;
      } else {
        const listRes = await requestMem0(endpoint, `/v1/memories/?limit=${limit}`);
        if (listRes.ok && Array.isArray(listRes.data)) {
          items = listRes.data as Array<Record<string, unknown>>;
        }
      }

      const entries: MemoryEntry[] = items.map((item, idx) => {
        const text = String(item["memory"] ?? item["text"] ?? item["content"] ?? "无记忆内容");
        const id = String(item["id"] ?? `mem0-${idx}`);
        const created = toIso(item["created_at"] as string) ?? new Date().toISOString();
        const updated = toIso(item["updated_at"] as string) ?? created;
        return {
          entryId: id,
          writtenAt: updated,
          content: text,
          sizeBytes: Buffer.byteLength(text, "utf8"),
        };
      });

      return ok(entries, startedAt);
    },

    async verifyIntegrity(scope: DriverScope): Promise<Result<IntegrityReport>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      const res = await requestMem0(endpoint, "/v2/memories/search/", {
        method: "POST",
        body: JSON.stringify({ query: "ping", limit: 1 }),
      });

      if (!res.ok) {
        return ok(
          {
            healthy: false,
            checkedAt: new Date(now()).toISOString(),
            totalChecked: 0,
            problems: [{ kind: "service-unreachable", detail: `Mem0 响应异常: ${res.error?.message ?? "未知错误"}` }],
          },
          startedAt,
        );
      }

      return ok(
        {
          healthy: true,
          checkedAt: new Date(now()).toISOString(),
          totalChecked: 1,
          problems: [],
        },
        startedAt,
      );
    },

    async analyze(scope: DriverScope): Promise<Result<MemoryHealth>> {
      const startedAt = Date.now();
      const integrity = await this.verifyIntegrity(scope);
      const healthy = integrity.ok && integrity.data?.healthy === true;

      const health: MemoryHealth = {
        score: healthy ? 95 : 40,
        checkedAt: new Date(now()).toISOString(),
        signals: [
          {
            id: "mem0-service",
            label: "Mem0 服务",
            status: healthy ? "ok" : "warn",
            detail: healthy
              ? "在线；记忆由外部 Mem0 服务托管与检索"
              : integrity.ok
                ? (integrity.data?.problems.map((p) => p.detail).join("; ") ?? "服务异常")
                : (integrity.error?.message ?? "检查失败"),
          },
        ],
        suggestions: healthy
          ? []
          : [
              {
                id: "check-mem0",
                kind: "notice",
                title: "检查 Mem0 服务状态",
                detail: "确认本地 Docker 容器或云端 Mem0 Platform 连接正常",
              },
            ],
      };

      return ok(health, startedAt);
    },

    archiveCold: async (): Promise<Result<ArchiveReport>> => readonlyWrite(),
    restoreCold: async (): Promise<Result<RestoreReport>> => readonlyWrite(),
    purge: async (): Promise<Result<PurgeReport>> => readonlyWrite(),
    rebuildIndex: async (): Promise<Result<RebuildIndexReport>> => readonlyWrite(),
  };
}
