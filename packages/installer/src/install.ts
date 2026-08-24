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
import path from "node:path";
import { defaultExec, detectPlatform, type Exec, type PlatformReport } from "./platform.js";
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

/** Hermes 官方安装脚本地址（可通过 opts.hermesInstallUrl 覆盖）。 */
export const DEFAULT_HERMES_INSTALL_URL = "https://raw.githubusercontent.com/hermes-agent/hermes/main/install.sh";

/** docker compose 服务的默认最长等待时间（毫秒）。 */
export const COMPOSE_UP_TIMEOUT_MS = 600_000;

/** 本仓三服务。 */
export const BUTLER_SERVICES = ["butler-watch", "butler-web", "butler-gateway"] as const;

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
  exec?: Exec;
  /** 仅打印不执行/不写文件，默认 false。 */
  dryRun?: boolean;
  /** 本仓根目录，默认 process.cwd()。 */
  repoDir?: string;
  /** Hermes 官方安装脚本 URL。 */
  hermesInstallUrl?: string;
  /** 容器形态的 compose 文件路径，默认 <repoDir>/docker-compose.yml。 */
  composeFile?: string;
  /** 镜像 override 文件写入路径，默认 <repoDir>/docker-compose.override.yml。 */
  overridePath?: string;
}

/** 单形态安装结果。 */
export interface InstallResult {
  form: "host" | "docker";
  steps: InstallStep[];
  success: boolean;
}

