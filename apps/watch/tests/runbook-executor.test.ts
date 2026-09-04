/**
 * runbook 执行器测试：快照前置 / 步骤顺序与审计 / 失败升级告警 /
 * 复验语义 / 内置 rb-cleanup-gateway 孤儿清理 / 自动触发防抖与熔断跳过。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor } from "@butler/adapter-hermes";
import type { ControlAck, Job, Result } from "@butler/contract";
import { createCore, type Core } from "@butler/core";
import { CircuitBreaker } from "../src/runbook/breaker.js";
import {
  createBuiltinRunbooks,
  findOrphanGatewayPids,
  ORPHAN_GATEWAY_PATTERNS,
  RB_CLEANUP_GATEWAY,
  RB_RECONNECT,
  RB_RESTART,
  RunbookExecutor,
  RUNBOOK_ACTOR,
  RUNBOOK_FAILED_KIND,
  RUNBOOK_STEP_ACTION,
  RUNBOOK_SKIPPED_ACTION,
  type RunbookControl,
  type RunbookDefinition,
} from "../src/runbook/executor.js";
import type { AlertPoster, GatewayAlertBody } from "../src/alert-forward.js";
import type { InspectionStage } from "../src/pipeline.js";

let tmp: string;
let core: Core;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-runbook-"));
  core = createCore({ home: tmp });
});

afterEach(() => {
  core.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** 可推进 fake 时钟（防抖 / 熔断窗口共用）。 */
