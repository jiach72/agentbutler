import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommandExecutor, CommandResult } from "@butler/adapter-hermes";

export interface ButlerRuntimeInfo {
  kind: "wsl" | "windows-wsl" | "linux" | "unknown";
  distro: string | null;
  user: string | null;
  home: string;
  sourceDir: string;
  butlerDataDir: string;
  hermesRoot: string;
  openclawRoot: string;
  npmGlobalRoot: string | null;
  packageManager: "npm" | "unknown";
  detail: string;
  portProxy?: PortProxyStatus;
}

export interface PortProxyStatus {
  status: "healthy" | "stale" | "missing" | "unknown";
  listenAddress: string;
  listenPort: number;
  connectAddress: string | null;
  connectPort: number | null;
  expectedAddress: string | null;
  detail: string;
  fixCommand: string;
}

export interface PortProxyRule {
  listenAddress: string;
  listenPort: number;
  connectAddress: string;
  connectPort: number;
}

function decodeWslOutput(value: string | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf16 = buffer.toString("utf16le").replaceAll("\u0000", "");
  const utf8 = buffer.toString("utf8").replaceAll("\u0000", "");
  return utf16.includes("\n") && !utf16.includes("�") ? utf16 : utf8;
}

function wslDistros(): string[] {
  try {
    const output = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 5_000 });
    return decodeWslOutput(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

function commandOutput(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

function wslCommandOutput(distro: string, script: string): string | null {
  try {
    const output = execFileSync("wsl.exe", ["-d", distro, "--", "sh", "-lc", script], {
      encoding: "buffer",
      timeout: 8_000,
      windowsHide: true,
    });
    const value = decodeWslOutput(output).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function wslPathOf(distro: string, pathValue: string): string | null {
  try {
    const output = execFileSync("wsl.exe", ["-d", distro, "--", "wslpath", "-a", "-u", pathValue], {
      encoding: "buffer",
      timeout: 8_000,
      windowsHide: true,
    });
    const value = decodeWslOutput(output).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * 解析 `netsh interface portproxy show v4tov4` 的数据行。
 * netsh 的表头会随 Windows 语言变化，因此只依赖四列 IPv4/端口数据。
 */
export function parsePortProxyOutput(output: string): PortProxyRule[] {
  const ipv4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
  const rule = new RegExp(
    String.raw`^\s*(${ipv4})\s+(\d+)\s+(${ipv4})\s+(\d+)\s*$`,
  );
  const rules: PortProxyRule[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = rule.exec(line);
    if (match === null) continue;
    rules.push({
      listenAddress: match[1]!,
      listenPort: Number(match[2]),
      connectAddress: match[3]!,
      connectPort: Number(match[4]),
    });
  }
  return rules;
}

function inspectWindowsPortProxy(
  listenAddress: string,
  listenPort: number,
  expectedAddress: string | null,
): PortProxyStatus {
  const fixCommand = "管理员 PowerShell：.\\scripts\\fix-portproxy.ps1";
  if (expectedAddress === null) {
    return {
      status: "unknown",
      listenAddress,
      listenPort,
      connectAddress: null,
      connectPort: null,
      expectedAddress: null,
      detail: "无法读取当前 WSL 地址，暂时不能判断 Windows 端口转发是否过期。",
      fixCommand,
    };
  }
  let output: string;
  try {
    output = execFileSync("netsh.exe", ["interface", "portproxy", "show", "v4tov4"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return {
      status: "unknown",
      listenAddress,
      listenPort,
      connectAddress: null,
      connectPort: null,
      expectedAddress,
      detail: "无法读取 Windows portproxy 状态；可能需要在 Windows 主机上检查。",
      fixCommand,
    };
  }
  const rules = parsePortProxyOutput(output).filter(
    (item) => item.listenPort === listenPort && item.listenAddress === listenAddress,
  );
  const current = rules[0] ?? null;
  if (current === null) {
    return {
      status: "missing",
      listenAddress,
      listenPort,
      connectAddress: null,
      connectPort: null,
      expectedAddress,
      detail: `没有找到 ${listenAddress}:${listenPort} 的 Windows 端口转发规则。`,
      fixCommand,
    };
  }
  const healthy = current.connectAddress === expectedAddress && current.connectPort === listenPort;
  return {
    status: healthy ? "healthy" : "stale",
    listenAddress,
    listenPort,
    connectAddress: current.connectAddress,
    connectPort: current.connectPort,
    expectedAddress,
    detail: healthy
      ? `Windows 端口转发正常，当前指向 WSL ${expectedAddress}:${listenPort}。`
      : `Windows 端口转发仍指向 ${current.connectAddress}:${current.connectPort}，当前 WSL 地址是 ${expectedAddress}。`,
    fixCommand,
  };
}

function isWslLinux(): boolean {
  if (process.platform !== "linux") return false;
  // WSL 内的 Docker 容器同样能在 /proc/version 看到 WSL 内核标识，但容器内
  // 执行 npm install -g 只会装进容器（且通常无权限）。容器形态不算「WSL 直跑」，
  // 由 /.dockerenv 判定排除，OpenClaw 安装等宿主侧操作按容器形态给出指引。
  if (existsSync("/.dockerenv")) return false;
  if (process.env["WSL_DISTRO_NAME"]?.trim()) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function sourceDirOf(start: string): string {
  let current = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

export function detectButlerRuntime(input: {
  sourceDir: string;
  butlerDataDir: string;
  hermesRoot?: string;
  openclawRoot?: string;
}): ButlerRuntimeInfo {
  const sourceDir = sourceDirOf(input.sourceDir);
  const hermesRoot = input.hermesRoot?.trim() || join(homedir(), ".hermes");
  const openclawRoot = input.openclawRoot?.trim() || join(homedir(), ".openclaw");
  const home = homedir();
  const linuxWsl = isWslLinux();
  if (linuxWsl) {
    const distro = process.env["WSL_DISTRO_NAME"]?.trim() || commandOutput("sh", ["-lc", "printf %s \"$WSL_DISTRO_NAME\""]);
    const npmGlobalRoot = commandOutput("npm", ["root", "-g"]);
    return {
      kind: "wsl",
      distro: distro || null,
      user: userInfo().username,
      home,
      sourceDir,
      butlerDataDir: input.butlerDataDir,
      hermesRoot,
      openclawRoot,
      npmGlobalRoot,
      packageManager: npmGlobalRoot !== null ? "npm" : "unknown",
      detail: `WSL${distro ? ` / ${distro}` : ""} / ${userInfo().username}`,
    };
  }
  if (process.platform === "win32") {
    const configured = process.env["BUTLER_WSL_DISTRO"]?.trim();
    const distro = configured || wslDistros()[0] || null;
    const wslUser = distro === null ? null : wslCommandOutput(distro, "id -un");
    const wslHome = distro === null ? null : wslCommandOutput(distro, "printf %s \"$HOME\"");
    const wslIpOutput = distro === null ? null : wslCommandOutput(distro, "hostname -I");
    const wslIp = wslIpOutput?.split(/\s+/).find((value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) ?? null;
    const wslNpmRoot = distro === null ? null : wslCommandOutput(distro, "npm root -g");
    const home = wslHome ?? homedir();
    const configuredSource = process.env["BUTLER_SRC"]?.trim() || input.sourceDir;
    const sourceDir = distro === null
      ? sourceDirOf(configuredSource)
      : wslPathOf(distro, configuredSource) ?? configuredSource;
    const configuredButlerData = input.butlerDataDir.trim();
    const mappedButlerData = distro === null ? null : wslPathOf(distro, configuredButlerData);
    const configuredHermesRoot = input.hermesRoot?.trim() || "";
    const configuredOpenClawRoot = input.openclawRoot?.trim() || "";
    const hermesRoot = configuredHermesRoot !== "" && distro !== null
      ? wslPathOf(distro, configuredHermesRoot) ?? configuredHermesRoot
      : configuredHermesRoot || join(home, ".hermes");
    const openclawRoot = configuredOpenClawRoot !== "" && distro !== null
      ? wslPathOf(distro, configuredOpenClawRoot) ?? configuredOpenClawRoot
      : configuredOpenClawRoot || join(home, ".openclaw");
    const butlerDataDir = mappedButlerData ?? (wslHome === null ? configuredButlerData : join(wslHome, ".agent-butler"));
    const webPort = Number(process.env["BUTLER_WEB_PORT"] ?? "7531");
    const webPublishHost = process.env["BUTLER_WEB_PUBLISH_HOST"]?.trim() || "127.0.0.1";
    return {
      kind: distro === null ? "unknown" : "windows-wsl",
      distro,
      user: wslUser,
      home,
      sourceDir,
      butlerDataDir,
      hermesRoot,
      openclawRoot,
      npmGlobalRoot: wslNpmRoot,
      packageManager: wslNpmRoot === null ? "unknown" : "npm",
      detail: distro === null ? "未检测到可用 WSL 发行版" : `WSL / ${distro}${wslUser ? ` / ${wslUser}` : ""}`,
      ...(distro !== null && Number.isInteger(webPort) && webPort > 0
        ? { portProxy: inspectWindowsPortProxy(webPublishHost, webPort, wslIp) }
        : {}),
    };
  }
  return {
    kind: process.platform === "linux" ? "linux" : "unknown",
    distro: null,
    user: userInfo().username,
    home,
    sourceDir,
    butlerDataDir: input.butlerDataDir,
    hermesRoot,
    openclawRoot,
    npmGlobalRoot: commandOutput("npm", ["root", "-g"]),
    packageManager: "npm",
    detail: `${process.platform} / ${userInfo().username}`,
  };
}

export function createRuntimeCommandExecutor(runtime: ButlerRuntimeInfo): CommandExecutor {
  if (runtime.kind !== "windows-wsl" || runtime.distro === null) {
    return requireDefaultExecutor();
  }
  const base = requireDefaultExecutor();
  const wrap = (cmd: string, args: string[]) => ["-d", runtime.distro!, "--", cmd, ...args];
  return {
    exec: async (cmd, args, opts) => base.exec("wsl.exe", wrap(cmd, args), opts),
    spawnDetached: (cmd, args) => base.spawnDetached("wsl.exe", wrap(cmd, args)),
  };
}

function requireDefaultExecutor(): CommandExecutor {
  // Kept in one place so WSL wrapping and native execution share identical timeout semantics.
  return {
    exec: (cmd, args, opts) =>
      new Promise<CommandResult>((resolveResult) => {
        execFile(cmd, args, { timeout: opts?.timeoutMs, ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }) }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 127 : 0;
          resolveResult({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      }),
    spawnDetached: (cmd, args) => {
      try {
        spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      } catch {
        // 状态轮询会把启动失败收敛成明确任务错误。
      }
    },
  };
}
