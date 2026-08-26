import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@butler/adapter-hermes";
import {
  apiEndpointOf,
  confidenceOf,
  createApiConnectivityStage,
  createDefaultStages,
  createProcessAliveStage,
  createResourceWatermarkStage,
  InspectionPipeline,
  overallOf,
  type CheckResult,
  type CheckStatus,
  type InspectionContext,
  type InspectionStage,
} from "../src/pipeline.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-pipeline-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<InspectionContext> = {}): InspectionContext {
  return {
    instanceId: "hermes-main",
    frameworkId: "hermes",
    rootPath: tmp,
    runtime: "process",
    shared: {},
    ...overrides,
  };
}

function stageOf(id: string, status: CheckStatus): InspectionStage {
  return { id, label: id, async run() { return { id, status }; } };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 写 hermes 风格 config.yaml（port / dashboard 可控）。 */
function writeConfig(port: number): void {
  writeFileSync(
    join(tmp, "config.yaml"),
    ["platforms:", "  api_server:", "    extra:", '      host: "127.0.0.1"', `      port: ${port}`, ""].join("\n"),
  );
}

describe("InspectionPipeline", () => {
  it("阶段按数组顺序执行且逐项产出结论", async () => {
    const order: string[] = [];
    const stages = ["a", "b", "c"].map((id) => ({
      id,
      label: id,
      async run() {
        order.push(id);
        return { id, status: "pass" as const };
      },
    }));
    const outcome = await new InspectionPipeline(stages).run(makeCtx());
    expect(order).toEqual(["a", "b", "c"]);
    expect(outcome.checks.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(outcome.checks.every((c) => typeof c.durationMs === "number" && c.durationMs >= 0)).toBe(true);
  });

  it("单阶段抛异常 → 该阶段 fail 不中断后续阶段", async () => {
    const order: string[] = [];
    const pipeline = new InspectionPipeline([
      { id: "ok1", label: "", async run() { order.push("ok1"); return { id: "ok1", status: "pass" }; } },
      {
        id: "boom",
        label: "",
        async run() {
          order.push("boom");
          throw new Error("探测崩了");
        },
      },
      { id: "ok2", label: "", async run() { order.push("ok2"); return { id: "ok2", status: "pass" }; } },
    ]);
    const outcome = await pipeline.run(makeCtx());
    expect(order).toEqual(["ok1", "boom", "ok2"]);
    expect(outcome.checks[1]).toMatchObject({ id: "boom", status: "fail" });
    expect(outcome.checks[1]!.detail).toContain("探测崩了");
    expect(outcome.overall).toBe("degraded"); // 非 process-alive 的 fail → degraded
  });

  it("阶段独立计时：慢阶段 durationMs 反映实际耗时", async () => {
    const pipeline = new InspectionPipeline([
      { id: "slow", label: "", async run() { await delay(25); return { id: "slow", status: "pass" }; } },
      { id: "fast", label: "", async run() { return { id: "fast", status: "pass" }; } },
    ]);
    const outcome = await pipeline.run(makeCtx());
    expect(outcome.checks[0]!.durationMs).toBeGreaterThanOrEqual(20);
    expect(outcome.checks[1]!.durationMs).toBeLessThan(outcome.checks[0]!.durationMs!);
  });

  it("stages 数组可扩展（Task 6 探针插入点）", async () => {
    const pipeline = new InspectionPipeline([stageOf("a", "pass")]);
    pipeline.stages.push(stageOf("probe-b", "pass"));
    const outcome = await pipeline.run(makeCtx());
    expect(outcome.checks.map((c) => c.id)).toEqual(["a", "probe-b"]);
  });
});

describe("overall 判定矩阵", () => {
  const cases: Array<[Array<[string, CheckStatus]>, string]> = [
    [[["process-alive", "pass"], ["api-connectivity", "pass"], ["functional-probes", "skipped"], ["resource-watermark", "pass"]], "healthy"],
    [[["process-alive", "pass"], ["resource-watermark", "warn"]], "degraded"],
    [[["process-alive", "fail"], ["api-connectivity", "fail"]], "down"],
    [[["process-alive", "fail"], ["api-connectivity", "pass"]], "down"],
    [[["process-alive", "pass"], ["api-connectivity", "fail"]], "degraded"],
    [[["process-alive", "pass"], ["api-connectivity", "skipped"]], "healthy"],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      const checks: CheckResult[] = input.map(([id, status]) => ({ id, status }));
      expect(overallOf(checks)).toBe(expected);
    });
  }

  it("pipeline 集成：process-alive fail + api fail → down", async () => {
    const pipeline = new InspectionPipeline([
      stageOf("process-alive", "fail"),
      stageOf("api-connectivity", "fail"),
    ]);
    const outcome = await pipeline.run(makeCtx());
    expect(outcome.overall).toBe("down");
    expect(outcome.confidence).toBe(0.6); // 1 - 0.2 * 2
  });

  it("confidenceOf：全 pass → 1；fail+warn 扣减；下限 0", () => {
    expect(confidenceOf([{ id: "x", status: "pass" }])).toBe(1);
    expect(confidenceOf([{ id: "x", status: "fail" }, { id: "y", status: "warn" }])).toBe(0.75);
    const many: CheckResult[] = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, status: "fail" }));
    expect(confidenceOf(many)).toBe(0);
  });
});

