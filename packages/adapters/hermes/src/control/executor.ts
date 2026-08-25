/**
 * Hermes L2 控制面执行器：宿主进程形态（systemd user unit / venv 直启）
 * 与容器形态（dockerode）双实现。
 *
 * 纪律约束（discipline.ts control 行）：
 * - 常规控制必须幂等：已运行的 start、已停止的 stop 均直接成功；
 * - 超时不盲目重试，返回 E202 交由上层转状态复核；
 * - docker 形态连接失败 → 降级只观察（fail + userHint），绝不抛异常。
 */
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import type { ErrorCode } from "@butler/contract";
import Docker from "dockerode";
import { readHermesConfig } from "../config.js";
import {
  defaultProber,
  findVenvPython,
  PROBE_TIMEOUT_MS,
  resolveApiEndpoint,
  type PortProber,
} from "../detect.js";

/* ------------------------------ 命令执行器抽象 ------------------------------ */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 可注入的命令执行器：进程形态执行器的所有进程探测/操作都经由它，
 * 默认基于 node:child_process execFile/spawn，测试注入 fake。
 */
export interface CommandExecutor {
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
  /** 后台拉起进程（fire-and-forget，不等待退出）。 */
  spawnDetached(cmd: string, args: string[]): void;
}

/** 默认实现：execFile（超时即杀死），spawn detached + unref。 */
export function createExecFileExecutor(): CommandExecutor {
  return {
    exec: (cmd, args, opts) =>
      new Promise<CommandResult>((resolve) => {
        execFile(cmd, args, { timeout: opts?.timeoutMs }, (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 127
                : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      }),
    spawnDetached: (cmd, args) => {
      try {
        spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      } catch {
        // 拉起失败交由存活轮询超时兜底（E202）。
      }
    },
  };
}

/* --------------------------------- 公共类型 --------------------------------- */

/** 执行器操作结果：ok 携带可选说明；fail 携带表内错误码（绝不抛异常）。 */
export type ExecutorOutcome =
  | { ok: true; note?: string }
  | { ok: false; code: ErrorCode; message: string; userHint?: string; cause?: unknown };

export interface ExecutorOpts {
  timeoutSec?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------ ProcessExecutor ----------------------------- */

/** stop 优雅等待的缺省超时（秒），超时后升级 SIGKILL。 */
export const DEFAULT_STOP_TIMEOUT_SEC = 30;
/** start 等待实例就绪的缺省超时（秒）。 */
export const DEFAULT_START_TIMEOUT_SEC = 30;
/** 存活轮询间隔（毫秒）。 */
const ALIVE_POLL_INTERVAL_MS = 200;

export interface ProcessExecutorOptions {
  exec?: CommandExecutor;
  prober?: PortProber;
  /** systemd user unit 名；未显式配置时禁用 systemd 控制，避免猜测错误服务。 */
  unitName?: string;
}

/**
 * 宿主进程形态执行器。
 * 存活判定：venv Python 存在且 API 端口探活成功，或 pgrep 命中实例进程模式。
 */
export class ProcessExecutor {
  private readonly runner: CommandExecutor;
  private readonly prober: PortProber;
  private readonly unitName?: string;

  constructor(opts: ProcessExecutorOptions = {}) {
    this.runner = opts.exec ?? createExecFileExecutor();
    this.prober = opts.prober ?? defaultProber;
    const configuredUnit = opts.unitName?.trim();
    this.unitName = configuredUnit === "" ? undefined : configuredUnit;
  }

  async isAlive(rootPath: string): Promise<boolean> {
    const venvPython = findVenvPython(rootPath);
    if (venvPython) {
      const config = await readHermesConfig(rootPath);
      const endpoint = resolveApiEndpoint(config);
      if (await this.prober(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS)) return true;
    }
    return this.pgrepAlive(rootPath);
  }

  async start(rootPath: string, opts: ExecutorOpts = {}): Promise<ExecutorOutcome> {
    if (await this.isAlive(rootPath)) return { ok: true, note: "已在运行，幂等成功" };
    const timeoutMs = (opts.timeoutSec ?? DEFAULT_START_TIMEOUT_SEC) * 1000;
    if (await this.unitExists()) {
      const r = await this.runner.exec("systemctl", ["--user", "start", this.unitName!], { timeoutMs });
      if (r.code !== 0) {
        return {
          ok: false,
          code: "E203",
          message: `systemctl --user start ${this.unitName} 退出码 ${r.code}: ${r.stderr.trim()}`,
        };
      }
    } else {
      const venvPython = findVenvPython(rootPath);
      if (!venvPython) {
        return { ok: false, code: "E203", message: `未找到可启动的 venv 入口（${rootPath}）` };
      }
      this.runner.spawnDetached(join(rootPath, venvPython), ["-m", "hermes_agent"]);
    }
    return this.waitAlive(rootPath, timeoutMs, "start");
  }

  async stop(rootPath: string, opts: ExecutorOpts = {}): Promise<ExecutorOutcome> {
    if (!(await this.isAlive(rootPath))) return { ok: true, note: "已停止，幂等成功" };
    const timeoutMs = (opts.timeoutSec ?? DEFAULT_STOP_TIMEOUT_SEC) * 1000;
    const hasUnit = await this.unitExists();
    if (hasUnit) {
      await this.runner.exec("systemctl", ["--user", "stop", this.unitName!], { timeoutMs });
    } else {
      for (const pid of await this.pgrepPids(rootPath)) {
        await this.runner.exec("kill", [pid]);
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (await this.isAlive(rootPath)) {
      if (Date.now() >= deadline) break;
      await sleep(ALIVE_POLL_INTERVAL_MS);
    }
    if (await this.isAlive(rootPath)) {
      if (hasUnit) {
        await this.runner.exec("systemctl", ["--user", "kill", this.unitName!]);
      } else {
        for (const pid of await this.pgrepPids(rootPath)) {
          await this.runner.exec("kill", ["-9", pid]);
        }
      }
      if (await this.isAlive(rootPath)) {
        return { ok: false, code: "E202", message: "stop 优雅等待超时且强杀后进程仍未退出" };
      }
    }
    return { ok: true };
  }

  async restart(rootPath: string, opts: ExecutorOpts = {}): Promise<ExecutorOutcome> {
    const stopOut = await this.stop(rootPath, opts);
    if (!stopOut.ok) return stopOut;
    return this.start(rootPath, opts);
  }

  private async unitExists(): Promise<boolean> {
    // Never probe or operate a guessed unit name. A service unit must be
    // explicitly bound by the host integration that owns the instance.
    if (!this.unitName) return false;
    const r = await this.runner.exec("systemctl", ["--user", "cat", this.unitName]);
    return r.code === 0;
  }

  private async pgrepPids(rootPath: string): Promise<string[]> {
    const r = await this.runner.exec("pgrep", ["-f", join(rootPath, "hermes-agent")]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  private async pgrepAlive(rootPath: string): Promise<boolean> {
    return (await this.pgrepPids(rootPath)).length > 0;
  }

  private async waitAlive(rootPath: string, timeoutMs: number, what: string): Promise<ExecutorOutcome> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.isAlive(rootPath)) return { ok: true };
      if (Date.now() >= deadline) {
        return { ok: false, code: "E202", message: `${what} 等待实例就绪超时（${rootPath}）` };
      }
      await sleep(ALIVE_POLL_INTERVAL_MS);
    }
  }
}

/* ------------------------------ DockerExecutor ------------------------------ */

/** dockerode 容器对象的最小面（测试注入 fake container）。 */
export interface ContainerLike {
  inspect(): Promise<{ State?: { Running?: boolean } }>;
  start(): Promise<unknown>;
  stop(opts?: { t?: number }): Promise<unknown>;
  restart(): Promise<unknown>;
}

export interface DockerLike {
  getContainer(idOrName: string): ContainerLike;
}

/** dockerode 实例工厂：入参为解析后的 DOCKER_HOST（测试可注入断言其取值）。 */
export type DockerodeFactory = (connect: { dockerHost: string }) => DockerLike;

/** 缺省 docker socket（注意双 daemon 并存场景 DOCKER_HOST 必须可配置）。 */
export const DEFAULT_DOCKER_HOST = "/var/run/docker.sock";

/** 解析生效的 docker host：显式入参 > DOCKER_HOST env > 缺省 socket。 */
export function resolveDockerHost(explicit?: string): string {
  const raw = (explicit ?? process.env["DOCKER_HOST"] ?? "").trim();
  return raw === "" ? DEFAULT_DOCKER_HOST : raw;
}

/** 把 DOCKER_HOST 形态翻译为 dockerode 连接参数。 */
export function dockerodeConnectOptions(dockerHost: string): {
  socketPath?: string;
  host?: string;
  port?: number;
} {
  const value = dockerHost.trim();
  if (value.startsWith("unix://")) return { socketPath: value.slice("unix://".length) };
  if (value.startsWith("npipe://")) return { socketPath: value.slice("npipe://".length) };
  if (value.startsWith("tcp://") || value.startsWith("http://") || value.startsWith("https://")) {
    const schemeEnd = value.indexOf("://") + 3;
    const hostPort = value.slice(schemeEnd);
    const colonAt = hostPort.lastIndexOf(":");
    if (colonAt > 0) {
      return { host: hostPort.slice(0, colonAt), port: Number(hostPort.slice(colonAt + 1)) };
    }
    return { host: hostPort };
  }
  return { socketPath: value };
}

export interface DockerExecutorOptions {
  factory?: DockerodeFactory;
  /** hermes 容器名/ID（默认 "hermes"）。 */
  containerName?: string;
  /** 显式 DOCKER_HOST（缺省读 env，再缺省 /var/run/docker.sock）。 */
  dockerHost?: string;
}

/** 容器形态执行器：所有操作幂等，daemon 不可达 → 降级只观察（fail，不抛异常）。 */
export class DockerExecutor {
  private readonly factory: DockerodeFactory | undefined;
  private readonly containerName: string;
  private readonly explicitHost: string | undefined;
  private docker: DockerLike | null = null;

  constructor(opts: DockerExecutorOptions = {}) {
    this.factory = opts.factory;
    this.containerName = opts.containerName ?? "hermes";
    this.explicitHost = opts.dockerHost;
  }

  async isAlive(): Promise<boolean> {
    try {
      const info = await this.container().inspect();
      return info?.State?.Running === true;
    } catch {
      return false;
    }
  }

  async start(): Promise<ExecutorOutcome> {
    try {
      const container = this.container();
      const info = await container.inspect();
      if (info?.State?.Running) return { ok: true, note: "容器已在运行，幂等成功" };
      await container.start();
      return { ok: true };
    } catch (e) {
      return this.degrade(e);
    }
  }

  async stop(opts: ExecutorOpts = {}): Promise<ExecutorOutcome> {
    try {
      const container = this.container();
      const info = await container.inspect();
      if (info?.State?.Running !== true) return { ok: true, note: "容器已停止，幂等成功" };
      await container.stop({ t: opts.timeoutSec ?? DEFAULT_STOP_TIMEOUT_SEC });
      return { ok: true };
    } catch (e) {
      return this.degrade(e);
    }
  }

  async restart(): Promise<ExecutorOutcome> {
    try {
      await this.container().restart();
      return { ok: true };
    } catch (e) {
      return this.degrade(e);
    }
  }

  private container(): ContainerLike {
    if (this.docker === null) {
      const dockerHost = resolveDockerHost(this.explicitHost);
      const factory = this.factory ?? defaultDockerodeFactory;
      this.docker = factory({ dockerHost });
    }
    return this.docker.getContainer(this.containerName);
  }

  private degrade(e: unknown): Extract<ExecutorOutcome, { ok: false }> {
    return {
      ok: false,
      code: "E203",
      message: `docker 操作失败（容器 ${this.containerName}）: ${String(e)}`,
      userHint: "Docker 不可达，已降级为只观察",
      cause: e,
    };
  }
}

/** 默认工厂：真实 dockerode 实例（连接参数由 DOCKER_HOST 解析）。 */
function defaultDockerodeFactory(connect: { dockerHost: string }): DockerLike {
  return new Docker(dockerodeConnectOptions(connect.dockerHost)) as unknown as DockerLike;
}