class FakeClock {
  private t = 1_800_000_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function stageOf(id: string, status: "pass" | "fail" | "warn" | "skipped"): InspectionStage {
  return { id, label: id, async run() { return { id, status }; } };
}

function okJob(): Job {
  return { jobId: "job-1", kind: "snapshot", steps: [{ id: "copy-data", label: "拷贝数据", status: "passed" }] };
}

const ackOf = (action: "restart"): ControlAck => ({
  instanceId: "ins1",
  action,
  startedAt: "2026-08-20T00:00:00.000Z",
});

function makeControl(
  overrides: Partial<Record<"restart" | "snapshot", () => Promise<Result<Job | ControlAck>>>> &
    Partial<Record<"restore", () => Promise<Result<Job>>>> = {},
): RunbookControl {
  const base: RunbookControl = {
    restart: (overrides.restart ?? (async () => ({ ok: true, data: ackOf("restart"), durationMs: 5 }))) as RunbookControl["restart"],
    snapshot: (overrides.snapshot ?? (async () => ({ ok: true, data: okJob(), durationMs: 5 }))) as RunbookControl["snapshot"],
  };
  // restore 是可选能力：不传就当作控制面不支持还原，执行器必须优雅跳过而不是崩。
  if (overrides.restore !== undefined) base.restore = overrides.restore;
  return base;
}

interface Harness {
  executor: RunbookExecutor;
  breaker: CircuitBreaker;
  poster: AlertPoster;
  posts: GatewayAlertBody[];
  clock: FakeClock;
}

function makeHarness(
  defs: RunbookDefinition[],
  opts: { stages?: InspectionStage[]; control?: RunbookControl; debounceMs?: number } = {},
): Harness {
  const posts: GatewayAlertBody[] = [];
  const poster: AlertPoster = {
    post: async (body) => {
      posts.push(body);
    },
    flush: async () => {},
  };
  const clock = new FakeClock();
  const breaker = new CircuitBreaker({ now: () => clock.now() });
  const executor = new RunbookExecutor(
    {
      core,
      control: opts.control ?? makeControl({}),
      stages: opts.stages ?? [],
      breaker,
      poster,
      debounceMs: opts.debounceMs ?? 15 * 60 * 1000,
      now: () => clock.now(),
    },
    defs,
  );
  return { executor, breaker, poster, posts, clock };
}

const instance = { instanceId: "ins1", rootPath: "/opt/hermes", runtime: "process" as const };

function stepAudits(): Array<Record<string, unknown>> {
  // audit.list 最新在前（ORDER BY id DESC），反转回执行顺序。
  return core.audit
    .list({ action: RUNBOOK_STEP_ACTION, target: "ins1" })
    .map((a) => a.detail as Record<string, unknown>)
    .reverse();
}

describe("RunbookExecutor（执行规则）", () => {
  it("快照 → 有序步骤 → 复验：顺序执行、每步落审计、事件形态、成功无告警", async () => {
    const order: string[] = [];
    const def: RunbookDefinition = {
      id: "rb-x",
      label: "测试 runbook",
      steps: [
        { id: "s1", label: "一", async run() { order.push("s1"); return { status: "passed", detail: "ok1" }; } },
        { id: "s2", label: "二", async run() { order.push("s2"); return { status: "passed", detail: "ok2" }; } },
      ],
      verifyStageIds: ["memory-probe"],
    };
    const { executor, posts } = makeHarness([def], { stages: [stageOf("memory-probe", "pass")] });
    const result = await executor.runRunbook("rb-x", { trigger: "manual", reason: "面板触发", instance });

    expect(result.success).toBe(true);
    expect(order).toEqual(["s1", "s2"]);
    expect(result.steps.map((s) => s.id)).toEqual(["snapshot", "s1", "s2", "verify-memory-probe"]);
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);

    // 每步审计（actor runbook，含快照与复验步骤）
    const audits = stepAudits();
    expect(audits.map((d) => d["stepId"])).toEqual(["snapshot", "s1", "s2", "verify-memory-probe"]);

    // 事件形态
    const started = core.store.listEvents({ type: "runbook-started" });
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ runbookId: "rb-x", instanceId: "ins1", trigger: "manual", reason: "面板触发" });
    const completed = core.store.listEvents({ type: "runbook-completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ runbookId: "rb-x", instanceId: "ins1", success: true, durationMs: expect.any(Number) });

    expect(posts).toHaveLength(0); // 成功不告警
    expect(result.alertDedupeKey).toBeUndefined();
  });

  it("快照失败（!ok）→ 中止整个 runbook 记 failed + 升级 critical 告警", async () => {
    const ranSteps: string[] = [];
    const def: RunbookDefinition = {
      id: "rb-x",
      label: "",
      steps: [
        { id: "s1", label: "", async run() { ranSteps.push("s1"); return { status: "passed" }; } },
      ],
      verifyStageIds: [],
    };
    const { executor, posts } = makeHarness([def], {
      control: makeControl({
        snapshot: async () => ({
          ok: false,
          error: { code: "E002", message: "disk full", retryable: false },
          durationMs: 3,
        }),
      }),
    });
    const result = await executor.runRunbook("rb-x", { trigger: "auto", instance });

    expect(result.success).toBe(false);
    expect(ranSteps).toHaveLength(0); // 快照失败 → 后续步骤不执行
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ id: "snapshot", status: "failed" });
    expect(result.steps[0]!.detail).toContain("disk full");

    // 升级告警：critical / kind runbook-failed / dedupeKey 含 runbookId + 日期
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: RUNBOOK_FAILED_KIND, severity: "critical", source: "butler-watch" });
    expect(result.alertDedupeKey).toMatch(/^runbook-failed:rb-x:ins1:\d{4}-\d{2}-\d{2}$/);
    expect(posts[0]!.dedupeKey).toBe(result.alertDedupeKey);
    expect(posts[0]!.body).toContain("snapshot");
  });

  it("快照 Job 含 failed 步骤 → 同样中止", async () => {
    const def: RunbookDefinition = { id: "rb-x", label: "", steps: [], verifyStageIds: [] };
    const { executor, posts } = makeHarness([def], {
      control: makeControl({
        snapshot: async () => ({
          ok: true,
          data: { jobId: "j", kind: "snapshot", steps: [{ id: "copy", label: "拷贝", status: "failed" }] },
          durationMs: 3,
        }),
      }),
    });
    const result = await executor.runRunbook("rb-x", { trigger: "manual", instance });
    expect(result.success).toBe(false);
    expect(result.steps[0]!.detail).toContain("copy");
    expect(posts).toHaveLength(1);
  });

  it("步骤失败 → 终止后续步骤 + 升级告警 + 计入熔断（5 次后跳闸）", async () => {
    const def: RunbookDefinition = {
      id: "rb-x",
      label: "",
      steps: [
        { id: "s1", label: "", async run() { return { status: "passed" }; } },
        { id: "s2", label: "", async run() { return { status: "failed", detail: "重启超时" }; } },
        { id: "s3", label: "", async run() { return { status: "passed" }; } },
      ],
      verifyStageIds: [],
    };
    const { executor, posts, breaker, clock } = makeHarness([def]);
    const result = await executor.runRunbook("rb-x", { trigger: "auto", instance });

    expect(result.success).toBe(false);
    expect(result.steps.map((s) => s.id)).toEqual(["snapshot", "s1", "s2"]); // s3 不再执行
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toContain("s2");

    // 失败计入熔断：1 次未跳闸；手动再执行 4 次（手动入口不受拦截）→ 第 5 次失败跳闸
    expect(breaker.isTripped("rb-x:ins1")).toBe(false);
    for (let i = 0; i < 4; i++) {
      clock.advance(60_000);
      await executor.runRunbook("rb-x", { trigger: "manual", instance });
    }
    expect(breaker.isTripped("rb-x:ins1")).toBe(true);
  });

  it("复验 fail → 升级告警（kind runbook-failed）", async () => {
    const def: RunbookDefinition = {
      id: "rb-x",
      label: "",
      steps: [{ id: "s1", label: "", async run() { return { status: "passed" }; } }],
      verifyStageIds: ["channel-probe"],
    };
    const { executor, posts } = makeHarness([def], { stages: [stageOf("channel-probe", "fail")] });
    const result = await executor.runRunbook("rb-x", { trigger: "auto", instance });

    expect(result.success).toBe(false);
    expect(result.steps.map((s) => s.id)).toEqual(["snapshot", "s1", "verify-channel-probe"]);
    expect(result.steps[2]).toMatchObject({ status: "failed" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.kind).toBe(RUNBOOK_FAILED_KIND);
    expect(posts[0]!.severity).toBe("critical");
  });

  it("复验 warn → 记 skipped 不升级告警", async () => {
    const def: RunbookDefinition = {
      id: "rb-x",
      label: "",
      steps: [{ id: "s1", label: "", async run() { return { status: "passed" }; } }],
      verifyStageIds: ["stall-write"],
    };
    const { executor, posts } = makeHarness([def], { stages: [stageOf("stall-write", "warn")] });
    const result = await executor.runRunbook("rb-x", { trigger: "auto", instance });
    expect(result.success).toBe(true);
    expect(result.steps[2]).toMatchObject({ id: "verify-stall-write", status: "skipped" });
    expect(posts).toHaveLength(0);
  });

  it("未知 runbook → 抛错并列举已注册 id", async () => {
    const { executor } = makeHarness([]);
    await expect(executor.runRunbook("rb-nope", { trigger: "manual", instance })).rejects.toThrow(/未知 runbook/);
  });
});

