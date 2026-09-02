/**
 * skills-manager CLI 集成（xingkongliang/skills-manager，MIT）：
 * 把外部「中央技能库 + 任意来源安装 + 部署到 agent skills 目录 + 更新检查」
 * 的 CLI 包装成 watch 内可注入测试的服务。
 *
 * 运行约定（部署设计见 docs 与 Dockerfile）：
 * - CLI 以独立 glibc 二进制打进镜像 /usr/local/bin/skills-manager-cli
 *   （版本固定 SKILLS_MANAGER_CLI_VERSION，Dockerfile ARG/ENV 可覆盖）；
 * - 所有调用用 `env HOME=<cliHome>` 隔离：cliHome = <butler dataDir>/skills-manager-home，
 *   CLI 的中央库（~/.skills-manager）随之持久化在 Butler 数据卷；
 * - 部署目标 agent key 固定 claude_code：deploy 落在 $HOME/.claude/skills，
 *   服务把该路径维护为指向 Hermes skills 目录的 symlink，文件穿透落位；
 * - 破坏性操作（install/deploy/undeploy/update/adopt）二段式：
 *   confirmed !== true 时内部追加 --dry-run 只做预览。
 */
import { execFile as execFileCallback } from "node:child_process";
import {
  existsSync,
  lstatSync as lstatSyncReal,
  mkdirSync,
  readlinkSync,
  symlinkSync as symlinkSyncReal,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { butlerPaths } from "@butler/core";

const execFile = promisify(execFileCallback);

/** CLI 在镜像内的固定安装路径（Dockerfile RUN 下载并 chmod +x）。 */
export const SKILLS_MANAGER_CLI_PATH = "/usr/local/bin/skills-manager-cli";
/** 与 Dockerfile ARG SKILLS_MANAGER_CLI_VERSION 保持一致的默认版本。 */
export const SKILLS_MANAGER_DEFAULT_VERSION = "v1.36.0";
/** 部署目标 agent key：deploy 落在 $HOME/.claude/skills（经 symlink 穿透到 Hermes）。 */
export const SKILLS_MANAGER_DEPLOY_AGENT = "claude_code";
/** CLI 缺失时给用户的安装指引（status 200 降级与 503 共用文案）。 */
export const SKILLS_MANAGER_INSTALL_HINT =
  "技能库管理器（skills-manager CLI）未随当前 watch 镜像提供。" +
  "请升级管家镜像（Dockerfile 会下载 skills-manager-cli 到 /usr/local/bin），" +
  "或重新执行 bash scripts/deploy.sh 构建后重试。";

/** CLI 单次调用超时（安装/更新可能拉取远端仓库，默认 120s）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** CLI 业务错误：code 为 CLI 的错误码（INVALID_ARGUMENT / TARGET_CONFLICT / …）。 */
export class SkillsManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillsManagerError";
    this.code = code;
  }
}

export type SkillsManagerExecFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** ensureTarget / status 探测所需的文件系统能力（注入以便测试 symlink 分支）。 */
export interface SkillsManagerFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  /** 不存在返回 undefined；存在时 isSymbolicLink 区分链接与真实目录。 */
  lstatSync(path: string): { isSymbolicLink(): boolean } | undefined;
  readlinkSync(path: string): string;
  symlinkSync(target: string, path: string): void;
  unlinkSync(path: string): void;
}

const defaultFs: SkillsManagerFs = {
  existsSync,
  mkdirSync,
  lstatSync: (path) => {
    try {
      return lstatSyncReal(path);
    } catch {
      return undefined;
    }
  },
  readlinkSync,
  // Windows 宿主直跑（开发形态）没有管理员权限建 symlink，junction 无需特权且目录语义一致。
  symlinkSync: (target, path) =>
    symlinkSyncReal(target, path, process.platform === "win32" ? "junction" : undefined),
  unlinkSync,
};

export interface SkillsManagerCliDeps {
  /** CLI 二进制路径（默认镜像内固定路径）。 */
  cliPath?: string;
  /** 隔离 HOME（默认 <butler dataDir>/skills-manager-home，复用 @butler/core 解析）。 */
  cliHome?: string;
  /** Hermes skills 目录（symlink 目标；默认 $BUTLER_HERMES_ROOT/skills，回退 ~/.hermes/skills）。 */
  hermesSkillsDir?: string;
  execFile?: SkillsManagerExecFile;
  fs?: SkillsManagerFs;
  /** CLI 超时毫秒（默认 120s）。 */
  timeoutMs?: number;
}

