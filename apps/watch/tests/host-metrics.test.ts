/**
 * 主机与 agent 进程指标采样测试：纯函数（CPU 双采样差值 / df 解析）+
 * snapshot 服务（环形缓冲去重与上限 / GPU 可用性缓存 / 非 Linux 降级）+
 * HTTP /api/host/metrics 端点（未接线 503 / 接线 200）。
 * 全部副作用注入，不依赖真机 /proc 与 nvidia-smi。
 */
import { describe, expect, it } from "vitest";
import {
  computeCpuPercent,
  createHostMetricsService,
  parseDfLine,
  type HostMetricsDeps,
} from "../src/host-metrics.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

/** /proc/stat 样本：cpu 行为 user nice system idle iowait irq softirq steal guest guest_nice。 */
const STAT_BEFORE = [
  "cpu  100 0 100 900 0 0 0 0 0 0",
  "cpu0 100 0 100 900 0 0 0 0 0 0",
  "intr 12345",
].join("\n");
/** 总量差 = (150+150+950)-(100+100+900)=150；idle 差 = 950-900=50 → 非空闲 100/150 ≈ 66.67%。 */
const STAT_AFTER = [
  "cpu  150 0 150 950 0 0 0 0 0 0",
  "cpu0 150 0 150 950 0 0 0 0 0 0",
  "intr 22345",
].join("\n");

const DF_OUTPUT = [
  "Filesystem 1B-blocks Used Available Use% Mounted",
  "/dev/sda1 1000000 250000 750000 25% /",
  "",
].join("\n");

describe("computeCpuPercent", () => {
  it("按两次 /proc/stat cpu 行差值计算非空闲占比", () => {
    expect(computeCpuPercent(STAT_BEFORE, STAT_AFTER)).toBeCloseTo(66.67, 1);
  });

  it("总量无增量（间隔过短/时钟未走）返回 null", () => {
    expect(computeCpuPercent(STAT_BEFORE, STAT_BEFORE)).toBeNull();
  });

  it("缺 cpu 行或乱码返回 null", () => {
    expect(computeCpuPercent("", STAT_AFTER)).toBeNull();
    expect(computeCpuPercent("garbage", "garbage")).toBeNull();
    expect(computeCpuPercent("cpu a b c d", STAT_AFTER)).toBeNull();
  });
});

describe("parseDfLine", () => {
  it("解析 df -B1 / 第二行的总量与已用字节数", () => {
    expect(parseDfLine(DF_OUTPUT)).toEqual({ total: 1_000_000, used: 250_000 });
  });

  it("缺第二行 / 非数字 / 空输出返回 null", () => {
    expect(parseDfLine("Filesystem 1B-blocks Used Available Use% Mounted")).toBeNull();
    expect(parseDfLine("")).toBeNull();
    expect(parseDfLine("Filesystem 1B-blocks Used\n/dev/sda1 abc def 25% /")).toBeNull();
  });
});

/** 构造全注入的 host-metrics 依赖（clock 可手动推进，proc/exec 记录调用）。 */
function makeDeps(overrides: Partial<HostMetricsDeps> = {}): {
  deps: HostMetricsDeps;
  procPaths: string[];
  execCalls: Array<{ file: string; args: string[] }>;
  advance: (ms: number) => void;
} {
  const procPaths: string[] = [];
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const statQueue = [STAT_BEFORE, STAT_AFTER];
  let now = 1_000_000;
  const deps: HostMetricsDeps = {
    procReader: async (path) => {
      procPaths.push(path);
      return statQueue[procPaths.length % 2 === 1 ? 0 : 1] ?? STAT_AFTER;
    },
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (file === "df") return DF_OUTPUT;
      throw new Error("nvidia-smi: command not found");
    },
    sleep: async () => undefined,
    instancesProvider: () => [
      { instanceId: "hermes-main", frameworkId: "hermes", rootPath: "/opt/hermes", runtime: "process" },
    ],
    resourceSampler: async () => ({ rssBytes: 2048, cpuPercent: 7.5 }),
    clock: () => now,
    platform: "linux",
    osStats: () => ({ memTotalBytes: 16_000_000_000, memFreeBytes: 8_000_000_000, load1: 0.5, uptimeSeconds: 3600 }),
    ...overrides,
  };
  return { deps, procPaths, execCalls, advance: (ms) => { now += ms; } };
}

