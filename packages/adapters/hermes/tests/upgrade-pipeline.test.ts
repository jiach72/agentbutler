import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fail,
  ok,
  type ControlAck,
  type InstanceRef,
  type Job,
  type JobStep,
  type Result,
  type SnapshotRef,
  type SnapshotScope,
} from "@butler/contract";
import { SqliteStore } from "@butler/core";
import type { CommandExecutor, CommandResult } from "../src/control/executor.js";
import {
  createDefaultPullStrategy,
  createUpgradePipeline,
  type HealthVerifier,
  type PullStrategy,
  type UpgradeControl,
  type UpgradeJobView,
  type UpgradePipeline,
  type UpgradePipelineDeps,
  type UpgradeRunInput,
} from "../src/control/upgrade-pipeline.js";
import type {
  ApplyOutcome,
  DriftReport,
  PatchCallContext,
  PatchDefinition,
  PatchManager,
  PatchParams,
} from "../src/patches/index.js";

/* ------------------------------ 测试基础设施 ------------------------------ */

/** 轮询等待条件成立（后台 Job 收敛终态）。 */
async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** fake UpgradeControl：记录调用并可在 store 登记快照（模拟真实 takeSnapshot）。 */
class FakeControl implements UpgradeControl {
  readonly stopCalls: InstanceRef[] = [];
  startCalls = 0;
  readonly snapshotCalls: Array<{ include: string[]; label?: string }> = [];
  readonly rollbackCalls: Array<{ snapshotId: string }> = [];
  private snapshotCounter = 0;
  /** 覆盖 snapshot 返回（缺省：成功 + 登记快照行）。 */
  snapshotImpl: (scope: SnapshotScope) => Promise<Result<Job>> | undefined;
  /** 覆盖 rollback 返回（缺省：成功，子步骤全 passed）。 */
  rollbackImpl: (ref: SnapshotRef) => Promise<Result<Job>> | undefined;

  constructor(private readonly store: SqliteStore) {}

  async stop(instance: InstanceRef): Promise<Result<ControlAck>> {
    this.stopCalls.push(instance);
    return ok({
      instanceId: instance.instanceId,
      action: "stop",
      startedAt: new Date().toISOString(),
    });
  }

  async start(instance: InstanceRef): Promise<Result<ControlAck>> {
    this.startCalls += 1;
    return ok({
      instanceId: instance.instanceId,
      action: "start",
      startedAt: new Date().toISOString(),
    });
  }

  async snapshot(instance: InstanceRef, scope: SnapshotScope): Promise<Result<Job>> {
    this.snapshotCalls.push({ include: scope.include, label: scope.label });
    if (this.snapshotImpl) return this.snapshotImpl(scope);
    this.snapshotCounter += 1;
    const snapshotId = `snap-${this.snapshotCounter}`;
    this.store.insertSnapshot({
      instance: instance.instanceId,
      scope: { include: scope.include, snapshotId },
      label: scope.label,
    });
    return ok({
      jobId: `snapshot-job-${this.snapshotCounter}`,
      kind: "snapshot",
      steps: [
        { id: "copy-code", label: "复制 code", status: "passed" },
        { id: "copy-venv", label: "复制 venv", status: "passed" },
        { id: "copy-data", label: "复制 data", status: "passed" },
        { id: "register", label: "登记快照", status: "passed" },
      ],
    });
  }

  async rollback(_instance: InstanceRef, ref: SnapshotRef): Promise<Result<Job>> {
    this.rollbackCalls.push({ snapshotId: ref.snapshotId });
    if (this.rollbackImpl) return this.rollbackImpl(ref);
    return ok({
      jobId: `rollback-job-${this.rollbackCalls.length}`,
      kind: "rollback",
      steps: [
        { id: "locate", label: "定位快照", status: "passed" },
        { id: "check-state", label: "记录运行状态", status: "passed" },
        { id: "backup", label: "备份当前态", status: "passed" },
        { id: "restore-code", label: "恢复 code", status: "passed" },
        { id: "restore-venv", label: "恢复 venv", status: "passed" },
        { id: "restore-data", label: "恢复 data", status: "passed" },
      ],
    });
  }
}

