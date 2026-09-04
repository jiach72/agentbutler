/**
 * butler-watch 配置：env 读取 + 全量可注入覆盖。
 *
 * 环境变量：
 * - BUTLER_HOME              Butler 主目录（经 core resolveButlerHome 解析，默认 ~/.agent-butler）
 * - BUTLER_INSPECT_INTERVAL_MIN  巡检间隔（分钟，默认 5；为 10 分钟告警/修复 SLA 预留执行时间）
 * - BUTLER_CRITICAL_PROBE_INTERVAL_MIN  关键记忆探针间隔（分钟，默认 1；最大 5）
 * - BUTLER_TAIL_POLL_SEC     日志尾随轮询间隔（秒，默认 10）
 * - BUTLER_GATEWAY_URL       告警网关地址（默认 http://127.0.0.1:7532）
 * - BUTLER_HERMES_ROOT       Hermes 根目录（容器形态可显式挂载并指定）
 * - BUTLER_HERMES_CONTROL_URL / BUTLER_HERMES_CONTROL_TOKEN_FILE
 *                            容器部署访问宿主受控控制桥（仅固定白名单动作）
 * - BUTLER_EVOLUTION_RUN_ROOT Hermes 候选运行目录（默认 <BUTLER_HOME>/evolution-runs，必须可写）
 * - BUTLER_OPENCLAW_ROOT     OpenClaw 根目录（默认 ~/.openclaw）
 * - BUTLER_FRAMEWORK          管理框架：hermes 或 openclaw（默认 hermes）
 * - BUTLER_DASHBOARD_URL     Dashboard 地址（默认 http://127.0.0.1:9119）
 * - BUTLER_LLM_BASE_URL / BUTLER_LLM_API_KEY / BUTLER_LLM_MODEL / BUTLER_LLM_BALANCE_URL
 *                            LLM 端点探针（Task 6.3，可选；未配置探针 skipped）
 * - BUTLER_CHANNEL_DRYRUN_ENDPOINT / BUTLER_CHANNEL_DRYRUN_PAYLOAD
 *                            通道 dry-run 探针（Task 6.2，可选；未配置走静态检查）
 * - BUTLER_STALL_WRITE_THRESHOLD_MIN  停写静默阈值（分钟，默认 360 = 6h）
 * - BUTLER_RUNBOOK_AUTO     自动 runbook 触发（默认开；"0"/"false" 关闭）
 * - BUTLER_AUTO_START      自动启动巡检与日志尾随（默认开；开发只读联调可关闭）
 * - BUTLER_RUNBOOK_DEBOUNCE_MIN  自动触发防抖窗口（分钟，默认 15）
 * - BUTLER_WATCH_HOST / BUTLER_WATCH_PORT
 *                            HTTP 控制通道监听地址（默认 127.0.0.1:7533；Task 10 面板入口）
 * - BUTLER_CREDENTIAL_WRITES_ALLOWED
 *                            是否允许写入凭据库（默认仅回环监听时允许）
 * - BUTLER_VERSION_MIRROR_HOST  GitHub API 镜像前缀（版本源逐源探测，可选；Task 13.2）
 * - BUTLER_VERSION_REPO     版本源 GitHub 仓库（默认 hermes-agent/hermes；Task 13.2）
 * - BUTLER_VERSION_DOCKER_IMAGE  版本源 Docker Hub 镜像，兼 docker 拉取镜像
 *                            （默认 hermes-agent/hermes）
 * - BUTLER_UPGRADE_PIP_PACKAGE  venv pip 拉取包名（默认 hermes-agent；Task 13.1）
 * - BUTLER_UPGRADE_NOTIFY_COOLDOWN_MS  升级完成通知冷却窗（毫秒，默认 60000；
 *                            窗口内多条完成通知合并为一条投递，Task 13.2）
 */
import { resolveButlerHome } from "@butler/core";
import type { ChannelDryRunConfig, LlmProbeEnv } from "./probes/index.js";

