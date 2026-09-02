/**
 * 主机与 agent 进程指标采样（就绪度「Agent 主机状态」信息卡数据源）。
 *
 * - machine：CPU（/proc/stat 双采样差值，非 Linux 平台恒 null）、内存/负载/uptime（os）、
 *   磁盘（df -B1 /）、GPU（nvidia-smi 单行 CSV；不可用性缓存 10 分钟避免每次 exec）；
 * - agents：复用巡检的 pgrep+ps 资源采样器（pipeline.defaultResourceSampler）对实例
 *   列表逐个采样；实例不在或采样失败时保留条目、字段置 null；
 * - samples：机器样本环形缓冲（最多 60 点），同一 15 秒窗口内重复 snapshot 不重复追加。
 *
 * 全部副作用可注入（procReader / execFileFn / sleep / clock / osStats /
 * instancesProvider / resourceSampler / platform），测试不依赖真机 /proc 与 nvidia-smi。
 */
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import { defaultResourceSampler, type ResourceSampler } from "./pipeline.js";

const execFile = promisify(execFileCallback);

/** 单条 GPU 采样（无 GPU / 驱动缺失 / 命令失败时整条为 null）。 */
export interface GpuSample {
  name: string;
  utilPercent: number | null;
  memUsedMb: number;
}

/** 一次机器级样本；null 表示该项采样失败或不适用（如 Windows 无 /proc/stat）。 */
export interface HostMetricsSample {
  capturedAt: string;
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memFreeBytes: number | null;
  load1: number | null;
  uptimeSeconds: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  gpu: GpuSample | null;
}

/** 单个 agent 进程资源占用；实例不存在或采样失败时字段为 null。 */
export interface AgentProcessSample {
  instanceId: string;
  cpuPercent: number | null;
  rssBytes: number | null;
}

/** GET /api/host/metrics 响应：当前机器样本 + agent 进程样本 + 历史环形缓冲。 */
export interface HostMetricsSnapshot {
  machine: HostMetricsSample;
  agents: AgentProcessSample[];
  samples: HostMetricsSample[];
}

/** agent 采样所需的最小实例信息（与 InstanceRecord / InspectionContext 对齐）。 */
export interface HostMetricsInstanceRef {
  instanceId: string;
  frameworkId: string;
  rootPath: string;
  runtime: "docker" | "process" | "unknown";
}

/** os 维度统计（注入后测试可脱离真机断言）。 */
export interface OsStats {
  memTotalBytes: number;
  memFreeBytes: number;
  load1: number;
  uptimeSeconds: number;
}

export interface HostMetricsDeps {
  /** 读 /proc/stat 等伪文件（默认 node:fs/promises readFile）。 */
  procReader?: (path: string) => Promise<string>;
  /** 命令执行（df / nvidia-smi），返回 stdout；抛异常视为失败。 */
  execFileFn?: (file: string, args: string[]) => Promise<string>;
  /** CPU 两次采样间隔等待（默认 200ms；测试注入 no-op）。 */
  sleep?: (ms: number) => Promise<void>;
  /** agent 实例提供者（接线层给 core.instances.listInstances）。 */
  instancesProvider?: () => HostMetricsInstanceRef[];
  /** agent 进程资源采样器（默认 pipeline.defaultResourceSampler()）。 */
  resourceSampler?: ResourceSampler;
  /** 毫秒时钟（15s 去重与 GPU 缓存过期判定，默认 Date.now）。 */
  clock?: () => number;
  /** 平台判定（默认 process.platform；非 linux 时 CPU 置 null）。 */
  platform?: string;
  /** os 维度统计（默认 os.totalmem/freemem/loadavg/uptime）。 */
  osStats?: () => OsStats;
  /** 环形缓冲上限（默认 60）。 */
  maxSamples?: number;
}

export interface HostMetricsService {
  /** 采样一次：机器样本（并按窗口去重入环形缓冲）+ agent 进程样本 + 历史。 */
  snapshot(): Promise<HostMetricsSnapshot>;
}

/** 环形缓冲去重窗口：同窗口内重复 snapshot 不追加。 */
const SAMPLE_DEDUPE_MS = 15_000;
/** GPU 不可用缓存时长：避免无 GPU 机器每次 snapshot 都 exec 失败。 */
const GPU_UNAVAILABLE_CACHE_MS = 10 * 60_000;
/** /proc/stat 双采样间隔（毫秒）。 */
const CPU_SAMPLE_INTERVAL_MS = 200;

/**
 * 解析 /proc/stat 两次采样的 cpu 行，按「非空闲 / 总增量」计算 CPU 占用百分比。
 * idle = idle + iowait；总增量 <= 0 或字段不可解析返回 null。
 */
export function computeCpuPercent(statBefore: string, statAfter: string): number | null {
  const before = parseProcStatCpuLine(statBefore);
  const after = parseProcStatCpuLine(statAfter);
  if (before === null || after === null) return null;
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0) return null;
  const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
}

/** 取 cpu 汇总行（首列恰为 "cpu"，非 cpu0/cpuN）的字段和与 idle 和。 */
function parseProcStatCpuLine(stat: string): { total: number; idle: number } | null {
  const line = stat
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item === "cpu" || item.startsWith("cpu "));
  if (line === undefined) return null;
  const fields = line.split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) return null;
  const total = fields.reduce((sum, value) => sum + value, 0);
  const idle = fields[3]! + fields[4]!; // idle + iowait
  return { total, idle };
}

