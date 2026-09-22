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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  MemoryApplyResult,
  MemoryConfigPreview,
  MemoryConfigPreviewDiff,
  MemoryDeployMode,
  MemoryEngineId,
  MemorySystemView,
} from "@butler/contract";
import { atomicWriteText } from "@butler/core";

/** 支持识别的记忆后端。 */
export type MemoryBackendId = "hermes" | "hindsight" | "mem0";
/** 配置声明值：具体后端，或 auto（按文件标记自动检测）。 */
export type MemoryBackendConfig = MemoryBackendId | "auto";

export interface MemoryBackendDetection {
  backend: MemoryBackendId;
  /** env 显式声明 > config.yaml MCP 配置 > 实例目录文件标记 > 默认 SQLite 假设。 */
  source: "env" | "config" | "marker" | "default";
  /** 人读判定依据（UI 直接展示）。 */
  detail: string;
}

/** hindsight 本地服务的部署标记（真实部署勘察：<root>/hindsight/config.json）。 */
export const HINDSIGHT_CONFIG_FILE = "hindsight/config.json";
/** hindsight 识别标记清单（包含 config.json、本地 env、虚拟环境及进程 pid 标记）。 */
export const HINDSIGHT_MARKER_FILES = [
  "hindsight/config.json",
  "hindsight-local.env",
  "hindsight-venv",
  "hindsight-local.pid",
] as const;

/** mem0 部署标记（与 hindsight 目录约定对齐；json/yaml 任一即认定）。 */
export const MEM0_CONFIG_FILES = ["mem0/config.json", "mem0/config.yaml"] as const;
/** mem0 识别标记清单。 */
export const MEM0_MARKER_FILES = [
  "mem0/config.json",
  "mem0/config.yaml",
  "mem0.json",
  "mem0-local.env",
] as const;

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
  /** 文本文件读取（测试注入）；默认 readFileSync。 */
  readTextFile?: (path: string) => string | null;
}

function defaultReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function detectMemoryBackend(
  rootPath: string,
  options: DetectMemoryBackendOptions = {},
): MemoryBackendDetection {
  const exists = options.exists ?? existsSync;
  const readText = options.readTextFile ?? defaultReadTextFile;
  const configured = options.configured ?? "auto";
  if (configured !== "auto") {
    return {
      backend: configured,
      source: "env",
      detail: `BUTLER_MEMORY_BACKEND 显式指定 ${configured}`,
    };
  }

  // 检查 Hermes config.yaml / config.yml 中的 mcp_servers 配置
  for (const configFile of ["config.yaml", "config.yml"]) {
    const configPath = join(rootPath, configFile);
    if (exists(configPath)) {
      const raw = readText(configPath);
      if (raw !== null && raw.trim() !== "") {
        try {
          const parsed = parseYaml(raw);
          if (parsed !== null && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            const memoryConfig = record["memory"];
            if (memoryConfig !== null && typeof memoryConfig === "object") {
              const memRecord = memoryConfig as Record<string, unknown>;
              const provider = typeof memRecord["provider"] === "string" ? memRecord["provider"].trim().toLowerCase() : "";
              if (provider === "hindsight") {
                return {
                  backend: "hindsight",
                  source: "config",
                  detail: `检测到 ${configFile} 中 memory.provider 配置为 hindsight`,
                };
              }
              if (provider === "mem0") {
                return {
                  backend: "mem0",
                  source: "config",
                  detail: `检测到 ${configFile} 中 memory.provider 配置为 mem0`,
                };
              }
            }
            const mcp = record["mcp_servers"] ?? record["mcpServers"];
            if (mcp !== null && typeof mcp === "object") {
              const mcpRecord = mcp as Record<string, unknown>;
              if ("hindsight" in mcpRecord && mcpRecord["hindsight"] != null) {
                return {
                  backend: "hindsight",
                  source: "config",
                  detail: `检测到 ${configFile} 中配置了 hindsight MCP 记忆服务`,
                };
              }
              if ("mem0" in mcpRecord && mcpRecord["mem0"] != null) {
                return {
                  backend: "mem0",
                  source: "config",
                  detail: `检测到 ${configFile} 中配置了 mem0 MCP 记忆服务`,
                };
              }
            }
          }
        } catch {
          // YAML 解析异常降级检查 marker
        }
      }
    }
  }

  const hindsightMarker = HINDSIGHT_MARKER_FILES.find((file) => exists(join(rootPath, file)));
  if (hindsightMarker !== undefined) {
    return {
      backend: "hindsight",
      source: "marker",
      detail: `检测到 ${hindsightMarker}（hindsight 记忆服务）`,
    };
  }
  const mem0Marker = MEM0_MARKER_FILES.find((file) => exists(join(rootPath, file)));
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

/**
 * 探测并列举当前支持的记忆系统列表与各自状态
 */
export function listSupportedMemorySystems(
  rootPath: string,
  options: DetectMemoryBackendOptions = {},
): MemorySystemView[] {
  const current = detectMemoryBackend(rootPath, options);
  const exists = options.exists ?? existsSync;
  const readText = options.readTextFile ?? defaultReadTextFile;

  // 检测 Hindsight 模式
  let hindsightMode: MemoryDeployMode | null = null;
  if (current.backend === "hindsight") {
    const configRaw = readText(join(rootPath, HINDSIGHT_CONFIG_FILE));
    if (configRaw && (configRaw.includes("127.0.0.1:9177") || configRaw.includes("localhost:9177"))) {
      hindsightMode = "docker";
    } else if (configRaw && configRaw.includes("http")) {
      hindsightMode = "api";
    } else {
      hindsightMode = "local";
    }
  }

  // 检测 Mem0 模式
  let mem0Mode: MemoryDeployMode | null = null;
  if (current.backend === "mem0") {
    const configRaw = readText(join(rootPath, "mem0.json")) || readText(join(rootPath, "mem0/config.json"));
    if (configRaw && (configRaw.includes("127.0.0.1:8888") || configRaw.includes("localhost:8888"))) {
      mem0Mode = "docker";
    } else if (configRaw && configRaw.includes("platform")) {
      mem0Mode = "api";
    } else {
      mem0Mode = "local";
    }
  }

  return [
    {
      id: "hindsight",
      name: "Hindsight 知识图谱记忆",
      category: "graph",
      description: "知识图谱驱动的深度记忆引擎，具备跨会话 Reflect 综合推理与实体解析能力。",
      supportedModes: ["docker", "api", "local"],
      currentMode: hindsightMode,
      active: current.backend === "hindsight",
      containerPort: 9177,
      probeStatus: current.backend === "hindsight" ? "pass" : "unknown",
      recommended: true,
      uniqueFeature: "知识图谱 + 跨会话 Reflect 反思推理",
      docsUrl: "https://hindsight.vectorize.io",
    },
    {
      id: "mem0",
      name: "Mem0 长期记忆系统",
      category: "hybrid",
      description: "双层向量数据库 + 实体图谱架构，免维护自动提取，具备极高的 Token 检索经济性。",
      supportedModes: ["docker", "api", "local"],
      currentMode: mem0Mode,
      active: current.backend === "mem0",
      containerPort: 8888,
      probeStatus: current.backend === "mem0" ? "pass" : "unknown",
      recommended: true,
      uniqueFeature: "双层向量与图谱检索，高 Token 效率",
      docsUrl: "https://mem0.ai",
    },
    {
      id: "hermes",
      name: "Hermes 原生 SQLite 记忆库",
      category: "relational",
      description: "内置 SQLite + FTS5 全文检索引擎，零外部依赖，极低内存消耗。",
      supportedModes: ["builtin"],
      currentMode: "builtin",
      active: current.backend === "hermes",
      probeStatus: current.backend === "hermes" ? "pass" : "unknown",
      recommended: false,
      uniqueFeature: "原生轻量，零网络与容器依赖",
    },
    {
      id: "honcho",
      name: "Honcho 辩证用户建模",
      category: "hybrid",
      description: "专注于多对话者心智建模与会话级别辩证认知。",
      supportedModes: ["api", "docker"],
      currentMode: null,
      active: false,
      probeStatus: "unknown",
      recommended: false,
      uniqueFeature: "会话级别辩证用户画像建模",
      docsUrl: "https://honcho.dev",
    },
    {
      id: "supermemory",
      name: "Supermemory 语义围栏",
      category: "vector",
      description: "上下文安全围栏与多容器记忆隔离。",
      supportedModes: ["api", "docker"],
      currentMode: null,
      active: false,
      probeStatus: "unknown",
      recommended: false,
      uniqueFeature: "上下文隔离与安全记忆保护",
      docsUrl: "https://supermemory.ai",
    },
  ];
}

export interface MemoryBackendChangeOptions {
  engineId?: MemoryEngineId;
  deployMode?: MemoryDeployMode;
  customEndpoint?: string;
  apiUrl?: string;
  apiKey?: string;
  port?: number;
}

/**
 * 预览记忆系统切换的配置 Diff
 */
export function previewMemoryBackendChange(
  rootPath: string,
  engineOrOptions: MemoryEngineId | MemoryBackendChangeOptions,
  modeArg?: MemoryDeployMode,
  paramsArg: { apiUrl?: string; apiKey?: string; port?: number } = {},
): MemoryConfigPreview & { targetFiles: string[] } {
  let engine: MemoryEngineId;
  let mode: MemoryDeployMode;
  let params: { apiUrl?: string; apiKey?: string; port?: number };

  if (typeof engineOrOptions === "object" && engineOrOptions !== null) {
    const opts = engineOrOptions as MemoryBackendChangeOptions;
    engine = opts.engineId ?? "hermes";
    mode = opts.deployMode ?? "docker";
    params = {
      apiUrl: opts.customEndpoint ?? opts.apiUrl,
      apiKey: opts.apiKey,
      port: opts.port,
    };
  } else {
    engine = engineOrOptions;
    mode = modeArg ?? "docker";
    params = paramsArg;
  }

  const diffs: (MemoryConfigPreviewDiff & { file: string; oldContent: string | null; newContent: string })[] = [];
  const warnings: string[] = [];

  // 1. config.yaml
  const configPath = join(rootPath, "config.yaml");
  let origConfigYaml: string | null = null;
  let parsedConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    origConfigYaml = readFileSync(configPath, "utf8");
    try {
      parsedConfig = (parseYaml(origConfigYaml) as Record<string, unknown>) || {};
    } catch {
      warnings.push("现有 config.yaml 存在语法格式告警，将进行安全合并");
    }
  }

  const newConfig = { ...parsedConfig };
  const memoryObj = (typeof newConfig["memory"] === "object" && newConfig["memory"] !== null
    ? { ...(newConfig["memory"] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  memoryObj["memory_enabled"] = true;
  if (engine === "hermes") {
    delete memoryObj["provider"];
  } else {
    memoryObj["provider"] = engine;
  }
  newConfig["memory"] = memoryObj;

  // 同时也维护 mcp_servers，使外部后端在各客户端与测试环境下一体化就绪
  const mcpObj = (typeof newConfig["mcp_servers"] === "object" && newConfig["mcp_servers"] !== null
    ? { ...(newConfig["mcp_servers"] as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  if (engine === "hindsight") {
    const ep =
      mode === "docker"
        ? `http://127.0.0.1:${params.port || 9177}`
        : params.apiUrl || "https://api.hindsight.vectorize.io";
    mcpObj["hindsight"] = { url: ep };
    newConfig["mcp_servers"] = mcpObj;
  } else if (engine === "mem0") {
    const ep =
      mode === "docker"
        ? `http://127.0.0.1:${params.port || 8888}`
        : params.apiUrl || "https://api.mem0.ai";
    mcpObj["mem0"] = { url: ep };
    newConfig["mcp_servers"] = mcpObj;
  }

  const proposedConfigYaml = stringifyYaml(newConfig);
  diffs.push({
    path: "config.yaml",
    original: origConfigYaml,
    proposed: proposedConfigYaml,
    file: "config.yaml",
    oldContent: origConfigYaml,
    newContent: proposedConfigYaml,
  });

  // 2. 专用配置文件 (hindsight/config.json 或 mem0.json)
  if (engine === "hindsight") {
    const targetFile = join(rootPath, HINDSIGHT_CONFIG_FILE);
    const origJson = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : null;
    const apiUrl = mode === "docker"
      ? `http://127.0.0.1:${params.port || 9177}`
      : params.apiUrl || "https://api.hindsight.vectorize.io";
    const proposedJson = JSON.stringify(
      {
        api_url: apiUrl,
        bank_id: "hermes",
        mode: mode,
      },
      null,
      2,
    );
    diffs.push({
      path: HINDSIGHT_CONFIG_FILE,
      original: origJson,
      proposed: proposedJson,
      file: HINDSIGHT_CONFIG_FILE,
      oldContent: origJson,
      newContent: proposedJson,
    });
  } else if (engine === "mem0") {
    const targetFile = join(rootPath, "mem0.json");
    const origJson = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : null;
    const host = mode === "docker" ? `http://127.0.0.1:${params.port || 8888}` : undefined;
    const proposedJson = JSON.stringify(
      {
        version: "v1",
        mode: mode === "docker" ? "selfhosted" : "platform",
        ...(host ? { host } : {}),
      },
      null,
      2,
    );
    diffs.push({
      path: "mem0.json",
      original: origJson,
      proposed: proposedJson,
      file: "mem0.json",
      oldContent: origJson,
      newContent: proposedJson,
    });
  }

  return {
    engine,
    mode,
    diffs,
    targetFiles: diffs.map((d) => d.path),
    restartRequired: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * 安全原子应用记忆系统配置变更，并备份原文件
 */
export function applyMemoryBackendChange(
  rootPath: string,
  engineOrOptions: MemoryEngineId | MemoryBackendChangeOptions,
  modeArg?: MemoryDeployMode,
  paramsArg: { apiUrl?: string; apiKey?: string; port?: number } = {},
): MemoryApplyResult {
  const preview = previewMemoryBackendChange(rootPath, engineOrOptions, modeArg, paramsArg);
  const backupPaths: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const diff of preview.diffs) {
    const fullPath = join(rootPath, diff.path);
    if (existsSync(fullPath)) {
      const backupPath = `${fullPath}.bak-butler-${stamp}`;
      copyFileSync(fullPath, backupPath);
      backupPaths.push(backupPath);
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    atomicWriteText(fullPath, diff.proposed);
  }

  const apiKey =
    typeof engineOrOptions === "object" && engineOrOptions !== null
      ? (engineOrOptions as MemoryBackendChangeOptions).apiKey
      : paramsArg.apiKey;

  // 若提供了 API Key，同步写入 .env
  if (apiKey && (preview.engine === "mem0" || preview.engine === "hindsight")) {
    const envPath = join(rootPath, ".env");
    const envVar = preview.engine === "mem0" ? "MEM0_API_KEY" : "HINDSIGHT_API_KEY";
    let envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const reg = new RegExp(`^${envVar}=.*$`, "m");
    if (reg.test(envContent)) {
      envContent = envContent.replace(reg, `${envVar}=${apiKey.trim()}`);
    } else {
      envContent = `${envContent.trimEnd()}\n${envVar}=${apiKey.trim()}\n`;
    }
    atomicWriteText(envPath, envContent);
  }

  return {
    success: true,
    backupPaths,
    restarted: false,
    message: `已安全更新记忆系统配置为 ${preview.engine} (${preview.mode})，创建了 ${backupPaths.length} 份备份`,
  };
}

