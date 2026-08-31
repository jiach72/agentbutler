/**
 * 双形态安装通路 + 顶层编排。
 *
 * - installHostForm：宿主进程形态（Node>=22 校验 → Hermes 官方 install.sh →
 *   pip 镜像注入 → 本仓 pnpm install/build → 三服务启动指引）
 * - installDockerForm：容器形态（docker/compose 校验 → registry 镜像以 compose
 *   override 文件形式注入（不改系统 docker 配置）→ docker compose up -d）
 * - runInstaller：平台检测 → 网络探测 → 密钥引导 → 按形态执行，产出汇总报告。
 *
 * 每步结构化 InstallStep 顺序执行、失败即停；命令执行可注入；dryRun 默认 false。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { defaultExec, detectPlatform, findPortOwner, type Exec, type PlatformReport } from "./platform.js";
import {
  buildDefaultSources,
  defaultProbeFetch,
  findSourcePlan,
  probeSources,
  type NetworkPlan,
  type ProbeFetch,
  type SourcePlan,
} from "./network.js";
import { checkSecrets, DEFAULT_SECRET_GROUPS, type SecretGroup, type SecretsReport } from "./secrets.js";
export interface DestructiveActionPreview {
  operation: string;
  deleteItems: string[];
  keepItems: string[];
  backupItems: string[];
  warnings: string[];
  blockedReasons: string[];
  manualNextStep: string[];
  canRun: boolean;
}

/** Hermes 官方安装脚本地址（可通过 opts.hermesInstallUrl 覆盖）。 */
export const DEFAULT_HERMES_INSTALL_URL = "https://raw.githubusercontent.com/hermes-agent/hermes/main/install.sh";
export const DEFAULT_OPENCLAW_PACKAGE = "openclaw@latest";
export const OPENCLAW_NODE_REQUIREMENT = ">=24.15.0 <25 || >=22.22.3 <23 || >=25.9.0";

/** docker compose 服务的默认最长等待时间（毫秒）。 */
export const COMPOSE_UP_TIMEOUT_MS = 600_000;
export const COMPOSE_WAIT_TIMEOUT_SECONDS = Math.floor(COMPOSE_UP_TIMEOUT_MS / 1_000);
export const DEFAULT_WEB_HOST_PORT = 7531;
export const DEFAULT_WATCH_HOST_PORT = 7533;
export const DEFAULT_GATEWAY_HOST_PORT = 7532;
export const HOST_HEALTH_RETRY_COUNT = 5;
export const HOST_HEALTH_RETRY_DELAY_MS = 1_000;

/**
 * Hermes 在 macOS 上可能把 Node/Corepack 放在 ~/.hermes/node/bin，后台 shell
 * 的 PATH 不一定包含该目录。优先使用当前 Node 同目录的 Corepack，找不到时
 * 保留裸命令以兼容系统安装与测试环境。
 */