export interface WatchConfig {
  /** 被管家管理的框架。 */
  framework: "hermes" | "openclaw";
  /** Butler 主目录（状态库/适配器目录所在）。 */
  home: string;
  /** 巡检间隔（分钟）。 */
  inspectIntervalMin: number;
  /** 关键记忆探针间隔（分钟；独立于整轮巡检，最大 5 分钟）。 */
  criticalProbeIntervalMin: number;
  /** 日志尾随轮询间隔（秒）。 */
  tailPollSec: number;
  /** 告警网关地址（POST /api/alerts）。 */
  gatewayUrl: string;
  /** Dashboard 地址（GET /api/status，可选信号）。 */
  dashboardUrl: string;
  /** API 端口探活超时（毫秒）。 */
  probeTimeoutMs: number;
  /** HTTP 请求（dashboard 信号 / 告警转发）超时（毫秒）。 */
  fetchTimeoutMs: number;
  /** 资源水位：内存告警阈值（字节 RSS，默认 512MB）。 */
  memoryWarnBytes: number;
  /** 资源水位：CPU 告警阈值（百分比，默认 80）。 */
  cpuWarnPercent: number;
  /** 错误指纹聚合窗口（毫秒，默认 5 分钟）。 */
  fingerprintWindowMs: number;
  /** 停写检测静默阈值（毫秒，默认 6h，Task 6.3）。 */
  stallWriteThresholdMs: number;
  /** LLM 端点探针 env（Task 6.3；未配置探针 skipped）。 */
  llm: LlmProbeEnv;
  /** 通道 dry-run 探针配置（Task 6.2；未配置走静态检查降级）。 */
  channelDryRun?: ChannelDryRunConfig;
  /** 自动 runbook 触发（Task 7，默认开）。 */
  runbookAuto: boolean;
  /** 自动启动首轮巡检与日志尾随（默认开；关闭时仍提供只读 HTTP 与手动巡检入口）。 */
  autoStart: boolean;
  /** 自动 runbook 触发防抖窗口（毫秒，默认 15min）。 */
  runbookDebounceMs: number;
  /** HTTP 控制通道监听地址（Task 10 面板入口，默认 127.0.0.1）。 */
  watchHttpHost: string;
  /** HTTP 控制通道监听端口（默认 7533；0 = 随机端口，测试用）。 */
  watchHttpPort: number;
  /** 是否允许 LLM 凭据写入；与监听地址解耦，公网部署默认关闭。 */
  credentialWritesAllowed: boolean;
  /** GitHub API 镜像前缀（版本源逐源探测插入镜像源；未配置则无镜像源）。 */
  versionMirrorHost?: string;
  /** 版本源 GitHub 仓库（默认 hermes-agent/hermes）。 */
  versionRepo: string;
  /** 版本源 Docker Hub 镜像，兼 docker 形态拉取镜像（默认 hermes-agent/hermes）。 */
  versionDockerImage: string;
  /** venv pip 拉取包名（默认 hermes-agent）。 */
  upgradePipPackage: string;
  /** 升级完成通知冷却窗（毫秒，默认 60000；窗口内多条合并为一条投递）。 */
  upgradeNotifyCooldownMs: number;
  /** hermes 探测 rootPath 提示（缺省扫 HERMES_ROOT 与 ~/.hermes）。 */
  hermesRoot?: string;
  /** 宿主 Hermes 控制桥地址；未配置时 process 形态沿用本地执行器。 */
  hermesControlUrl?: string;
  /** 宿主 Hermes 控制桥 token 文件。 */
  hermesControlTokenFile?: string;
  /** Hermes 候选、日志和克隆引擎的隔离目录；不可放在只读 Hermes checkout。 */
  evolutionRunRoot?: string;
  /** openclaw 探测 rootPath 提示。 */
  openclawRoot?: string;
}

