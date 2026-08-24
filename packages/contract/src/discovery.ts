import type { FrameworkId, InstanceId, InstanceRef, Level, Result } from "./common.js";

/** 契约承认的全部能力位（manifest 与 CapabilityReport 共用）。 */
export const CAPABILITIES = [
  "probe",
  "control",
  "messaging",
  "skill-driver",
  "memory-driver",
  "config-driver",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** 能力位运行时状态：未实现的能力必须显式声明 not-implemented 而非缺省。 */
export type CapabilityStatus = "ok" | "degraded" | "unavailable" | "not-implemented";

/** 探测提示：调用方已知的线索，用于缩小扫描范围。 */
export interface DiscoveryHint {
  rootPath?: string;
  containerName?: string;
}

/** 探测到的候选实例（detect 无副作用，instanceId 仅为建议名，由内核确认）。 */
export interface DetectedInstance {
  instanceId: InstanceId;
  version: string | null;
  rootPath: string;
  runtime: "docker" | "process" | "unknown";
  /** 置信度 0-1，1 为完全确定。 */
  confidence: number;
  /** 判定证据（文件路径、容器标签、端口探活结果等），供消歧与审计。 */
  evidence: string[];
}

/** 能力扫描报告：逐项独立判定，单项失败不影响其余项。 */
export interface CapabilityReport {
  effectiveLevel: Level;
  capabilities: Record<Capability, CapabilityStatus>;
  anomalies: string[];
}

/** 日志源描述：同步枚举，不产生 IO。 */
export interface LogSource {
  id: string;
  path: string;
  format: "text" | "jsonl";
  /** jsonl 格式下的时间戳字段名。 */
  tsField?: string;
}

/** I-1 发现适配器：只读观察面，所有方法不得产生副作用。 */
export interface DiscoveryAdapter {
  readonly frameworkId: FrameworkId;
  detect(hint?: DiscoveryHint): Promise<Result<DetectedInstance[]>>;
  capabilityScan(instance: InstanceRef): Promise<Result<CapabilityReport>>;
  logSources(instance: InstanceRef): LogSource[];
}