export function resolveCorepackCommand(nodePath = process.execPath): string {
  const directory = path.dirname(nodePath);
  const candidates =
    process.platform === "win32"
      ? [path.join(directory, "corepack.cmd"), path.join(directory, "corepack")]
      : [path.join(directory, "corepack")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "corepack";
}

function shellCommand(command: string, args: string[]): string {
  const rendered = command.includes(" ") ? JSON.stringify(command) : command;
  return [rendered, ...args].join(" ");
}

/** 本仓三服务。 */
export const BUTLER_SERVICES = ["butler-watch", "butler-web", "butler-gateway"] as const;
export type HostServiceManager = "auto" | "systemd-user" | "guide";

/** 宿主服务管理配置。auto 仅在真实执行且平台支持时尝试 user-systemd。 */
export interface HostServiceOptions {
  manager?: HostServiceManager;
  serviceDir?: string;
  nodePath?: string;
  start?: boolean;
}

export type InstallStepStatus = "ok" | "skipped" | "failed" | "dry-run";

/** 单个安装步骤。 */
export interface InstallStep {
  id: string;
  status: InstallStepStatus;
  detail: string;
  /** 该步骤对应的命令（如有，纯检查/指引步骤为空）。 */
  command?: string[];
}

/** 两通路共用的计划（平台 + 网络 + 密钥）。 */
export interface InstallPlan {
  platform: PlatformReport;
  network: NetworkPlan;
  secrets: SecretsReport;
}

/** 安装选项（全部可选，命令执行可注入）。 */
export interface InstallOptions {
  /** hermes | openclaw，缺省 hermes。 */
  framework?: "hermes" | "openclaw";
  exec?: Exec;
  /** 仅打印不执行/不写文件，默认 false。 */
  dryRun?: boolean;
  /** 本仓根目录，默认 process.cwd()。 */
  repoDir?: string;
  /** Hermes 官方安装脚本 URL。 */
  hermesInstallUrl?: string;
  /** OpenClaw npm 包规格，默认 openclaw@latest。 */
  openclawPackage?: string;
  /** OpenClaw Gateway token；未提供时由安装器生成本地随机 token。 */
  openclawGatewayToken?: string;
  /** Web 宿主端口（当前 Compose 默认 7531）。 */
  webHostPort?: number;
  /** 可注入端口探测器；生产默认尝试绑定 loopback 端口。 */
  portProbe?: PortProbe;
  /** 容器形态的 compose 文件路径，默认 <repoDir>/docker-compose.yml。 */
  composeFile?: string;
  /** 镜像 override 文件写入路径，默认 <repoDir>/docker-compose.override.yml。 */
  overridePath?: string;
  /** 宿主三服务管理方式；生产默认 auto，注入 exec 的测试默认退化为 guide。 */
  hostServices?: HostServiceOptions;
}

/** 单形态安装结果。 */
export interface InstallResult {
  form: "host" | "docker";
  framework: "hermes" | "openclaw";
  steps: InstallStep[];
  success: boolean;
}

/** 顶层编排选项。 */
export interface InstallerOptions extends InstallOptions {
  /** hermes | openclaw，缺省 hermes。 */
  framework?: "hermes" | "openclaw";
  /** host | docker，缺省 host。 */
  form?: "host" | "docker";
  skipNetwork?: boolean;
  secretsOnly?: boolean;
  fetch?: ProbeFetch;
  env?: Record<string, string | undefined>;
  modelEndpoints?: string[];
  secretGroups?: SecretGroup[];
}

/** 安装器汇总报告。 */
export interface InstallerReport {
  form: "host" | "docker" | "secrets-only";
  framework: "hermes" | "openclaw";
  dryRun: boolean;
  platform: PlatformReport;
  network: NetworkPlan;
  secrets: SecretsReport;
  install?: InstallResult;
  success: boolean;
  /** 后续步骤指引文案。 */
  nextActions: string[];
}

interface StepCommand {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export type PortProbe = (port: number, host?: string) => Promise<boolean>;

export type MaintenanceCommand = "reset" | "uninstall";

export interface MaintenanceOptions {
  command: MaintenanceCommand;
  confirmed?: boolean;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  exec?: Exec;
  repoDir?: string;
  homeDir?: string;
}

export interface MaintenanceResult {
  command: MaintenanceCommand;
  success: boolean;
  steps: InstallStep[];
  preview: DestructiveActionPreview;
}

export function buildMaintenancePreview(command: MaintenanceCommand, homeDir: string, units: string[], confirmed: boolean): DestructiveActionPreview {
  const uninstall = command === "uninstall";
  return {
    operation: command,
    deleteItems: uninstall ? [homeDir, ...units] : [`${homeDir}/*`, ...units],
    keepItems: ["Hermes/OpenClaw 受管实例目录", "系统外部数据与凭据"],
    backupItems: [path.join(homeDir, "backups")],
    warnings: ["该操作只处理 Butler 自身状态，不会删除受管 Agent 数据。", "执行前请确认备份目录可读取。"],
    blockedReasons: confirmed ? [] : ["尚未提供明确确认（--yes）"],
    manualNextStep: confirmed ? ["重新启动 Butler 服务并检查首页状态。"] : ["先查看本预览，确认影响后重新执行并附带 --yes。"],
    canRun: confirmed,
  };
}

/**
 * 停止并清理 Butler 自身状态，不触碰受管 Hermes/OpenClaw 数据目录。
 * 真实删除前要求 confirmed=true；默认只返回计划，方便 CLI 先展示影响范围。
 */
export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceResult> {
  const exec = options.exec ?? defaultExec;
  const dryRun = options.dryRun ?? false;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["BUTLER_HOME"]?.trim() ?? path.join(os.homedir(), ".agent-butler");
  const repoDir = options.repoDir ?? process.cwd();
  const serviceDir = path.join(env["XDG_CONFIG_HOME"]?.trim() || path.join(os.homedir(), ".config"), "systemd", "user");
  const steps: InstallStep[] = [];
  const destructive = options.confirmed === true && !dryRun;

  steps.push({
    id: "confirmation",
    status: destructive ? "ok" : "skipped",
    detail: destructive
      ? "已收到明确确认，将执行维护操作"
      : `仅展示 ${options.command} 计划；真正执行请再次提供 --yes（目标：${homeDir}）`,
  });

  const units = BUTLER_SERVICES.map((service) => path.join(serviceDir, `${service}.service`));
  const preview = buildMaintenancePreview(options.command, homeDir, units, destructive);
  if (!destructive) {
    steps.push({
      id: "services-stop",
      status: dryRun ? "dry-run" : "skipped",
      detail: `将停止 ${BUTLER_SERVICES.join(", ")}，并删除 ${units.join(", ")}`,
    });
    steps.push({
      id: "state-remove",
      status: dryRun ? "dry-run" : "skipped",
      detail: options.command === "reset" ? `将清空 ${homeDir}（保留目录）` : `将删除 ${homeDir}`,
    });
    return { command: options.command, success: true, steps, preview };
  }

  if (process.platform === "win32") {
    steps.push({
      id: "services-stop",
      status: "skipped",
      detail: "原生 Windows 没有已注册的 Butler systemd 服务；如通过任务计划运行，请在任务计划程序中停止 Agent Butler 任务",
    });
  } else {
    steps.push(await runExecStep(exec, "services-stop", "停止 Butler 用户服务", {
      command: "systemctl",
      args: ["--user", "disable", "--now", ...BUTLER_SERVICES.map((service) => `${service}.service`)],
      timeoutMs: 30_000,
    }, false));
  }
  // systemd 不存在时继续清理文件；删除动作本身仍被限制在明确的 Butler home。
  try {
    for (const unit of units) {
      if (fs.existsSync(unit)) fs.rmSync(unit, { force: true });
    }
    steps.push({ id: "services-remove", status: "ok", detail: "已移除 Butler 用户服务文件" });
  } catch (error) {
    steps.push({ id: "services-remove", status: "failed", detail: `移除用户服务文件失败：${String(error)}` });
  }

  try {
    const resolvedHome = path.resolve(homeDir);
    const protectedRoots = new Set([path.parse(resolvedHome).root, path.resolve(os.homedir()), path.resolve(repoDir)]);
    if (protectedRoots.has(resolvedHome)) {
      steps.push({ id: "state-remove", status: "failed", detail: "拒绝删除过于宽泛的 Butler home 路径，请设置独立目录" });
    } else if (options.command === "reset") {
      fs.mkdirSync(resolvedHome, { recursive: true });
      for (const entry of fs.readdirSync(resolvedHome)) fs.rmSync(path.join(resolvedHome, entry), { recursive: true, force: true });
      steps.push({ id: "state-remove", status: "ok", detail: `已清空 ${resolvedHome}，目录本身保留` });
    } else {
      fs.rmSync(resolvedHome, { recursive: true, force: true });
      steps.push({ id: "state-remove", status: "ok", detail: `已删除 ${resolvedHome}` });
    }
  } catch (error) {
    steps.push({ id: "state-remove", status: "failed", detail: `清理 Butler 状态失败：${String(error)}` });
  }
  return { command: options.command, success: !steps.some((step) => step.status === "failed"), steps, preview };
}

/** 通过短暂绑定检测宿主端口是否可用，不发送网络请求。 */
export function defaultPortProbe(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ port, host }, () => finish(true));
  });
}

/** 执行一个命令型步骤；dryRun 只记录不执行。 */
async function runExecStep(
  exec: Exec,
  id: string,
  description: string,
  step: StepCommand,
  dryRun: boolean,
): Promise<InstallStep> {
  const display = `${step.command} ${step.args.join(" ")}`.trim();
  const command = [step.command, ...step.args];
  if (dryRun) {
    return { id, status: "dry-run", detail: `${description}（dry-run 未执行）: ${display}`, command };
  }
  const res = await exec(step.command, step.args, { cwd: step.cwd, timeoutMs: step.timeoutMs });
  if (res.code === 0) {
    return { id, status: "ok", detail: `${description}: 已执行 ${display}`, command };
  }
  const stderrHead = res.stderr.split("\n")[0]?.trim();
  return {
    id,
    status: "failed",
    detail: `${description}: 命令失败（退出码 ${res.code}）${stderrHead === "" ? "" : `：${stderrHead}`}`,
    command,
  };
}

