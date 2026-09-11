/**
 * 影子执行器（shadow-runner）测试：不触网、不真装 venv——用可编程 fake exec。
 *
 * 覆盖：
 * - 可用性判定：模型端点三项缺一即 unavailable（绝不假装能验证）；
 * - 正常链路：venv + pip 安装 → 逐任务冒烟 → 指标全部来自回放实测（含 source 声明）；
 * - 安全：API key 只经环境变量（不出现在任何命令行参数或脚本正文）；
 * - 失败路径：venv 失败 / pip 失败 → ok=false 且 reason 如实；
 * - 样本上限：超 20 个任务截断并在 source 里声明跳过数。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShadowRunner, SHADOW_MAX_TASKS } from "../src/shadow-runner.js";
import type { CommandExecutor, CommandResult } from "@butler/adapter-hermes";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-shadow-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows 句柄延迟释放
    }
  }
});

const LLM = { baseUrl: "https://llm.example.com/v1", apiKey: "sk-test-1234567890", model: "test-model" };

interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

function fakeExec(handler: (call: Call) => CommandResult): { exec: CommandExecutor; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: {
      exec: async (cmd, args, opts) => {
        const call = { cmd, args, env: opts?.env };
        calls.push(call);
        return handler(call);
      },
      spawnDetached: () => undefined,
    },
  };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

const smokeOutput = (over: Partial<{ ok: boolean; tokens: number | null; duration_ms: number }> = {}): string =>
  JSON.stringify({ ok: true, tokens: 120, duration_ms: 800, error: null, ...over });

function makeRunner(exec: CommandExecutor) {
  return createShadowRunner({
    exec,
    stateDbPath: join(makeTempDir(), "state.db"), // 不存在 → 指纹读取静默为空（防御式）
    shadowRoot: join(makeTempDir(), "shadow"),
    llm: LLM,
    now: () => FIXED,
  });
}

const FIXED = Date.parse("2026-09-11T12:00:00Z");

const tasks = Array.from({ length: 3 }, (_, i) => ({
  sessionId: `s-${i}`,
  outcome: "ok",
  bucket: "regular" as const,
}));

describe("影子执行器：可用性（诚实优先）", () => {
  it("模型端点 / 密钥 / 模型名缺一即 unavailable，且 reason 说明缺什么", () => {
    const { exec } = fakeExec(() => ok());
    const base = {
      exec,
      stateDbPath: "x",
      shadowRoot: "y",
      now: () => FIXED,
    };
    expect(createShadowRunner({ ...base, llm: {} }).available()).toBe(false);
    expect(createShadowRunner({ ...base, llm: { baseUrl: LLM.baseUrl, apiKey: LLM.apiKey } }).available()).toBe(false);
    expect(createShadowRunner({ ...base, llm: { baseUrl: LLM.baseUrl, model: LLM.model } }).available()).toBe(false);
    expect(createShadowRunner({ ...base, llm: { apiKey: LLM.apiKey, model: LLM.model } }).available()).toBe(false);
    expect(createShadowRunner({ ...base, llm: LLM }).available()).toBe(true);
    expect(createShadowRunner({ ...base, llm: {} }).unavailableReason()).toContain("未配置");
  });

  it("unavailable 时 run 直接返回失败，不执行任何命令", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const runner = createShadowRunner({
      exec,
      stateDbPath: "x",
      shadowRoot: "y",
      llm: {},
      now: () => FIXED,
    });
    const result = await runner.run({ runId: "r1", targetVersion: "2.0.0", instance: "", tasks });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("未配置");
    expect(calls.length).toBe(0);
  });
});

describe("影子执行器：正常链路", () => {
  it("venv + pip → 冒烟回放 → 指标全部实测且 source 声明等价回放", async () => {
    const { exec, calls } = fakeExec((call) => {
      if (call.args[0] === "-m") return ok(); // venv
      if (call.cmd.endsWith("pip")) return ok(); // pip install
      return ok(smokeOutput()); // 冒烟脚本（stdout 末行 JSON）
    });
    const runner = makeRunner(exec);
    const result = await runner.run({ runId: "r1", targetVersion: "2.0.0", instance: "", tasks });

    expect(result.ok).toBe(true);
    const metrics = result.metrics!;
    expect(metrics.successRate).toBe(1);
    expect(metrics.avgTokens).toBe(120);
    expect(metrics.avgDurationMs).toBe(800);
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.outputSimilarity).toBeNull(); // 无法计算 → null，不编造
    expect(metrics.errorFingerprints).toEqual([]); // state.db 不存在 → 防御式空集
    expect(metrics.source).toContain("2.0.0");
    expect(metrics.source).toContain("等价冒烟任务"); // 隐私边界写进口径
    // 链路形状：1 venv + 1 pip + 3 冒烟。
    expect(calls.length).toBe(5);
    expect(calls[0]!.args).toContain("venv");
    expect(calls[1]!.args.join(" ")).toContain("hermes-agent==2.0.0");
  });

  it("冒烟失败计入 successRate（实测，不粉饰）", async () => {
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "-m" || call.cmd.endsWith("pip")) return ok();
      // 第 1 个冒烟失败，其余成功。
      const smokeCallsBefore = call.cmd.includes("smoke-");
      if (smokeCallsBefore && call.args[0]?.includes("smoke-") === false) return ok(smokeOutput());
      return ok(smokeOutput());
    });
    // 更直接的方式：按调用序号区分。
    let smokeCount = 0;
    const seq = fakeExec((call) => {
      if (call.args[0] === "-m" || call.cmd.endsWith("pip")) return ok();
      smokeCount += 1;
      return smokeCount === 1
        ? ok(JSON.stringify({ ok: false, tokens: null, duration_ms: 900, error: "HTTP 500" }))
        : ok(smokeOutput());
    });
    const runner = makeRunner(seq.exec);
    const result = await runner.run({ runId: "r2", targetVersion: "2.0.0", instance: "", tasks });
    void exec;
    expect(result.ok).toBe(true);
    expect(result.metrics!.successRate).toBeCloseTo(2 / 3, 5);
    expect(result.metrics!.avgDurationMs).toBeCloseTo((900 + 800 + 800) / 3, 5);
  });

  it("样本超过上限截断，source 声明跳过数", async () => {
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "-m" || call.cmd.endsWith("pip")) return ok();
      return ok(smokeOutput());
    });
    const runner = makeRunner(exec);
    const many = Array.from({ length: SHADOW_MAX_TASKS + 7 }, (_, i) => ({
      sessionId: `s-${i}`,
      outcome: "ok",
      bucket: "regular" as const,
    }));
    const result = await runner.run({ runId: "r3", targetVersion: "2.0.0", instance: "", tasks: many });
    expect(result.metrics!.sampleSize).toBe(SHADOW_MAX_TASKS);
    expect(result.metrics!.source).toContain("7 个样本超上限未回放");
  });
});

describe("影子执行器：安全与失败路径", () => {
  it("API key 只经环境变量：不出现在任何命令行参数或脚本内容里", async () => {
    const { exec, calls } = fakeExec((call) => {
      if (call.args[0] === "-m" || call.cmd.endsWith("pip")) return ok();
      return ok(smokeOutput());
    });
    const runner = makeRunner(exec);
    await runner.run({ runId: "r4", targetVersion: "2.0.0", instance: "", tasks });
    for (const call of calls) {
      // 命令行与参数绝不包含 key。
      expect(`${call.cmd} ${call.args.join(" ")}`).not.toContain(LLM.apiKey);
    }
    // 冒烟调用的 env 携带 key（且只有那里）。
    const smokes = calls.filter((call) => call.cmd === "python3" && !call.args[0]?.startsWith("-"));
    expect(smokes.length).toBeGreaterThan(0);
    for (const smoke of smokes) {
      expect(smoke.env?.["SHADOW_LLM_KEY"]).toBe(LLM.apiKey);
    }
  });

  it("venv 失败 → ok=false 且 reason 如实", async () => {
    const { exec } = fakeExec((call) =>
      call.args[0] === "-m" ? fail("python3-venv not installed") : ok(),
    );
    const runner = makeRunner(exec);
    const result = await runner.run({ runId: "r5", targetVersion: "2.0.0", instance: "", tasks });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("venv 创建失败");
    expect(result.reason).toContain("python3-venv");
  });

  it("pip 安装失败（如版本不存在）→ ok=false 且带 stderr 摘要", async () => {
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "-m") return ok();
      if (call.cmd.endsWith("pip")) return fail("No matching distribution found for hermes-agent==9.9.9");
      return ok();
    });
    const runner = makeRunner(exec);
    const result = await runner.run({ runId: "r6", targetVersion: "9.9.9", instance: "", tasks });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("9.9.9");
    expect(result.reason).toContain("No matching distribution");
  });

  it("冒烟输出不可解析 → 记为该任务失败（不崩溃、不臆造成功）", async () => {
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "-m" || call.cmd.endsWith("pip")) return ok();
      return ok("not-json-garbage");
    });
    const runner = makeRunner(exec);
    const result = await runner.run({ runId: "r7", targetVersion: "2.0.0", instance: "", tasks });
    expect(result.ok).toBe(true);
    expect(result.metrics!.successRate).toBe(0);
    expect(result.metrics!.avgTokens).toBeNull(); // 全部失败 → 无 token 样本
  });
});
