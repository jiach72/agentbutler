/**
 * 记忆可视化（M4.3）：本周 agent 新增 / 修改 / 遗忘了哪些记忆条目。
 *
 * 解决的焦虑是「重启失忆」——用户看不见记忆在被维护，就会怀疑它哪天把重要的事忘了。
 * 本模块把已经采到的动作流翻译成人能读的「记忆变更流」。
 *
 * **数据来源与诚实边界（重要）**：
 * - 唯一来源是行为审计流里的 `file-write` / `file-delete` 动作（M1.2 已采，零新增采集成本）；
 * - 因此它反映的是「**观测窗口内**被 agent 写入/删除过的记忆类文件」，而不是记忆内容的语义 diff；
 * - 窗口之前的存量、以及不经 agent 动作的外部改动，本模块看不到——这一点在 UI 与接口里显式声明，
 *   不冒称「完整记忆快照」。
 *
 * 三类判定（全部确定性）：
 * - `added`：窗口内首次出现该路径，且只有写入（此前无记录）；
 * - `modified`：窗口内对该路径有写入，且窗口开始前已存在（或窗口内被写过多次）；
 * - `forgotten`：窗口内出现删除动作，且此后没有再次写入（「忘了就再没想起来」）。
 */
import type { ActionEventRow, SqliteStore } from "@butler/core";
import type { MemoryEngineId } from "@butler/contract";
import type { MemoryBackendDetection, MemoryBackendId } from "@butler/adapter-hermes";

/** 记忆类路径特征（命中即视为记忆文件）。规则显式暴露，便于用户核对与调整预期。 */
export const MEMORY_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\\/])memory(?:[\\/]|\.|$)/i,
  /(?:^|[\\/])memories(?:[\\/]|$)/i,
  /(?:^|[\\/])notes?(?:[\\/]|$)/i,
  /MEMORY\.md$/i,
  /(?:^|[\\/])\.?(?:agent[-_]?butler)(?:[\\/])memory(?:[\\/]|$)/i,
  /(?:^|[\\/])knowledge(?:[\\/]|$)/i,
];

export type MemoryChange = "added" | "modified" | "forgotten";

export interface MemoryDiffEntry {
  path: string;
  change: MemoryChange;
  firstAt: string;
  lastAt: string;
  writes: number;
  deletes: number;
  /** 相关会话（最多保留 5 个，避免响应膨胀）。 */
  sessionIds: string[];
  /** 该路径当前是否在受管文件清单内；`null` = 不在清单内或无法判断（不等于已删除，不臆造）。 */
  stillPresent: boolean | null;
}

export interface MemoryDiffView {
  windowDays: number;
  activeEngine: MemoryEngineId;
  activeEngineName: string;
  activeEngineDetail: string;
  entries: MemoryDiffEntry[];
  /** 变化最多的 TOP N（周报「本周它记住了什么」直接用）。 */
  top: MemoryDiffEntry[];
  summary: { added: number; modified: number; forgotten: number; total: number };
  /** 观测口径（一句话说清「这份数据是什么」）。 */
  basis: string;
  /** 边界声明（说清「这份数据不是什么」）。 */
  basisLimits: string[];
  lastActionAt: string | null;
}

export interface MemoryDiffService {
  diff(windowDays: number): MemoryDiffView;
}

export interface MemoryDiffOptions {
  store: SqliteStore;
  /** 可选的受管文件清单（用于判定「当前是否仍在」）；缺省则该字段为 null。 */
  managedPaths?: () => string[];
  now?: () => number;
  /** 记忆后端检测供应器；默认按原生 SQLite hermes。 */
  getBackend?: () => MemoryBackendDetection;
}

