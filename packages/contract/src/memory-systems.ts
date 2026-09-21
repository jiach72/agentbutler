/**
 * 记忆系统中心契约协议：
 * 支持自由选择与切换第三方记忆系统（Hindsight、Mem0、原生 SQLite 等），
 * 覆盖本地 Docker 部署、云端 API 接入与宿主/本地进程，并定义 TypeSafe Jev 智能建议与配置契约。
 */

export type MemoryEngineId = "hermes" | "hindsight" | "mem0" | "honcho" | "supermemory" | (string & {});

export type MemoryDeployMode = "docker" | "api" | "local" | "builtin";

export type MemoryContainerStatus = "running" | "stopped" | "not-created" | "unsupported";

export type MemoryProbeStatus = "pass" | "fail" | "unknown" | "skipped";

export interface MemorySystemView {
  id: MemoryEngineId;
  name: string;
  category: "graph" | "vector" | "relational" | "hybrid";
  description: string;
  supportedModes: MemoryDeployMode[];
  currentMode: MemoryDeployMode | null;
  active: boolean;
  containerStatus?: MemoryContainerStatus;
  containerPort?: number;
  probeStatus: MemoryProbeStatus;
  probeDetail?: string;
  docsUrl?: string;
  recommended: boolean;
  uniqueFeature: string;
}

export interface JevAdvisorHardware {
  cpuCores?: number;
  memoryGb?: number;
  hasGpu?: boolean;
}

export interface JevAdvisorPriorities {
  privacy?: number; // 1-5
  costSensitivity?: number; // 1-5
  reasoningDepth?: number; // 1-5
}

export interface JevAdvisorRequest {
  scenario: string;
  userCount?: number;
  hardware?: JevAdvisorHardware;
  priorities?: JevAdvisorPriorities;
}

export interface JevAdvisorResult {
  engine: MemoryEngineId;
  mode: MemoryDeployMode;
  confidence: number;
  probabilities: Record<string, number>;
  hardwareFitScore: number; // 1-5
  maintenanceComplexityScore: number; // 1-5
  reason: string;
  source: "jev" | "heuristic";
}

export interface MemoryConfigPreviewDiff {
  path: string;
  original: string | null;
  proposed: string;
}

export interface MemoryConfigPreview {
  engine: MemoryEngineId;
  mode: MemoryDeployMode;
  diffs: MemoryConfigPreviewDiff[];
  restartRequired: boolean;
  warnings?: string[];
}

export interface MemoryApplyParams {
  engine: MemoryEngineId;
  mode: MemoryDeployMode;
  config?: {
    apiKey?: string;
    apiUrl?: string;
    port?: number;
  };
  restartNow?: boolean;
}

export interface MemoryApplyResult {
  success: boolean;
  backupPaths: string[];
  restarted: boolean;
  message: string;
}

export interface MemoryMigrateParams {
  sourceEngine: MemoryEngineId;
  targetEngine: MemoryEngineId;
  dryRun?: boolean;
}

export interface MemoryMigrateResult {
  success: boolean;
  totalFound: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  durationMs: number;
  detail?: string;
}
