/**
 * Hermes 升级流水线（Task 13.1 五步 Job 状态机 + 13.2 自动回滚）。
 *
 * 五步固定顺序（JobStep.id 固定，label 中文）：
 * 1. precheck  环境预检（rootPath 可解析 / hermes-agent 存在 / 当前版本 ≠ 目标 /
 *              进程形态需 venv Python）；失败无副作用不回滚；dry-run 只跑本步。
 * 2. snapshot  升级前全量快照（code/venv/data，label "pre-upgrade"）；
 *              失败即终止不回滚；skipSnapshot 时跳过（后续失败仅告警）。
 * 3. pull      停止实例 → 拉取策略（git / venv pip / docker pull）→ 复核新版本。
 * 4. patches   补丁重打与冲突检测（对已应用补丁按升级后新官方原文 reapply）。
 * 5. verify    启动实例 → 健康验收（可注入 HealthVerifier）。
 *
 * 第 3/4/5 步失败且存在升级前快照 → 追加 rollback 步骤自动回滚（rollbackSnapshot
 * 自带 .pre-rollback 当前态现场备份，detail 注明现场目录）；回滚失败 → 提示人工介入。
 *
 * 纪律约束（discipline.ts long-op 行）：1800s 长操作超时；以 idempotencyKey 幂等
 * （同键返回同一 Job 视图，不再执行）；同一时刻仅允许一个 running 升级（E202）。
 * 每步状态变化落库（store.updateJob）并经 emit 回调推送；全链路 Result 包装不抛异常。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fail,
  ok,
  type ControlAck,
  type ConfigValidation,
  type InstanceRef,
  type Job,
  type JobStep,
  type Result,
  type SnapshotRef,
  type SnapshotScope,
  type VersionRef,
} from "@butler/contract";
import type { JobRow, SqliteStore } from "@butler/core";
import { parseRootPath } from "../capability-scan.js";
import { findVenvPython, parsePyprojectVersion } from "../detect.js";
import { createPatchManager, normalizeRel, type PatchManager } from "../patches/applier.js";
import type { PatchParams } from "../patches/registry.js";
import { createExecFileExecutor, type CommandExecutor } from "./executor.js";
import { sanitizeSegment } from "./snapshot.js";

export type UpgradeJobStatus = "running" | "done" | "failed";

export interface UpgradeJobView {
  jobId: string;
  instanceId: string;
  targetVersion: string;
  channel?: "stable" | "beta";
  trigger: "manual" | "auto";
  status: UpgradeJobStatus;
  /** 五步：precheck/snapshot/pull/patches/verify（id 固定）；回滚时追加 rollback 步骤。 */
  steps: JobStep[];
  /** 第二步快照 id（自动回滚目标；skipSnapshot 时缺失）。 */
  snapshotId?: string;
  startedAt: string;
  finishedAt?: string;
  rolledBack?: boolean;
  /** 失败原因摘要。 */
  error?: string;
}

/** 健康验收函数：升级第 5 步在实例启动后调用；缺省实现为"启动就绪即通过"。 */
export type HealthVerifier = (ctx: { instance: InstanceRef; rootPath: string }) => Promise<{
  ok: boolean;
  detail?: string;
}>;

/** 升级流水线对实例控制面的最小依赖（由 control 门面闭包提供）。 */
export interface UpgradeControl {
  stop(instance: InstanceRef, opts?: { timeoutSec?: number }): Promise<Result<ControlAck>>;
  start(instance: InstanceRef, opts?: { timeoutSec?: number }): Promise<Result<ControlAck>>;
  snapshot(instance: InstanceRef, scope: SnapshotScope): Promise<Result<Job>>;
  rollback(instance: InstanceRef, ref: SnapshotRef): Promise<Result<Job>>;
  validateConfig?(instance: InstanceRef): Promise<Result<ConfigValidation>>;
}

export interface PullOutcome {
  ok: boolean;
  detail: string;
}

/** 拉取策略：按 runtime 形态执行 git / venv pip / docker 拉取。 */
export type PullStrategy = (ctx: {
  instance: InstanceRef;
  rootPath: string;
  targetVersion: string;
  exec: CommandExecutor;
}) => Promise<PullOutcome>;

