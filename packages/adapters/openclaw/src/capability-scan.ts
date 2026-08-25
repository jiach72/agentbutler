import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, type Capability, type CapabilityReport, type CapabilityStatus, type Result } from "@butler/contract";
import { DEFAULT_OPENCLAW_GATEWAY_PORT, defaultProber, PROBE_TIMEOUT_MS, type PortProber } from "./detect.js";

export function parseRootPath(instance: string): string {
  const separator = instance.indexOf("|");
  return separator >= 0 ? instance.slice(separator + 1) : instance;
}

export async function capabilityScan(instance: string, opts: { prober?: PortProber } = {}): Promise<Result<CapabilityReport>> {
  const startedAt = Date.now();
  const rootPath = parseRootPath(instance);
  const anomalies: string[] = [];
  const config = existsSync(join(rootPath, "openclaw.json"));
  const workspace = existsSync(join(rootPath, "workspace"));
  const state = existsSync(join(rootPath, "state"));
  const gatewayPort = Number(process.env["OPENCLAW_GATEWAY_PORT"] ?? DEFAULT_OPENCLAW_GATEWAY_PORT);
  const gatewayHost = process.env["OPENCLAW_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const effectivePort = Number.isFinite(gatewayPort) ? gatewayPort : DEFAULT_OPENCLAW_GATEWAY_PORT;
  const gatewayAlive = await (opts.prober ?? defaultProber)(gatewayHost, effectivePort, PROBE_TIMEOUT_MS);
  const capabilities: Record<Capability, CapabilityStatus> = {
    probe: gatewayAlive ? "ok" : config ? "degraded" : "unavailable",
    control: config ? "ok" : "unavailable",
    messaging: "not-implemented",
    "skill-driver": workspace ? "ok" : "degraded",
    "memory-driver": workspace ? "degraded" : "unavailable",
    "config-driver": config ? "ok" : "unavailable",
  };
  if (!config) anomalies.push("未找到 openclaw.json，配置校验与控制面不可用");
  if (!workspace) anomalies.push("未找到 workspace/，技能与 Markdown 记忆清单将不可用");
  if (!state) anomalies.push("未找到 state/，无法确认 OpenClaw 状态目录");
  if (!gatewayAlive) anomalies.push("Gateway " + gatewayHost + ":" + effectivePort + " 当前不可达");
  const effectiveLevel: 0 | 1 | 2 = config ? 2 : workspace ? 1 : 0;
  return ok({ effectiveLevel, capabilities, anomalies }, startedAt);
}
