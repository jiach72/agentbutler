/**
 * 巡检流水线（InspectionPipeline）：有序检查阶段架构。
 *
 * 每阶段 { id, label, run(ctx) } 独立计时；单阶段抛异常 → 该阶段记 fail
 * 不中断后续阶段；overall 取最差（process-alive fail → down，其他 fail →
 * degraded，仅 warn → degraded，否则 healthy）。
 *
 * 内置七阶段：process-alive / api-connectivity / memory-probe / channel-probe /
 * llm-probe / stall-write / resource-watermark（Task 6 以四个真实探针阶段替换
 * 原 functional-probes 占位）。后续探针以同接口 push 进 stages 即可。
 * 全部命令执行器 / 端口探活器 / 资源采样器 / SQLite 打开器 / fetch 可注入，
 * 测试不依赖真实 hermes。
 */
import { join } from "node:path";
import type { InspectionCheck } from "@butler/core";
import {
  createExecFileExecutor,
  DEFAULT_API_PORT,
  defaultProber,
  PROBE_TIMEOUT_MS,
  readHermesConfig,
  type CommandExecutor,
  type CommandResult,
  type PortProber,
} from "@butler/adapter-hermes";
import type { FetchLike } from "./dashboard-signal.js";
import { createChannelProbeStage, type ChannelDryRunConfig } from "./probes/channel-probe.js";
import { createLlmProbeStage, type LlmProbeEnv } from "./probes/llm-probe.js";
import { createMemoryProbeStage, type SqliteOpener } from "./probes/memory-probe.js";
import { createStallWriteStage, type LogMtimeSampler } from "./probes/stall-write.js";

/** 单阶段结论（与内核事件 InspectionCheck 同构）。 */
export type CheckResult = InspectionCheck;
export type CheckStatus = InspectionCheck["status"];
export type OverallStatus = "healthy" | "degraded" | "down";

/** process-alive 结论在 shared 中的键（stall-write 复用，避免重复 pgrep）。 */
export const SHARED_PROCESS_ALIVE = "processAlive";

/** 阶间共享上下文：实例信息 + 共享探测结果缓存（避免重复探测）。 */
export interface InspectionContext {
  instanceId: string;
  frameworkId: string;
  rootPath: string;
  runtime: "docker" | "process" | "unknown";
  shared: Record<string, unknown>;
}

export interface InspectionStage {
  id: string;
  label: string;
  run(ctx: InspectionContext): Promise<CheckResult>;
}

/** 资源采样结果：RSS 字节数与 CPU 累计百分比；null 表示采样失败。 */
export interface ResourceSample {
  rssBytes: number;
  cpuPercent: number;
}

export type ResourceSampler = (ctx: InspectionContext) => Promise<ResourceSample | null>;

/** 阶段依赖：全部可注入，缺省走真实 pgrep/ps/net.connect/sqlite/fetch。 */
export interface StageDeps {
  /** 命令执行器（process-alive 与默认资源采样共用），默认 execFile。 */
  exec?: CommandExecutor;
  /** API 端口探活器，默认 hermes defaultProber。 */
  prober?: PortProber;
  /** 资源采样器，默认 pgrep + ps。 */
  sampler?: ResourceSampler;
  probeTimeoutMs?: number;
  memoryWarnBytes?: number;
  cpuWarnPercent?: number;
  /* ------------------------- Task 6 功能探针注入 ------------------------- */
  /** SQLite 打开器（memory-probe，默认 node:sqlite 读写打开）。 */
  sqlite?: SqliteOpener;
  /** fetch（channel-probe dry-run 与 llm-probe）。 */
  fetchFn?: FetchLike;
  /** channel-probe dry-run 配置（缺省走静态检查降级）。 */
  channelDryRun?: ChannelDryRunConfig;
  /** llm-probe env（缺省走 skipped）。 */
  llmEnv?: LlmProbeEnv;
  /** 停写静默阈值（毫秒，默认 6h）。 */
  stallWriteThresholdMs?: number;
  /** 日志 mtime 采集器（stall-write，默认 readdir+stat）。 */
  logMtimeSampler?: LogMtimeSampler;
  /** 可注入时钟（memory-probe 清理判定 / stall-write 静默判定）。 */
  now?: () => number;
}