/** OpenClaw doctor/status 属于诊断命令：结构化输出可解析时，warning 退出码不阻断安装。 */
async function runDiagnosticStep(
  exec: Exec,
  id: string,
  description: string,
  step: StepCommand,
  dryRun: boolean,
): Promise<InstallStep> {
  const display = `${step.command} ${step.args.join(" ")}`.trim();
  const command = [step.command, ...step.args];
  if (dryRun) return { id, status: "dry-run", detail: `${description}（dry-run 未执行）: ${display}`, command };
  const res = await exec(step.command, step.args, { cwd: step.cwd, timeoutMs: step.timeoutMs });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    parsed = undefined;
  }
  if (res.code === 0 || (parsed !== undefined && typeof parsed === "object" && parsed !== null)) {
    const record = parsed as Record<string, unknown> | undefined;
    const findings = Array.isArray(record?.["findings"]) ? record!["findings"].length : 0;
    const suffix = res.code === 0 ? "" : `（检测到 ${findings} 条诊断提醒，未阻断安装）`;
    return { id, status: "ok", detail: `${description}: 已执行 ${display}${suffix}`, command };
  }
  const stderrHead = res.stderr.split("\n")[0]?.trim();
  return {
    id,
    status: "failed",
    detail: `${description}: 命令失败（退出码 ${res.code}）${stderrHead === "" ? "" : `：${stderrHead}`}`,
    command,
  };
}

/** 宿主服务启动后健康探测：短暂启动延迟不应直接把安装判失败。 */
async function runRetryingHealthStep(
  exec: Exec,
  id: string,
  description: string,
  step: StepCommand,
  dryRun: boolean,
): Promise<InstallStep> {
  let last: InstallStep | undefined;
  for (let attempt = 1; attempt <= HOST_HEALTH_RETRY_COUNT; attempt += 1) {
    last = await runExecStep(exec, id, description, step, dryRun);
    if (last.status !== "failed" || dryRun || attempt === HOST_HEALTH_RETRY_COUNT) return last;
    await new Promise((resolve) => setTimeout(resolve, HOST_HEALTH_RETRY_DELAY_MS));
  }
  return last!;
}

/**
 * 宿主三服务写入前检查 loopback 端口。真实重跑时，已经由对应 Butler unit 托管的
 * 端口可以复用；其它占用一律 fail-closed，避免先写 unit 再留下半安装状态。
 */
async function checkHostServicePorts(exec: Exec, opts: InstallOptions, dryRun: boolean): Promise<InstallStep> {
  const targets = [
    { service: "butler-watch", port: DEFAULT_WATCH_HOST_PORT },
    { service: "butler-gateway", port: DEFAULT_GATEWAY_HOST_PORT },
    { service: "butler-web", port: opts.webHostPort ?? DEFAULT_WEB_HOST_PORT },
  ] as const;
  if (dryRun) {
    return {
      id: "services-port-check",
      status: "dry-run",
      detail: "将检查宿主端口 " + targets.map((target) => target.service + "=127.0.0.1:" + target.port).join(", ") + "（dry-run 未探测）",
    };
  }
  // 注入式 exec 主要用于单测/上层编排；只有真实默认 exec 或显式 portProbe 才触碰 socket。
  const shouldProbe = opts.portProbe !== undefined || opts.exec === undefined;
  if (!shouldProbe) {
    return {
      id: "services-port-check",
      status: "skipped",
      detail: "注入式命令执行器未提供端口探测器，跳过宿主端口检查",
    };
  }
  const probe = opts.portProbe ?? defaultPortProbe;
  const conflicts: string[] = [];
  for (const target of targets) {
    if (await probe(target.port, "127.0.0.1")) continue;
    const managed = await exec("systemctl", ["--user", "is-active", "--quiet", target.service + ".service"], { timeoutMs: 10_000 });
    if (managed.code !== 0 || !(await unitOwnsListeningPort(exec, target.service, target.port))) {
      const owner = await findPortOwner(exec, target.port);
      const ownerLabel = owner === null ? "占用者未知" : `${owner.processName ?? "进程"}${owner.pid === null ? "" : ` PID=${owner.pid}`}`;
      conflicts.push(target.service + "=127.0.0.1:" + target.port + `（${ownerLabel}）`);
    }
  }
  if (conflicts.length > 0) {
    return {
      id: "services-port-check",
      status: "failed",
      detail: "宿主服务端口已被非 Butler 服务占用：" + conflicts.join(", ") + "；请停止占用进程后重试" + (opts.webHostPort === undefined ? "，Web 可用 --web-port 指定替代端口" : ""),
    };
  }
  return {
    id: "services-port-check",
    status: "ok",
    detail: "宿主端口可用或已由 Butler unit 托管：" + targets.map((target) => target.service + "=127.0.0.1:" + target.port).join(", "),
  };
}

/**
 * active 只代表 unit 进程存活，不代表它实际持有目标端口。
 * 通过 MainPID 与 ss 的监听者 PID 交叉核对，避免重跑时误放行被其它进程抢占的端口。
 * 无法取得任一侧证据时 fail-closed；空闲端口不会走到这里。
 */
async function unitOwnsListeningPort(exec: Exec, service: string, port: number): Promise<boolean> {
  const unit = service + ".service";
  const mainPid = await exec("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"], { timeoutMs: 10_000 });
  if (mainPid.code !== 0) return false;
  const pid = Number.parseInt(mainPid.stdout.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const listeners = await exec("ss", ["-H", "-ltnp"], { timeoutMs: 10_000 });
  if (listeners.code !== 0) return false;
  for (const line of listeners.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const localAddress = fields[3]!;
    const localPort = localAddress.slice(localAddress.lastIndexOf(":") + 1);
    if (localPort !== String(port)) continue;
    if ([...line.matchAll(/\bpid=(\d+)\b/g)].some((match) => Number.parseInt(match[1]!, 10) === pid)) return true;
  }
  return false;
}

/** 源探测结论 → 三态：镜像注入 / 跳过（官方可达或未探测）/ 失败（全不可达）。 */
function classifySource(plan: SourcePlan | undefined): "mirror" | "skipped" | "failed" {
  if (plan === undefined) return "skipped";
  if (plan.allFailed) return "failed";
  return plan.mirrorUsed ? "mirror" : "skipped";
}