export interface UpgradePipelineDeps {
  store: SqliteStore;
  snapshotsDir: string;
  control: UpgradeControl;
  /** 缺省 createExecFileExecutor()。 */
  exec?: CommandExecutor;
  /** 缺省 createPatchManager()（patchesDir = <BUTLER_HOME>/patches）。 */
  patchManager?: PatchManager;
  /** 缺省 node:fs/promises readFile utf8（读 pyproject.toml / 补丁目标文件）。 */
  readFile?: (p: string) => Promise<string>;
  /** 缺省：start 就绪即通过（detail 注明"默认验收：启动就绪即通过"）。 */
  verify?: HealthVerifier;
  /** 每次步骤状态变化回调（watch 接事件总线；缺省 no-op）。 */
  emit?: (view: UpgradeJobView) => void;
  /** 缺省 createDefaultPullStrategy()。 */
  pull?: PullStrategy;
  /** venv pip 包名，默认 "hermes-agent"。 */
  pipPackage?: string;
  /** docker 镜像，默认 "hermes-agent/hermes"。 */
  dockerImage?: string;
  now?: () => number;
  /** 拉取命令超时（毫秒），默认 1800s（长操作纪律）。 */
  commandTimeoutMs?: number;
}

export interface UpgradePipeline {
  /** 立即返回初始视图（Job 行已落库），后台执行；进度经 emit 推送。 */
  start(input: UpgradeRunInput): Result<UpgradeJobView>;
  /** 等待收敛到终态（测试/同步场景）。 */
  run(input: UpgradeRunInput): Promise<Result<UpgradeJobView>>;
  /** 当前 running 或最近一次的视图。 */
  status(): UpgradeJobView | null;
}

export interface UpgradeRunInput {
  instance: InstanceRef;
  target: VersionRef;
  idempotencyKey: string;
  trigger?: "manual" | "auto";
  skipSnapshot?: boolean;
  dryRun?: boolean;
}

/* ------------------------------ 步骤常量与工具 ------------------------------ */

const STEP_IDS = ["precheck", "snapshot", "pull", "patches", "verify"] as const;
type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  precheck: "环境预检",
  snapshot: "升级前快照",
  pull: "拉取升级",
  patches: "补丁重打与冲突检测",
  verify: "健康验收",
};

const ROLLBACK_LABEL = "自动回滚到升级前快照";

/** 默认健康验收：启动就绪即通过。 */
const defaultHealthVerifier: HealthVerifier = async () => ({
  ok: true,
  detail: "默认验收：启动就绪即通过",
});

/* ---------------------------- 默认拉取策略（Task 13.1） ---------------------------- */

/**
 * 默认拉取策略：
 * - runtime=process 且 <rootPath>/hermes-agent/.git 存在 → git fetch --tags +
 *   git checkout v<version>（失败回退裸 <version>）；
 * - runtime=process 且无 .git → venv Python pip install --upgrade <pkg>==<version>；
 * - runtime=docker → docker pull <image>:<version>。
 * 全部命令经注入的 CommandExecutor 执行（超时由流水线包装统一施加）。
 */
