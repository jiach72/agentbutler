import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ok, type DetectedInstance, type DiscoveryHint, type Result } from "@butler/contract";

const DEFAULT_ROOT = ".openclaw";
const CONFIDENCE_CAP = 0.95;
export const DEFAULT_OPENCLAW_GATEWAY_PORT = 18_789;
export const PROBE_TIMEOUT_MS = 1_500;

export type PortProber = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export function defaultProber(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    const done = (value: boolean) => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

function candidateRoots(hint?: DiscoveryHint): string[] {
  const raw = hint?.rootPath ? [hint.rootPath] : [process.env["OPENCLAW_HOME"], join(homedir(), DEFAULT_ROOT)];
  const seen = new Set<string>();
  return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => resolve(item)).filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function readVersion(rootPath: string): string | null {
  for (const file of [join(rootPath, "VERSION"), join(rootPath, "version"), join(rootPath, "node_modules", "openclaw", "package.json")]) {
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, "utf8").trim();
      const value = file.endsWith("package.json")
        ? String((JSON.parse(raw) as Record<string, unknown>)["version"] ?? "")
        : raw;
      if (value !== "") return value;
    } catch {
      // 发现面保持无副作用，版本读取失败只降低证据置信度。
    }
  }
  return null;
}

async function scanRoot(rootPath: string, prober: PortProber): Promise<DetectedInstance | null> {
  if (!existsSync(rootPath)) return null;
  const evidence: string[] = [`目录存在: ${rootPath}`];
  let confidence = 0.25;
  const config = join(rootPath, "openclaw.json");
  const workspace = join(rootPath, "workspace");
  const state = join(rootPath, "state");
  if (existsSync(config)) {
    evidence.push("openclaw.json 存在");
    confidence += 0.35;
  }
  if (existsSync(workspace)) {
    evidence.push("workspace/ 存在");
    confidence += 0.2;
  }
  if (existsSync(state)) {
    evidence.push("state/ 存在");
    confidence += 0.1;
  }
 const gatewayPort = Number(process.env["OPENCLAW_GATEWAY_PORT"] ?? DEFAULT_OPENCLAW_GATEWAY_PORT);
  const gatewayHost = process.env["OPENCLAW_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const effectivePort = Number.isFinite(gatewayPort) ? gatewayPort : DEFAULT_OPENCLAW_GATEWAY_PORT;
  if (await prober(gatewayHost, effectivePort, PROBE_TIMEOUT_MS)) {
    evidence.push("Gateway " + gatewayHost + ":" + effectivePort + " 探活成功");
    confidence += 0.2;
  }
  return {
    instanceId: "openclaw-main",
    version: readVersion(rootPath),
    rootPath,
    runtime: "process",
    confidence: Math.min(CONFIDENCE_CAP, Math.round(confidence * 100) / 100),
    evidence,
  };
}

export async function detect(hint?: DiscoveryHint, opts: { prober?: PortProber } = {}): Promise<Result<DetectedInstance[]>> {
  const startedAt = Date.now();
  const prober = opts.prober ?? defaultProber;
  const detected: DetectedInstance[] = [];
  for (const root of candidateRoots(hint)) {
    const item = await scanRoot(root, prober);
    if (item !== null) detected.push(item);
  }
  return ok(detected, startedAt);
}