/** fake PatchManager：登记表 + applied 状态 + 可编排 reapply 结果。 */
class FakePatchManager implements PatchManager {
  readonly detectCalls: string[] = [];
  readonly reapplyCalls: Array<{ patchId: string; params?: PatchParams; targetContent?: string }> =
    [];

  constructor(
    private readonly defIds: string[],
    private readonly applied: Record<string, PatchParams>,
    private readonly reapplyResult: (patchId: string) => Result<ApplyOutcome> = () =>
      ok({ status: "applied", targetPath: "<fake-target>", params: {} }),
  ) {}

  async apply(): Promise<Result<ApplyOutcome>> {
    return fail("E203", "fake patch manager does not support apply");
  }

  async reapply(
    patchId: string,
    params?: PatchParams,
    context?: PatchCallContext,
  ): Promise<Result<ApplyOutcome>> {
    this.reapplyCalls.push({ patchId, params, targetContent: context?.targetContent });
    return this.reapplyResult(patchId);
  }

  async detect(patchId: string): Promise<Result<DriftReport>> {
    this.detectCalls.push(patchId);
    const params = this.applied[patchId];
    if (params === undefined) {
      return ok({ patchId, status: "not-applied", diffs: [], checkedAt: new Date().toISOString() });
    }
    return ok({ patchId, status: "ok", params, diffs: [], checkedAt: new Date().toISOString() });
  }

  listPatches(): PatchDefinition[] {
    return this.defIds.map(
      (id) =>
        ({
          id,
          title: id,
          description: id,
          target: `hermes-agent/fake/${id}.py`,
          params: {},
          transformations: [],
        }) as PatchDefinition,
    );
  }
}

interface Harness {
  pipeline: UpgradePipeline;
  control: FakeControl;
  patches: FakePatchManager;
  emits: UpgradeJobView[];
  execCalls: Array<{ cmd: string; args: string[]; opts?: { timeoutMs?: number } }>;
  reads: string[];
  setVersion: (v: string | null) => void;
}

/* --------------------------------- fixture --------------------------------- */