export function createDefaultPullStrategy(options?: {
  pipPackage?: string;
  dockerImage?: string;
}): PullStrategy {
  const pipPackage = options?.pipPackage ?? "hermes-agent";
  const dockerImage = options?.dockerImage ?? "hermes-agent/hermes";
  return async ({ instance, rootPath, targetVersion, exec }) => {
    if (instance.runtime === "docker") {
      const r = await exec.exec("docker", ["pull", `${dockerImage}:${targetVersion}`]);
      return r.code === 0
        ? { ok: true, detail: `docker pull ${dockerImage}:${targetVersion} 完成` }
        : {
            ok: false,
            detail: `docker pull ${dockerImage}:${targetVersion} 失败（退出码 ${r.code}）：${r.stderr.trim()}`,
          };
    }
    const agentDir = join(rootPath, "hermes-agent");
    if (existsSync(join(agentDir, ".git"))) {
      const fetch = await exec.exec("git", ["-C", agentDir, "fetch", "--tags"]);
      if (fetch.code !== 0) {
        return {
          ok: false,
          detail: `git fetch --tags 失败（退出码 ${fetch.code}）：${fetch.stderr.trim()}`,
        };
      }
      let checkout = await exec.exec("git", ["-C", agentDir, "checkout", `v${targetVersion}`]);
      if (checkout.code !== 0) {
        // tag 命名无 v 前缀的仓库：回退裸版本号。
        checkout = await exec.exec("git", ["-C", agentDir, "checkout", targetVersion]);
      }
      if (checkout.code !== 0) {
        return {
          ok: false,
          detail: `git checkout v${targetVersion}（及裸 ${targetVersion}）均失败（退出码 ${checkout.code}）：${checkout.stderr.trim()}`,
        };
      }
      return { ok: true, detail: `git fetch --tags + checkout ${targetVersion} 完成` };
    }
    const venvPython = findVenvPython(rootPath);
    if (!venvPython) {
      return { ok: false, detail: `未找到 venv Python（${rootPath}），无法执行 pip 升级` };
    }
    const pip = await exec.exec(join(rootPath, venvPython), [
      "-m",
      "pip",
      "install",
      "--upgrade",
      `${pipPackage}==${targetVersion}`,
    ]);
    return pip.code === 0
      ? { ok: true, detail: `pip install --upgrade ${pipPackage}==${targetVersion} 完成` }
      : {
          ok: false,
          detail: `pip install ${pipPackage}==${targetVersion} 失败（退出码 ${pip.code}）：${pip.stderr.trim()}`,
        };
  };
}

/* --------------------------------- 流水线主体 --------------------------------- */

