/**
 * hindsight 只读记忆驱动（id: hindsight-rest-readonly）。
 *
 * 把 hindsight 本地服务的记忆单元（memories/list + stats）映射到 MemoryDriver
 * 契约的只读面：stats / preview / verifyIntegrity / analyze；归档、恢复、物理
 * 删除、重建索引等写操作一律 E403（记忆由 hindsight 管理，管家 V1 不改写）。
 *
 * 字段映射：totalEntries ← stats.total_nodes；lastWriteAt ← 最新记忆的
 * mentioned_at（list 按 mentioned_at 倒序取第一条）；preview ← memories/list
 * （q 参数即全文检索，与面板检索框直连）。
 */
import {
  MEMORY_PREVIEW_LIMIT,
  ok,
  fail,
  type ArchiveReport,
  type DriverScope,
  type MemoryDriver,
  type MemoryEntry,
  type MemoryHealth,
  type MemoryQuery,
  type MemoryStats,
  type PurgeReport,
  type RebuildIndexReport,
  type RestoreReport,
  type Result,
  type IntegrityReport,
} from "@butler/contract";
import {
  hindsightBankStats,
  hindsightListFailedOperations,
  hindsightListMemories,
  hindsightMemoriesTimeseries,
  hindsightRetryOperation,
  resolveHindsightService,
  type HindsightReadTextFile,
  type HindsightFetch,
} from "../hindsight-client.js";

export interface HindsightMemoryDriverOptions {
  /** 服务地址覆盖（BUTLER_HINDSIGHT_BASE_URL）。 */
  baseUrl?: string;
  /** bank 覆盖；缺省读 config.json 的 bank_id。 */
  bankId?: string;
  /** 可选 Bearer Token。 */
  token?: string;
  fetchFn?: HindsightFetch;
  readTextFile?: HindsightReadTextFile;
  now?: () => number;
  /** 单请求超时（毫秒，默认 8s）。 */
  timeoutMs?: number;
  /** rebuildIndex 每次最多重试的失败操作条数（默认 20，防止单击触发大量 LLM 调用）。 */
  retryBatchSize?: number;
}

function readonlyWrite<T>(): Result<T> {
  return fail("E403", "hindsight 记忆由外部服务管理，管家 V1 不支持从面板修改", {
    userHint: "记忆内容与生命周期由 hindsight 自己维护；面板仅提供查看与检索",
  });
}