let base: string;
let root: string;
let store: SqliteStore;
let snapshotsDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hermes-upgrade-"));
  root = join(base, "root");
  mkdirSync(join(root, "hermes-agent"), { recursive: true });
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  writeFileSync(join(root, "venv", "bin", "python"), "");
  store = new SqliteStore(join(base, "butler-test.db"));
  snapshotsDir = join(base, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const instance = (runtime: "process" | "docker" = "process"): InstanceRef => ({
  instanceId: "hermes-main",
  rootPath: root,
  runtime,
});

const input = (key: string, extra: Partial<UpgradeRunInput> = {}): UpgradeRunInput => ({
  instance: instance(),
  target: { version: "0.21.0" },
  idempotencyKey: key,
  ...extra,
});

/** 组装被测流水线：全部依赖注入 fake（零网络零真实进程）。 */
function makeHarness(
  overrides: {
    patchApplied?: Record<string, PatchParams>;
    reapplyResult?: (patchId: string) => Result<ApplyOutcome>;
    verify?: HealthVerifier;
    pull?: PullStrategy;
    version?: string | null;
    execImpl?: (cmd: string, args: string[]) => CommandResult;
    useDefaultPull?: boolean;
    deps?: Partial<UpgradePipelineDeps>;
  } = {},
): Harness {
  const control = new FakeControl(store);
  const patches = new FakePatchManager(
    ["wx-a", "wx-b"],
    overrides.patchApplied ?? {},
    overrides.reapplyResult,
  );
  const pyproject = join(root, "hermes-agent", "pyproject.toml");
  const targetFiles = new Map<string, string>([
    [join(root, "hermes-agent", "fake", "wx-a.py"), "# NEW OFFICIAL wx-a\n"],
    [join(root, "hermes-agent", "fake", "wx-b.py"), "# NEW OFFICIAL wx-b\n"],
  ]);
  const reads: string[] = [];
  let version: string | null = overrides.version === undefined ? "0.20.4" : overrides.version;
  const readFile = async (p: string): Promise<string> => {
    reads.push(p);
    if (p === pyproject) {
      if (version === null) throw new Error(`ENOENT: ${p}`);
      return `[project]\nname = "hermes-agent"\nversion = "${version}"\n`;
    }
    const hit = targetFiles.get(p);
    if (hit !== undefined) return hit;
    throw new Error(`ENOENT: ${p}`);
  };

  const emits: UpgradeJobView[] = [];
  const execCalls: Array<{ cmd: string; args: string[]; opts?: { timeoutMs?: number } }> = [];
  const execImpl =
    overrides.execImpl ?? ((): CommandResult => ({ code: 0, stdout: "", stderr: "" }));
  const fakeExec: CommandExecutor = {
    exec: async (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      return execImpl(cmd, args);
    },
    spawnDetached: () => {},
  };

  const simulatedPull: PullStrategy = async (ctx) => {
    if (version !== null) version = ctx.targetVersion; // 模拟拉取成功后 pyproject 版本更新
    return { ok: true, detail: "模拟拉取成功" };
  };

  const deps: UpgradePipelineDeps = {
    store,
    snapshotsDir,
    control,
    exec: fakeExec,
    patchManager: patches,
    readFile,
    emit: (v) => emits.push(v),
    verify: overrides.verify,
    ...overrides.deps,
  };
  if (!overrides.useDefaultPull) deps.pull = overrides.pull ?? simulatedPull;

  const pipeline = createUpgradePipeline(deps);
  return { pipeline, control, patches, emits, execCalls, reads, setVersion: (v) => (version = v) };
}

/* --------------------------------- 五步主流程 --------------------------------- */

describe("createUpgradePipeline 五步流水线", () => {
  it("五步全绿 → done：快照/停止/启动/补丁重打全执行，Job 落库", async () => {
    const h = makeHarness({ patchApplied: { "wx-a": { interval: 60 } } });
    const r = await h.pipeline.run(input("k-green"));
    expect(r.ok).toBe(true);
    const v = r.data!;
    expect(v.status).toBe("done");
    expect(v.rolledBack).toBeUndefined();
    expect(v.error).toBeUndefined();
    expect(v.finishedAt).toBeTruthy();
    expect(v.startedAt).toBeTruthy();
    expect(v.steps.map((s) => s.id)).toEqual(["precheck", "snapshot", "pull", "patches", "verify"]);
    expect(v.steps.every((s) => s.status === "passed")).toBe(true);
    expect(v.steps[4]!.detail).toContain("默认验收");
    expect(v.snapshotId).toBe("snap-1");

    // 控制序列：snapshot → stop →（拉取）→ start；未回滚。
    expect(h.control.snapshotCalls).toHaveLength(1);
    expect(h.control.snapshotCalls[0]).toEqual({
      include: ["code", "venv", "data"],
      label: "pre-upgrade",
    });
    expect(h.control.stopCalls).toHaveLength(1);
    expect(h.control.startCalls).toBe(1);
    expect(h.control.rollbackCalls).toHaveLength(0);

    // 补丁重打：按登记表探测 applied，reapply 携带升级后新官方原文与已存参数。
    expect(h.patches.detectCalls).toEqual(["wx-a", "wx-b"]);
    expect(h.patches.reapplyCalls).toHaveLength(1);
    expect(h.patches.reapplyCalls[0]!.patchId).toBe("wx-a");
    expect(h.patches.reapplyCalls[0]!.params).toEqual({ interval: 60 });
    expect(h.patches.reapplyCalls[0]!.targetContent).toBe("# NEW OFFICIAL wx-a\n");

    // pyproject 读取两次：预检一次 + 拉取后复核一次。
    expect(h.reads.filter((p) => p.endsWith("pyproject.toml"))).toHaveLength(2);

    // Job 行已落库并收敛 done。
    const row = store.findJobByIdempotencyKey("k-green");
    expect(row?.kind).toBe("upgrade");
    expect(row?.status).toBe("done");
    expect(row?.steps.map((s) => s.id)).toEqual([
      "precheck",
      "snapshot",
      "pull",
      "patches",
      "verify",
    ]);
  });

  it("步骤事件 emit 序列：running → passed 逐步推送，终态 done", async () => {
    const h = makeHarness();
    await h.pipeline.run(input("k-emit"));
    expect(h.emits.length).toBeGreaterThanOrEqual(11);

    // 相邻视图 diff 出的步骤状态迁移序列。
    const transitions: Array<[string, JobStep["status"]]> = [];
    for (let i = 1; i < h.emits.length; i += 1) {
      const prev = new Map(h.emits[i - 1]!.steps.map((s) => [s.id, s.status]));
      for (const s of h.emits[i]!.steps) {
        if (prev.get(s.id) !== s.status) transitions.push([s.id, s.status]);
      }
    }
    expect(transitions).toEqual([
      ["precheck", "running"],
      ["precheck", "passed"],
      ["snapshot", "running"],
      ["snapshot", "passed"],
      ["pull", "running"],
      ["pull", "passed"],
      ["patches", "running"],
      ["patches", "skipped"], // 无已登记补丁
      ["verify", "running"],
      ["verify", "passed"],
    ]);
    expect(h.emits[h.emits.length - 1]!.status).toBe("done");
    expect(h.emits[h.emits.length - 1]!.finishedAt).toBeTruthy();
    expect(h.emits[0]!.status).toBe("running");
  });

  it("手工 observed 补丁不纳入升级重打，补丁步骤保持 skipped", async () => {
    const reapplyCalls: string[] = [];
    const observedManager: PatchManager = {
      apply: async () => fail("E203", "not used"),
      reapply: async (patchId) => {
        reapplyCalls.push(patchId);
        return ok({ status: "applied", targetPath: "<unused>", params: {} });
      },
      detect: async (patchId) =>
        ok({
          patchId,
          status: "observed",
          params: { interval: 30 },
          targetPath: join(root, "hermes-agent", "fake", `${patchId}.py`),
          diffs: [],
          checkedAt: new Date().toISOString(),
        }),
      listPatches: () => [
        {
          id: "wx-manual",
          title: "wx-manual",
          description: "manual",
          target: "hermes-agent/fake/wx-manual.py",
          params: {},
          transformations: [],
        },
      ],
      state: async () => ({}),
    };
    const h = makeHarness({ deps: { patchManager: observedManager } });
    const r = await h.pipeline.run(input("k-observed"));

    expect(r.ok).toBe(true);
    expect(r.data!.status).toBe("done");
    expect(r.data!.steps.find((step) => step.id === "patches")).toMatchObject({
      status: "skipped",
      detail: "无已登记补丁",
    });
    expect(reapplyCalls).toEqual([]);
  });

  it("dry-run：只跑 precheck，其余四步 skipped，无任何实例副作用", async () => {
    const h = makeHarness({ patchApplied: { "wx-a": {} } });
    const r = await h.pipeline.run(input("k-dry", { dryRun: true }));
    expect(r.ok).toBe(true);
    const v = r.data!;
    expect(v.status).toBe("done");
    expect(v.steps[0]!.status).toBe("passed");
    for (const step of v.steps.slice(1)) {
      expect(step.status).toBe("skipped");
      expect(step.detail).toBe("dry-run");
    }
    expect(v.snapshotId).toBeUndefined();
    expect(h.control.snapshotCalls).toHaveLength(0);
    expect(h.control.stopCalls).toHaveLength(0);
    expect(h.control.startCalls).toBe(0);
    expect(h.patches.detectCalls).toHaveLength(0);
  });

  it("docker 形态：precheck 不要求 venv，pull 后跳过本地版本复核", async () => {
    rmSync(join(root, "venv"), { recursive: true, force: true });
    const h = makeHarness({ pull: async () => ({ ok: true, detail: "docker pull 完成" }) });
    const r = await h.pipeline.run({
      instance: instance("docker"),
      target: { version: "0.21.0" },
      idempotencyKey: "k-docker",
    });
    expect(r.ok).toBe(true);
    expect(r.data!.status).toBe("done");
    expect(r.data!.steps[2]!.detail).toContain("docker 形态");
  });

  it("缺幂等键或目标版本 → E002", async () => {
    const h = makeHarness();
    const noKey = h.pipeline.start({ ...input(""), idempotencyKey: "" });
    expect(noKey.ok).toBe(false);
    expect(noKey.error!.code).toBe("E002");
    const noVersion = h.pipeline.start({ ...input("k2"), target: { version: "" } });
    expect(noVersion.ok).toBe(false);
    expect(noVersion.error!.code).toBe("E002");
  });
});

/* --------------------------------- 失败与回滚 --------------------------------- */

describe("失败终止与自动回滚", () => {
  it("precheck 失败（已是目标版本）→ 终止且无副作用不回滚", async () => {
    const h = makeHarness({ version: "0.21.0" }); // 当前版本 == 目标版本
    const r = await h.pipeline.run(input("k-precheck"));
    expect(r.ok).toBe(true);
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.steps[0]!.status).toBe("failed");
    expect(v.steps[0]!.detail).toContain("已是目标版本");
    // 其余四步保持 pending（未执行）。
    for (const step of v.steps.slice(1)) expect(step.status).toBe("pending");
    expect(v.error).toContain("环境预检未通过");
    expect(h.control.snapshotCalls).toHaveLength(0);
    expect(h.control.stopCalls).toHaveLength(0);
    expect(h.control.rollbackCalls).toHaveLength(0);
    expect(store.listSnapshots("hermes-main")).toHaveLength(0);
  });

  it("precheck 失败（缺 rootPath / 无 pyproject）→ 终止且无副作用", async () => {
    const h = makeHarness({ version: null });
    const noRoot = await h.pipeline.run({
      instance: { instanceId: "hermes-main" },
      target: { version: "0.21.0" },
      idempotencyKey: "k-noroot",
    });
    expect(noRoot.data!.steps[0]!.detail).toContain("根路径");

    const r = await h.pipeline.run(input("k-nopyproject"));
    expect(r.data!.status).toBe("failed");
    expect(r.data!.steps[0]!.detail).toContain("pyproject");
    expect(h.control.snapshotCalls).toHaveLength(0);
  });

  it("snapshot 失败（fail 结果）→ 终止，不进入 pull 不回滚", async () => {
    const h = makeHarness();
    h.control.snapshotImpl = async () => fail("E203", "disk full", { userHint: "磁盘空间不足" });
    const r = await h.pipeline.run(input("k-snapfail"));
    expect(r.data!.status).toBe("failed");
    expect(r.data!.steps[1]!.status).toBe("failed");
    expect(r.data!.steps[1]!.detail).toContain("磁盘空间不足");
    for (const step of r.data!.steps.slice(2)) expect(step.status).toBe("pending");
    expect(h.control.stopCalls).toHaveLength(0);
    expect(h.control.rollbackCalls).toHaveLength(0);
    expect(r.data!.rolledBack).toBeUndefined();
  });

  it("snapshot 子步骤失败 → 同样终止", async () => {
    const h = makeHarness();
    h.control.snapshotImpl = async () =>
      ok({
        jobId: "snapshot-job-x",
        kind: "snapshot",
        steps: [
          { id: "copy-code", label: "复制 code", status: "passed" },
          { id: "copy-venv", label: "复制 venv", status: "failed", detail: "权限不足" },
        ],
      });
    const r = await h.pipeline.run(input("k-snapsub"));
    expect(r.data!.status).toBe("failed");
    expect(r.data!.steps[1]!.detail).toContain("copy-venv");
    expect(h.control.stopCalls).toHaveLength(0);
  });

  it("pull 失败 → 自动回滚：rollback 被调用、rolledBack=true、现场目录注明", async () => {
    const h = makeHarness({ pull: async () => ({ ok: false, detail: "git checkout 冲突" }) });
    const r = await h.pipeline.run(input("k-pullfail"));
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.steps[2]!.status).toBe("failed");
    expect(v.steps[2]!.detail).toContain("git checkout 冲突");
    expect(v.rolledBack).toBe(true);
    expect(h.control.rollbackCalls).toEqual([{ snapshotId: "snap-1" }]);
    const rollbackStep = v.steps.find((s) => s.id === "rollback");
    expect(rollbackStep).toBeDefined();
    expect(rollbackStep!.status).toBe("passed");
    expect(rollbackStep!.detail).toContain("snap-1.pre-rollback");
    expect(rollbackStep!.detail).toContain("restore-code:passed");
    expect(v.error).toContain("已自动回滚");
    // verify 未执行。
    expect(v.steps.find((s) => s.id === "verify")!.status).toBe("pending");
  });

  it("拉取后版本未达标 → pull 失败并回滚", async () => {
    const h = makeHarness({
      pull: async () => ({ ok: true, detail: "拉取命令成功但版本未变" }), // 不翻转版本
    });
    const r = await h.pipeline.run(input("k-stale"));
    expect(r.data!.status).toBe("failed");
    expect(r.data!.steps[2]!.detail).toContain("未达到目标");
    expect(r.data!.rolledBack).toBe(true);
  });

  it("补丁冲突（reapply 失败）→ failed + 自动回滚", async () => {
    const h = makeHarness({
      patchApplied: { "wx-a": { interval: 60 } },
      reapplyResult: () => fail("E203", "anchor not found", { userHint: "第 1 处锚点未找到" }),
    });
    const r = await h.pipeline.run(input("k-conflict"));
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.steps[3]!.status).toBe("failed");
    expect(v.steps[3]!.detail).toContain("wx-a");
    expect(v.steps[3]!.detail).toContain("锚点未找到");
    expect(v.rolledBack).toBe(true);
    expect(h.control.rollbackCalls).toEqual([{ snapshotId: "snap-1" }]);
  });

  it("verify 失败（注入 HealthVerifier）→ 回滚", async () => {
    const h = makeHarness({ verify: async () => ({ ok: false, detail: "API 探活失败" }) });
    const r = await h.pipeline.run(input("k-verifyfail"));
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.steps[4]!.status).toBe("failed");
    expect(v.steps[4]!.detail).toContain("API 探活失败");
    expect(v.rolledBack).toBe(true);
    expect(h.control.startCalls).toBe(1);
    expect(h.control.rollbackCalls).toEqual([{ snapshotId: "snap-1" }]);
  });

  it("回滚本身失败 → failed 且提示需人工介入", async () => {
    const h = makeHarness({ pull: async () => ({ ok: false, detail: "拉取失败" }) });
    h.control.rollbackImpl = async () =>
      fail("E204", "snapshot missing", { userHint: "目标快照不存在" });
    const r = await h.pipeline.run(input("k-rbfail"));
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.rolledBack).toBeUndefined();
    const rollbackStep = v.steps.find((s) => s.id === "rollback")!;
    expect(rollbackStep.status).toBe("failed");
    expect(rollbackStep.detail).toContain("目标快照不存在");
    expect(v.error).toContain("回滚失败，需人工介入");
  });

  it("skipSnapshot：快照步 skipped，后续失败不回滚仅告警", async () => {
    const h = makeHarness({ pull: async () => ({ ok: false, detail: "拉取失败" }) });
    const r = await h.pipeline.run(input("k-skip", { skipSnapshot: true }));
    const v = r.data!;
    expect(v.status).toBe("failed");
    expect(v.steps[1]!.status).toBe("skipped");
    expect(v.snapshotId).toBeUndefined();
    expect(v.rolledBack).toBeUndefined();
    const rollbackStep = v.steps.find((s) => s.id === "rollback")!;
    expect(rollbackStep.status).toBe("skipped");
    expect(rollbackStep.detail).toContain("无法自动回滚");
    expect(h.control.rollbackCalls).toHaveLength(0);
    expect(h.control.snapshotCalls).toHaveLength(0);
  });
});