/** 顶层编排选项。 */
export interface InstallerOptions extends InstallOptions {
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

/** 源探测结论 → 三态：镜像注入 / 跳过（官方可达或未探测）/ 失败（全不可达）。 */
function classifySource(plan: SourcePlan | undefined): "mirror" | "skipped" | "failed" {
  if (plan === undefined) return "skipped";
  if (plan.allFailed) return "failed";
  return plan.mirrorUsed ? "mirror" : "skipped";
}

/** 生成 docker-compose override 文件内容（REGISTRY_MIRROR 环境变量 + daemon.json 建议）。 */
export function buildComposeOverride(
  mirrorUrl: string,
  services: readonly string[] = BUTLER_SERVICES,
): string {
  let mirrorHost: string;
  try {
    mirrorHost = new URL(mirrorUrl).host;
  } catch {
    mirrorHost = mirrorUrl;
  }
  const lines = [
    "# Agent Butler 安装器生成：Docker Hub 镜像加速（按网络探测结果）",
    `# 探测所选镜像: ${mirrorHost}`,
    "# 说明: 本文件不改系统 Docker 配置，仅通过 REGISTRY_MIRROR 环境变量传递给构建/运行时；",
    "# 如需系统级镜像加速，可编辑 /etc/docker/daemon.json 后重启 Docker：",
    `#   { "registry-mirrors": ["https://${mirrorHost}"] }`,
    "services:",
  ];
  for (const service of services) {
    lines.push(`  ${service}:`, "    environment:", `      - REGISTRY_MIRROR=${mirrorUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 宿主进程形态安装。 */
export async function installHostForm(plan: InstallPlan, opts: InstallOptions = {}): Promise<InstallResult> {
  const exec = opts.exec ?? defaultExec;
  const dryRun = opts.dryRun ?? false;
  const repoDir = opts.repoDir ?? process.cwd();
  const hermesUrl = opts.hermesInstallUrl ?? DEFAULT_HERMES_INSTALL_URL;
  const steps: InstallStep[] = [];

  // 1. 前置 Node>=22 校验（失败即停）
  if (!plan.platform.nodeSatisfied) {
    steps.push({
      id: "node-check",
      status: "failed",
      detail: `Node ${plan.platform.nodeVersion} 不满足要求（${plan.platform.nodeRequirement}），请升级 Node 后重试`,
    });
    return { form: "host", steps, success: false };
  }
  steps.push({
    id: "node-check",
    status: "ok",
    detail: `Node ${plan.platform.nodeVersion} 满足 ${plan.platform.nodeRequirement} 要求`,
  });

  // 2. Hermes 官方安装脚本封装
  const pipeline = `curl -fsSL ${hermesUrl} | bash`;
  steps.push(
    await runExecStep(exec, "hermes-install", "安装 Hermes 宿主进程（官方 install.sh）", {
      command: "bash",
      args: ["-lc", pipeline],
      timeoutMs: 600_000,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", steps);

  // 3. pypi 镜像注入（pip 配置 index-url 按探测结果）
  const pypi = findSourcePlan(plan.network, "pypi");
  const pypiState = classifySource(pypi);
  if (pypiState === "failed") {
    steps.push({
      id: "pip-mirror",
      status: "failed",
      detail: `PyPI 官方与镜像源均不可达，无法继续安装：${pypi?.guidance ?? ""}`,
    });
    return finish("host", steps);
  }
  if (pypiState === "mirror") {
    steps.push(
      await runExecStep(exec, "pip-mirror", "注入 PyPI 镜像（pip index-url）", {
        command: "pip",
        args: ["config", "set", "global.index-url", pypi?.chosenUrl ?? ""],
      }, dryRun),
    );
    if (steps[steps.length - 1]!.status === "failed") return finish("host", steps);
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

  // 4/5. 本仓 pnpm install + build
  steps.push(
    await runExecStep(exec, "repo-install", "安装本仓依赖", {
      command: "corepack",
      args: ["pnpm", "install"],
      cwd: repoDir,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", steps);
  steps.push(
    await runExecStep(exec, "repo-build", "构建本仓", {
      command: "corepack",
      args: ["pnpm", "run", "build"],
      cwd: repoDir,
    }, dryRun),
  );
  if (steps[steps.length - 1]!.status === "failed") return finish("host", steps);

  // 6. 三服务启动指引（纯文案步骤）
  steps.push({
    id: "services-guide",
    status: "ok",
    detail: [
      "三服务启动指引（宿主形态）:",
      "  - butler-watch:   corepack pnpm --filter @butler/watch start",
      "  - butler-web:     corepack pnpm --filter @butler/web start（http://127.0.0.1:7531）",
      "  - butler-gateway: corepack pnpm --filter @butler/gateway start",
    ].join("\n"),
  });
  return finish("host", steps);
}

/** 容器形态安装。 */
export async function installDockerForm(plan: InstallPlan, opts: InstallOptions = {}): Promise<InstallResult> {
  const exec = opts.exec ?? defaultExec;
  const dryRun = opts.dryRun ?? false;
  const repoDir = opts.repoDir ?? process.cwd();
  const composeFile = opts.composeFile ?? path.join(repoDir, "docker-compose.yml");
  const overridePath = opts.overridePath ?? path.join(repoDir, "docker-compose.override.yml");
  const steps: InstallStep[] = [];

  // 1. docker CLI 可用性
  if (!plan.platform.dockerAvailable) {
    steps.push({ id: "docker-check", status: "failed", detail: "docker CLI 不可用（docker version 失败）：请先安装 Docker" });
    return { form: "docker", steps, success: false };
  }
  steps.push({ id: "docker-check", status: "ok", detail: "docker CLI 可用" });

  // 2. docker compose 可用性
  if (!plan.platform.dockerComposeAvailable) {
    steps.push({
      id: "compose-check",
      status: "failed",
      detail: "docker compose 不可用（需 Docker Compose v2 子命令）：请升级 Docker 或安装 compose 插件",
    });
    return finish("docker", steps);
  }
  steps.push({ id: "compose-check", status: "ok", detail: "docker compose 可用" });

  // 3. docker registry 镜像注入（compose override 文件形式，不改系统 docker 配置）
  const registry = findSourcePlan(plan.network, "docker-registry");
  const registryState = classifySource(registry);
  if (registryState === "failed") {
    steps.push({
      id: "registry-mirror",
      status: "failed",
      detail: `Docker Hub 官方与镜像源均不可达，拉取镜像大概率失败：${registry?.guidance ?? ""}`,
    });
    return finish("docker", steps);
  }
  if (registryState === "mirror") {
    const content = buildComposeOverride(registry?.chosenUrl ?? "");
    if (dryRun) {
      steps.push({
        id: "registry-mirror",
        status: "dry-run",
        detail: `生成镜像加速 override（dry-run 未写入 ${overridePath}）:\n${content}`,
      });
    } else {
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, content, "utf-8");
      steps.push({
        id: "registry-mirror",
        status: "ok",
        detail: `已写入 ${overridePath}（REGISTRY_MIRROR=${registry?.chosenUrl ?? ""}，含 daemon.json 建议）`,
      });
    }
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

  // 4. docker compose up -d 封装
  steps.push(
    await runExecStep(exec, "compose-up", "启动三服务容器", {
      command: "docker",
      args: ["compose", "-f", composeFile, "up", "-d"],
      cwd: repoDir,
      timeoutMs: COMPOSE_UP_TIMEOUT_MS,
    }, dryRun),
  );
  return finish("docker", steps);
}

function finish(form: "host" | "docker", steps: InstallStep[]): InstallResult {
  return { form, steps, success: !steps.some((s) => s.status === "failed") };
}

/** 顶层编排：平台检测 → 网络探测 → 密钥引导 → 按形态执行，产出汇总报告。 */
export async function runInstaller(options: InstallerOptions = {}): Promise<InstallerReport> {
  const exec = options.exec ?? defaultExec;
  const dryRun = options.dryRun ?? false;

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
    return { form: "secrets-only", dryRun, platform, network, secrets, success: true, nextActions };
  }

  const form = options.form ?? "host";
  const plan: InstallPlan = { platform, network, secrets };
  const install =
    form === "docker" ? await installDockerForm(plan, options) : await installHostForm(plan, options);

  if (form === "docker") {
    nextActions.push("docker compose ps 查看三服务状态", "docker compose logs -f 跟随日志", "访问 http://127.0.0.1:7531 打开 butler-web");
  } else {
    nextActions.push("按 services-guide 指引依次启动 butler-watch / butler-web / butler-gateway");
  }
  if (!install.success) {
    nextActions.push("存在失败步骤：按上方失败详情修复后重新运行安装器");
  }
  return { form, dryRun, platform, network, secrets, install, success: install.success, nextActions };
}
