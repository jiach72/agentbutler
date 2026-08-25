/**
 * Hermes L2 控制面（ControlAdapter 组装）。
 *
 * 形态分派：InstanceRef.runtime === "docker" 走容器执行器，
 * 其余（process/unknown，真实环境为宿主进程形态）走进程执行器。
 * 常规控制幂等由执行器保证；所有方法返回 Result 包装（durationMs 由 ok/fail 计算）。
 * upgrade 委托内部升级流水线（createUpgradePipeline，五步 Job 状态机）：
 * 复用同一 store/snapshotsDir/执行器，control 门面方法闭包即 UpgradeControl；
 * 契约要求 upgrade 立即返回初始 Job，进度经事件流（HermesControlOptions.upgrade.emit）推送。
 */
import {
  fail,
  ok,
  type ControlAck,
  type ControlAction,
  type ControlAdapter,
  type ConfigValidation,
  type InstanceRef,
  type Job,
  type Result,
  type SnapshotRef,
  type SnapshotScope,
  type StartOpts,
  type StopOpts,
  type UpgradeOpts,
  type VersionRef,
} from "@butler/contract";
import { ensureButlerHome, SqliteStore } from "@butler/core";
import { parseRootPath } from "../capability-scan.js";
import type { PortProber } from "../detect.js";
import type { PatchManager } from "../patches/applier.js";
import {
  DockerExecutor,
  ProcessExecutor,
  type CommandExecutor,
  type DockerodeFactory,
  type ExecutorOutcome,
} from "./executor.js";
import { rollbackSnapshot, takeSnapshot, type RollbackExecutors, type SnapshotDeps } from "./snapshot.js";
import { createUpgradePipeline, type HealthVerifier, type PullStrategy, type UpgradeControl, type UpgradeJobView, type UpgradePipeline } from "./upgrade-pipeline.js";
import { validateHermesConfig } from "./validate-config.js";

/** 控制面可注入项：store/snapshotsDir 缺省时按需自建（ensureButlerHome + WAL 安全双连接）。 */
export interface HermesControlOptions {
  store?: SqliteStore;
  snapshotsDir?: string;
  exec?: CommandExecutor;
  prober?: PortProber;
  process?: { unitName?: string };
  docker?: {
    dockerodeFactory?: DockerodeFactory;
    containerName?: string;
    dockerHost?: string;
  };
  /** 升级流水线可注入项（缺省默认值：默认验收 / 默认补丁管理器 / 默认拉取策略）。 */
  upgrade?: {
    verify?: HealthVerifier;
    patchManager?: PatchManager;
    emit?: (view: UpgradeJobView) => void;
    pull?: PullStrategy;
  };
  /**
   * 升级流水线内部控制调用器。watch 注入 core.invoke 后，流水线中的
   * stop/start/snapshot/rollback/validateConfig 也会经过能力路由；
   * 独立使用时缺省为直通调用，保持适配器向后兼容。
   */
  controlInvoker?: HermesControlInvoker;
}

export type HermesControlInvoker = <T>(
  method: string,
  instance: InstanceRef,
  capability: "control" | "config-driver",
  fn: () => Promise<Result<T>>,
) => Promise<Result<T>>;

/** 从 InstanceRef 解析 rootPath：优先 rootPath 字段，回退 "instanceId|rootPath" 复合形式。 */
function rootPathFromRef(ref: InstanceRef): string | null {
  return ref.rootPath ?? parseRootPath(ref.instanceId);
}