/* --------------------------------- 幂等与互斥 --------------------------------- */

describe("幂等与并发互斥", () => {
  it("幂等键复用：同键第二次 run 返回已存视图且不再执行", async () => {
    const h = makeHarness();
    const first = await h.pipeline.run(input("k-idem"));
    expect(first.data!.status).toBe("done");
    const second = await h.pipeline.run(input("k-idem"));
    expect(second.ok).toBe(true);
    expect(second.data!.jobId).toBe(first.data!.jobId);
    expect(second.data!.status).toBe("done");
    expect(h.control.snapshotCalls).toHaveLength(1); // 未重复执行
    expect(store.listJobs({ instance: "hermes-main", status: "done" })).toHaveLength(1);
  });

  it("跨流水线实例（共用 store）幂等：命中已存 Job 行不执行", async () => {
    const h1 = makeHarness();
    const first = await h1.pipeline.run(input("k-cross"));
    expect(first.data!.status).toBe("done");

    const control2 = new FakeControl(store);
    const patches2 = new FakePatchManager(["wx-a", "wx-b"], {}, undefined as never);
    const pipeline2 = createUpgradePipeline({
      store,
      snapshotsDir,
      control: control2,
      patchManager: patches2,
      readFile: async () => {
        throw new Error("should not read");
      },
    });
    const again = await pipeline2.run(input("k-cross"));
    expect(again.ok).toBe(true);
    expect(again.data!.jobId).toBe(first.data!.jobId);
    expect(again.data!.status).toBe("done");
    expect(again.data!.snapshotId).toBe("snap-1");
    expect(control2.snapshotCalls).toHaveLength(0);
  });

  it("并发第二个 start → E202 升级进行中；同键 start 返回同一视图", async () => {
    let releasePull!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const h = makeHarness({
      pull: async (ctx) => {
        await gate;
        h.setVersion(ctx.targetVersion);
        return { ok: true, detail: "门闩拉取" };
      },
    });
    const first = h.pipeline.start(input("k-a"));
    expect(first.ok).toBe(true);

    const second = h.pipeline.start(input("k-b"));
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe("E202");
    expect(second.error!.userHint).toContain("升级进行中");

    const sameKey = h.pipeline.start(input("k-a"));
    expect(sameKey.ok).toBe(true);
    expect(sameKey.data!.jobId).toBe(first.data!.jobId);

    releasePull();
    await waitUntil(() => h.pipeline.status()?.status !== "running");
    expect(h.pipeline.status()!.status).toBe("done");
    // k-b 未落库（被互斥拒绝）。
    expect(store.findJobByIdempotencyKey("k-b")).toBeUndefined();
  });
});