/** 解析 `df -B1 /` 输出的第二行，返回 { total, used } 字节数；畸形输出返回 null。 */
export function parseDfLine(output: string): { total: number; used: number } | null {
  const lines = output.split("\n").map((item) => item.trim()).filter((item) => item !== "");
  if (lines.length < 2) return null;
  const parts = lines[1]!.split(/\s+/);
  if (parts.length < 3) return null;
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total < 0 || used < 0) return null;
  return { total, used };
}

function defaultProcReader(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function defaultExecFile(file: string, args: string[]): Promise<string> {
  const result = await execFile(file, args, { timeout: 5_000, windowsHide: true });
  return result.stdout;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOsStats(): OsStats {
  return {
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    load1: os.loadavg()[0] ?? 0,
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

export function createHostMetricsService(deps: HostMetricsDeps = {}): HostMetricsService {
  const procReader = deps.procReader ?? defaultProcReader;
  const execFileFn = deps.execFileFn ?? defaultExecFile;
  const sleep = deps.sleep ?? defaultSleep;
  const instancesProvider = deps.instancesProvider ?? (() => []);
  const resourceSampler = deps.resourceSampler ?? defaultResourceSampler();
  const clock = deps.clock ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const osStats = deps.osStats ?? defaultOsStats;
  const maxSamples = deps.maxSamples ?? 60;

  const samples: HostMetricsSample[] = [];
  let lastAppendAt = Number.NEGATIVE_INFINITY;
  let gpuCache: { available: boolean; checkedAt: number } | null = null;

  /** CPU 占用：读两次 /proc/stat（间隔 200ms）求差；非 Linux 平台恒 null。 */
  async function sampleCpuPercent(): Promise<number | null> {
    if (platform !== "linux") return null;
    try {
      const before = await procReader("/proc/stat");
      await sleep(CPU_SAMPLE_INTERVAL_MS);
      const after = await procReader("/proc/stat");
      return computeCpuPercent(before, after);
    } catch {
      return null;
    }
  }

  /** 磁盘占用：df -B1 /，失败（含 Windows 无 df）返回 null。 */
  async function sampleDisk(): Promise<{ total: number; used: number } | null> {
    try {
      return parseDfLine(await execFileFn("df", ["-B1", "/"]));
    } catch {
      return null;
    }
  }

  /** GPU：nvidia-smi 第一行 CSV；不可用结果缓存 10 分钟。 */
  async function sampleGpu(now: number): Promise<GpuSample | null> {
    if (gpuCache !== null && !gpuCache.available && now - gpuCache.checkedAt < GPU_UNAVAILABLE_CACHE_MS) {
      return null;
    }
    try {
      const output = await execFileFn("nvidia-smi", [
        "--query-gpu=name,utilization.gpu,memory.used",
        "--format=csv,noheader,nounits",
      ]);
      const firstLine = output.split("\n")[0]?.trim() ?? "";
      const parts = firstLine.split(",").map((item) => item.trim());
      if (parts.length < 3 || parts[0] === "") throw new Error("malformed nvidia-smi output");
      const util = Number(parts[1]);
      const memUsedMb = Number(parts[2]);
      gpuCache = { available: true, checkedAt: now };
      return {
        name: parts[0]!,
        utilPercent: Number.isFinite(util) ? util : null,
        memUsedMb: Number.isFinite(memUsedMb) ? memUsedMb : 0,
      };
    } catch {
      gpuCache = { available: false, checkedAt: now };
      return null;
    }
  }

  /** agent 进程采样：复用巡检资源采样器，失败保留条目并置 null。 */
  async function sampleAgents(): Promise<AgentProcessSample[]> {
    const instances = instancesProvider();
    return Promise.all(
      instances.map(async (instance) => {
        try {
          const sample = await resourceSampler({
            instanceId: instance.instanceId,
            frameworkId: instance.frameworkId,
            rootPath: instance.rootPath,
            runtime: instance.runtime,
            shared: {},
          });
          if (sample === null) {
            return { instanceId: instance.instanceId, cpuPercent: null, rssBytes: null };
          }
          return {
            instanceId: instance.instanceId,
            cpuPercent: sample.cpuPercent,
            rssBytes: sample.rssBytes,
          };
        } catch {
          return { instanceId: instance.instanceId, cpuPercent: null, rssBytes: null };
        }
      }),
    );
  }

  return {
    async snapshot(): Promise<HostMetricsSnapshot> {
      const now = clock();
      const [cpuPercent, disk, gpu, stats, agents] = await Promise.all([
        sampleCpuPercent(),
        sampleDisk(),
        sampleGpu(now),
        Promise.resolve(osStats()),
        sampleAgents(),
      ]);
      const machine: HostMetricsSample = {
        capturedAt: nowIso(clock),
        cpuPercent,
        memTotalBytes: stats.memTotalBytes,
        memFreeBytes: stats.memFreeBytes,
        load1: stats.load1,
        uptimeSeconds: stats.uptimeSeconds,
        diskTotalBytes: disk?.total ?? null,
        diskUsedBytes: disk?.used ?? null,
        gpu,
      };
      // 同 15 秒窗口内重复 snapshot 不重复追加（UI 轮询 + 手动刷新并存时不产生密集重复点）。
      if (now - lastAppendAt >= SAMPLE_DEDUPE_MS) {
        samples.push(machine);
        lastAppendAt = now;
        if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
      }
      return { machine, agents, samples: [...samples] };
    },
  };
}