export function createHermesControl(options: HermesControlOptions = {}): ControlAdapter {
  const controlInvoker: HermesControlInvoker =
    options.controlInvoker ??
    (async <T>(
      _method: string,
      _instance: InstanceRef,
      _capability: "control" | "config-driver",
      fn: () => Promise<Result<T>>,
    ): Promise<Result<T>> => fn());
  const processExecutor = new ProcessExecutor({
    exec: options.exec,
    prober: options.prober,
    unitName: options.process?.unitName,
  });
  const dockerExecutor = new DockerExecutor({
    factory: options.docker?.dockerodeFactory,
    containerName: options.docker?.containerName,
    dockerHost: options.docker?.dockerHost,
  });

  // 快照依赖惰性解析：只读用法（start/stop/validateConfig）不触碰用户 home。
  let store: SqliteStore | undefined = options.store;
  let resolvedSnapshotsDir: string | undefined = options.snapshotsDir;
  function snapshotDeps(): SnapshotDeps {
    if (!store) store = new SqliteStore(ensureButlerHome().dbFile);
    if (!resolvedSnapshotsDir) resolvedSnapshotsDir = options.snapshotsDir ?? ensureButlerHome().snapshotsDir;
    return { store, snapshotsDir: resolvedSnapshotsDir };
  }

  async function runControl(
    action: ControlAction,
    ref: InstanceRef,
    opts?: { timeoutSec?: number },
  ): Promise<Result<ControlAck>> {
    const startedAt = Date.now();
    const rootPath = rootPathFromRef(ref);
    if (action !== "stop") {
      if (!rootPath) {
        return fail(
          "E002",
          "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes config gate",
          { userHint: "缺少实例根路径，无法在启动前校验配置不变式", startedAt },
        );
      }
      const validation = await validateHermesConfig(rootPath);
      if (!validation.passed) {
        const blocked = validation.violations
          .filter((violation) => violation.severity === "block")
          .map((violation) => violation.detail)
          .join("；");
        return fail("E203", `hermes ${action} blocked by configuration invariants: ${blocked}`, {
          userHint: `配置安全规则未通过，已拒绝${action === "restart" ? "重启" : "启动"}：${blocked}`,
          startedAt,
        });
      }
    }
    let outcome: ExecutorOutcome;
    if (ref.runtime === "docker") {
      outcome =
        action === "start"
          ? await dockerExecutor.start()
          : action === "stop"
            ? await dockerExecutor.stop(opts)
            : await dockerExecutor.restart();
    } else {
      if (!rootPath) {
        return fail(
          "E002",
          "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes control",
          { userHint: "缺少实例根路径，无法执行控制操作", startedAt },
        );
      }
      outcome =
        action === "start"
          ? await processExecutor.start(rootPath, opts)
          : action === "stop"
            ? await processExecutor.stop(rootPath, opts)
            : await processExecutor.restart(rootPath, opts);
    }
    if (!outcome.ok) {
      return fail(outcome.code, outcome.message, {
        userHint: outcome.userHint,
        cause: outcome.cause,
        startedAt,
      });
    }
    return ok(
      { instanceId: ref.instanceId, action, startedAt: new Date(startedAt).toISOString() },
      startedAt,
    );
  }

  // 升级流水线惰性创建：只读用法（start/stop/validateConfig）不触碰用户 home；
  // 首次 upgrade 调用时与快照共用同一 store/snapshotsDir。
  let upgradePipeline: UpgradePipeline | null = null;
  function pipeline(): UpgradePipeline {
    if (!upgradePipeline) {
      const deps = snapshotDeps();
      // control 门面方法闭包即 UpgradeControl（stop/start/snapshot/rollback 复用双执行器）。
      const upgradeControl: UpgradeControl = {
        stop: (instance, opts) =>
          controlInvoker("stop", instance, "control", () => adapter.stop(instance, opts)),
        start: (instance, opts) =>
          controlInvoker("start", instance, "control", () => adapter.start(instance, opts)),
        snapshot: (instance, scope) =>
          controlInvoker("snapshot", instance, "control", () => adapter.snapshot(instance, scope)),
        rollback: (instance, ref) =>
          controlInvoker("rollback", instance, "control", () => adapter.rollback(instance, ref)),
        validateConfig: (instance) =>
          controlInvoker("validateConfig", instance, "config-driver", () => adapter.validateConfig(instance)),
      };
      upgradePipeline = createUpgradePipeline({
        store: deps.store,
        snapshotsDir: deps.snapshotsDir,
        control: upgradeControl,
        exec: options.exec,
        patchManager: options.upgrade?.patchManager,
        verify: options.upgrade?.verify,
        emit: options.upgrade?.emit,
        pull: options.upgrade?.pull,
      });
    }
    return upgradePipeline;
  }

  const adapter: ControlAdapter = {
    start: (instance, opts?: StartOpts) => runControl("start", instance, opts),
    stop: (instance, opts?: StopOpts) => runControl("stop", instance, opts),
    restart: (instance) => runControl("restart", instance),
    upgrade: async (
      instance: InstanceRef,
      target: VersionRef,
      opts: UpgradeOpts & { idempotencyKey: string },
    ): Promise<Result<Job>> => {
      const startedAt = Date.now();
      if (!opts?.idempotencyKey) {
        return fail("E002", "hermes upgrade requires idempotencyKey", {
          userHint: "缺少幂等键（长操作必须携带 idempotencyKey）",
          startedAt,
        });
      }
      // 契约：方法立即返回 Job，进度经事件流推送（upgrade.emit 注入 watch）。
      const started = pipeline().start({
        instance,
        target,
        idempotencyKey: opts.idempotencyKey,
        trigger: "manual",
        skipSnapshot: opts.skipSnapshot,
        dryRun: opts.dryRun,
      });
      if (!started.ok) {
        const error = started.error!;
        return fail(error.code, error.message, { userHint: error.userHint, startedAt });
      }
      const initial = started.data!;
      return ok({ jobId: initial.jobId, kind: "upgrade", steps: initial.steps }, startedAt);
    },
    snapshot: async (instance: InstanceRef, scope: SnapshotScope): Promise<Result<Job>> => {
      const startedAt = Date.now();
      const rootPath = rootPathFromRef(instance);
      if (!rootPath) {
        return fail("E002", "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes snapshot", {
          userHint: "缺少实例根路径，无法执行快照",
          startedAt,
        });
      }
      return takeSnapshot(snapshotDeps(), instance, scope, rootPath);
    },
    rollback: async (instance: InstanceRef, ref: SnapshotRef): Promise<Result<Job>> => {
      const startedAt = Date.now();
      const rootPath = rootPathFromRef(instance);
      if (!rootPath) {
        return fail("E002", "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes rollback", {
          userHint: "缺少实例根路径，无法执行回滚",
          startedAt,
        });
      }
      const executors: RollbackExecutors =
        instance.runtime === "docker"
          ? {
              isAlive: () => dockerExecutor.isAlive(),
              stop: () => dockerExecutor.stop(),
              start: () => dockerExecutor.start(),
            }
          : {
              isAlive: () => processExecutor.isAlive(rootPath),
              stop: () => processExecutor.stop(rootPath),
              start: () => processExecutor.start(rootPath),
            };
      return rollbackSnapshot(snapshotDeps(), instance, ref, rootPath, executors);
    },
    validateConfig: async (instance: InstanceRef): Promise<Result<ConfigValidation>> => {
      const startedAt = Date.now();
      const rootPath = rootPathFromRef(instance);
      if (!rootPath) {
        return fail("E002", "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes validateConfig", {
          userHint: "缺少实例根路径，无法校验配置",
          startedAt,
        });
      }
      return ok(await validateHermesConfig(rootPath), startedAt);
    },
  };

  return adapter;
}

/* 升级流水线与版本源公开出口（Task 13.1 / 13.2）。 */
export {
  createDefaultPullStrategy,
  createUpgradePipeline,
  type HealthVerifier,
  type PullOutcome,
  type PullStrategy,
  type UpgradeControl,
  type UpgradeJobStatus,
  type UpgradeJobView,
  type UpgradePipeline,
  type UpgradePipelineDeps,
  type UpgradeRunInput,
} from "./upgrade-pipeline.js";
export {
  createVersionSources,
  listAvailableVersions,
  type VersionListEntry,
  type VersionListSource,
  type VersionSourceAttempt,
  type VersionSourceOptions,
} from "./version-source.js";