/** 生成 docker-compose override 文件内容（REGISTRY_MIRROR 环境变量 + daemon.json 建议）。 */
export function buildComposeOverride(
  mirrorUrl: string | undefined,
  services: readonly string[] = BUTLER_SERVICES,
  webHostPort?: number,
): string {
  const mirrorHost = mirrorUrl === undefined ? undefined : getMirrorHost(mirrorUrl);
  const lines = [
    "# Agent Butler 安装器生成的 Docker Compose override",
    ...(mirrorHost === undefined
      ? []
      : [
          "# Docker Hub 镜像加速（按网络探测结果）",
          `# 探测所选镜像: ${mirrorHost}`,
          "# 说明: 本文件不改系统 Docker 配置，仅通过 REGISTRY_MIRROR 环境变量传递给构建/运行时；",
          "# 如需系统级镜像加速，可编辑 /etc/docker/daemon.json 后重启 Docker：",
          `#   { "registry-mirrors": ["https://${mirrorHost}"] }`,
        ]),
    "services:",
  ];
  for (const service of services) {
    const needsPortOverride = service === "butler-web" && webHostPort !== undefined;
    if (mirrorUrl === undefined && !needsPortOverride) continue;
    lines.push(`  ${service}:`);
    if (needsPortOverride) lines.push("    ports: !override", `      - "127.0.0.1:${webHostPort}:7531"`);
    if (mirrorUrl !== undefined) lines.push("    environment:", `      - REGISTRY_MIRROR=${mirrorUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

function getMirrorHost(mirrorUrl: string): string {
  try {
    return new URL(mirrorUrl).host;
  } catch {
    return mirrorUrl;
  }
}

function quoteUnitToken(value: string): string {
  // The quote/backslash escapes are intentional for systemd's unit parser.
  // eslint-disable-next-line no-useless-escape
  return "\"" + value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"').replace(/\\r?\\n/g, "\\n") + "\"";
}

function defaultHostServiceDir(): string {
  return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "systemd", "user");
}

/** 生成宿主 user-systemd unit；不含任何真实密钥，密钥从 ~/.agent-butler/env 读取。 */
export function buildHostServiceUnits(
  repoDir: string,
  framework: "hermes" | "openclaw",
  webHostPort = DEFAULT_WEB_HOST_PORT,
  nodePath = process.execPath,
): Record<(typeof BUTLER_SERVICES)[number], string> {
  const unitRepoDir = repoDir.replace(/\\/g, "/");
  const entries: Record<(typeof BUTLER_SERVICES)[number], string> = {
    "butler-watch": path.posix.join(unitRepoDir, "apps", "watch", "dist", "main.js"),
    "butler-web": path.posix.join(unitRepoDir, "apps", "web", "dist", "main.js"),
    "butler-gateway": path.posix.join(unitRepoDir, "apps", "gateway", "dist", "main.js"),
  };
  const common = [
    "EnvironmentFile=-%h/.agent-butler/env",
    "Environment=" + quoteUnitToken("BUTLER_HOME=%h/.agent-butler"),
    "Environment=" + quoteUnitToken("BUTLER_FRAMEWORK=" + framework),
    "WorkingDirectory=" + quoteUnitToken(unitRepoDir),
    "Restart=on-failure",
    "RestartSec=5",
  ];
  const unit = (name: string, description: string, dependencies: string[], env: string[]): string => [
    "[Unit]",
    "Description=" + description,
    "After=network-online.target",
    "Wants=network-online.target",
    ...dependencies,
    "",
    "[Service]",
    "Type=simple",
    ...common,
    ...env.map((entry) => "Environment=" + quoteUnitToken(entry)),
    "ExecStart=" + quoteUnitToken(nodePath) + " " + quoteUnitToken(entries[name as keyof typeof entries]),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\\n");
  return {
    "butler-gateway": unit("butler-gateway", "Agent Butler Gateway", [], [
      "BUTLER_GATEWAY_HOST=127.0.0.1",
      "BUTLER_GATEWAY_PORT=" + DEFAULT_GATEWAY_HOST_PORT,
      // Gateway 持久消息运行时：auto 在 Bridge 配置完整时接入；Bridge 暂时
      // 离线仍由 Gateway 内部重试，不影响普通控制面启动。
      "BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=auto",
      "BUTLER_HERMES_BRIDGE_URL=http://127.0.0.1:8754",
      "BUTLER_HERMES_INSTANCE_ID=hermes-main",
      "BUTLER_HERMES_ROOT=%h/.hermes",
      "BUTLER_HERMES_BRIDGE_TOKEN_FILE=%h/.hermes/agent-butler/bridge.token",
      "BUTLER_MESSAGE_PROJECTION_DB=%h/.agent-butler/messages.sqlite",
      "BUTLER_HERMES_BRIDGE_ALLOW_NON_LOOPBACK=false",
      "BUTLER_MESSAGE_REQUEST_TIMEOUT_MS=120000",
      "BUTLER_MESSAGE_POLL_INTERVAL_MS=1000",
      "BUTLER_MESSAGE_STOP_TIMEOUT_MS=5000",
    ]),
    "butler-watch": unit("butler-watch", "Agent Butler Watch", [
      "After=butler-gateway.service",
      "Wants=butler-gateway.service",
    ], [
      "BUTLER_WATCH_HOST=127.0.0.1",
      "BUTLER_WATCH_PORT=" + DEFAULT_WATCH_HOST_PORT,
      "BUTLER_GATEWAY_URL=http://127.0.0.1:7532",
      ...(framework === "hermes" ? ["BUTLER_HERMES_ROOT=%h/.hermes", "HERMES_ROOT=%h/.hermes"] : ["BUTLER_OPENCLAW_ROOT=%h/.openclaw"]),
    ]),
    "butler-web": unit("butler-web", "Agent Butler Web", [
      "After=butler-gateway.service butler-watch.service",
      "Wants=butler-gateway.service butler-watch.service",
    ], [
      "BUTLER_WEB_HOST=127.0.0.1",
      "BUTLER_WEB_PORT=" + webHostPort,
      "BUTLER_GATEWAY_URL=http://127.0.0.1:7532",
      "BUTLER_WATCH_URL=http://127.0.0.1:7533",
    ]),
  };
}

async function installHostServices(
  plan: InstallPlan,
  opts: InstallOptions,
  exec: Exec,
  dryRun: boolean,
  repoDir: string,
  framework: "hermes" | "openclaw",
): Promise<InstallStep[]> {
  const configured = opts.hostServices?.manager;
  const manager: HostServiceManager = configured ?? (opts.exec === undefined ? "auto" : "guide");
  const steps: InstallStep[] = [];
  if (manager === "guide") {
    const corepackCommand = resolveCorepackCommand(opts.hostServices?.nodePath ?? process.execPath);
    steps.push({
      id: "services-guide",
      status: "ok",
      detail: [
        "宿主三服务未写入系统服务管理器，请按以下命令启动：",
        "  - butler-watch:   " + shellCommand(corepackCommand, ["pnpm", "--filter", "@butler/watch", "start"]),
        "  - butler-web:     " + shellCommand(corepackCommand, ["pnpm", "--filter", "@butler/web", "start"]) + "（http://127.0.0.1:" + (opts.webHostPort ?? DEFAULT_WEB_HOST_PORT) + "）",
        "  - butler-gateway: " + shellCommand(corepackCommand, ["pnpm", "--filter", "@butler/gateway", "start"]),
      ].join("\\n"),
    });
    return steps;
  }

  if (plan.platform.os !== "linux" && !plan.platform.isWsl) {
    steps.push({
      id: "services-install",
      status: configured === "systemd-user" ? "failed" : "skipped",
      detail: "宿主服务自动托管需要 Linux/WSL user-systemd；当前平台不满足，请使用 services-guide 手动启动",
    });
    if (configured !== "systemd-user") {
      steps.push({ id: "services-guide", status: "ok", detail: "请在支持 systemd 的 Linux/WSL 环境重新运行，或按三服务命令手动启动" });
    }
    return steps;
  }

  if (!dryRun) {
    const probe = await exec("systemctl", ["--user", "show-environment"], { timeoutMs: 10_000 });
    if (probe.code !== 0) {
      if (configured === "systemd-user") {
        steps.push({
          id: "services-install",
          status: "failed",
          detail: "user-systemd 不可用（systemctl --user show-environment 退出码 " + probe.code + "），未写入服务文件",
        });
        return steps;
      }
      steps.push({
        id: "services-guide",
        status: "ok",
        detail: "未检测到可用的 user-systemd，未写入系统服务文件；请按三服务命令手动启动",
      });
      return steps;
    }
  }

  if (!path.isAbsolute(repoDir)) {
    steps.push({
      id: "services-install",
      status: "failed",
      detail: "仓库路径必须是 Linux 绝对路径才能写入 user-systemd unit：" + repoDir,
    });
    return steps;
  }

  const serviceDir = opts.hostServices?.serviceDir ?? defaultHostServiceDir();
  const portCheck = await checkHostServicePorts(exec, opts, dryRun);
  steps.push(portCheck);
  if (portCheck.status === "failed") return steps;
  const units = buildHostServiceUnits(repoDir, framework, opts.webHostPort ?? DEFAULT_WEB_HOST_PORT, opts.hostServices?.nodePath ?? process.execPath);
  const filenames = BUTLER_SERVICES.map((service) => path.join(serviceDir, service + ".service"));
  if (dryRun) {
    steps.push({
      id: "services-install",
      status: "dry-run",
      detail: "将生成 " + filenames.join(", ") + "（dry-run 未写入）；unit 内容：\\n" + BUTLER_SERVICES.map((service) => "--- " + service + ".service\\n" + units[service]).join("\\n"),
    });
  } else {
    try {
      fs.mkdirSync(serviceDir, { recursive: true });
      for (const service of BUTLER_SERVICES) {
        fs.writeFileSync(path.join(serviceDir, service + ".service"), units[service], "utf-8");
      }
      steps.push({ id: "services-install", status: "ok", detail: "已写入 " + filenames.join(", ") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ id: "services-install", status: "failed", detail: "写入 user-systemd 服务文件失败：" + message });
      return steps;
    }
  }

  const start = opts.hostServices?.start ?? true;
  if (!start) {
    steps.push({ id: "services-start", status: "skipped", detail: "按配置跳过 user-systemd 启动" });
    return steps;
  }
  const reload = await runExecStep(exec, "services-daemon-reload", "刷新 user-systemd unit", {
    command: "systemctl",
    args: ["--user", "daemon-reload"],
  }, dryRun);
  steps.push(reload);
  if (reload.status === "failed") return steps;
  const startStep = await runExecStep(exec, "services-start", "启用并启动 Butler 三项宿主服务", {
    command: "systemctl",
    args: ["--user", "enable", "--now", ...BUTLER_SERVICES.map((service) => service + ".service")],
  }, dryRun);
  steps.push(startStep);
  if (startStep.status === "failed") return steps;

  // 安装成功必须证明 systemd 已接管且应用健康；健康失败时停止三项服务，避免半安装状态。
  const activeChecks: InstallStep[] = [];
  for (const service of BUTLER_SERVICES) {
    activeChecks.push(
      await runRetryingHealthStep(
        exec,
        `services-active-${service}`,
        `确认 ${service} 已由 user-systemd 激活`,
        { command: "systemctl", args: ["--user", "is-active", "--quiet", service + ".service"] },
        dryRun,
      ),
    );
  }
  steps.push(...activeChecks);
  const activeFailure = activeChecks.find((step) => step.status === "failed");
  if (activeFailure !== undefined) {
    steps.push(
      await runExecStep(
        exec,
        "services-rollback",
        "服务健康检查失败，停止已启动的 Butler 服务",
        { command: "systemctl", args: ["--user", "stop", ...BUTLER_SERVICES.map((service) => service + ".service")] },
        dryRun,
      ),
    );
    return steps;
  }

  const nodePath = opts.hostServices?.nodePath ?? process.execPath;
  const healthTargets = [
    { service: "butler-watch", port: DEFAULT_WATCH_HOST_PORT, path: "/healthz", strict: false },
    { service: "butler-gateway", port: DEFAULT_GATEWAY_HOST_PORT, path: "/healthz", strict: false },
    { service: "butler-web", port: opts.webHostPort ?? DEFAULT_WEB_HOST_PORT, path: "/api/health", strict: true },
  ] as const;
  for (const target of healthTargets) {
    const url = `http://127.0.0.1:${target.port}${target.path}`;
    const bodyCheck = target.strict ? " && body.db === true && body.gateway === true" : "";
    const script =
      `fetch(${JSON.stringify(url)}).then(async (response) => {` +
      `let body = {}; try { body = await response.json(); } catch {}` +
      `process.exit(response.ok && body.ok === true${bodyCheck} ? 0 : 1);` +
      `}).catch(() => process.exit(1));`;
    const health = await runRetryingHealthStep(
      exec,
      `services-health-${target.service}`,
      `检查 ${target.service} 健康接口 ${url}`,
      { command: nodePath, args: ["-e", script], timeoutMs: 15_000 },
      dryRun,
    );
    steps.push(health);
    if (health.status === "failed") {
      steps.push(
        await runExecStep(
          exec,
          "services-rollback",
          "服务健康检查失败，停止已启动的 Butler 服务",
          { command: "systemctl", args: ["--user", "stop", ...BUTLER_SERVICES.map((service) => service + ".service")] },
          dryRun,
        ),
      );
      return steps;
    }
  }
  steps.push({
    id: "services-guide",
    status: "ok",
    detail: "三项宿主服务已由 user-systemd 托管且健康接口通过；状态检查：systemctl --user status " + BUTLER_SERVICES.map((service) => service + ".service").join(" "),
  });
  return steps;
}

/** OpenClaw 容器形态 override：安装官方 npm 包并以前台 Gateway 运行。 */
export function buildOpenClawComposeOverride(
  packageSpec = DEFAULT_OPENCLAW_PACKAGE,
  mirrorUrl?: string,
  gatewayToken = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? randomBytes(24).toString("hex"),
  webHostPort = DEFAULT_WEB_HOST_PORT,
): string {
  const mirrorEnv = mirrorUrl === undefined ? [] : [`      - REGISTRY_MIRROR=${mirrorUrl}`];
  return [
    "# Agent Butler 安装器生成：OpenClaw 容器形态（Node 24.15+）",
    "services:",
    "  openclaw:",
    "    image: node:24.15-bookworm-slim",
    "    environment:",
    "      - HOME=/home/openclaw",
    "      - OPENCLAW_HOME=/home/openclaw",
    `      - OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
    ...(mirrorUrl === undefined ? [] : [`      - REGISTRY_MIRROR=${mirrorUrl}`]),
    "    volumes:",
    "      - openclaw-data:/home/openclaw",
    `    command: ["bash", "-lc", "npm install --global ${packageSpec} && openclaw setup --baseline && exec openclaw gateway run --allow-unconfigured --bind lan --auth token --token $$OPENCLAW_GATEWAY_TOKEN"]`,
    "    expose:",
    "      - \"18789\"",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"openclaw gateway health --json --token \\\"$$OPENCLAW_GATEWAY_TOKEN\\\" >/dev/null 2>&1\"]",
    "      interval: 30s",
    "      timeout: 10s",
    "      retries: 5",
    "    restart: unless-stopped",
    "  butler-watch:",
    "    environment:",
    "      - BUTLER_FRAMEWORK=openclaw",
    "      - BUTLER_OPENCLAW_ROOT=/home/openclaw/.openclaw",
    ...mirrorEnv,
    "    volumes:",
    "      - openclaw-data:/home/openclaw:ro",
    "    depends_on:",
    "      openclaw:",
    "        condition: service_healthy",
    "  butler-web:",
    "    ports: !override",
    `      - "127.0.0.1:${webHostPort}:7531"`,
    "volumes:",
    "  openclaw-data:",
    "",
  ].join("\n");
}

/** 宿主进程形态安装。 */
export async function installHostForm(plan: InstallPlan, opts: InstallOptions = {}): Promise<InstallResult> {
  const exec = opts.exec ?? defaultExec;
  const dryRun = opts.dryRun ?? false;
  const repoDir = opts.repoDir ?? process.cwd();
  const corepackCommand = resolveCorepackCommand(opts.hostServices?.nodePath ?? process.execPath);
  const framework = opts.framework ?? "hermes";
  const hermesUrl = opts.hermesInstallUrl ?? DEFAULT_HERMES_INSTALL_URL;
  const openclawPackage = opts.openclawPackage ?? DEFAULT_OPENCLAW_PACKAGE;
  const steps: InstallStep[] = [];

  // Hermes 官方安装脚本和宿主服务托管依赖 Bash/Linux；原生 Windows 不能安全地
  // 走同一条路径，明确引导 Docker Desktop 或 WSL，避免“命令跑完但服务不可用”。
  if (
    framework === "hermes" &&
    plan.platform.os === "win32" &&
    !plan.platform.isWsl &&
    !dryRun &&
    opts.hostServices?.manager === undefined
  ) {
    steps.push({
      id: "windows-host-guidance",
      status: "failed",
      detail: "原生 Windows 暂不支持 Hermes 宿主进程安装。请安装 Docker Desktop 后使用 --form docker，或在 WSL 中重新运行 --form host。",
    });
    return finish("host", framework, steps);
  }

  // 1. 前置 Node>=22 校验（失败即停）
  if (!plan.platform.nodeSatisfied || (framework === "openclaw" && !isOpenClawNodeSatisfied(plan.platform.nodeVersion))) {
    steps.push({
      id: "node-check",
      status: "failed",
      detail:
        framework === "openclaw"
          ? `Node ${plan.platform.nodeVersion} 不满足 OpenClaw 要求（${OPENCLAW_NODE_REQUIREMENT}），请升级 Node 后重试`
          : `Node ${plan.platform.nodeVersion} 不满足要求（${plan.platform.nodeRequirement}），请升级 Node 后重试`,
    });
    return { form: "host", framework, steps, success: false };
  }
  steps.push({
    id: "node-check",
    status: "ok",
    detail:
      framework === "openclaw"
        ? `Node ${plan.platform.nodeVersion} 满足 OpenClaw 要求（${OPENCLAW_NODE_REQUIREMENT}）`
        : `Node ${plan.platform.nodeVersion} 满足 ${plan.platform.nodeRequirement} 要求`,
  });

  if (framework === "openclaw") {
    steps.push(
      await runExecStep(
        exec,
        "openclaw-install",
        "安装 OpenClaw（官方 npm 包）",
        { command: "npm", args: ["install", "--global", openclawPackage], timeoutMs: 600_000 },
        dryRun,
      ),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
    steps.push(
      await runExecStep(
        exec,
        "openclaw-setup",
        "初始化 OpenClaw 基线目录",
        { command: "openclaw", args: ["setup", "--baseline"], timeoutMs: 120_000 },
        dryRun,
      ),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
    steps.push(
      await runExecStep(
        exec,
        "openclaw-config-validate",
        "校验 OpenClaw 配置",
        { command: "openclaw", args: ["config", "validate", "--json"], timeoutMs: 120_000 },
        dryRun,
      ),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
    steps.push(
      await runDiagnosticStep(
        exec,
        "openclaw-doctor",
        "运行 OpenClaw 基线诊断",
        { command: "openclaw", args: ["doctor", "--lint", "--json"], timeoutMs: 120_000 },
        dryRun,
      ),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
    steps.push(
      await runDiagnosticStep(
        exec,
        "openclaw-status",
        "读取 OpenClaw 结构化状态",
        { command: "openclaw", args: ["status", "--json"], timeoutMs: 120_000 },
        dryRun,
      ),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
  }

  // Hermes 官方安装脚本封装
  if (framework === "hermes") {
  if (plan.platform.pythonSatisfied === false) {
    steps.push({
      id: "python-check",
      status: "failed",
      detail: `未找到满足要求的 Python（需要 >=3.11，当前：${plan.platform.pythonVersion ?? "未安装"}）。请先安装 Python 3.11+ 后重试。`,
    });
    return finish("host", framework, steps);
  }
  if (plan.platform.pythonSatisfied !== undefined) {
    steps.push({
      id: "python-check",
      status: "ok",
      detail: `Python ${plan.platform.pythonVersion} 满足 Hermes 要求`,
    });
  }
  const pipeline = `curl -fsSL ${hermesUrl} | bash`;
  steps.push(
    await runExecStep(exec, "hermes-install", "安装 Hermes 宿主进程（官方 install.sh）", {
      command: "bash",
      args: ["-lc", pipeline],
      timeoutMs: 600_000,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
  }

  // 3. pypi 镜像注入（pip 配置 index-url 按探测结果）
  const pypi = findSourcePlan(plan.network, "pypi");
  const pypiState = classifySource(pypi);
  if (pypiState === "failed") {
    steps.push({
      id: "pip-mirror",
      status: "failed",
      detail: `PyPI 官方与镜像源均不可达，无法继续安装：${pypi?.guidance ?? ""}`,
    });
    return finish("host", framework, steps);
  }
  if (pypiState === "mirror") {
    steps.push(
      await runExecStep(exec, "pip-mirror", "注入 PyPI 镜像（pip index-url）", {
        command: "pip",
        args: ["config", "set", "global.index-url", pypi?.chosenUrl ?? ""],
      }, dryRun),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
  } else {
    steps.push({
      id: "pip-mirror",
      status: "skipped",
      detail:
        pypi === undefined
          ? "网络探测已跳过（--skip-network），未修改 pip 配置，按默认源处理"
          : "PyPI 官方源可达，无需镜像",
    });
  }

  // 4. 启用 Corepack shim，确保 package scripts 中的 pnpm 也能解析。
  steps.push(
    await runExecStep(
      exec,
      "corepack-enable",
      "启用 pnpm 运行时 shim",
      { command: corepackCommand, args: ["enable"] },
      dryRun,
    ),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);

  // 5/6. 本仓 pnpm install + build
  steps.push(
    await runExecStep(exec, "repo-install", "安装本仓依赖", {
      command: corepackCommand,
      args: ["pnpm", "install"],
      cwd: repoDir,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);
  steps.push(
    await runExecStep(exec, "repo-build", "构建本仓", {
      command: corepackCommand,
      args: ["pnpm", "run", "build"],
      cwd: repoDir,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", framework, steps);

  // 6. 生成并托管宿主三服务；注入 exec 的测试默认退化为纯指引，避免触碰用户 systemd。
  steps.push(...await installHostServices(plan, opts, exec, dryRun, repoDir, framework));
  return finish("host", framework, steps);
}

/** 容器形态安装。 */
export async function installDockerForm(plan: InstallPlan, opts: InstallOptions = {}): Promise<InstallResult> {
  const exec = opts.exec ?? defaultExec;
  const dryRun = opts.dryRun ?? false;
  const repoDir = opts.repoDir ?? process.cwd();
  const composeFile = opts.composeFile ?? path.join(repoDir, "docker-compose.yml");
  const overridePath = opts.overridePath ?? path.join(repoDir, "docker-compose.override.yml");
  const framework = opts.framework ?? "hermes";
  const steps: InstallStep[] = [];
  let useOverride = false;

  // 1. docker CLI 可用性
  if (!plan.platform.dockerAvailable) {
    steps.push({ id: "docker-check", status: "failed", detail: "docker CLI 不可用（docker version 失败）：请先安装 Docker" });
    return { form: "docker", framework, steps, success: false };
  }
  steps.push({ id: "docker-check", status: "ok", detail: "docker CLI 可用" });

  // 2. docker compose 可用性
  if (!plan.platform.dockerComposeAvailable) {
    steps.push({
      id: "compose-check",
      status: "failed",
      detail: "docker compose 不可用（需 Docker Compose v2 子命令）：请升级 Docker 或安装 compose 插件",
    });
    return finish("docker", framework, steps);
  }
  steps.push({ id: "compose-check", status: "ok", detail: "docker compose 可用" });

  // 3. 宿主 Web 端口前置检查，避免写入 override 后才在 compose up 阶段失败。
  // 注入 exec 的调用通常是测试/上层编排，默认不触碰真实 socket；显式 portProbe 仍可覆盖。
  const shouldProbePort = opts.portProbe !== undefined || opts.exec === undefined;
  if (shouldProbePort) {
    const webPort = opts.webHostPort ?? DEFAULT_WEB_HOST_PORT;
    const available = await (opts.portProbe ?? defaultPortProbe)(webPort, "127.0.0.1");
    if (!available) {
      steps.push({
        id: "web-port-check",
        status: "failed",
        detail: `Web 宿主端口 127.0.0.1:${webPort} 已被占用，请停止占用进程后重试，或使用 --web-port 配置未占用端口`,
      });
      return finish("docker", framework, steps);
    }
    steps.push({ id: "web-port-check", status: "ok", detail: `Web 宿主端口 127.0.0.1:${webPort} 可用` });
  }

  // 4. docker registry 镜像注入（compose override 文件形式，不改系统 docker 配置）
  const registry = findSourcePlan(plan.network, "docker-registry");
  const registryState = classifySource(registry);
  if (registryState === "failed") {
    steps.push({
      id: "registry-mirror",
      status: "failed",
      detail: `Docker Hub 官方与镜像源均不可达，拉取镜像大概率失败：${registry?.guidance ?? ""}`,
    });
    return finish("docker", framework, steps);
  }
  if (framework === "openclaw") {
    const content = buildOpenClawComposeOverride(
      opts.openclawPackage ?? DEFAULT_OPENCLAW_PACKAGE,
      registryState === "mirror" ? registry?.chosenUrl ?? undefined : undefined,
      opts.openclawGatewayToken,
      opts.webHostPort ?? DEFAULT_WEB_HOST_PORT,
    );
    if (dryRun) {
      steps.push({
        id: "openclaw-compose",
        status: "dry-run",
        detail: `生成 OpenClaw compose override（dry-run 未写入 ${overridePath}，Gateway token 已脱敏）:\n${content.replace(/^(\s*- OPENCLAW_GATEWAY_TOKEN=).+$/gm, "$1<redacted>")}`,
      });
    } else {
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, content, "utf-8");
      steps.push({ id: "openclaw-compose", status: "ok", detail: `已写入 ${overridePath}（OpenClaw 服务 + 持久化数据卷）` });
    }
    useOverride = true;
  } else if (registryState === "mirror" || opts.webHostPort !== undefined) {
    const content = buildComposeOverride(
      registryState === "mirror" ? registry?.chosenUrl ?? undefined : undefined,
      BUTLER_SERVICES,
      opts.webHostPort,
    );
    if (dryRun) {
      steps.push({
        id: "registry-mirror",
        status: "dry-run",
        detail: `生成 Compose override（dry-run 未写入 ${overridePath}）:\n${content}`,
      });
    } else {
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, content, "utf-8");
      steps.push({
        id: "registry-mirror",
        status: "ok",
        detail:
          registryState === "mirror"
            ? `已写入 ${overridePath}（REGISTRY_MIRROR=${registry?.chosenUrl ?? ""}，含 daemon.json 建议）`
            : `已写入 ${overridePath}（Web 监听 127.0.0.1:${opts.webHostPort}）`,
      });
    }
    useOverride = true;
  } else {
    steps.push({
      id: "registry-mirror",
      status: "skipped",
      detail:
        registry === undefined
          ? "网络探测已跳过（--skip-network），未生成镜像 override，按官方 registry 处理"
          : "Docker Hub 官方 registry 可达，无需镜像 override",
    });
  }

  // 明确传入生成的 override：显式 -f 基础文件时，不依赖 Docker Compose 的隐式 override 发现规则。
  const composeFiles = ["compose", "-f", composeFile, ...(useOverride ? ["-f", overridePath] : [])];

  // 5. 先解析完整拓扑，避免在启动阶段才发现 override 与基础 Compose 不兼容。
  steps.push(
    await runExecStep(exec, "compose-config", "校验合并后的 Compose 配置", {
      command: "docker",
      args: [...composeFiles, "config", "-q"],
      cwd: repoDir,
      timeoutMs: 120_000,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("docker", framework, steps);

  // 6. 构建、启动并等待服务 health，安装成功不再仅代表 compose 命令已提交。
  steps.push(
    await runExecStep(exec, "compose-up", "构建、启动并等待容器健康", {
      command: "docker",
      args: [...composeFiles, "up", "-d", "--build", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_SECONDS)],
      cwd: repoDir,
      timeoutMs: COMPOSE_UP_TIMEOUT_MS,
    }, dryRun),
  );
  return finish("docker", framework, steps);
}

function finish(form: "host" | "docker", framework: "hermes" | "openclaw", steps: InstallStep[]): InstallResult {
  return { form, framework, steps, success: !steps.some((s) => s.status === "failed") };
}

/** OpenClaw 官方支持的 Node 版本范围，避免仅按主版本误放行。 */
export function isOpenClawNodeSatisfied(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    (major === 24 && (minor > 15 || (minor === 15 && patch >= 0))) ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major > 25 && (major > 25 || minor > 9 || (minor === 9 && patch >= 0))) ||
    (major === 25 && (minor > 9 || (minor === 9 && patch >= 0)))
  );
}

/** 顶层编排：平台检测 → 网络探测 → 密钥引导 → 按形态执行，产出汇总报告。 */
export async function runInstaller(options: InstallerOptions = {}): Promise<InstallerReport> {
  const exec = options.exec ?? defaultExec;
  const dryRun = options.dryRun ?? false;
  const framework = options.framework ?? "hermes";

  const platform = await detectPlatform(exec);
  const network = options.skipNetwork
    ? { results: [] as SourcePlan[] }
    : await probeSources(
        buildDefaultSources({ modelEndpoints: options.modelEndpoints }),
        options.fetch ?? defaultProbeFetch,
      );
  const secrets = checkSecrets(options.env ?? process.env, options.secretGroups ?? DEFAULT_SECRET_GROUPS);

  const nextActions: string[] = [];
  if (!secrets.allPresent) {
    nextActions.push(`补齐缺失密钥（详见上方密钥引导），建议写入 ${secrets.envPath}`);
  }
  const modelPlan = findSourcePlan(network, "model-endpoints");
  if (modelPlan?.allFailed === true) {
    nextActions.push(modelPlan.guidance ?? "模型端点不可达（不阻断安装），建议配置代理或可达端点");
  }

  if (options.secretsOnly) {
    if (!secrets.allPresent) {
      nextActions.push(`可调用 writeEnvTemplate 在 ${secrets.envPath} 生成留空模板后填写`);
    }
    return { form: "secrets-only", framework, dryRun, platform, network, secrets, success: true, nextActions };
  }

  const form = options.form ?? "host";
  const plan: InstallPlan = { platform, network, secrets };
  const install =
    form === "docker" ? await installDockerForm(plan, options) : await installHostForm(plan, options);

  if (form === "docker") {
    const webPort = options.webHostPort ?? DEFAULT_WEB_HOST_PORT;
    nextActions.push("docker compose ps 查看面板与 updater 状态", "docker compose logs -f 跟随日志", `访问 http://127.0.0.1:${webPort} 打开 butler-web`);
  } else {
    const servicesStarted = install.steps.some((step) => step.id === "services-start" && step.status === "ok");
    nextActions.push(
      servicesStarted
        ? "systemctl --user status butler-watch.service butler-web.service butler-gateway.service 查看宿主服务状态"
        : install.steps.some((step) => step.id === "windows-host-guidance")
          ? "请改用 Docker Desktop，或在 WSL 中重新运行宿主进程安装"
          : "按 services-guide 指引依次启动 butler-watch / butler-web / butler-gateway",
    );
  }
  if (!install.success) {
    nextActions.push("存在失败步骤：按上方失败详情修复后重新运行安装器");
  }
  return { form, framework, dryRun, platform, network, secrets, install, success: install.success, nextActions };
}