export const DEFAULT_INSPECT_INTERVAL_MIN = 5;
/** 关键记忆探针默认每分钟运行；独立于整轮巡检以满足 10 分钟 SLA。 */
export const DEFAULT_CRITICAL_PROBE_INTERVAL_MIN = 1;
export const MAX_CRITICAL_PROBE_INTERVAL_MIN = 5;
/** M1 关键记忆探针 SLA deadline（分钟）；不允许被环境变量放宽。 */
export const CRITICAL_PROBE_SLA_MIN = 10;
export const DEFAULT_TAIL_POLL_SEC = 10;
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7532";
export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:9119";
/** 与 hermes 适配器 PROBE_TIMEOUT_MS 对齐。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;
export const DEFAULT_MEMORY_WARN_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CPU_WARN_PERCENT = 80;
export const DEFAULT_FINGERPRINT_WINDOW_MS = 300_000;
/** 停写静默阈值默认 360 分钟（= 6h；毫秒常量见 probes/stall-write.ts）。 */
export const DEFAULT_STALL_WRITE_THRESHOLD_MIN = 360;
/** 自动 runbook 触发防抖默认 15 分钟（毫秒常量见 runbook/executor.ts）。 */
export const DEFAULT_RUNBOOK_DEBOUNCE_MIN = 15;
/** HTTP 控制通道默认监听地址 / 端口（Task 10 面板入口）。 */
export const DEFAULT_WATCH_HTTP_HOST = "127.0.0.1";
export const DEFAULT_WATCH_HTTP_PORT = 7533;
/** Task 13：版本源与升级缺省值（GitHub 仓库 / Docker Hub 镜像 / venv pip 包名）。 */
export const DEFAULT_VERSION_REPO = "hermes-agent/hermes";
export const DEFAULT_VERSION_DOCKER_IMAGE = "hermes-agent/hermes";
export const DEFAULT_UPGRADE_PIP_PACKAGE = "hermes-agent";
/** 升级完成通知冷却窗默认 60s（Task 13.2）。 */
export const DEFAULT_UPGRADE_NOTIFY_COOLDOWN_MS = 60_000;

function readPortEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // 允许 0（随机端口，测试）；仅拒绝负数/NaN。
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readCriticalProbeIntervalEnv(): number {
  const raw = process.env["BUTLER_CRITICAL_PROBE_INTERVAL_MIN"];
  const parsed = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_CRITICAL_PROBE_INTERVAL_MIN
    ? parsed
    : DEFAULT_CRITICAL_PROBE_INTERVAL_MIN;
}

function readUrlEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw !== "" ? raw : fallback;
}

function readStrEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw !== "" ? raw : undefined;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** LLM 探针 env：显式覆盖 > BUTLER_LLM_* env。 */
function readLlmEnv(overrides?: LlmProbeEnv): LlmProbeEnv {
  return {
    baseUrl: overrides?.baseUrl ?? readStrEnv("BUTLER_LLM_BASE_URL"),
    apiKey: overrides?.apiKey ?? readStrEnv("BUTLER_LLM_API_KEY"),
    model: overrides?.model ?? readStrEnv("BUTLER_LLM_MODEL"),
    balanceUrl: overrides?.balanceUrl ?? readStrEnv("BUTLER_LLM_BALANCE_URL"),
  };
}

/** 通道 dry-run 配置：显式覆盖 > BUTLER_CHANNEL_DRYRUN_* env；均缺省 → undefined（静态检查）。 */
function readChannelDryRun(overrides?: ChannelDryRunConfig): ChannelDryRunConfig | undefined {
  const endpoint = overrides?.endpointTemplate ?? readStrEnv("BUTLER_CHANNEL_DRYRUN_ENDPOINT");
  if (!endpoint) return undefined;
  return {
    endpointTemplate: endpoint,
    payloadTemplate: overrides?.payloadTemplate ?? readStrEnv("BUTLER_CHANNEL_DRYRUN_PAYLOAD"),
  };
}

/**
 * 读取配置：显式覆盖 > 环境变量 > 默认值。
 * 测试注入 Partial<WatchConfig> 即可隔离全部外部依赖。
 */
