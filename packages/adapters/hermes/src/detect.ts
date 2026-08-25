import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ok, type DetectedInstance, type DiscoveryHint, type Result } from "@butler/contract";
import { readHermesConfig, type HermesConfig } from "./config.js";

/** 端口探活函数签名：连通返回 true，超时/拒绝返回 false（不抛异常）。 */
export type PortProber = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface DetectOptions {
  /** 端口探活实现，默认 net.connect；测试可注入 fakeProber。 */
  prober?: PortProber;
}

/** 默认 API 端口：config.yaml 未声明 api_server.extra.port 时的缺省值。 */
export const DEFAULT_API_PORT = 8642;

/** 端口探活超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 1500;

/** confidence 上限：即使全部证据命中也保留人工确认空间。 */
const CONFIDENCE_CAP = 0.95;

/** detect 建议的实例名（内核确认后生效）。 */
const SUGGESTED_INSTANCE_ID = "hermes-main";

/** venv Python 解释器的候选相对路径（真实 Hermes v0.20.4 为 hermes-agent/venv/bin/python）。 */
const VENV_PYTHON_CANDIDATES = [
  join("hermes-agent", "venv", "bin", "python"),
  join("hermes-agent", "venv", "Scripts", "python.exe"),
  join("venv", "bin", "python"),
  join("venv", "Scripts", "python.exe"),
];

/** 默认端口探活：net.connect，带超时，任何失败路径都静默返回 false。 */
export function defaultProber(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    const finish = (result: boolean) => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * I-1 实例探测（纯只读：仅 stat/read 文件与 TCP connect，不启进程、不写文件）。
 * 候选根路径：hint.rootPath 用于缩小扫描范围（只扫该根）；
 * 无 hint 时扫描 HERMES_ROOT 与 ~/.hermes 的去重合集。
 * 逐候选收集 evidence 并计 confidence，evidence 为空的候选直接丢弃。
 */
export async function detect(
  hint?: DiscoveryHint,
  opts: DetectOptions = {},
): Promise<Result<DetectedInstance[]>> {
  const startedAt = Date.now();
  const prober = opts.prober ?? defaultProber;

  const instances: DetectedInstance[] = [];
  for (const rootPath of candidateRoots(hint)) {
    const instance = await scanRoot(rootPath, prober);
    if (instance) instances.push(instance);
  }
  return ok(instances, startedAt);
}

/** 候选根路径：有 hint 只扫 hint；否则取 HERMES_ROOT 与 ~/.hermes，resolve 后去重。 */
function candidateRoots(hint?: DiscoveryHint): string[] {
  const raw: Array<string | undefined> = hint?.rootPath
    ? [hint.rootPath]
    : [process.env["HERMES_ROOT"], join(homedir(), ".hermes")];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of raw) {
    if (!candidate) continue;
    const resolved = resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  }
  return roots;
}

async function scanRoot(rootPath: string, prober: PortProber): Promise<DetectedInstance | null> {
  const evidence: string[] = [];
  let confidence = 0;
  let version: string | null = null;
  let runtime: DetectedInstance["runtime"] = "unknown";

  if (!existsSync(rootPath)) return null;
  evidence.push(`目录存在: ${rootPath}`);
  confidence += 0.25;

  const config = await readHermesConfig(rootPath);
  if (config) {
    evidence.push("config.yaml 存在");
    confidence += 0.15;
  }

  version = readPyprojectVersion(rootPath);
  if (version) {
    evidence.push(`pyproject.toml version=${version}`);
    confidence += 0.3;
  }

  const venvPython = findVenvPython(rootPath);
  if (venvPython) {
    evidence.push(`${venvPython} 存在`);
    confidence += 0.15;
    runtime = "process";
  }
  // TODO(I-2): 无 venv 证据时应探测 docker 容器标签以判定 runtime="docker"；V1 简化为 unknown。

  const endpoint = resolveApiEndpoint(config);
  if (await prober(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS)) {
    evidence.push(`API Server :${endpoint.port} 探活成功`);
    confidence += 0.2;
  }

  return {
    instanceId: SUGGESTED_INSTANCE_ID,
    version,
    rootPath,
    runtime,
    confidence: Math.min(CONFIDENCE_CAP, Math.round(confidence * 100) / 100),
    evidence,
  };
}

/** 从 <root>/hermes-agent/pyproject.toml 解析 version = "x.y.z"；缺失/无版本返回 null。 */
export function readPyprojectVersion(rootPath: string): string | null {
  const pyprojectPath = join(rootPath, "hermes-agent", "pyproject.toml");
  if (!existsSync(pyprojectPath)) return null;
  try {
    return parsePyprojectVersion(readFileSync(pyprojectPath, "utf8"));
  } catch {
    return null;
  }
}

/** 正则提取首个 `version = "x.y.z"` 声明。 */
export function parsePyprojectVersion(content: string): string | null {
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(content);
  return match ? match[1]! : null;
}

/** 返回首个存在的 venv Python 相对路径；不存在返回 null。 */
export function findVenvPython(rootPath: string): string | null {
  return VENV_PYTHON_CANDIDATES.find((rel) => existsSync(join(rootPath, rel))) ?? null;
}

/** 解析 API 探活端点：port 取 config 声明（缺省 8642）；通配地址归一为 127.0.0.1。 */
export function resolveApiEndpoint(config: HermesConfig | null): { host: string; port: number } {
  const configuredPort = Number(process.env["BUTLER_HERMES_API_PORT"] ?? "");
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : (config?.apiServer.port ?? DEFAULT_API_PORT);
  const rawHost = process.env["BUTLER_HERMES_API_HOST"]?.trim() || config?.apiServer.host;
  const host = !rawHost || rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  return { host, port };
}