/* ------------------------------ 默认拉取策略 ------------------------------ */

describe("createDefaultPullStrategy", () => {
  function recordingExec(
    handlers: Array<{ match: (cmd: string, args: string[]) => boolean; run: () => CommandResult }>,
  ): { executor: CommandExecutor; calls: Array<{ cmd: string; args: string[] }> } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const executor: CommandExecutor = {
      exec: async (cmd, args) => {
        calls.push({ cmd, args });
        const handler = handlers.find((h) => h.match(cmd, args));
        return handler ? handler.run() : { code: 0, stdout: "", stderr: "" };
      },
      spawnDetached: () => {},
    };
    return { executor, calls };
  }

  it("git 仓库：fetch --tags + checkout v<version>（v 失败回退裸版本）", async () => {
    mkdirSync(join(root, "hermes-agent", ".git"), { recursive: true });
    const agentDir = join(root, "hermes-agent");
    const { executor, calls } = recordingExec([
      {
        match: (cmd, args) =>
          cmd === "git" && args.includes("checkout") && args.includes("v0.21.0"),
        run: () => ({ code: 1, stdout: "", stderr: "pathspec 'v0.21.0' did not match" }),
      },
    ]);
    const outcome = await createDefaultPullStrategy()({
      instance: instance(),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("git");
    expect(calls).toEqual([
      { cmd: "git", args: ["-C", agentDir, "fetch", "--tags"] },
      { cmd: "git", args: ["-C", agentDir, "checkout", "v0.21.0"] },
      { cmd: "git", args: ["-C", agentDir, "checkout", "0.21.0"] },
    ]);
  });

  it("git fetch 失败 → ok:false 附 stderr", async () => {
    mkdirSync(join(root, "hermes-agent", ".git"), { recursive: true });
    const { executor } = recordingExec([
      {
        match: (cmd) => cmd === "git",
        run: () => ({ code: 128, stdout: "", stderr: "fatal: not a git repo" }),
      },
    ]);
    const outcome = await createDefaultPullStrategy()({
      instance: instance(),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("git fetch --tags 失败");
    expect(outcome.detail).toContain("fatal: not a git repo");
  });

  it("非 git 仓库：venv pip install --upgrade <pkg>==<version>", async () => {
    const { executor, calls } = recordingExec([]);
    const outcome = await createDefaultPullStrategy({ pipPackage: "hermes-agent" })({
      instance: instance(),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([
      {
        cmd: join(root, "venv", "bin", "python"),
        args: ["-m", "pip", "install", "--upgrade", "hermes-agent==0.21.0"],
      },
    ]);
  });

  it("pip 失败 → ok:false 附 stderr", async () => {
    const { executor } = recordingExec([
      {
        match: (cmd) => cmd === join(root, "venv", "bin", "python"),
        run: () => ({ code: 1, stdout: "", stderr: "No matching distribution" }),
      },
    ]);
    const outcome = await createDefaultPullStrategy()({
      instance: instance(),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("pip install hermes-agent==0.21.0 失败");
    expect(outcome.detail).toContain("No matching distribution");
  });

  it("docker 形态：docker pull <image>:<version>", async () => {
    const { executor, calls } = recordingExec([]);
    const outcome = await createDefaultPullStrategy({ dockerImage: "hermes-agent/hermes" })({
      instance: instance("docker"),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "docker", args: ["pull", "hermes-agent/hermes:0.21.0"] }]);
  });

  it("无 venv 且非 git → ok:false 说明缺 venv Python", async () => {
    rmSync(join(root, "venv"), { recursive: true, force: true });
    const { executor } = recordingExec([]);
    const outcome = await createDefaultPullStrategy()({
      instance: instance(),
      rootPath: root,
      targetVersion: "0.21.0",
      exec: executor,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("未找到 venv Python");
  });
});

/* ---------------------------- 流水线默认拉取接线 ---------------------------- */

describe("流水线与默认拉取策略接线", () => {
  it("默认策略经流水线执行：git 路径生效，命令超时施加长操作纪律（1800s）", async () => {
    mkdirSync(join(root, "hermes-agent", ".git"), { recursive: true });
    const h = makeHarness({
      useDefaultPull: true,
      execImpl: (cmd, args) => {
        if (cmd === "git" && args.includes("checkout")) h.setVersion("0.21.0"); // checkout 成功 → 版本更新
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const r = await h.pipeline.run(input("k-default-pull"));
    expect(r.ok).toBe(true);
    expect(r.data!.status).toBe("done");
    expect(r.data!.steps[2]!.status).toBe("passed");
    // 命令序列：git fetch --tags → git checkout v0.21.0；超时缺省 1800s。
    const cmds = h.execCalls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    expect(cmds[0]).toContain("git");
    expect(cmds[0]).toContain("fetch --tags");
    expect(cmds[1]).toContain("checkout v0.21.0");
    expect(h.execCalls.every((c) => c.opts?.timeoutMs === 1_800_000)).toBe(true);
  });
});