describe("process-alive 阶段", () => {
  it("pgrep 命中 venv python → pass 且 detail 含 pid", async () => {
    const calls: Array<[string, string[]]> = [];
    const exec = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push([cmd, args]);
      return { code: 0, stdout: "4242\n", stderr: "" };
    };
    const outcome = await createProcessAliveStage({ exec: { exec, spawnDetached: () => {} } }).run(makeCtx());
    expect(outcome.status).toBe("pass");
    expect(outcome.detail).toContain("4242");
    expect(calls[0]![0]).toBe("pgrep");
    expect(calls[0]![1]![0]).toBe("-f");
    expect(calls[0]![1]![1]).toContain(join(tmp, "venv", "bin", "python"));
  });

  it("pgrep 全部未命中 → fail", async () => {
    const exec = async (): Promise<CommandResult> => ({ code: 1, stdout: "", stderr: "" });
    const outcome = await createProcessAliveStage({ exec: { exec, spawnDetached: () => {} } }).run(makeCtx());
    expect(outcome.status).toBe("fail");
  });

  it("docker 形态 → skipped（容器状态覆盖，V1 简化）", async () => {
    let called = false;
    const exec = async (): Promise<CommandResult> => {
      called = true;
      return { code: 0, stdout: "1\n", stderr: "" };
    };
    const outcome = await createProcessAliveStage({ exec: { exec, spawnDetached: () => {} } }).run(
      makeCtx({ runtime: "docker" }),
    );
    expect(outcome.status).toBe("skipped");
    expect(called).toBe(false);
  });

  it("Hermes 在宿主机运行 → skipped 且不在容器内执行 pgrep", async () => {
    vi.stubEnv("BUTLER_HERMES_EXTERNAL_RUNTIME", "true");
    let called = false;
    const exec = async (): Promise<CommandResult> => {
      called = true;
      return { code: 0, stdout: "1\n", stderr: "" };
    };
    const outcome = await createProcessAliveStage({ exec: { exec, spawnDetached: () => {} } }).run(makeCtx());
    expect(outcome).toMatchObject({
      status: "skipped",
      detail: "Hermes 在宿主机运行，容器内不可见宿主进程；改用 API/Bridge 探活",
    });
    expect(called).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("api-connectivity 阶段", () => {
  it("端口取自 config.yaml 且探活成功 → pass，结果写共享上下文", async () => {
    writeConfig(18642);
    const probeCalls: Array<{ host: string; port: number; timeoutMs: number }> = [];
    const ctx = makeCtx();
    const outcome = await createApiConnectivityStage({
      prober: async (host, port, timeoutMs) => {
        probeCalls.push({ host, port, timeoutMs });
        return true;
      },
      probeTimeoutMs: 800,
    }).run(ctx);
    expect(outcome.status).toBe("pass");
    expect(outcome.detail).toContain("127.0.0.1:18642");
    expect(probeCalls).toEqual([{ host: "127.0.0.1", port: 18642, timeoutMs: 800 }]);
    expect(ctx.shared["apiAlive"]).toBe(true);
    expect(ctx.shared["apiEndpoint"]).toEqual({ host: "127.0.0.1", port: 18642 });
  });

  it("探活失败 → fail", async () => {
    writeConfig(18642);
    const outcome = await createApiConnectivityStage({ prober: async () => false }).run(makeCtx());
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("18642");
  });

  it("config.yaml 缺失 → 回退默认端口 8642", async () => {
    const probeCalls: Array<{ port: number }> = [];
    await createApiConnectivityStage({
      prober: async (_host, port) => {
        probeCalls.push({ port });
        return true;
      },
    }).run(makeCtx());
    expect(probeCalls).toEqual([{ port: 8642 }]);
  });
});

describe("resource-watermark 阶段", () => {
  it("内存超阈值 → warn", async () => {
    const outcome = await createResourceWatermarkStage({
      sampler: async () => ({ rssBytes: 800 * 1024 * 1024, cpuPercent: 5 }),
      memoryWarnBytes: 512 * 1024 * 1024,
      cpuWarnPercent: 80,
    }).run(makeCtx());
    expect(outcome.status).toBe("warn");
    expect(outcome.detail).toContain("内存");
  });

  it("CPU 超阈值 → warn", async () => {
    const outcome = await createResourceWatermarkStage({
      sampler: async () => ({ rssBytes: 1024, cpuPercent: 95 }),
      memoryWarnBytes: 512 * 1024 * 1024,
      cpuWarnPercent: 80,
    }).run(makeCtx());
    expect(outcome.status).toBe("warn");
    expect(outcome.detail).toContain("CPU");
  });

  it("采样失败 → skipped 不判故障", async () => {
    const outcome = await createResourceWatermarkStage({ sampler: async () => null }).run(makeCtx());
    expect(outcome.status).toBe("skipped");
  });

  it("水位正常 → pass", async () => {
    const outcome = await createResourceWatermarkStage({
      sampler: async () => ({ rssBytes: 64 * 1024 * 1024, cpuPercent: 3 }),
      memoryWarnBytes: 512 * 1024 * 1024,
      cpuWarnPercent: 80,
    }).run(makeCtx());
    expect(outcome.status).toBe("pass");
  });
});

describe("createDefaultStages", () => {
  it("内置七阶段按序：process-alive → api-connectivity → memory-probe → channel-probe → llm-probe → stall-write → resource-watermark", async () => {
    const exec = async (cmd: string): Promise<CommandResult> =>
      cmd === "pgrep"
        ? { code: 0, stdout: "7\n", stderr: "" }
        : { code: 0, stdout: "40960 1.5\n", stderr: "" };
    const stages = createDefaultStages({
      exec: { exec, spawnDetached: () => {} },
      prober: async () => true,
    });
    expect(stages.map((s) => s.id)).toEqual([
      "process-alive",
      "api-connectivity",
      "memory-probe",
      "channel-probe",
      "llm-probe",
      "stall-write",
      "resource-watermark",
    ]);
    const outcome = await new InspectionPipeline(stages).run(makeCtx());
    // tmp 下无 memory_store.db / config.yaml weixin 声明 / LLM env / logs → 四探针降级 skipped。
    const byId = new Map(outcome.checks.map((c) => [c.id, c.status] as const));
    expect(byId.get("process-alive")).toBe("pass");
    expect(byId.get("api-connectivity")).toBe("pass");
    expect(byId.get("memory-probe")).toBe("skipped");
    expect(byId.get("channel-probe")).toBe("skipped");
    expect(byId.get("llm-probe")).toBe("skipped");
    expect(byId.get("stall-write")).toBe("skipped");
    expect(byId.get("resource-watermark")).toBe("pass");
    expect(outcome.overall).toBe("healthy");
  });
});

describe("apiEndpointOf", () => {
  it("config 为 null → 127.0.0.1:8642", () => {
    expect(apiEndpointOf(null)).toEqual({ host: "127.0.0.1", port: 8642 });
  });

  it("通配地址归一为 127.0.0.1", () => {
    expect(apiEndpointOf({ apiServer: { host: "0.0.0.0", port: 9000, key: null }, weixinExtra: null, hasDashboard: false })).toEqual({
      host: "127.0.0.1",
      port: 9000,
    });
  });

  it("Compose 注入宿主机 API 地址和端口时优先于 Hermes config", () => {
    vi.stubEnv("BUTLER_HERMES_API_HOST", "host.docker.internal");
    vi.stubEnv("BUTLER_HERMES_API_PORT", "18642");
    expect(apiEndpointOf({ apiServer: { host: "127.0.0.1", port: 8642, key: null }, weixinExtra: null, hasDashboard: false })).toEqual({
      host: "host.docker.internal",
      port: 18642,
    });
    vi.unstubAllEnvs();
  });
});