/** Python 风格 ISO（微秒+偏移）归一为 UTC ISO；无法解析返回 null。 */
function toIso(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function createHindsightMemoryDriver(options: HindsightMemoryDriverOptions = {}): MemoryDriver {
  const now = options.now ?? Date.now;
  const retryBatchSize = Math.max(1, options.retryBatchSize ?? 20);
  const requestInit = {
    token: options.token,
    timeoutMs: options.timeoutMs,
    fetchFn: options.fetchFn,
  };
  const resolve = (scope: DriverScope) =>
    resolveHindsightService(scope.rootPath, { baseUrl: options.baseUrl, bankId: options.bankId }, options.readTextFile);

  return {
    id: "hindsight-rest-readonly",

    async stats(scope: DriverScope): Promise<Result<MemoryStats>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      if ("error" in endpoint) return fail("E402", endpoint.error, { userHint: "未配置 hindsight 服务地址" });
      try {
        // timeseries 实测上限 90d；只用于按月趋势，失败不拖累 stats 本身。
        const [list, bankStats, timeseries] = await Promise.all([
          hindsightListMemories(endpoint, { limit: 1 }, requestInit),
          hindsightBankStats(endpoint, requestInit),
          hindsightMemoriesTimeseries(endpoint, { period: "90d", timeField: "created_at" }, requestInit).catch(
            () => null,
          ),
        ]);
        const lastWriteAt = toIso(list.items[0]?.mentionedAt ?? null);
        const byMonth = new Map<string, number>();
        if (timeseries !== null) {
          for (const bucket of timeseries.buckets) {
            const month = bucket.time.slice(0, 7);
            if (!/^\d{4}-\d{2}$/.test(month)) continue;
            byMonth.set(month, (byMonth.get(month) ?? 0) + bucket.world + bucket.experience + bucket.observation);
          }
        }
        const data: MemoryStats = {
          totalEntries: bankStats.totalNodes,
          byMonth: [...byMonth.entries()]
            .map(([month, count]) => ({ month, count }))
            .sort((a, b) => a.month.localeCompare(b.month)),
          coldCandidates: 0,
          lastWriteAt,
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
      } catch (error) {
        return fail("E302", `hindsight 服务不可达：${error instanceof Error ? error.message : String(error)}`, {
          userHint: "确认 hindsight 服务已启动；容器部署需经 BUTLER_HINDSIGHT_BASE_URL 指向宿主可达地址",
        });
      }
    },

    async preview(scope: DriverScope, query: MemoryQuery): Promise<Result<MemoryEntry[]>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      if ("error" in endpoint) return fail("E402", endpoint.error, { userHint: "未配置 hindsight 服务地址" });
      try {
        const limit = Math.min(MEMORY_PREVIEW_LIMIT, query.limit ?? MEMORY_PREVIEW_LIMIT);
        const list = await hindsightListMemories(
          endpoint,
          { q: query.keyword, limit },
          requestInit,
        );
        const entries: MemoryEntry[] = list.items.map((item) => ({
          entryId: item.id,
          writtenAt: toIso(item.mentionedAt) ?? new Date(now()).toISOString(),
          content: item.text,
          sizeBytes: Buffer.byteLength(item.text, "utf8"),
        }));
        return ok(entries, startedAt);
      } catch (error) {
        return fail("E302", `hindsight 服务不可达：${error instanceof Error ? error.message : String(error)}`, {
          userHint: "确认 hindsight 服务已启动；容器部署需经 BUTLER_HINDSIGHT_BASE_URL 指向宿主可达地址",
        });
      }
    },

    async verifyIntegrity(scope: DriverScope): Promise<Result<IntegrityReport>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      if ("error" in endpoint) return fail("E402", endpoint.error, { userHint: "未配置 hindsight 服务地址" });
      try {
        const bankStats = await hindsightBankStats(endpoint, requestInit);
        const data: IntegrityReport = {
          healthy: true,
          checkedAt: new Date().toISOString(),
          totalChecked: bankStats.totalNodes,
          problems: [],
        };
        return ok(data, startedAt);
      } catch (error) {
        return fail("E302", `hindsight 服务不可达：${error instanceof Error ? error.message : String(error)}`, {
          userHint: "完整性检查需要 hindsight 服务在线",
        });
      }
    },

    async analyze(scope: DriverScope): Promise<Result<MemoryHealth>> {
      const startedAt = Date.now();
      const endpoint = resolve(scope);
      if ("error" in endpoint) return fail("E402", endpoint.error, { userHint: "未配置 hindsight 服务地址" });
      try {
        const bankStats = await hindsightBankStats(endpoint, requestInit);
        const healthy = bankStats.failedOperations === 0;
        const suggestions: MemoryHealth["suggestions"] = [];
        if (!healthy) {
          suggestions.push({
            id: "hindsight-retry-failed",
            kind: "rebuild-index",
            title: `一键重试 ${bankStats.failedOperations} 次失败的后台操作`,
            detail:
              "把失败的记忆写入/整理操作重新排队处理（每次最多 " +
              `${retryBatchSize} 条，重试会消耗 hindsight 配置的 LLM 调用）`,
            action: "rebuild-index",
          });
        }
        const data: MemoryHealth = {
          score: healthy ? 90 : 70,
          checkedAt: new Date().toISOString(),
          signals: [
            {
              id: "hindsight-service",
              label: "hindsight 服务",
              status: "ok",
              detail: `在线；记忆单元 ${bankStats.totalNodes} 条，文档 ${bankStats.totalDocuments} 份`,
            },
            {
              id: "hindsight-operations",
              label: "后台处理",
              status: healthy ? "ok" : "warn",
              detail: healthy
                ? "无失败的后台操作"
                : `有 ${bankStats.failedOperations} 次失败的后台操作（嵌入/整理），可用下方一键重试修复`,
            },
          ],
          suggestions,
        };
        return ok(data, startedAt);
      } catch (error) {
        return fail("E302", `hindsight 服务不可达：${error instanceof Error ? error.message : String(error)}`, {
          userHint: "健康分析需要 hindsight 服务在线",
        });
      }
    },

    async archiveCold(): Promise<Result<ArchiveReport>> {
      return readonlyWrite();
    },
    async restoreCold(): Promise<Result<RestoreReport>> {
      return readonlyWrite();
    },
    async purge(): Promise<Result<PurgeReport>> {
      return readonlyWrite();
    },
    /**
     * 修复动作（契约的 rebuildIndex 槽位）：把 hindsight 失败的后台操作
     * （嵌入/整理失败的 retain 等）重新排队。限额批次执行，避免一次单击
     * 触发大量 LLM 调用；重试由 hindsight 异步完成，报告反映重新排队数。
     */
    async rebuildIndex(scope: DriverScope): Promise<Result<RebuildIndexReport>> {
      const endpoint = resolve(scope);
      if ("error" in endpoint) return fail("E402", endpoint.error, { userHint: "未配置 hindsight 服务地址" });
      try {
        const [bankStats, failed] = await Promise.all([
          hindsightBankStats(endpoint, requestInit),
          hindsightListFailedOperations(endpoint, { limit: retryBatchSize }, requestInit),
        ]);
        if (failed.length === 0) {
          return ok(
            {
              rebuilt: false,
              rowsBefore: bankStats.failedOperations,
              rowsAfter: bankStats.failedOperations,
              errors: [],
            },
            Date.now(),
          );
        }
        const errors: string[] = [];
        let requeued = 0;
        for (const operation of failed) {
          try {
            if (await hindsightRetryOperation(endpoint, operation.id, requestInit)) {
              requeued += 1;
            } else {
              errors.push(`重试被拒绝：${operation.taskType ?? "operation"} ${operation.id.slice(0, 8)}`);
            }
          } catch (error) {
            errors.push(
              `重试失败：${operation.taskType ?? "operation"} ${operation.id.slice(0, 8)} — ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        return ok(
          {
            rebuilt: requeued > 0,
            rowsBefore: bankStats.failedOperations,
            rowsAfter: Math.max(0, bankStats.failedOperations - requeued),
            errors,
          },
          Date.now(),
        );
      } catch (error) {
        return fail("E302", `hindsight 服务不可达：${error instanceof Error ? error.message : String(error)}`, {
          userHint: "修复操作需要 hindsight 服务在线",
        });
      }
    },
  };
}