export interface InspectionOutcome {
  checks: CheckResult[];
  overall: OverallStatus;
  confidence: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** overall 判定：process-alive fail → down；存在其他 fail → degraded；仅 warn → degraded；否则 healthy。 */
export function overallOf(checks: CheckResult[]): OverallStatus {
  const processAlive = checks.find((c) => c.id === "process-alive");
  if (checks.some((c) => c.status === "fail")) {
    return processAlive?.status === "fail" ? "down" : "degraded";
  }
  if (checks.some((c) => c.status === "warn")) return "degraded";
  return "healthy";
}

/** 置信度：fail -0.2 / warn -0.05，下限 0 上限 1；dashboard 信号在流水线外叠加。 */
export function confidenceOf(checks: CheckResult[]): number {
  let confidence = 1;
  for (const check of checks) {
    if (check.status === "fail") confidence -= 0.2;
    else if (check.status === "warn") confidence -= 0.05;
  }
  return round2(Math.min(1, Math.max(0, confidence)));
}

export class InspectionPipeline {
  /** 有序阶段集合；后续探针可直接扩展此数组。 */
  readonly stages: InspectionStage[];

  constructor(stages: InspectionStage[] = []) {
    this.stages = [...stages];
  }

  /** 逐阶段执行：独立计时，单阶段异常 → 该阶段 fail 不中断。 */
  async run(ctx: InspectionContext): Promise<InspectionOutcome> {
    const checks: CheckResult[] = [];
    for (const stage of this.stages) {
      const startedAt = Date.now();
      let result: CheckResult;
      try {
        result = await stage.run(ctx);
      } catch (error) {
        result = { id: stage.id, status: "fail", detail: `阶段异常: ${describe(error)}` };
      }
      checks.push({ ...result, id: result.id || stage.id, durationMs: Date.now() - startedAt });
    }
    return { checks, overall: overallOf(checks), confidence: confidenceOf(checks) };
  }
}

/** 默认命令执行器：hermes 适配器的 execFile 实现（超时即杀死，永不 reject）。 */
export function defaultCommandRunner(): CommandExecutor {
  return createExecFileExecutor();
}

/* ------------------------------ 内置七阶段 ------------------------------ */

/**
 * API 探活端点解析（与 hermes detect.resolveApiEndpoint 同语义；
 * 该函数未从包导出，此处按 config 声明复算，通配地址归一为 127.0.0.1）。
 */
export function apiEndpointOf(config: Awaited<ReturnType<typeof readHermesConfig>>): { host: string; port: number } {
  const port = config?.apiServer.port ?? DEFAULT_API_PORT;
  const rawHost = config?.apiServer.host;
  const host = !rawHost || rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  return { host, port };
}

/** process-alive：pgrep -f 匹配 venv python / hermes systemd unit；docker 形态 skipped（容器状态覆盖，V1 简化 pgrep）。结论写 shared 供 stall-write 复用。 */
export function createProcessAliveStage(deps: StageDeps = {}): InspectionStage {
  const exec = deps.exec ?? defaultCommandRunner();
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  return {
    id: "process-alive",
    label: "进程存活",
    async run(ctx) {
      if (ctx.runtime === "docker") {
        ctx.shared[SHARED_PROCESS_ALIVE] = "skipped";
        return { id: "process-alive", status: "skipped", detail: "docker 形态跳过进程探测（由容器状态覆盖）" };
      }
      const patterns = [join(ctx.rootPath, "venv", "bin", "python"), "hermes"];
      for (const pattern of patterns) {
        const result = await exec.exec("pgrep", ["-f", pattern], { timeoutMs });
        const pids = result.stdout.trim().split("\n").filter((p) => p.trim() !== "");
        if (result.code === 0 && pids.length > 0) {
          ctx.shared[SHARED_PROCESS_ALIVE] = "pass";
          return { id: "process-alive", status: "pass", detail: `pgrep -f ${pattern} 命中 pid ${pids.join(",")}` };
        }
      }
      ctx.shared[SHARED_PROCESS_ALIVE] = "fail";
      return { id: "process-alive", status: "fail", detail: "pgrep 未命中 venv python / hermes unit，进程疑似未运行" };
    },
  };
}

/** api-connectivity：复用 hermes readHermesConfig + resolveApiEndpoint + defaultProber 端口探活。 */
export function createApiConnectivityStage(deps: StageDeps = {}): InspectionStage {
  const prober = deps.prober ?? defaultProber;
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  return {
    id: "api-connectivity",
    label: "API 端口探活",
    async run(ctx) {
      const config = await readHermesConfig(ctx.rootPath);
      const endpoint = apiEndpointOf(config);
      ctx.shared["apiEndpoint"] = endpoint;
      const alive = await prober(endpoint.host, endpoint.port, timeoutMs);
      ctx.shared["apiAlive"] = alive;
      return alive
        ? { id: "api-connectivity", status: "pass", detail: `${endpoint.host}:${endpoint.port} 探活成功` }
        : { id: "api-connectivity", status: "fail", detail: `${endpoint.host}:${endpoint.port} 探活失败` };
    },
  };
}

/** resource-watermark：内存超限 → warn；采样失败 → skipped 不判故障。 */
export function createResourceWatermarkStage(deps: StageDeps = {}): InspectionStage {
  const sampler = deps.sampler ?? defaultResourceSampler(deps.exec ?? defaultCommandRunner());
  const memoryWarnBytes = deps.memoryWarnBytes ?? 512 * 1024 * 1024;
  const cpuWarnPercent = deps.cpuWarnPercent ?? 80;
  return {
    id: "resource-watermark",
    label: "资源水位",
    async run(ctx) {
      const sample = await sampler(ctx);
      if (sample === null) {
        return { id: "resource-watermark", status: "skipped", detail: "资源采样失败，不判故障" };
      }
      const rssMb = Math.round(sample.rssBytes / (1024 * 1024));
      const issues: string[] = [];
      if (sample.rssBytes > memoryWarnBytes) {
        issues.push(`内存 ${rssMb}MB 超阈值 ${Math.round(memoryWarnBytes / (1024 * 1024))}MB`);
      }
      if (sample.cpuPercent > cpuWarnPercent) {
        issues.push(`CPU ${sample.cpuPercent.toFixed(1)}% 超阈值 ${cpuWarnPercent}%`);
      }
      if (issues.length > 0) {
        return { id: "resource-watermark", status: "warn", detail: issues.join("; ") };
      }
      return { id: "resource-watermark", status: "pass", detail: `RSS ${rssMb}MB / CPU ${sample.cpuPercent.toFixed(1)}%` };
    },
  };
}

/** 默认资源采样器：pgrep -f rootPath 拿 pid → ps 汇总 RSS(KB) 与 CPU%，任一步失败返回 null。 */
export function defaultResourceSampler(exec: CommandExecutor = defaultCommandRunner()): ResourceSampler {
  return async (ctx) => {
    try {
      const pgrep = await exec.exec("pgrep", ["-f", ctx.rootPath], { timeoutMs: 3000 });
      if (pgrep.code !== 0) return null;
      const pids = pgrep.stdout.trim().split("\n").map((p) => p.trim()).filter((p) => /^\d+$/.test(p));
      if (pids.length === 0) return null;
      const ps: CommandResult = await exec.exec("ps", ["-o", "rss=,pcpu=", "-p", pids.join(",")], { timeoutMs: 3000 });
      if (ps.code !== 0) return null;
      let rssBytes = 0;
      let cpuPercent = 0;
      for (const line of ps.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const rssKb = Number(parts[0]);
        const cpu = Number(parts[1]);
        if (!Number.isFinite(rssKb) || !Number.isFinite(cpu)) continue;
        rssBytes += rssKb * 1024;
        cpuPercent += cpu;
      }
      return { rssBytes, cpuPercent };
    } catch {
      return null;
    }
  };
}

/**
 * 内置七阶段（Task 6 探针替换 functional-probes 占位）：
 * process-alive → api-connectivity → memory-probe → channel-probe →
 * llm-probe → stall-write → resource-watermark。
 */
export function createDefaultStages(deps: StageDeps = {}): InspectionStage[] {
  return [
    createProcessAliveStage(deps),
    createApiConnectivityStage(deps),
    createMemoryProbeStage({
      open: deps.sqlite,
      now: deps.now,
    }),
    createChannelProbeStage({
      dryRun: deps.channelDryRun,
      fetchFn: deps.fetchFn,
      prober: deps.prober,
      now: deps.now,
    }),
    createLlmProbeStage({ env: deps.llmEnv, fetchFn: deps.fetchFn }),
    createStallWriteStage({
      thresholdMs: deps.stallWriteThresholdMs,
      sampler: deps.logMtimeSampler,
      now: deps.now,
    }),
    createResourceWatermarkStage(deps),
  ];
}