/** 路径是否属于记忆类文件。 */
export function isMemoryPath(path: string): boolean {
  return MEMORY_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** 记忆变更判定（纯函数，可独立测试）。 */
export function classifyChange(input: {
  writes: number;
  deletes: number;
  lastWriteAt: string | null;
  lastDeleteAt: string | null;
  /** 窗口开始前该路径是否已出现过。 */
  knownBeforeWindow: boolean;
}): MemoryChange {
  const deletedLast =
    input.lastDeleteAt !== null && (input.lastWriteAt === null || input.lastDeleteAt >= input.lastWriteAt);
  if (input.deletes > 0 && deletedLast) return "forgotten";
  if (!input.knownBeforeWindow) return "added";
  return "modified";
}

/** 判定动作是否与外部第三方记忆后端（hindsight / mem0）直接相关。 */
export function isExternalMemoryAction(row: ActionEventRow, backend: MemoryBackendId): boolean {
  if (backend === "hindsight") {
    const target = row.target.toLowerCase();
    if (
      target.includes("hindsight") ||
      target.includes("9177") ||
      target.includes("/banks/") ||
      target.includes("memories/retain") ||
      target.includes("memories/recall") ||
      target.includes("memories")
    ) {
      return true;
    }
  } else if (backend === "mem0") {
    const target = row.target.toLowerCase();
    if (
      target.includes("mem0") ||
      target.includes("8888") ||
      target.includes("api.mem0.ai") ||
      target.includes("/v1/memories") ||
      target.includes("/v2/memories")
    ) {
      return true;
    }
  }
  return false;
}

function normalizeTarget(row: ActionEventRow, backend: MemoryBackendId): string {
  if (backend === "hindsight" && isExternalMemoryAction(row, backend)) {
    return row.target.startsWith("hindsight:")
      ? row.target
      : `hindsight://${row.target.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "") || "memories"}`;
  }
  if (backend === "mem0" && isExternalMemoryAction(row, backend)) {
    return row.target.startsWith("mem0:")
      ? row.target
      : `mem0://${row.target.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "") || "memories"}`;
  }
  return row.target;
}

export function createMemoryDiffService(options: MemoryDiffOptions): MemoryDiffService {
  const now = options.now ?? (() => Date.now());

  /** 窗口开始前的全部历史路径集合（用于区分「新增」与「修改」）。 */
  function pathsBefore(cutoff: string, backend: MemoryBackendId): Set<string> {
    const rows = options.store.listActionEvents({ until: cutoff, limit: 2000 });
    return new Set(
      rows
        .filter((row) => {
          if (row.target === "") return false;
          if (row.kind === "file-write" || row.kind === "file-delete") return isMemoryPath(row.target);
          if (backend !== "hermes") return isExternalMemoryAction(row, backend);
          return false;
        })
        .map((row) => normalizeTarget(row, backend)),
    );
  }

  function diff(windowDays: number): MemoryDiffView {
    const days = Math.max(1, Math.min(90, Math.floor(windowDays)));
    const cutoff = new Date(now() - days * 86_400_000).toISOString();
    const backendDetection = options.getBackend?.() ?? {
      backend: "hermes",
      source: "default",
      detail: "未发现外部记忆系统标记，按默认 SQLite 记忆库处理",
    };
    const activeEngine: MemoryEngineId = backendDetection.backend;
    const activeEngineName =
      activeEngine === "hindsight"
        ? "Hindsight 知识图谱记忆"
        : activeEngine === "mem0"
          ? "Mem0 长期记忆系统"
          : "Hermes 原生 SQLite 记忆库";
    const activeEngineDetail = backendDetection.detail;

    const knownBefore = pathsBefore(cutoff, backendDetection.backend);
    const rows: ActionEventRow[] = options.store.listActionEvents({ since: cutoff, limit: 5000 });

    interface Acc {
      path: string;
      writes: number;
      deletes: number;
      firstAt: string;
      lastAt: string;
      lastWriteAt: string | null;
      lastDeleteAt: string | null;
      sessionIds: Set<string>;
    }
    const byPath = new Map<string, Acc>();
    for (const row of rows) {
      const isFileMemory = (row.kind === "file-write" || row.kind === "file-delete") && isMemoryPath(row.target);
      const isExtMemory = activeEngine !== "hermes" && isExternalMemoryAction(row, backendDetection.backend);
      if (!isFileMemory && !isExtMemory) continue;

      const targetPath = normalizeTarget(row, backendDetection.backend);
      const entry = byPath.get(targetPath) ?? {
        path: targetPath,
        writes: 0,
        deletes: 0,
        firstAt: row.ts,
        lastAt: row.ts,
        lastWriteAt: null,
        lastDeleteAt: null,
        sessionIds: new Set<string>(),
      };
      const isDelete = row.kind === "file-delete" || row.target.toLowerCase().includes("delete");
      if (!isDelete) {
        entry.writes += 1;
        entry.lastWriteAt = row.ts;
      } else {
        entry.deletes += 1;
        entry.lastDeleteAt = row.ts;
      }
      if (row.ts < entry.firstAt) entry.firstAt = row.ts;
      if (row.ts > entry.lastAt) entry.lastAt = row.ts;
      if (row.sessionId !== null && entry.sessionIds.size < 5) entry.sessionIds.add(row.sessionId);
      byPath.set(targetPath, entry);
    }

    const managed = options.managedPaths === undefined ? null : new Set(options.managedPaths());
    const entries: MemoryDiffEntry[] = Array.from(byPath.values())
      .map((entry) => ({
        path: entry.path,
        change: classifyChange({
          writes: entry.writes,
          deletes: entry.deletes,
          lastWriteAt: entry.lastWriteAt,
          lastDeleteAt: entry.lastDeleteAt,
          knownBeforeWindow: knownBefore.has(entry.path),
        }),
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
        writes: entry.writes,
        deletes: entry.deletes,
        sessionIds: Array.from(entry.sessionIds),
        // 三态：命中受管清单 = true；没命中 = null（清单可能只覆盖部分目录，不能据此断言「已删除」）。
        stillPresent: managed !== null && managed.has(entry.path) ? true : null,
      }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

    const count = (change: MemoryChange): number => entries.filter((entry) => entry.change === change).length;
    const top = entries
      .slice()
      .sort((a, b) => b.writes + b.deletes - (a.writes + a.deletes) || b.lastAt.localeCompare(a.lastAt))
      .slice(0, 5);

    let basis: string;
    let basisLimits: string[];
    if (activeEngine === "hindsight") {
      basis = `近 ${days} 天基于 Hindsight 知识图谱记忆系统的行为审计流（共扫描 ${rows.length} 条动作事件，捕获 ${entries.length} 项图谱与记忆文件改动）`;
      basisLimits = [
        "主记忆系统为 Hindsight（知识图谱），记忆条目通过图谱实体与反思提取维护，不再频繁改动本地 Markdown 文件",
        "只反映观测窗口内被 agent 调用的 Hindsight 记忆 API 及受管记忆文件，不做远程图谱全量快照",
        "「不在受管清单内」不等于文件被删除；若图谱条目无本地映射，清单状态显示为未知属正常现象",
      ];
    } else if (activeEngine === "mem0") {
      basis = `近 ${days} 天基于 Mem0 长期记忆系统的行为审计流（共扫描 ${rows.length} 条动作事件，捕获 ${entries.length} 项向量与记忆文件改动）`;
      basisLimits = [
        "主记忆系统为 Mem0（双层向量/图谱），记忆条目通过 API 与向量索引维护，不依赖本地 Markdown 扁平文件",
        "只反映观测窗口内被 agent 调用的 Mem0 记忆 API 及受管记忆文件，不做外部向量全量快照",
        "「不在受管清单内」不等于文件被删除；若向量条目无本地映射，清单状态显示为未知属正常现象",
      ];
    } else {
      basis = `近 ${days} 天行为审计流中命中记忆类路径的写入/删除动作（共扫描 ${rows.length} 条动作事件）`;
      basisLimits = [
        "只反映观测窗口内被 agent 动作过的记忆文件，不做内容级语义 diff",
        "窗口之前的存量、以及不经 agent 动作的外部改动，本视图看不到",
        "「不在受管清单内」不等于已被删除——清单可能只覆盖部分目录",
      ];
    }

    return {
      windowDays: days,
      activeEngine,
      activeEngineName,
      activeEngineDetail,
      entries,
      top,
      summary: {
        added: count("added"),
        modified: count("modified"),
        forgotten: count("forgotten"),
        total: entries.length,
      },
      basis,
      basisLimits,
      lastActionAt: rows[0]?.ts ?? null,
    };
  }

  return { diff };
}
