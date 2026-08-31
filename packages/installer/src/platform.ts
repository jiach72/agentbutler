/**
 * 平台检测：安装器一切决策的起点。
 *
 * 产出结构化 PlatformReport：
 * - OS/Arch（process.platform / process.arch）
 * - 是否 WSL（/proc/version 含 microsoft 或设置 WSL_DISTRO_NAME）
 * - Node 版本是否满足 >=22（本仓 engines 约束）
 * - docker CLI / docker compose 可用性（短超时探测）
 *
 * 所有命令执行均可注入（exec 参数），测试不触网、不执行真实命令。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 单次命令执行结果（永不 throw，失败以非零 code 表达）。 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** 可注入的命令执行器（默认实现见 defaultExec）。 */
export type Exec = (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** 默认执行器：child_process.execFile 封装，错误折叠为非零退出码。 */
export function defaultExec(command: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: opts.timeoutMs, cwd: opts.cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** 平台检测结果。 */
export interface PlatformReport {
  os: string;
  arch: string;
  isWsl: boolean;
  /** 判定 WSL 的证据（/proc/version 命中或 WSL_DISTRO_NAME 存在）。 */
  wslEvidence: string[];
  nodeVersion: string;
  /** Node 主版本 >= 22。 */
  nodeSatisfied: boolean;
  nodeRequirement: string;
  dockerAvailable: boolean;
  dockerComposeAvailable: boolean;
  /** 可选运行时体检：只在真实默认执行器下探测，注入式测试不会触碰宿主命令。 */
  pythonVersion?: string | null;
  pythonSatisfied?: boolean;
  hermesRoot?: string | null;
  hermesCandidates?: string[];
  installationCandidates?: InstallationCandidate[];
}

/** docker 探测使用的短超时（毫秒）。 */
export const DOCKER_PROBE_TIMEOUT_MS = 5000;

/** detectPlatform 的可覆盖项（均用于测试注入）。 */
export interface DetectPlatformOverrides {
  nodeVersion?: string;
  env?: Record<string, string | undefined>;
  /** 读文本文件的实现（默认安全读取，失败返回空串）。 */
  readFile?: (path: string) => string;
}

export interface InstallationCandidate {
  framework: "hermes" | "openclaw";
  rootPath: string;
  source: "configured" | "home" | "local-app-data" | "workspace" | "unknown";
  version: string | null;
  ownership: "managed" | "unmanaged" | "unknown";
  active: boolean;
  fingerprint: string | null;
}

export interface PortOwner {
  port: number;
  pid: number | null;
  processName: string | null;
  command: string | null;
}

/** 跨平台读取监听端口归属；取不到进程名时仍返回 PID 线索。 */
export async function findPortOwner(exec: Exec, port: number): Promise<PortOwner | null> {
  if (process.platform === "win32") {
    const netstat = await exec("netstat", ["-ano", "-p", "tcp"], { timeoutMs: 10_000 });
    const match = netstat.stdout.split(/\r?\n/).map((line) => /^\s*TCP\s+\S+:([0-9]+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)).find((item) => item !== null && Number(item[1]) === port);
    if (match === undefined || match === null) return null;
    const pid = Number(match[2]);
    const task = await exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 10_000 });
    const name = /^"([^"]+)"/.exec(task.stdout)?.[1] ?? null;
    return { port, pid: Number.isInteger(pid) ? pid : null, processName: name, command: name };
  }
  const ss = await exec("ss", ["-H", "-ltnp"], { timeoutMs: 10_000 });
  if (ss.code === 0) {
    for (const line of ss.stdout.split(/\r?\n/)) {
      if (!new RegExp(`:${port}\\b`).test(line)) continue;
      const pid = /pid=(\d+)/.exec(line)?.[1];
    const name = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? null;
      return { port, pid: pid === undefined ? null : Number(pid), processName: name, command: name };
    }
  }
  const lsof = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"], { timeoutMs: 10_000 });
  if (lsof.code !== 0) return null;
  const pid = /^p(\d+)/m.exec(lsof.stdout)?.[1];
  const name = /^c(.+)/m.exec(lsof.stdout)?.[1] ?? null;
  return { port, pid: pid === undefined ? null : Number(pid), processName: name, command: name };
}

