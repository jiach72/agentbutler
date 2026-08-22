import type { BridgeHealth, CapabilityStatus } from "@butler/contract";

import { BridgeHttpError, HermesBridgeClient } from "./bridge-client.js";

export const REQUIRED_MESSAGING_COVERAGE = [
  "runtime",
  "adapterAttach",
  "inbound",
  "runLifecycle",
  "progress",
  "queuedSend",
  "apiJson",
  "apiSse",
  "a2aWaiter",
  "a2aPush",
  "edit",
  "media",
] as const;

export interface HermesMessagingCapabilityOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HermesMessagingCapabilityResult {
  status: CapabilityStatus;
  anomalies: string[];
}

/** Read-only live capability probe. It never returns URL, token, or remote error details. */
export async function probeHermesMessagingCapability(
  instanceId: string,
  options: HermesMessagingCapabilityOptions = {},
): Promise<HermesMessagingCapabilityResult> {
  const bridgeUrl = options.bridgeUrl?.trim();
  const bridgeToken = options.bridgeToken?.trim();
  if (!bridgeUrl && !bridgeToken) {
    return {
      status: "unavailable",
      anomalies: ["Hermes Bridge 未配置（消息接管未安装或未启用）"],
    };
  }
  if (!bridgeUrl || !bridgeToken) {
    return {
      status: "degraded",
      anomalies: ["Hermes Bridge 配置不完整（需要 URL 与文件加载的 token）"],
    };
  }

  let health;
  try {
    health = await new HermesBridgeClient({
      baseUrl: bridgeUrl,
      token: bridgeToken,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    }).health();
  } catch (error) {
    return { status: "degraded", anomalies: [probeFailure(error)] };
  }

  if (!validHealthShape(health)) {
    return { status: "degraded", anomalies: ["Hermes Bridge 健康响应结构无效"] };
  }

  const anomalies: string[] = [];
  if (health.instanceId !== instanceId) anomalies.push("Hermes Bridge 实例不匹配");
  if (!health.outboxWritable) anomalies.push("Hermes Bridge Outbox 不可写");
  if (!health.attached || Object.keys(health.channels).length === 0) {
    anomalies.push("Hermes Bridge 没有已 attach 的适配器");
  } else if (Object.values(health.channels).some((status) => status !== "ok")) {
    anomalies.push("Hermes Bridge 通道状态未全部就绪");
  }
  if (health.policyVersion === null || health.policyVersion.trim() === "") {
    anomalies.push("Hermes Bridge 没有有效策略快照");
  }

  const coverage =
    (
      health as BridgeHealth & {
        coverage?: Record<string, "ok" | "degraded" | "unavailable" | "pending">;
      }
    ).coverage ?? {};
  const incomplete = REQUIRED_MESSAGING_COVERAGE.filter((key) => coverage[key] !== "ok");
  if (incomplete.length > 0) {
    anomalies.push(`Hermes Bridge 覆盖矩阵不完整: ${incomplete.join(", ")}`);
  }

  return anomalies.length === 0
    ? { status: "ok", anomalies: [] }
    : { status: "degraded", anomalies };
}

function probeFailure(error: unknown): string {
  if (error instanceof BridgeHttpError) {
    if (error.status === 401 || error.status === 403) return "Hermes Bridge 鉴权失败";
    if (error.code === "protocol_mismatch") return "Hermes Bridge 协议版本不兼容";
    if (error.status === 0) return "Hermes Bridge 不可达";
  }
  return "Hermes Bridge 健康探针失败";
}

function validHealthShape(health: BridgeHealth): boolean {
  if (
    typeof health.instanceId !== "string" ||
    typeof health.attached !== "boolean" ||
    typeof health.outboxWritable !== "boolean" ||
    (health.policyVersion !== null && typeof health.policyVersion !== "string") ||
    !isRecord(health.channels)
  ) {
    return false;
  }
  return Object.values(health.channels).every((status) =>
    ["ok", "degraded", "unavailable"].includes(String(status)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
