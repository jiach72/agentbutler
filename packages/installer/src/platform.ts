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
  };
}