export interface SkillsManagerDeployTarget {
  agent: string;
  dir: string;
  symlinked: boolean;
}

export interface SkillsManagerStatusView {
  available: true;
  cli: { path: string; version: string };
  repo: Record<string, unknown>;
  skills: unknown[];
  /** agents list 里 key=claude_code 的条目（缺失为 null）。 */
  deployAgent: Record<string, unknown> | null;
  deployTarget: SkillsManagerDeployTarget;
}

export interface SkillsManagerUnavailableView {
  available: false;
  installHint: string;
}

export interface SkillsManagerInstallInput {
  source: string;
  name?: string;
  confirmed?: boolean;
}

export interface SkillsManagerNameInput {
  name: string;
  confirmed?: boolean;
}

export interface SkillsManagerUpdateInput {
  name?: string;
  confirmed?: boolean;
}

export interface SkillsManagerAdoptInput {
  dir: string;
  confirmed?: boolean;
}

export interface SkillsManagerCli {
  readonly cliPath: string;
  readonly cliHome: string;
  readonly hermesSkillsDir: string;
  /** 执行 CLI 子命令（自动追加 --json 并解析 stdout）；失败抛 SkillsManagerError。 */
  run(args: string[]): Promise<unknown>;
  /** CLI 二进制是否就位（只做存在性探测，不真正执行）。 */
  available(): boolean;
  /** 确保 <cliHome>/.claude/skills 是指向 Hermes skills 目录的 symlink（幂等；冲突抛错且绝不删数据）。 */
  ensureTarget(): SkillsManagerDeployTarget;
  status(): Promise<SkillsManagerStatusView | SkillsManagerUnavailableView>;
  install(input: SkillsManagerInstallInput): Promise<unknown>;
  deploy(input: SkillsManagerNameInput): Promise<unknown>;
  undeploy(input: SkillsManagerNameInput): Promise<unknown>;
  check(): Promise<unknown>;
  update(input: SkillsManagerUpdateInput): Promise<unknown>;
  adopt(input: SkillsManagerAdoptInput): Promise<unknown>;
}

/** CLI 版本：镜像构建时以 ENV 固化（SKILLS_MANAGER_CLI_VERSION），本地开发回退默认值。 */
function resolveCliVersion(): string {
  const fromEnv = process.env["SKILLS_MANAGER_CLI_VERSION"]?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : SKILLS_MANAGER_DEFAULT_VERSION;
}

/** 默认 Hermes skills 目录：$BUTLER_HERMES_ROOT/skills，回退 ~/.hermes/skills。 */
function defaultHermesSkillsDir(): string {
  const root = process.env["BUTLER_HERMES_ROOT"]?.trim() || join(homedir(), ".hermes");
  return join(root, "skills");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 从 CLI 的 stdout/stderr 提取 {ok:false,code,message}；都不是 JSON 错误则返回 null。 */
function parseCliError(chunks: Array<string | undefined>): { code: string; message: string } | null {
  for (const chunk of chunks) {
    const text = chunk?.trim() ?? "";
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; code?: unknown; message?: unknown };
      if (parsed.ok === false && typeof parsed.code === "string" && parsed.code !== "") {
        return {
          code: parsed.code,
          message: typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : parsed.code,
        };
      }
    } catch {
      // 该流不是 JSON，继续看下一个流
    }
  }
  return null;
}

function toSkillsManagerError(cause: unknown): SkillsManagerError {
  if (cause instanceof SkillsManagerError) return cause;
  const err = cause as (Error & { code?: string | number; stdout?: string; stderr?: string }) | null;
  if (err !== null && typeof err === "object" && err.code === "ENOENT") {
    return new SkillsManagerError(
      "skills-manager-unavailable",
      "skills-manager CLI 不可用（二进制缺失或不可执行）",
    );
  }
  const parsed = parseCliError([err?.stdout, err?.stderr]);
  if (parsed !== null) return new SkillsManagerError(parsed.code, parsed.message);
  return new SkillsManagerError(
    "skills-manager-cli-failed",
    cause instanceof Error ? cause.message : String(cause),
  );
}