describe("内置 rb-cleanup-gateway / 孤儿清理", () => {
  it("配置宿主清理器时不在容器内执行 pgrep 或 kill", async () => {
    const exec: CommandExecutor = {
      exec: async () => {
        throw new Error("不应在容器内执行清理命令");
      },
      spawnDetached: () => {},
    };
    const calls: string[] = [];
    const { executor } = makeHarness(createBuiltinRunbooks({
      control: makeControl({}),
      exec,
      cleanupOrphans: async () => {
        calls.push("host-cleanup");
        return { status: "passed", detail: "宿主已清理孤儿网关进程 pid 222" };
      },
    }), {
      stages: [stageOf("process-alive", "pass")],
    });

    const result = await executor.runRunbook(RB_CLEANUP_GATEWAY, { trigger: "manual", instance });
    expect(result.success).toBe(true);
    expect(calls).toEqual(["host-cleanup"]);
    expect(result.steps[1]).toMatchObject({ id: "cleanup-orphans", status: "passed", detail: expect.stringContaining("宿主") });
  });

  it("无孤儿进程 → 直接成功，不执行 kill", async () => {
    const execCalls: Array<[string, string[]]> = [];
    const exec: CommandExecutor = {
      exec: async (cmd, args) => {
        execCalls.push([cmd, args]);
        return { code: 1, stdout: "", stderr: "" }; // pgrep 无命中
      },
      spawnDetached: () => {},
    };
    const { executor, posts } = makeHarness(createBuiltinRunbooks({ control: makeControl({}), exec }), {
      stages: [stageOf("process-alive", "pass")],
    });
    const result = await executor.runRunbook(RB_CLEANUP_GATEWAY, { trigger: "manual", instance });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(["snapshot", "cleanup-orphans", "verify-process-alive"]);
    expect(result.steps[1]!.detail).toContain("无孤儿");
    expect(execCalls.every(([cmd]) => cmd === "pgrep")).toBe(true); // 只有探测，没有 kill
    expect(posts).toHaveLength(0);
  });

  it("有孤儿 → kill 孤儿 pid，保留 gateway.pid 记录的主进程", async () => {
    writeFileSync(join(tmp, "gateway.pid"), JSON.stringify({ pid: 111, kind: "hermes-gateway" }));
    const kills: string[] = [];
    const exec: CommandExecutor = {
      exec: async (cmd, args) => {
        if (cmd === "pgrep" && args[1] === ORPHAN_GATEWAY_PATTERNS[0]) {
          return { code: 0, stdout: "111\n222\n", stderr: "" };
        }
        if (cmd === "kill") {
          kills.push(args[0]!);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    const { executor } = makeHarness(createBuiltinRunbooks({ control: makeControl({}), exec }), {
      stages: [stageOf("process-alive", "pass")],
    });
    const result = await executor.runRunbook(RB_CLEANUP_GATEWAY, { trigger: "manual", instance });

    expect(result.success).toBe(true);
    expect(kills).toEqual(["222"]); // 主进程 111 不被杀
    expect(result.steps[1]!.detail).toContain("222");
  });

  it("findOrphanGatewayPids：gateway.pid 缺失时最小 pid 视为主进程（绝不误杀全部）", async () => {
    const exec: CommandExecutor = {
      exec: async (cmd, args) => {
        if (cmd === "pgrep" && args[1] === ORPHAN_GATEWAY_PATTERNS[0]) {
          return { code: 0, stdout: "111\n222\n333\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    const { orphans, mainPid } = await findOrphanGatewayPids(exec, tmp);
    expect(mainPid).toBe(111); // 最小 pid 为主
    expect(orphans).toEqual(["222", "333"]);
  });

  it("kill 孤儿失败 → 步骤失败并升级告警", async () => {
    writeFileSync(join(tmp, "gateway.pid"), JSON.stringify({ pid: 111 }));
    const exec: CommandExecutor = {
      exec: async (cmd, args) => {
        if (cmd === "pgrep" && args[1] === ORPHAN_GATEWAY_PATTERNS[0]) {
          return { code: 0, stdout: "111\n222\n", stderr: "" };
        }
        if (cmd === "kill") return { code: 1, stdout: "", stderr: "Operation not permitted" };
        return { code: 1, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    const { executor, posts } = makeHarness(createBuiltinRunbooks({ control: makeControl({}), exec }), {
      stages: [stageOf("process-alive", "pass")],
    });
    const result = await executor.runRunbook(RB_CLEANUP_GATEWAY, { trigger: "manual", instance });
    expect(result.success).toBe(false);
    expect(result.steps[1]).toMatchObject({ id: "cleanup-orphans", status: "failed" });
    expect(posts).toHaveLength(1);
  });
});

describe("autoTrigger（自动触发：熔断 + 防抖）", () => {
  const okDef = (): RunbookDefinition => ({
    id: "rb-x",
    label: "",
    steps: [{ id: "s1", label: "", async run() { return { status: "passed" }; } }],
    verifyStageIds: [],
  });

  it("正常自动执行；防抖窗口内第二次跳过；过窗后恢复", async () => {
    const { executor, clock } = makeHarness([okDef()]);
    const first = await executor.autoTrigger("rb-x", instance, "巡检 memory-probe fail");
    expect(first.skipped).toBe(false);
    expect(core.store.listEvents({ type: "runbook-started" })).toHaveLength(1);

    const second = await executor.autoTrigger("rb-x", instance, "巡检 memory-probe fail");
    expect(second).toMatchObject({ skipped: true, reason: "debounced" });
    expect(core.store.listEvents({ type: "runbook-started" })).toHaveLength(1);

    clock.advance(15 * 60 * 1000 + 1); // 越过默认防抖窗口
    const third = await executor.autoTrigger("rb-x", instance, "巡检 memory-probe fail");
    expect(third.skipped).toBe(false);
    expect(core.store.listEvents({ type: "runbook-started" })).toHaveLength(2);
  });

  it("熔断跳闸后自动触发一律跳过并记 audit", async () => {
    const { executor, breaker, clock } = makeHarness([okDef()]);
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      breaker.recordFailure("rb-x:ins1", "密集失败");
    }
    expect(breaker.isTripped("rb-x:ins1")).toBe(true);

    const outcome = await executor.autoTrigger("rb-x", instance, "巡检 fail");
    expect(outcome).toMatchObject({ skipped: true, reason: "circuit-breaker" });
    expect(core.store.listEvents({ type: "runbook-started" })).toHaveLength(0);

    const skipped = core.audit
      .list({ action: RUNBOOK_SKIPPED_ACTION, target: "ins1" })
      .filter((a) => a.actor === RUNBOOK_ACTOR);
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.detail as Record<string, unknown>)["reason"]).toBe("circuit-breaker");
  });
});

describe("内置 runbook 注册形态", () => {
  it("三条内置 runbook：id / 步骤 / 复验探针映射", () => {
    const defs = createBuiltinRunbooks({ control: makeControl({}) });
    expect(defs.map((d) => d.id)).toEqual([RB_RESTART, RB_RECONNECT, RB_CLEANUP_GATEWAY]);

    const restart = defs.find((d) => d.id === RB_RESTART)!;
    expect(restart.steps.map((s) => s.id)).toEqual(["restart"]);
    expect(restart.verifyStageIds).toEqual(["memory-probe", "channel-probe"]);

    const reconnect = defs.find((d) => d.id === RB_RECONNECT)!;
    expect(reconnect.steps.map((s) => s.id)).toEqual(["cleanup-orphans", "restart"]);
    expect(reconnect.verifyStageIds).toEqual(["channel-probe"]);

    const cleanup = defs.find((d) => d.id === RB_CLEANUP_GATEWAY)!;
    expect(cleanup.steps.map((s) => s.id)).toEqual(["cleanup-orphans"]);
    expect(cleanup.verifyStageIds).toEqual(["process-alive"]);
  });

  it("restart 步骤：control.restart 成功/失败映射步骤结论", async () => {
    const okDefs = createBuiltinRunbooks({ control: makeControl({}) });
    const { executor: okExecutor } = makeHarness(okDefs, {
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const okResult = await okExecutor.runRunbook(RB_RESTART, { trigger: "manual", instance });
    expect(okResult.success).toBe(true);
    expect(okResult.steps.map((s) => s.id)).toEqual(["snapshot", "restart", "verify-memory-probe", "verify-channel-probe"]);

    const failDefs = createBuiltinRunbooks({
      control: makeControl({
        restart: async () => ({
          ok: false,
          error: { code: "E202", message: "restart timeout", retryable: true },
          durationMs: 3,
        }),
      }),
    });
    const { executor: failExecutor, posts } = makeHarness(failDefs, {
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const failResult = await failExecutor.runRunbook(RB_RESTART, { trigger: "manual", instance });
    expect(failResult.success).toBe(false);
    expect(failResult.steps[1]).toMatchObject({ id: "restart", status: "failed", detail: expect.stringContaining("restart timeout") });
    expect(posts).toHaveLength(1);
  });
});

/**
 * 失败自动还原。
 *
 * 做了快照却还原不了，等于告诉用户"我保护了你"但其实保护不了。
 * 这组用例守住：能动过手就必须还原得回去；还原不了要如实写进步骤里。
 */
describe("RunbookExecutor 失败自动还原", () => {
  const failingRestart = () =>
    makeControl({
      restart: async () => ({
        ok: false,
        error: { code: "E202", message: "restart timeout", retryable: true },
        durationMs: 3,
      }),
    });

  it("动作失败且快照成功 → 自动还原，并记入步骤", async () => {
    let restoreCalls = 0;
    const control = failingRestart();
    control.restore = async () => {
      restoreCalls += 1;
      return {
        ok: true,
        data: { jobId: "rollback-1", kind: "rollback", steps: [{ id: "restore", label: "还原", status: "passed" }] },
        durationMs: 5,
      };
    };

    const { executor } = makeHarness(createBuiltinRunbooks({ control }), {
      control,
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const result = await executor.runRunbook(RB_RESTART, { trigger: "manual", instance });

    expect(result.success).toBe(false);
    expect(restoreCalls).toBe(1);
    const rollback = result.steps.find((step) => step.id === "rollback");
    expect(rollback).toMatchObject({ status: "passed" });
    expect(rollback?.detail).toContain("已自动还原");
  });

  it("还原失败 → 如实记录，并说明快照仍在", async () => {
    const control = failingRestart();
    control.restore = async () => ({
      ok: false,
      error: { code: "E204", message: "snapshot missing", retryable: false },
      durationMs: 2,
    });

    const { executor } = makeHarness(createBuiltinRunbooks({ control }), {
      control,
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const result = await executor.runRunbook(RB_RESTART, { trigger: "manual", instance });

    const rollback = result.steps.find((step) => step.id === "rollback");
    expect(rollback).toMatchObject({ status: "failed" });
    expect(rollback?.detail).toContain("快照仍然保留着");
  });

  it("快照本身失败 → 不做还原（压根没动过手）", async () => {
    let restoreCalls = 0;
    const control = makeControl({
      snapshot: async () => ({
        ok: false,
        error: { code: "E203", message: "snapshot failed", retryable: false },
        durationMs: 2,
      }),
    });
    control.restore = async () => {
      restoreCalls += 1;
      return { ok: true, data: okJob(), durationMs: 1 };
    };

    const { executor } = makeHarness(createBuiltinRunbooks({ control }), {
      control,
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const result = await executor.runRunbook(RB_RESTART, { trigger: "manual", instance });

    expect(result.success).toBe(false);
    expect(restoreCalls).toBe(0);
    expect(result.steps.find((step) => step.id === "rollback")).toBeUndefined();
  });

  it("控制面不支持还原 → 跳过而不是崩，也不假装补救过", async () => {
    const control = failingRestart(); // 没有 restore
    const { executor } = makeHarness(createBuiltinRunbooks({ control }), {
      control,
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const result = await executor.runRunbook(RB_RESTART, { trigger: "manual", instance });

    expect(result.success).toBe(false);
    expect(result.steps.find((step) => step.id === "rollback")).toBeUndefined();
  });

  it("执行成功 → 不做还原", async () => {
    let restoreCalls = 0;
    const control = makeControl({});
    control.restore = async () => {
      restoreCalls += 1;
      return { ok: true, data: okJob(), durationMs: 1 };
    };

    const { executor } = makeHarness(createBuiltinRunbooks({ control }), {
      control,
      stages: [stageOf("memory-probe", "pass"), stageOf("channel-probe", "pass")],
    });
    const result = await executor.runRunbook(RB_RESTART, { trigger: "manual", instance });

    expect(result.success).toBe(true);
    expect(restoreCalls).toBe(0);
  });
});
