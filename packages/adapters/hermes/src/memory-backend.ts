/**
 * 记忆后端检测：识别用户实例实际使用的记忆系统。
 *
 * Hermes 默认记忆后端是实例根目录下的 SQLite+FTS5（memory_store.db），但用户
 * 可能已迁移到外部记忆系统（真实部署勘察 2026-09-07：hindsight 以 local_embedded
 * 模式运行，标记 <root>/hindsight/config.json，内含 api_url / bank_id 等字段）。
 * 检测结果供三处消费，保证「识别 → 读取 → 呈现」一致：
 * - 记忆探针：外部后端走各自 API 探针（apps/watch probes/memory-providers.ts），
 *   不再对 SQLite 假设 schema；
 * - 能力扫描：检测到外部后端时 memory-driver 不再记 anomaly（capability-scan.ts）；
 * - 备份：外部后端本地无（或陈旧的）memory_store.db，记忆增量备份明示跳过。
 *
 * 显式声明（BUTLER_MEMORY_BACKEND）优先于文件标记，文件标记优先于默认假设。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 支持识别的记忆后端。 */
export type MemoryBackendId = "hermes" | "hindsight" | "mem0";
/** 配置声明值：具体后端，或 auto（按文件标记自动检测）。 */
export type MemoryBackendConfig = MemoryBackendId | "auto";

export interface MemoryBackendDetection {
  backend: MemoryBackendId;
  /** env 显式声明 > 实例目录文件标记 > 默认 SQLite 假设。 */
  source: "env" | "marker" | "default";
  /** 人读判定依据（UI 直接展示）。 */
  detail: string;
}

/** hindsight 本地服务的部署标记（真实部署勘察：<root>/hindsight/config.json）。 */
export const HINDSIGHT_CONFIG_FILE = "hindsight/config.json";
/** mem0 部署标记（与 hindsight 目录约定对齐；json/yaml 任一即认定）。 */
export const MEM0_CONFIG_FILES = ["mem0/config.json", "mem0/config.yaml"] as const;

/**
 * 归一化 BUTLER_MEMORY_BACKEND 原始值；空值/未知值一律回落 auto（自动检测），
 * 未知配置不致把默认实例误判成外部后端。
 */
export function normalizeMemoryBackendConfig(raw: string | undefined | null): MemoryBackendConfig {
  const value = raw?.trim().toLowerCase();
  if (value === "hermes" || value === "hindsight" || value === "mem0") return value;
  return "auto";
}

export interface DetectMemoryBackendOptions {
  /** 已归一化的配置声明；缺省按 auto。 */
  configured?: MemoryBackendConfig;
  /** 文件存在性探测（测试注入）；默认 existsSync。 */
  exists?: (path: string) => boolean;
}

export function detectMemoryBackend(
  rootPath: string,
  options: DetectMemoryBackendOptions = {},
): MemoryBackendDetection {
  const exists = options.exists ?? existsSync;
  const configured = options.configured ?? "auto";
  if (configured !== "auto") {
    return {
      backend: configured,
      source: "env",
      detail: `BUTLER_MEMORY_BACKEND 显式指定 ${configured}`,
    };
  }
  if (exists(join(rootPath, HINDSIGHT_CONFIG_FILE))) {
    return {
      backend: "hindsight",
      source: "marker",
      detail: `检测到 ${HINDSIGHT_CONFIG_FILE}（hindsight 记忆服务）`,
    };
  }
  const mem0Marker = MEM0_CONFIG_FILES.find((file) => exists(join(rootPath, file)));
  if (mem0Marker !== undefined) {
    return {
      backend: "mem0",
      source: "marker",
      detail: `检测到 ${mem0Marker}（mem0 记忆服务）`,
    };
  }
  return {
    backend: "hermes",
    source: "default",
    detail: "未发现外部记忆系统标记，按默认 SQLite 记忆库处理",
  };
}