export function createSkillsManagerCli(deps: SkillsManagerCliDeps = {}): SkillsManagerCli {
  const cliPath = deps.cliPath ?? SKILLS_MANAGER_CLI_PATH;
  const cliHome = deps.cliHome ?? join(butlerPaths().dataDir, "skills-manager-home");
  const hermesSkillsDir = deps.hermesSkillsDir ?? defaultHermesSkillsDir();
  const exec = deps.execFile ?? (execFile as unknown as SkillsManagerExecFile);
  const fs = deps.fs ?? defaultFs;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (args: string[]): Promise<unknown> => {
    let stdout: string;
    try {
      ({ stdout } = await exec(cliPath, [...args, "--json"], {
        env: { ...process.env, HOME: cliHome },
        timeout: timeoutMs,
      }));
    } catch (cause) {
      throw toSkillsManagerError(cause);
    }
    const text = stdout.trim();
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new SkillsManagerError(
        "skills-manager-cli-failed",
        `CLI 输出不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const ensureTarget = (): SkillsManagerDeployTarget => {
    const claudeDir = join(cliHome, ".claude");
    const link = join(claudeDir, "skills");
    const wanted = resolve(hermesSkillsDir);
    fs.mkdirSync(claudeDir, { recursive: true });
    const stat = fs.lstatSync(link);
    if (stat !== undefined) {
      if (!stat.isSymbolicLink()) {
        throw new SkillsManagerError(
          "deploy-target-conflict",
          `部署目标 ${link} 已是真实目录或文件；为避免删除用户数据未做替换，请手动迁移后重试`,
        );
      }
      // Windows junction 可能返回 \\?\ 前缀，统一归一后再比较。
      const raw = fs.readlinkSync(link).replace(/^\\\\\?\\/, "");
      const current = resolve(dirname(link), raw);
      if (current !== wanted) {
        fs.unlinkSync(link);
        fs.symlinkSync(wanted, link);
      }
      return { agent: SKILLS_MANAGER_DEPLOY_AGENT, dir: hermesSkillsDir, symlinked: true };
    }
    fs.symlinkSync(wanted, link);
    return { agent: SKILLS_MANAGER_DEPLOY_AGENT, dir: hermesSkillsDir, symlinked: true };
  };

  const trimmed = (value: string | undefined): string => (value ?? "").trim();

  return {
    cliPath,
    cliHome,
    hermesSkillsDir,
    run,
    available: () => fs.existsSync(cliPath),
    ensureTarget,

    async status() {
      if (!fs.existsSync(cliPath)) {
        return { available: false, installHint: SKILLS_MANAGER_INSTALL_HINT };
      }
      const deployTarget = ensureTarget();
      const [repo, skills, agents] = await Promise.all([
        run(["repo", "status"]),
        run(["skills", "list"]),
        run(["agents", "list"]),
      ]);
      const agentList = Array.isArray(agents) ? agents : [];
      const deployAgent =
        agentList.find((item) => isRecord(item) && item["key"] === SKILLS_MANAGER_DEPLOY_AGENT) ?? null;
      return {
        available: true,
        cli: { path: cliPath, version: resolveCliVersion() },
        repo: isRecord(repo) ? repo : {},
        skills: Array.isArray(skills) ? skills : [],
        deployAgent: isRecord(deployAgent) ? deployAgent : null,
        deployTarget,
      };
    },

    async install({ source, name, confirmed = false }) {
      const args = ["skills", "install", source];
      const nameClean = trimmed(name);
      if (nameClean !== "") args.push("--name", nameClean);
      if (!confirmed) args.push("--dry-run");
      return run(args);
    },

    async deploy({ name, confirmed = false }) {
      ensureTarget();
      const args = ["skills", "deploy", name, "--agent", SKILLS_MANAGER_DEPLOY_AGENT];
      if (!confirmed) args.push("--dry-run");
      return run(args);
    },

    async undeploy({ name, confirmed = false }) {
      ensureTarget();
      const args = ["skills", "undeploy", name, "--agent", SKILLS_MANAGER_DEPLOY_AGENT];
      if (!confirmed) args.push("--dry-run");
      return run(args);
    },

    async check() {
      return run(["skills", "check", "--all"]);
    },

    async update({ name, confirmed = false }) {
      const nameClean = trimmed(name);
      const args = nameClean !== "" ? ["skills", "update", nameClean] : ["skills", "update", "--all"];
      if (!confirmed) args.push("--dry-run");
      return run(args);
    },

    async adopt({ dir, confirmed = false }) {
      const args = ["skills", "adopt", dir];
      if (!confirmed) args.push("--dry-run");
      return run(args);
    },
  };
}