describe("createHostMetricsService snapshot", () => {
  it("CPU 双采样、磁盘解析与 agent 进程采样进入快照", async () => {
    const { deps } = makeDeps();
    const service = createHostMetricsService(deps);
    const snap = await service.snapshot();

    expect(snap.machine.cpuPercent).toBeCloseTo(66.67, 1);
    expect(snap.machine.diskTotalBytes).toBe(1_000_000);
    expect(snap.machine.diskUsedBytes).toBe(250_000);
    expect(snap.machine.memTotalBytes).toBe(16_000_000_000);
    expect(snap.machine.uptimeSeconds).toBe(3600);
    expect(snap.machine.gpu).toBeNull();
    expect(snap.agents).toEqual([
      { instanceId: "hermes-main", cpuPercent: 7.5, rssBytes: 2048 },
    ]);
    expect(snap.samples).toHaveLength(1);
    expect(snap.samples[0]).toEqual(snap.machine);
  });

  it("同一 15 秒窗口内重复 snapshot 不重复追加样本", async () => {
    const { deps, advance } = makeDeps();
    const service = createHostMetricsService(deps);
    await service.snapshot();
    advance(5_000);
    const second = await service.snapshot();
    expect(second.samples).toHaveLength(1);
    advance(10_001);
    const third = await service.snapshot();
    expect(third.samples).toHaveLength(2);
  });

  it("样本环形缓冲最多保留 60 个点", async () => {
    const { deps, advance } = makeDeps();
    const service = createHostMetricsService(deps);
    for (let i = 0; i < 65; i += 1) {
      await service.snapshot();
      advance(16_000);
    }
    const snap = await service.snapshot();
    expect(snap.samples.length).toBeLessThanOrEqual(60);
  });

  it("GPU 采样失败后 10 分钟内不再 exec，缓存过期后重试", async () => {
    const { deps, execCalls, advance } = makeDeps();
    const service = createHostMetricsService(deps);
    await service.snapshot();
    expect(execCalls.filter((call) => call.file === "nvidia-smi")).toHaveLength(1);
    advance(60_000);
    await service.snapshot();
    expect(execCalls.filter((call) => call.file === "nvidia-smi")).toHaveLength(1);
    advance(10 * 60_000 + 1_000);
    await service.snapshot();
    expect(execCalls.filter((call) => call.file === "nvidia-smi")).toHaveLength(2);
  });

  it("GPU 可用时解析第一行 name/util/mem", async () => {
    const { deps } = makeDeps({
      execFileFn: async (file) => {
        if (file === "df") return DF_OUTPUT;
        return "NVIDIA GeForce RTX 4090, 35, 1234\n";
      },
    });
    const service = createHostMetricsService(deps);
    const snap = await service.snapshot();
    expect(snap.machine.gpu).toEqual({ name: "NVIDIA GeForce RTX 4090", utilPercent: 35, memUsedMb: 1234 });
  });

  it("非 linux 平台 cpuPercent 为 null 且不读 /proc", async () => {
    const { deps, procPaths } = makeDeps({ platform: "win32" });
    const service = createHostMetricsService(deps);
    const snap = await service.snapshot();
    expect(snap.machine.cpuPercent).toBeNull();
    expect(procPaths).toHaveLength(0);
  });

  it("agent 采样失败时保留条目但字段置 null", async () => {
    const { deps } = makeDeps({ resourceSampler: async () => null });
    const service = createHostMetricsService(deps);
    const snap = await service.snapshot();
    expect(snap.agents).toEqual([{ instanceId: "hermes-main", cpuPercent: null, rssBytes: null }]);
  });
});

/** /api/host/metrics 端点测试所需的最小 WatchHttpDeps。 */
function makeHttpDeps(hostMetrics: WatchHttpDeps["hostMetrics"]): WatchHttpDeps {
  return {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "no-servicing-instance" }),
    upgrade: {
      startUpgrade: () => ({ status: "missing-target-version" }),
      status: () => null,
      listVersions: async () => ({ reachable: false, versions: [] }),
      rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    },
    gateway: {
      stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
      patches: async () => [],
      applyPatch: async () => ({ status: "unknown-patch" }),
      reapplyPatch: async () => ({ status: "unknown-patch" }),
      detectPatch: async () => ({ status: "unknown-patch" }),
    },
    hostMetrics,
  };
}

describe("GET /api/host/metrics", () => {
  it("未接线时返回 503 host-metrics-unavailable", async () => {
    const http: WatchHttp = startWatchHttp(makeHttpDeps(undefined), { port: 0 });
    const address = await http.start();
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/host/metrics`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "host-metrics-unavailable" });
    } finally {
      http.close();
    }
  });

  it("接线时返回 snapshot 载荷", async () => {
    const { deps } = makeDeps();
    const service = createHostMetricsService(deps);
    const http: WatchHttp = startWatchHttp(makeHttpDeps(service), { port: 0 });
    const address = await http.start();
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/host/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { machine: { cpuPercent: number | null }; agents: unknown[] };
      expect(body.machine.cpuPercent).toBeCloseTo(66.67, 1);
      expect(body.agents).toHaveLength(1);
    } finally {
      http.close();
    }
  });
});