function defaultReadFile(path: string): string {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** 解析主版本号："v22.1.0" -> 22，解析失败返回 0。 */
export function majorVersion(version: string): number {
  const match = /^\s*v?(\d+)/.exec(version);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

/** 检测当前平台（OS/WSL/Node/docker/compose），命令执行全部走注入的 exec。 */
export async function detectPlatform(
  exec: Exec = defaultExec,
  overrides: DetectPlatformOverrides = {},
): Promise<PlatformReport> {
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const env = overrides.env ?? process.env;
  const readFile = overrides.readFile ?? defaultReadFile;

  const wslEvidence: string[] = [];
  const procVersion = readFile("/proc/version");
  if (procVersion.toLowerCase().includes("microsoft")) {
    wslEvidence.push("/proc/version 含 microsoft");
  }
  if (env["WSL_DISTRO_NAME"] !== undefined && env["WSL_DISTRO_NAME"] !== "") {
    wslEvidence.push(`WSL_DISTRO_NAME=${env["WSL_DISTRO_NAME"]}`);
  }

  const dockerRes = await exec("docker", ["version"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  const composeRes = await exec("docker", ["compose", "version"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });

  let pythonVersion: string | null = null;
  if (exec === defaultExec) {
    for (const command of process.platform === "win32" ? ["py", "python"] : ["python3", "python"]) {
      const result = await exec(command, ["--version"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
      if (result.code === 0) {
        pythonVersion = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? null;
        if (pythonVersion !== null && pythonVersion !== "") break;
      }
    }
  }
  const configuredHermes = env["BUTLER_HERMES_ROOT"]?.trim() || env["HERMES_ROOT"]?.trim();
  const hermesCandidates = [...new Set([
    configuredHermes,
    path.join(env["USERPROFILE"]?.trim() || os.homedir(), ".hermes"),
    path.join(os.homedir(), ".hermes"),
    path.join(env["LOCALAPPDATA"]?.trim() || path.join(os.homedir(), "AppData", "Local"), "hermes"),
  ].filter((value): value is string => value !== undefined && value !== ""))];
  const hermesRoot = hermesCandidates.find((candidate) => fs.existsSync(path.join(candidate, "hermes-agent"))) ?? null;
  const selectedFramework = env["BUTLER_FRAMEWORK"] === "openclaw" ? "openclaw" : "hermes";
  const candidateRoots = [
    ...hermesCandidates.map((root) => ({ root, source: root === configuredHermes ? "configured" as const : root.includes("AppData") ? "local-app-data" as const : "home" as const })),
    { root: env["BUTLER_OPENCLAW_ROOT"]?.trim() ?? path.join(os.homedir(), ".openclaw"), source: env["BUTLER_OPENCLAW_ROOT"]?.trim() ? "configured" as const : "home" as const },
    { root: path.join(process.cwd(), ".runtime", "openclaw"), source: "workspace" as const },
  ];
  const installationCandidates: InstallationCandidate[] = [];
  for (const item of candidateRoots) {
    const framework = fs.existsSync(path.join(item.root, "openclaw.json")) ? "openclaw" : fs.existsSync(path.join(item.root, "hermes-agent")) ? "hermes" : null;
    if (framework === null) continue;
    const versionFile = framework === "openclaw" ? path.join(item.root, "VERSION") : path.join(item.root, "VERSION");
    let version: string | null = null;
    try { version = fs.readFileSync(versionFile, "utf8").trim() || null; } catch { /* optional */ }
    let fingerprint: string | null = null;
    try {
      const config = framework === "openclaw" ? fs.readFileSync(path.join(item.root, "openclaw.json"), "utf8") : fs.readFileSync(path.join(item.root, "config.yaml"), "utf8");
      fingerprint = createHash("sha256").update(`${framework}\u0000${version ?? ""}\u0000${config.slice(0, 16 * 1024)}`).digest("hex");
    } catch { /* optional */ }
    installationCandidates.push({ framework, rootPath: item.root, source: item.source, version, ownership: item.source === "configured" ? "managed" : "unknown", active: framework === selectedFramework && item.root === (framework === "hermes" ? hermesRoot : candidateRoots.find((candidate) => fs.existsSync(path.join(candidate.root, "openclaw.json")))?.root), fingerprint });
  }

  return {
    os: process.platform,
    arch: process.arch,
    isWsl: wslEvidence.length > 0,
    wslEvidence,
    nodeVersion,
    nodeSatisfied: majorVersion(nodeVersion) >= 22,
    nodeRequirement: ">=22",
    dockerAvailable: dockerRes.code === 0,
    dockerComposeAvailable: composeRes.code === 0,
    pythonVersion,
    pythonSatisfied: pythonVersion === null ? (exec === defaultExec ? false : undefined) : (() => {
      const match = /Python\s+(\d+)\.(\d+)\.(\d+)/i.exec(pythonVersion);
      return match !== null && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 11));
    })(),
    hermesRoot,
    hermesCandidates,
    installationCandidates,
  };
}
