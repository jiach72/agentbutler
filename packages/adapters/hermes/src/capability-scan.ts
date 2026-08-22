import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ok,
  type Capability,
  type CapabilityReport,
  type CapabilityStatus,
  type Result,
} from "@butler/contract";
import { readHermesConfig } from "./config.js";
import {
  defaultProber,
  findVenvPython,
  PROBE_TIMEOUT_MS,
  resolveApiEndpoint,
  type PortProber,
} from "./detect.js";
import {
  probeHermesMessagingCapability,
  type HermesMessagingCapabilityOptions,
} from "./messaging/capability.js";

export interface ScanOptions {
  /** 端口探活实现，默认 net.connect；测试可注入 fakeProber。 */
  prober?: PortProber;
  /** 可选 Bridge 只读探针配置；未配置时 messaging 明确为 unavailable。 */
  messaging?: HermesMessagingCapabilityOptions & { instanceId: string };
}

/** 解析 "instanceId|rootPath" 复合形式的 rootPath；不含 "|" 时返回 null。 */
export function parseRootPath(instance: string): string | null {
  const separator = instance.indexOf("|");
  return separator >= 0 ? instance.slice(separator + 1) : null;
}

/**
 * I-1 能力扫描（纯只读，逐项独立判定，单项失败不连坐）。
 *
 * @param instance 实例定位串：约定为 DetectedInstance 的 rootPath，
 *   或 "instanceId|rootPath" 复合形式（内部取 "|" 后半段为 rootPath）。
 */
export async function capabilityScan(
  instance: string,
  opts: ScanOptions = {},
): Promise<Result<CapabilityReport>> {
  const startedAt = Date.now();
  const separator = instance.indexOf("|");
  const rootPath = separator >= 0 ? instance.slice(separator + 1) : instance;
  const prober = opts.prober ?? defaultProber;

  const anomalies: string[] = [];
  const config = await readHermesConfig(rootPath);

  const endpoint = resolveApiEndpoint(config);
  const apiAlive = await prober(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS);

  const capabilities: Record<Capability, CapabilityStatus> = {
    probe: apiAlive ? "ok" : "unavailable",
    control: "degraded",
    messaging: "unavailable",
    "skill-driver": "unavailable",
    "memory-driver": "degraded",
    "config-driver": "unavailable",
  };

  if (findVenvPython(rootPath)) {
    capabilities["control"] = "ok";
  } else {
    anomalies.push("未找到 venv Python 解释器（非默认进程形态，控制面降级）");
  }

  if (existsSync(join(rootPath, "skills"))) {
    capabilities["skill-driver"] = "ok";
  } else {
    anomalies.push("未找到 skills/ 目录（技能布局非默认）");
  }

  if (existsSync(join(rootPath, "memory_store.db"))) {
    capabilities["memory-driver"] = "ok";
  } else {
    anomalies.push("未找到 memory_store.db（记忆后端非默认）");
  }

  if (config) {
    capabilities["config-driver"] = "ok";
  } else {
    anomalies.push("未找到 config.yaml（配置面不可用）");
  }
  // 注：Dashboard :9119 未监听属可选组件缺失，不算 anomaly。

  let effectiveLevel: 0 | 1 | 2 | 3 =
    capabilities["control"] === "ok" ? 2 : capabilities["probe"] === "ok" ? 1 : 0;
  const messaging = await probeHermesMessagingCapability(
    opts.messaging?.instanceId ?? (separator >= 0 ? instance.slice(0, separator) : "hermes-main"),
    opts.messaging,
  );
  capabilities["messaging"] = messaging.status;
  anomalies.push(...messaging.anomalies);
  if (messaging.status === "ok") effectiveLevel = 3;

  return ok({ effectiveLevel, capabilities, anomalies }, startedAt);
}