export function loadWatchConfig(overrides: Partial<WatchConfig> = {}): WatchConfig {
  const watchHttpHost = overrides.watchHttpHost ?? readStrEnv("BUTLER_WATCH_HOST") ?? DEFAULT_WATCH_HTTP_HOST;
  const config: WatchConfig = {
    framework:
      overrides.framework ??
      (readStrEnv("BUTLER_FRAMEWORK") === "openclaw" ? "openclaw" : "hermes"),
    home: overrides.home ?? resolveButlerHome(),
    inspectIntervalMin:
      overrides.inspectIntervalMin ??
      readIntEnv("BUTLER_INSPECT_INTERVAL_MIN", DEFAULT_INSPECT_INTERVAL_MIN),
    criticalProbeIntervalMin:
      overrides.criticalProbeIntervalMin ?? readCriticalProbeIntervalEnv(),
    tailPollSec: overrides.tailPollSec ?? readIntEnv("BUTLER_TAIL_POLL_SEC", DEFAULT_TAIL_POLL_SEC),
    gatewayUrl: overrides.gatewayUrl ?? readUrlEnv("BUTLER_GATEWAY_URL", DEFAULT_GATEWAY_URL),
    dashboardUrl:
      overrides.dashboardUrl ?? readUrlEnv("BUTLER_DASHBOARD_URL", DEFAULT_DASHBOARD_URL),
    probeTimeoutMs: overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    memoryWarnBytes: overrides.memoryWarnBytes ?? DEFAULT_MEMORY_WARN_BYTES,
    cpuWarnPercent: overrides.cpuWarnPercent ?? DEFAULT_CPU_WARN_PERCENT,
    fingerprintWindowMs: overrides.fingerprintWindowMs ?? DEFAULT_FINGERPRINT_WINDOW_MS,
    stallWriteThresholdMs:
      overrides.stallWriteThresholdMs ??
      readIntEnv("BUTLER_STALL_WRITE_THRESHOLD_MIN", DEFAULT_STALL_WRITE_THRESHOLD_MIN) * 60_000,
    llm: readLlmEnv(overrides.llm),
    channelDryRun: readChannelDryRun(overrides.channelDryRun),
    runbookAuto: overrides.runbookAuto ?? readBoolEnv("BUTLER_RUNBOOK_AUTO", true),
    autoStart: overrides.autoStart ?? readBoolEnv("BUTLER_AUTO_START", true),
    runbookDebounceMs:
      overrides.runbookDebounceMs ??
      readIntEnv("BUTLER_RUNBOOK_DEBOUNCE_MIN", DEFAULT_RUNBOOK_DEBOUNCE_MIN) * 60_000,
    watchHttpHost,
    watchHttpPort:
      overrides.watchHttpPort ?? readPortEnv("BUTLER_WATCH_PORT", DEFAULT_WATCH_HTTP_PORT),
    credentialWritesAllowed:
      overrides.credentialWritesAllowed ??
      readBoolEnv(
        "BUTLER_CREDENTIAL_WRITES_ALLOWED",
        isLoopbackHost(watchHttpHost),
      ),
    versionMirrorHost: overrides.versionMirrorHost ?? readStrEnv("BUTLER_VERSION_MIRROR_HOST"),
    versionRepo: overrides.versionRepo ?? readStrEnv("BUTLER_VERSION_REPO") ?? DEFAULT_VERSION_REPO,
    versionDockerImage:
      overrides.versionDockerImage ??
      readStrEnv("BUTLER_VERSION_DOCKER_IMAGE") ??
      DEFAULT_VERSION_DOCKER_IMAGE,
    upgradePipPackage:
      overrides.upgradePipPackage ??
      readStrEnv("BUTLER_UPGRADE_PIP_PACKAGE") ??
      DEFAULT_UPGRADE_PIP_PACKAGE,
    upgradeNotifyCooldownMs:
      overrides.upgradeNotifyCooldownMs ??
      readIntEnv("BUTLER_UPGRADE_NOTIFY_COOLDOWN_MS", DEFAULT_UPGRADE_NOTIFY_COOLDOWN_MS),
    hermesRoot:
      overrides.hermesRoot ?? readStrEnv("BUTLER_HERMES_ROOT") ?? readStrEnv("HERMES_ROOT"),
    hermesControlUrl: overrides.hermesControlUrl ?? readStrEnv("BUTLER_HERMES_CONTROL_URL"),
    hermesControlTokenFile:
      overrides.hermesControlTokenFile ??
      readStrEnv("BUTLER_HERMES_CONTROL_TOKEN_FILE") ??
      "/home/butler/hermes/agent-butler/control.token",
    evolutionRunRoot: overrides.evolutionRunRoot ?? readStrEnv("BUTLER_EVOLUTION_RUN_ROOT"),
    openclawRoot: overrides.openclawRoot ?? readStrEnv("BUTLER_OPENCLAW_ROOT") ?? readStrEnv("OPENCLAW_HOME"),
  };
  return config;
}
