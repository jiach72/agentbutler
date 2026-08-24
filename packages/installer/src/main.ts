/**
 * CLI 入口：手写 process.argv 解析（零外部依赖）。
 *
 * 参数: --form host|docker（缺省 host）、--dry-run、--skip-network、--secrets-only、--help
 * 运行 runInstaller 并打印人类可读报告；退出码：全部通过 0、有失败步骤 1。
 */
import { pathToFileURL } from "node:url";
import { runInstaller, type InstallerReport, type InstallerOptions } from "./install.js";

export interface CliArgs {
  form: "host" | "docker";
  dryRun: boolean;
  skipNetwork: boolean;
  secretsOnly: boolean;
  help: boolean;
  /** 解析失败原因（有值时调用方应打印用法并以 1 退出）。 */
  error?: string;
}

export const USAGE = `Agent Butler 安装器（双形态 + 国内镜像切换）

用法: node packages/installer/dist/main.js [选项]

选项:
  --form host|docker   安装形态：宿主进程形态（host，缺省）或容器形态（docker）
  --dry-run            只打印将执行的步骤，不执行命令、不写文件
  --skip-network       跳过网络逐源探测（按官方源处理，不切镜像）
  --secrets-only       仅做密钥逐项校验引导，不执行安装
  --help               显示本帮助

示例:
  node packages/installer/dist/main.js --form docker --dry-run
  node packages/installer/dist/main.js --form host --secrets-only`;

/** 手写 argv 解析：支持 --form host 与 --form=host 两种写法。 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    form: "host",
    dryRun: false,
    skipNetwork: false,
    secretsOnly: false,
    help: false,
  };
  const fail = (reason: string): CliArgs => ({ ...args, error: reason });
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--skip-network") {
      args.skipNetwork = true;
    } else if (token === "--secrets-only") {
      args.secretsOnly = true;
    } else if (token === "--form" || token.startsWith("--form=")) {
      const value = token === "--form" ? argv[++i] : token.slice("--form=".length);
      if (value !== "host" && value !== "docker") {
        return fail(`--form 的值必须是 host 或 docker，收到: ${String(value)}`);
      }
      args.form = value;
    } else {
      return fail(`未知参数: ${token}`);
    }
    i += 1;
  }
  return args;
}

function formatNetworkPlan(report: InstallerReport): string[] {
  if (report.network.results.length === 0) {
    return ["  （已跳过网络探测，按官方源处理）"];
  }
  return report.network.results.map((source) => {
    if (source.allFailed) {
      return `  - ${source.label}: 全部不可达${source.blocking ? "" : "（不阻断）"} → ${source.guidance ?? ""}`;
    }
    const via = source.mirrorUsed ? "官方不可达，已切镜像" : "官方可达";
    return `  - ${source.label}: 选择 ${source.chosen}（${via}）`;
  });
}

function formatSecrets(report: InstallerReport): string[] {
  return report.secrets.groups.map((group) =>
    group.status === "present"
      ? `  - ${group.feature}: 已就绪`
      : `  - ${group.feature}: 缺失 ${group.missingKeys.join(", ")}\n${group.guidance
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}`,
  );
}

const STATUS_MARK: Record<string, string> = { ok: "[ok]", failed: "[fail]", skipped: "[skip]", "dry-run": "[dry]" };

/** 渲染人类可读报告。 */
export function renderReport(report: InstallerReport): string {
  const lines: string[] = [];
  const formLabel =
    report.form === "secrets-only" ? "secrets-only（仅密钥引导）" : report.form === "docker" ? "docker（容器形态）" : "host（宿主进程形态）";
  lines.push(`Agent Butler 安装器报告`, `形态: ${formLabel}${report.dryRun ? "（dry-run）" : ""}`, "");

  const platform = report.platform;
  lines.push(
    "[平台]",
    `  系统: ${platform.os} ${platform.arch}${platform.isWsl ? "（WSL: " + platform.wslEvidence.join("; ") + "）" : ""}`,
    `  Node: ${platform.nodeVersion}（${platform.nodeSatisfied ? "满足" : "不满足"} ${platform.nodeRequirement}）`,
    `  docker: ${platform.dockerAvailable ? "可用" : "不可用"} · docker compose: ${platform.dockerComposeAvailable ? "可用" : "不可用"}`,
    "",
  );

  lines.push("[网络]", ...formatNetworkPlan(report), "");
  lines.push("[密钥]", ...formatSecrets(report), "");

  if (report.install !== undefined) {
    lines.push("[安装步骤]");
    for (const step of report.install.steps) {
      lines.push(`  ${STATUS_MARK[step.status] ?? "[?]"} ${step.id}: ${step.detail.split("\n").join("\n    ")}`);
    }
    lines.push("");
  }

  lines.push(`[结果] ${report.success ? "成功" : "存在失败步骤"}`);
  if (report.nextActions.length > 0) {
    lines.push("[后续步骤]");
    report.nextActions.forEach((action, index) => lines.push(`  ${index + 1}. ${action}`));
  }
  return lines.join("\n");
}

/** 运行 CLI 并返回退出码（0 成功 / 1 失败或参数错误）。 */
export async function main(
  argv: string[] = process.argv.slice(2),
  options: Pick<InstallerOptions, "env" | "exec" | "fetch" | "repoDir"> = {},
): Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    console.error(`参数错误: ${args.error}`);
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const report = await runInstaller({
    form: args.form,
    dryRun: args.dryRun,
    skipNetwork: args.skipNetwork,
    secretsOnly: args.secretsOnly,
    env: options.env ?? process.env,
    exec: options.exec,
    fetch: options.fetch,
    repoDir: options.repoDir,
  });
  console.log(renderReport(report));
  return report.success ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