export function createUpgradePipeline(deps: UpgradePipelineDeps): UpgradePipeline {
  const control = deps.control;
  const exec = deps.exec ?? createExecFileExecutor();
  const patchManager = deps.patchManager ?? createPatchManager();
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const verifyFn = deps.verify ?? defaultHealthVerifier;
  const emit = deps.emit ?? (() => {});
  const pullStrategy =
    deps.pull ??
    createDefaultPullStrategy({ pipPackage: deps.pipPackage, dockerImage: deps.dockerImage });
  const now = deps.now ?? Date.now;
  const commandTimeoutMs = deps.commandTimeoutMs ?? 1_800_000;

  /** 拉取命令执行器包装：未显式传超时的命令统一施加长操作超时纪律。 */
  const pullExec: CommandExecutor = {
    exec: (cmd, args, opts) =>
      exec.exec(cmd, args, { timeoutMs: opts?.timeoutMs ?? commandTimeoutMs }),
    spawnDetached: (cmd, args) => exec.spawnDetached(cmd, args),
  };

  /** idempotencyKey → 最近视图（进程内幂等缓存）。 */
  const views = new Map<string, UpgradeJobView>();
  let current: UpgradeJobView | null = null;
  let active: { key: string; promise: Promise<UpgradeJobView> } | null = null;

  function iso(ts: number): string {
    return new Date(ts).toISOString();
  }

  /** 视图深拷贝（emit / 返回值不与内部状态别名）。 */
  function copyView(view: UpgradeJobView): UpgradeJobView {
    return { ...view, steps: view.steps.map((s) => ({ ...s })) };
  }

  /** 由步骤状态推导 Job 状态：未收敛 running；任一 failed → failed；否则 done。 */
  function statusOf(view: UpgradeJobView): UpgradeJobStatus {
    if (view.finishedAt === undefined) return "running";
    return view.steps.some((s) => s.status === "failed") ? "failed" : "done";
  }

  /** 落库 + 推送（每次步骤状态变化调用）。 */
  function persist(view: UpgradeJobView): void {
    view.status = statusOf(view);
    deps.store.updateJob(view.jobId, { status: view.status, steps: view.steps });
    emit(copyView(view));
  }

  function setStep(
    view: UpgradeJobView,
    id: string,
    status: JobStep["status"],
    detail?: string,
  ): void {
    const step = view.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    persist(view);
  }

  /** 读取当前版本：hermes-agent/pyproject.toml 的 version 声明；缺失/异常返回 null。 */
  async function readCurrentVersion(rootPath: string | null): Promise<string | null> {
    if (!rootPath) return null;
    try {
      return parsePyprojectVersion(
        await readFile(join(rootPath, "hermes-agent", "pyproject.toml")),
      );
    } catch {
      return null;
    }
  }

  /** 从 Job 行重建视图（跨进程/跨流水线实例的幂等命中）。 */
  function viewFromRow(row: JobRow, input: UpgradeRunInput): UpgradeJobView {
    const snapshotId = row.steps
      .find((s) => s.id === "snapshot" && s.status === "passed")
      ?.detail?.match(/snapshotId=([^\s（(；;]+)/)?.[1];
    const rollbackStep = row.steps.find((s) => s.id === "rollback");
    const failedStep = row.steps.find((s) => s.status === "failed");
    const terminal = row.status === "done" || row.status === "failed";
    return {
      jobId: row.jobId,
      instanceId: row.instance,
      targetVersion: input.target.version,
      channel: input.target.channel,
      trigger: input.trigger ?? "manual",
      status: terminal ? (row.status as UpgradeJobStatus) : "running",
      steps: row.steps.map((s) => ({ ...s })),
      snapshotId,
      startedAt: row.createdAt,
      finishedAt: terminal ? row.updatedAt : undefined,
      rolledBack: rollbackStep?.status === "passed" ? true : undefined,
      error: failedStep ? `${failedStep.label}失败：${failedStep.detail ?? ""}` : undefined,
    };
  }

  /* ------------------------------ 五步执行主体 ------------------------------ */

  async function executeJob(view: UpgradeJobView, input: UpgradeRunInput): Promise<UpgradeJobView> {
    const instance = input.instance;
    const targetVersion = input.target.version;
    const rootPath = instance.rootPath ?? parseRootPath(instance.instanceId);
    try {
      /* 步骤 1：precheck —— 环境预检（无副作用；失败不回滚）。 */
      setStep(view, "precheck", "running");
      const currentVersion = await readCurrentVersion(rootPath);
      const problems: string[] = [];
      if (!rootPath) {
        problems.push("缺少实例根路径（InstanceRef.rootPath 或 instanceId|rootPath 复合形式）");
      } else {
        if (!existsSync(join(rootPath, "hermes-agent"))) {
          problems.push(`hermes-agent 目录不存在（${join(rootPath, "hermes-agent")}）`);
        }
        if (currentVersion === null) {
          problems.push("无法读取当前版本（hermes-agent/pyproject.toml 缺失或无 version 声明）");
        } else if (currentVersion === targetVersion) {
          problems.push(`当前已是目标版本 ${targetVersion}，无需升级`);
        }
        if ((instance.runtime ?? "unknown") !== "docker" && !findVenvPython(rootPath)) {
          problems.push("未找到 venv Python（hermes-agent/venv/bin/python 等），进程形态无法升级");
        }
        if (control.validateConfig !== undefined) {
          const validation = await control.validateConfig(instance);
          if (!validation.ok || validation.data === undefined) {
            problems.push(
              `配置不变式校验失败：${validation.error?.userHint ?? validation.error?.message ?? "未知错误"}`,
            );
          } else if (!validation.data.passed) {
            const blocked = validation.data.violations
              .filter((violation) => violation.severity === "block")
              .map((violation) => violation.detail)
              .join("；");
            problems.push(`配置不变式未通过：${blocked}`);
          }
        }
      }
      if (problems.length > 0) {
        const detail = problems.join("；");
        setStep(view, "precheck", "failed", detail);
        return finish(view, `环境预检未通过：${detail}`);
      }
      const resolvedRoot = rootPath as string;
      setStep(view, "precheck", "passed", `当前版本 ${currentVersion} → 目标 ${targetVersion}`);

      /* dry-run：只跑预检，其余四步 skipped，不落任何实例改动。 */
      if (input.dryRun) {
        for (const id of STEP_IDS.slice(1)) {
          setStep(view, id, "skipped", "dry-run");
        }
        return finish(view, undefined);
      }

      /* 步骤 2：snapshot —— 升级前全量快照（失败即终止，不回滚）。 */
      if (input.skipSnapshot) {
        setStep(
          view,
          "snapshot",
          "skipped",
          "skipSnapshot=true：未做升级前快照，后续失败不自动回滚",
        );
      } else {
        setStep(view, "snapshot", "running");
        const snap = await control.snapshot(instance, {
          include: ["code", "venv", "data"],
          label: "pre-upgrade",
        });
        const failedSubSteps = snap.ok ? snap.data!.steps.filter((s) => s.status === "failed") : [];
        if (!snap.ok || failedSubSteps.length > 0) {
          const detail = snap.ok
            ? `快照子步骤失败：${failedSubSteps.map((s) => `${s.id}（${s.detail ?? s.status}）`).join("、")}`
            : `快照失败：${snap.error!.userHint ?? snap.error!.message}`;
          setStep(view, "snapshot", "failed", detail);
          return finish(view, `升级前快照失败：${detail}`);
        }
        const latest = deps.store.listSnapshots(instance.instanceId)[0];
        const snapshotId = (latest?.scope as { snapshotId?: string } | null | undefined)
          ?.snapshotId;
        if (!snapshotId) {
          const detail = "快照已执行但登记缺失（store 中最新快照无 snapshotId）";
          setStep(view, "snapshot", "failed", detail);
          return finish(view, `升级前快照失败：${detail}`);
        }
        view.snapshotId = snapshotId;
        setStep(view, "snapshot", "passed", `snapshotId=${snapshotId}（code/venv/data 全量）`);
      }

      /* 步骤 3：pull —— 停止实例并拉取升级。 */
      setStep(view, "pull", "running");
      const stopOut = await control.stop(instance);
      if (!stopOut.ok) {
        const detail = `停止实例失败：${stopOut.error!.userHint ?? stopOut.error!.message}`;
        setStep(view, "pull", "failed", detail);
        return failAndMaybeRollback(view, input, `拉取升级失败：${detail}`);
      }
      const pullOut = await pullStrategy({
        instance,
        rootPath: resolvedRoot,
        targetVersion,
        exec: pullExec,
      });
      if (!pullOut.ok) {
        const detail = `拉取失败：${pullOut.detail}`;
        setStep(view, "pull", "failed", detail);
        return failAndMaybeRollback(view, input, `拉取升级失败：${detail}`);
      }
      if ((instance.runtime ?? "unknown") !== "docker") {
        const afterVersion = await readCurrentVersion(resolvedRoot);
        if (afterVersion !== targetVersion) {
          const detail = `拉取后版本为 ${afterVersion ?? "未知"}，未达到目标 ${targetVersion}`;
          setStep(view, "pull", "failed", detail);
          return failAndMaybeRollback(view, input, `拉取升级失败：${detail}`);
        }
        setStep(view, "pull", "passed", pullOut.detail);
      } else {
        setStep(
          view,
          "pull",
          "passed",
          `${pullOut.detail}；docker 形态以镜像拉取为准，跳过本地 pyproject 版本复核`,
        );
      }

      /* 步骤 4：patches —— 补丁重打与冲突检测。 */
      setStep(view, "patches", "running");
      const patchesOutcome = await rerunPatches(resolvedRoot);
      setStep(view, "patches", patchesOutcome.status, patchesOutcome.detail);
      if (patchesOutcome.status === "failed") {
        return failAndMaybeRollback(view, input, `补丁冲突：${patchesOutcome.detail}`);
      }

      /* 步骤 5：verify —— 启动实例并健康验收。 */
      setStep(view, "verify", "running");
      const startOut = await control.start(instance);
      if (!startOut.ok) {
        const detail = `启动实例失败：${startOut.error!.userHint ?? startOut.error!.message}`;
        setStep(view, "verify", "failed", detail);
        return failAndMaybeRollback(view, input, `健康验收失败：${detail}`);
      }
      const health = await verifyFn({ instance, rootPath: resolvedRoot });
      if (!health.ok) {
        const detail = `健康验收未通过：${health.detail ?? "未提供原因"}`;
        setStep(view, "verify", "failed", detail);
        return failAndMaybeRollback(view, input, detail);
      }
      setStep(view, "verify", "passed", health.detail ?? "健康验收通过");
      return finish(view, undefined);
    } catch (e) {
      // 兜底：内部不应抛异常；万一抛出 → 当前 running 步骤置 failed，按需回滚。
      const message = `升级流水线异常中断：${String(e)}`;
      const running = view.steps.find((s) => s.status === "running");
      if (running) setStep(view, running.id, "failed", message);
      const rollbackable =
        running?.id === "pull" || running?.id === "patches" || running?.id === "verify";
      if (rollbackable && view.snapshotId) {
        try {
          return await failAndMaybeRollback(view, input, message);
        } catch {
          // 回滚二次异常 → 直接收敛失败终态。
        }
      }
      return finish(view, message);
    }
  }

  /** 补丁重打：对每个已应用补丁读升级后新官方原文并 reapply（新原文成为新基线）。 */
  async function rerunPatches(
    rootPath: string,
  ): Promise<{ status: "passed" | "skipped" | "failed"; detail: string }> {
    const applied: Array<{ id: string; params: PatchParams; targetPath: string }> = [];
    for (const def of patchManager.listPatches()) {
      const report = await patchManager.detect(def.id, { rootPath });
      if (!report.ok) {
        return {
          status: "failed",
          detail: `补丁 ${def.id} 状态读取失败：${report.error!.userHint ?? report.error!.message}`,
        };
      }
      // 只重打 Butler 已纳管的补丁。observed 是源码中的手工实现，不属于
      // Butler 状态；无 appliedAt 的 missing-target 也只是未安装对应目标文件。
      if (
        report.data!.status === "not-applied" ||
        report.data!.status === "observed" ||
        (report.data!.status === "missing-target" && report.data!.appliedAt === undefined)
      ) {
        continue;
      }
      const targetPath =
        report.data!.targetPath ?? join(rootPath, ...normalizeRel(def.target).split("/"));
      applied.push({ id: def.id, params: report.data!.params ?? {}, targetPath });
    }
    if (applied.length === 0) return { status: "skipped", detail: "无已登记补丁" };

    const done: string[] = [];
    for (const patch of applied) {
      let content: string;
      try {
        content = await readFile(patch.targetPath);
      } catch {
        return {
          status: "failed",
          detail: `补丁 ${patch.id} 冲突：升级后目标文件缺失（${patch.targetPath}），无法获取新官方原文`,
        };
      }
      const r = await patchManager.reapply(patch.id, patch.params, {
        rootPath,
        targetContent: content,
      });
      if (!r.ok) {
        return {
          status: "failed",
          detail: `补丁 ${patch.id} 重打失败（锚点缺失或参数越界）：${r.error!.userHint ?? r.error!.message}`,
        };
      }
      done.push(`${patch.id}=${r.data!.status}`);
    }
    return { status: "passed", detail: `已按升级后新原文重打：${done.join("、")}` };
  }

  /** 第 3/4/5 步失败后的自动回滚（SubTask 13.2）；无快照时仅告警。 */
  async function failAndMaybeRollback(
    view: UpgradeJobView,
    input: UpgradeRunInput,
    reason: string,
  ): Promise<UpgradeJobView> {
    const instance = input.instance;
    if (!view.snapshotId) {
      if (input.skipSnapshot) {
        view.steps.push({
          id: "rollback",
          label: ROLLBACK_LABEL,
          status: "skipped",
          detail: "未做升级前快照（skipSnapshot=true），无法自动回滚——请人工检查实例状态",
        });
        persist(view);
      }
      return finish(view, reason);
    }

    view.steps.push({
      id: "rollback",
      label: ROLLBACK_LABEL,
      status: "running",
      detail: `回滚目标 snapshotId=${view.snapshotId}`,
    });
    persist(view);

    let rollback: Result<Job>;
    try {
      rollback = await control.rollback(instance, { snapshotId: view.snapshotId });
    } catch (e) {
      rollback = fail("E203", `rollback crashed: ${String(e)}`, { userHint: "回滚执行异常" });
    }
    // rollbackSnapshot 自带 .pre-rollback 当前态备份，即"现场保留"。
    const sceneDir = join(
      deps.snapshotsDir,
      sanitizeSegment(instance.instanceId),
      `${sanitizeSegment(view.snapshotId)}.pre-rollback`,
    );
    const failedSubSteps = rollback.ok
      ? rollback.data!.steps.filter((s) => s.status === "failed")
      : [];
    if (rollback.ok && failedSubSteps.length === 0) {
      view.rolledBack = true;
      const subSummary = rollback.data!.steps.map((s) => `${s.id}:${s.status}`).join("、");
      setStep(
        view,
        "rollback",
        "passed",
        `已回滚到升级前快照 snapshotId=${view.snapshotId}；现场保留：${sceneDir}；回滚子步骤：${subSummary}`,
      );
      return finish(view, `${reason}；已自动回滚到升级前快照（现场保留于 ${sceneDir}）`);
    }
    const why = rollback.ok
      ? `回滚子步骤失败：${failedSubSteps.map((s) => `${s.id}（${s.detail ?? ""}）`).join("、")}`
      : `回滚失败：${rollback.error!.userHint ?? rollback.error!.message}`;
    setStep(view, "rollback", "failed", `${why}；现场保留：${sceneDir}`);
    return finish(
      view,
      `${reason}；回滚失败，需人工介入（快照 ${view.snapshotId}，现场保留于 ${sceneDir}）`,
    );
  }

  /** 收敛到终态：记录 finishedAt 与失败摘要，落库 + 推送终态。 */
  function finish(view: UpgradeJobView, error?: string): UpgradeJobView {
    view.finishedAt = iso(now());
    view.error = error;
    persist(view);
    return view;
  }

  /* --------------------------------- 出入口 --------------------------------- */

  function start(input: UpgradeRunInput): Result<UpgradeJobView> {
    if (!input.idempotencyKey || !input.target.version) {
      return fail("E002", "UpgradeRunInput requires idempotencyKey and target.version", {
        userHint: "缺少幂等键或目标版本号",
      });
    }
    // ① 幂等：同键命中直接返回已存视图（不再执行）。
    const cached = views.get(input.idempotencyKey);
    if (cached) return ok(copyView(cached));
    const row = deps.store.findJobByIdempotencyKey(input.idempotencyKey);
    if (row) {
      const restored = viewFromRow(row, input);
      views.set(input.idempotencyKey, restored);
      current = restored;
      return ok(copyView(restored));
    }
    // ② 同一时刻仅允许一个 running 升级（进程内 + 落库行双保险）。
    if (active !== null) {
      return fail("E202", `another upgrade is running (idempotencyKey=${active.key})`, {
        userHint: "升级进行中，请等待当前升级完成后再试",
      });
    }
    const runningRows = deps.store
      .listJobs({ instance: input.instance.instanceId, status: "running" })
      .filter((j) => j.kind === "upgrade" && j.idempotencyKey !== input.idempotencyKey);
    if (runningRows.length > 0) {
      return fail(
        "E202",
        `upgrade job ${runningRows[0]!.jobId} still running for ${input.instance.instanceId}`,
        {
          userHint: "升级进行中，请等待当前升级完成后再试",
        },
      );
    }
    // ③ 建档落库（kind "upgrade"），后台执行。
    const steps: JobStep[] = STEP_IDS.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: "pending",
    }));
    const view: UpgradeJobView = {
      jobId: randomUUID(),
      instanceId: input.instance.instanceId,
      targetVersion: input.target.version,
      channel: input.target.channel,
      trigger: input.trigger ?? "manual",
      status: "running",
      steps,
      startedAt: iso(now()),
    };
    deps.store.insertJob({
      jobId: view.jobId,
      kind: "upgrade",
      instance: view.instanceId,
      idempotencyKey: input.idempotencyKey,
      steps: view.steps,
    });
    views.set(input.idempotencyKey, view);
    current = view;
    emit(copyView(view)); // 初始视图（全 pending）也推送一次，消费方可 diff 出首个 running 迁移
    const promise = executeJob(view, input).finally(() => {
      if (active?.promise === promise) active = null;
    });
    active = { key: input.idempotencyKey, promise };
    promise.catch(() => {}); // executeJob 内部全捕获；此为未处理拒绝兜底
    return ok(copyView(view));
  }

  async function run(input: UpgradeRunInput): Promise<Result<UpgradeJobView>> {
    const started = start(input);
    if (!started.ok) return started;
    if (active !== null && active.key === input.idempotencyKey) {
      try {
        return ok(copyView(await active.promise));
      } catch (e) {
        return fail("E203", `upgrade job crashed unexpectedly: ${String(e)}`, {
          userHint: "升级任务异常中断，请检查实例状态后重试",
        });
      }
    }
    return started;
  }

  function status(): UpgradeJobView | null {
    return current ? copyView(current) : null;
  }

  return { start, run, status };
}
