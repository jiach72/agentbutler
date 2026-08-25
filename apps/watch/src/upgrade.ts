/**
 * 升级服务（Task 13.1/13.2 butler-watch 侧）：把已实现的 hermes 升级流水线
 * 引擎（createUpgradePipeline 五步 Job 状态机）接线进 watch 应用，并提供
 * 发起升级 / 状态查询 / 版本源列表 / 快照回滚四个入口。
 *
 * 流水线组装：
 * - control 门面 = hermes adapter.control（start/stop/snapshot/rollback）；
 * - store/snapshotsDir 复用 core（与适配器同一状态库与快照目录）；
 * - patchManager 缺省 createPatchManager（patchesDir = <home>/patches）；
 * - verify 复用巡检阶段（process-alive + api-connectivity + channel-probe
 *   三阶段构造 HealthVerifier，做法同 runbook 执行器的复验）；
 * - pull 用 createDefaultPullStrategy（pipPackage/dockerImage 来自 config）；
 * - emit 回调 → core.bus.emit("job-event", ...)（经内核落 events 表，
 *   web /ws 推送消费）。
 *
 * 审计（actor "upgrade"）：upgrade-start / upgrade-done / upgrade-failed /
 * upgrade-rollback。
 *
 * 告警与缓释（SubTask 13.2）：完成通知走 alertPoster POST 网关（gateway
 * 持久化队列天然缓释配速），并做"60s 冷却 + 队列合并"——job done 后的通知
 * 进入冷却窗，窗内多条合并为一条（含合并条数）在窗口结束时投递；失败/回滚
 * critical 立即投递不走冷却。冷却窗毫秒数可配（默认 60000），now 可注入
 * （测试用 fake 时钟推进窗口）。
 *
 * 熔断联动：升级 Job 失败 → breaker.recordJobFailure（key "upgrade:<instanceId>"，
 * 与 runbook 同一熔断器同窗口同阈值）；成功 → recordSuccess 复位失败累计。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { InstanceRef, JobStep } from "@butler/contract";
import {
  createDefaultPullStrategy,
  createPatchManager,
  createUpgradePipeline,
  listAvailableVersions,
  type CommandExecutor,
  type HealthVerifier,
  type PatchManager,
  type UpgradeControl,
  type UpgradeJobView,
  type VersionListEntry,
} from "@butler/adapter-hermes";
import type { Core, InstanceRecord } from "@butler/core";
import { DEFAULT_UPGRADE_NOTIFY_COOLDOWN_MS } from "./config.js";
import { ALERT_SOURCE, type AlertPoster } from "./alert-forward.js";
import { defaultFetchLike, type FetchLike } from "./dashboard-signal.js";
import { InspectionPipeline, type InspectionStage } from "./pipeline.js";

/** 升级服务审计与告警的统一 actor / kind 常量。 */
export const UPGRADE_ACTOR = "upgrade";
export const UPGRADE_START_ACTION = "upgrade-start";
export const UPGRADE_DONE_ACTION = "upgrade-done";
export const UPGRADE_FAILED_ACTION = "upgrade-failed";
export const UPGRADE_ROLLBACK_ACTION = "upgrade-rollback";
export const UPGRADE_DONE_KIND = "upgrade-done";
export const UPGRADE_FAILED_KIND = "upgrade-failed";
export const UPGRADE_ROLLBACK_KIND = "upgrade-rollback";

/** 健康验收复用的巡检阶段 id（进程存活 + API 连通 + 通道 dry-run）。 */
export const UPGRADE_VERIFY_STAGE_IDS = ["process-alive", "api-connectivity", "channel-probe"] as const;

export type UpgradeStartOutcome =
  | { status: "started"; jobId: string; instanceId: string }
  | { status: "missing-target-version" }
  | { status: "upgrade-in-flight" }
  | { status: "no-servicing-instance" }
  | { status: "backup-failed"; error: string };

/** rollbackSnapshot 结果（HTTP 层按 status 映射 200/404/503）。 */
export type RollbackSnapshotOutcome =
  | { status: "ok"; job: { jobId: string; kind: "rollback"; steps: JobStep[] } }
  | { status: "snapshot-not-found" }
  | { status: "no-servicing-instance" };

export interface UpgradeService {
  /** 发起升级（异步执行，立即返回）。instanceId 缺省取首个 Serving 实例。 */
  startUpgrade(input: {
    instanceId?: string;
    targetVersion: string;
    channel?: "stable" | "beta";
    trigger?: "manual" | "auto";
  }): UpgradeStartOutcome | Promise<UpgradeStartOutcome>;
  /** 当前 running 或最近一次升级 Job 视图。 */
  status(): UpgradeJobView | null;
  /** 版本源可用版本列表（逐源探测，fetch 注入）。 */
  listVersions(): Promise<{ reachable: boolean; source?: string; versions: VersionListEntry[] }>;
  /** 回滚到快照登记行（同步收敛，返回 rollback Job）。 */
  rollbackSnapshot(snapshotRowId: number, instanceId?: string): Promise<RollbackSnapshotOutcome>;
}

/** 熔断联动所需的最小面（CircuitBreaker 结构满足；测试可注入记录型 fake）。 */
export interface UpgradeBreaker {
  recordJobFailure(key: string, reason?: string): unknown;
  recordSuccess(key: string): void;
}

export interface UpgradeServiceDeps {
  core: Core;
  /** 控制门面（hermes adapter.control 收窄为升级所需四方法）。 */
  control: UpgradeControl;
  /** 巡检阶段全集（健康验收取 process-alive/api-connectivity/channel-probe）。 */
  stages: InspectionStage[];
  poster: AlertPoster;
  breaker: UpgradeBreaker;
  /** fetch（版本源列表；缺省包装全局 fetch）。 */
  fetchFn?: FetchLike;
  exec?: CommandExecutor;
  /** 缺省 createPatchManager（patchesDir = <home>/patches）。 */
  patchManager?: PatchManager;
  /** 读文件（pyproject 版本 / 补丁目标文件；缺省 node:fs/promises）。 */
  readFile?: (p: string) => Promise<string>;
  now?: () => number;
  /** 版本源：GitHub 仓库 / Docker Hub 镜像 / GitHub API 镜像前缀（均可选）。 */
  versionRepo?: string;
  versionDockerImage?: string;
  versionMirrorHost?: string;
  /** 拉取策略：venv pip 包名 / docker 镜像。 */
  pipPackage?: string;
  dockerImage?: string;
  /** 升级完成通知冷却窗（毫秒，默认 60000）。 */
  notifyCooldownMs?: number;
}

/** 由巡检阶段构造健康验收（同 runbook 执行器复验：任一阶段 fail → 未通过）。 */
function createStageHealthVerifier(stages: InspectionStage[]): HealthVerifier | undefined {
  const verifyStages = stages.filter((s) => (UPGRADE_VERIFY_STAGE_IDS as readonly string[]).includes(s.id));
  if (verifyStages.length === 0) return undefined;
  return async ({ instance, rootPath }) => {
    const outcome = await new InspectionPipeline(verifyStages).run({
      instanceId: instance.instanceId,
      frameworkId: "hermes",
      rootPath,
      runtime: instance.runtime ?? "unknown",
      shared: {},
    });
    const failed = outcome.checks.filter((c) => c.status === "fail");
    if (failed.length > 0) {
      return {
        ok: false,
        detail: failed.map((c) => `${c.id}（${c.detail ?? c.status}）`).join("、"),
      };
    }
    return { ok: true, detail: outcome.checks.map((c) => `${c.id}:${c.status}`).join("、") };
  };
}

/** 冷却窗内的待合并完成通知。 */
interface DoneWindow {
  startAt: number;
  views: UpgradeJobView[];
}

export function createUpgradeService(deps: UpgradeServiceDeps): UpgradeService {
  const core = deps.core;
  const poster = deps.poster;
  const breaker = deps.breaker;
  const now = deps.now ?? Date.now;
  const notifyCooldownMs = deps.notifyCooldownMs ?? DEFAULT_UPGRADE_NOTIFY_COOLDOWN_MS;
  const fetchFn = deps.fetchFn ?? defaultFetchLike;

  /* ------------------------- 完成通知冷却 + 队列合并 ------------------------- */

  let doneWindow: DoneWindow | null = null;
  let backstop: ReturnType<typeof setTimeout> | undefined;

  function clearBackstop(): void {
    if (backstop !== undefined) {
      clearTimeout(backstop);
      backstop = undefined;
    }
  }

  /** 投递冷却窗内合并的完成通知（未到期为 no-op；可被任意公开入口懒触发）。 */
  function flushDoneWindow(): void {
    if (doneWindow === null) return;
    if (now() - doneWindow.startAt < notifyCooldownMs) return;
    const merged = doneWindow.views;
    const startAt = doneWindow.startAt;
    doneWindow = null;
    clearBackstop();
    const summary = merged.map((v) => `${v.instanceId} → ${v.targetVersion}（job ${v.jobId}）`).join("；");
    void poster.post({
      kind: UPGRADE_DONE_KIND,
      severity: "warn",
      title:
        merged.length > 1
          ? `升级完成通知合并（${merged.length} 条）`
          : `升级完成：实例 ${merged[0]!.instanceId} → ${merged[0]!.targetVersion}`,
      body: `冷却窗（${Math.round(notifyCooldownMs / 1000)}s）内合并 ${merged.length} 条升级完成通知：${summary}`,
      source: ALERT_SOURCE,
      dedupeKey: `upgrade-done:${new Date(startAt).toISOString()}`,
    });
  }

  /** 兜底定时器：即使后续无任何入口调用，窗口到期也能投递（unref 不阻退出）。 */
  function armBackstop(): void {
    if (backstop !== undefined) return;
    const tick = (): void => {
      backstop = undefined;
      if (doneWindow === null) return;
      flushDoneWindow();
      if (doneWindow !== null) {
        backstop = setTimeout(tick, Math.max(1, doneWindow.startAt + notifyCooldownMs - now()));
        backstop.unref?.();
      }
    };
    backstop = setTimeout(tick, notifyCooldownMs);
    backstop.unref?.();
  }

  /** 完成通知入口：先结算已到期窗口，再并入当前（或新开）冷却窗。 */
  function notifyDone(view: UpgradeJobView): void {
    flushDoneWindow();
    if (doneWindow === null) {
      doneWindow = { startAt: now(), views: [] };
      armBackstop();
    }
    doneWindow.views.push(view);
  }

  /* ---------------------------- 流水线事件接线 ---------------------------- */

  /** 步骤状态变化 → job-event；终态 → 审计 + 告警 + 熔断联动。 */
  function handlePipelineEmit(view: UpgradeJobView): void {
    core.bus.emit("job-event", {
      instanceId: view.instanceId,
      job: { jobId: view.jobId, kind: "upgrade", steps: view.steps },
    });
    if (view.status !== "done" && view.status !== "failed") return;
    const breakerKey = `upgrade:${view.instanceId}`;
    if (view.status === "done") {
      core.audit.append({
        actor: UPGRADE_ACTOR,
        action: UPGRADE_DONE_ACTION,
        target: view.instanceId,
        detail: {
          jobId: view.jobId,
          targetVersion: view.targetVersion,
          trigger: view.trigger,
          finishedAt: view.finishedAt ?? "",
        },
      });
      breaker.recordSuccess(breakerKey);
      notifyDone(view); // 60s 冷却 + 队列合并（不立即投递）
      return;
    }
    core.audit.append({
      actor: UPGRADE_ACTOR,
      action: UPGRADE_FAILED_ACTION,
      target: view.instanceId,
      detail: {
        jobId: view.jobId,
        targetVersion: view.targetVersion,
        error: view.error ?? "",
        rolledBack: view.rolledBack === true,
      },
    });
    breaker.recordJobFailure(breakerKey, `升级失败：${view.error ?? ""}`);
    void poster.post({
      kind: UPGRADE_FAILED_KIND,
      severity: "critical",
      title: `升级失败：实例 ${view.instanceId} → ${view.targetVersion}`,
      body: `升级 Job ${view.jobId}（实例 ${view.instanceId} → ${view.targetVersion}）失败：${view.error ?? "未知原因"}${
        view.rolledBack === true ? "；已自动回滚到升级前快照" : ""
      }`,
      source: ALERT_SOURCE,
      dedupeKey: `upgrade-failed:${view.jobId}`,
    });
  }

  const pipeline = createUpgradePipeline({
    store: core.store,
    snapshotsDir: core.paths.snapshotsDir,
    control: deps.control,
    exec: deps.exec,
    patchManager: deps.patchManager ?? createPatchManager({ patchesDir: join(core.paths.home, "patches") }),
    readFile: deps.readFile,
    verify: createStageHealthVerifier(deps.stages),
    emit: handlePipelineEmit,
    pull: createDefaultPullStrategy({ pipPackage: deps.pipPackage, dockerImage: deps.dockerImage }),
    now: deps.now,
  });

  /* ------------------------------ 实例解析 ------------------------------ */

  /** 升级目标实例解析：显式 instanceId 精确取；缺省取首个 Serving 实例。 */
  function resolveTargetInstance(instanceId?: string): InstanceRecord | undefined {
    const record =
      instanceId !== undefined
        ? core.instances.getInstance(instanceId)
        : core.instances.listInstances().find((r) => r.state === "Serving");
    if (record === undefined || record.state !== "Serving" || record.rootPath === "") return undefined;
    return record;
  }

  function refOf(record: InstanceRecord): InstanceRef {
    return { instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime };
  }

  /* -------------------------------- 出入口 -------------------------------- */

  function startUpgrade(input: {
    instanceId?: string;
    targetVersion: string;
    channel?: "stable" | "beta";
    trigger?: "manual" | "auto";
  }): UpgradeStartOutcome {
    flushDoneWindow();
    if (typeof input.targetVersion !== "string" || input.targetVersion.trim() === "") {
      return { status: "missing-target-version" };
    }
    const record = resolveTargetInstance(input.instanceId);
    if (record === undefined) return { status: "no-servicing-instance" };
    const targetVersion = input.targetVersion.trim();
    const started = pipeline.start({
      instance: refOf(record),
      target: { version: targetVersion, channel: input.channel },
      idempotencyKey: `upgrade:${record.instanceId}:${targetVersion}:${randomUUID()}`,
      trigger: input.trigger ?? "manual",
    });
    if (!started.ok) {
      // E202 = 升级在飞；E002（入参不完整）已被前置校验拦截，正常不可达。
      return started.error?.code === "E202"
        ? { status: "upgrade-in-flight" }
        : { status: "missing-target-version" };
    }
    const view = started.data!;
    core.audit.append({
      actor: UPGRADE_ACTOR,
      action: UPGRADE_START_ACTION,
      target: view.instanceId,
      detail: {
        jobId: view.jobId,
        targetVersion: view.targetVersion,
        channel: view.channel ?? "",
        trigger: view.trigger,
      },
    });
    return { status: "started", jobId: view.jobId, instanceId: view.instanceId };
  }

  async function listVersions(): Promise<{ reachable: boolean; source?: string; versions: VersionListEntry[] }> {
    flushDoneWindow();
    const result = await listAvailableVersions({
      // 版本源只使用 ok/status/json，FetchLike 运行时兼容（结构收窄）。
      fetchFn: fetchFn as unknown as typeof fetch,
      repo: deps.versionRepo,
      dockerImage: deps.versionDockerImage,
      mirrorHost: deps.versionMirrorHost,
    });
    if (result.ok) {
      return { reachable: true, source: result.data!.source, versions: result.data!.versions };
    }
    return { reachable: false, versions: [] }; // 版本源全败不抛异常（HTTP 不 5xx）
  }

  async function rollbackSnapshot(snapshotRowId: number, instanceId?: string): Promise<RollbackSnapshotOutcome> {
    flushDoneWindow();
    const row = core.store.listSnapshots().find((r) => r.id === snapshotRowId);
    if (row === undefined || row.status === "expired") return { status: "snapshot-not-found" };
    const snapshotId = (row.scope as { snapshotId?: string } | null)?.snapshotId;
    if (snapshotId === undefined) return { status: "snapshot-not-found" }; // 登记行缺定位信息（异常数据）
    const record = core.instances.getInstance(instanceId ?? row.instance);
    if (record === undefined || record.rootPath === "") return { status: "no-servicing-instance" };
    const instance = refOf(record);
    const rollback = await deps.control.rollback(instance, { snapshotId });
    if (!rollback.ok) {
      core.audit.append({
        actor: UPGRADE_ACTOR,
        action: UPGRADE_ROLLBACK_ACTION,
        target: record.instanceId,
        detail: {
          status: "failed",
          snapshotRowId,
          snapshotId,
          error: rollback.error?.userHint ?? rollback.error?.message ?? "",
        },
      });
      return { status: "snapshot-not-found" }; // 快照不可回滚（E204 目录缺失/已淘汰等）
    }
    const job = rollback.data!;
    core.bus.emit("job-event", {
      instanceId: record.instanceId,
      job: { jobId: job.jobId, kind: "rollback", steps: job.steps },
    });
    core.audit.append({
      actor: UPGRADE_ACTOR,
      action: UPGRADE_ROLLBACK_ACTION,
      target: record.instanceId,
      detail: {
        status: "ok",
        snapshotRowId,
        snapshotId,
        jobId: job.jobId,
        steps: job.steps.map((s) => `${s.id}:${s.status}`).join(","),
      },
    });
    void poster.post({
      kind: UPGRADE_ROLLBACK_KIND,
      severity: "critical", // 回滚立即投递，不走冷却
      title: `已回滚到快照：实例 ${record.instanceId}（snapshotId=${snapshotId}）`,
      body: `实例 ${record.instanceId} 回滚到快照 snapshotId=${snapshotId}（登记行 ${snapshotRowId}）。子步骤：${job.steps
        .map((s) => `${s.id}:${s.status}`)
        .join("、")}`,
      source: ALERT_SOURCE,
      dedupeKey: `upgrade-rollback:${job.jobId}`,
    });
    return { status: "ok", job: { jobId: job.jobId, kind: "rollback", steps: job.steps } };
  }

  return {
    startUpgrade,
    status: () => {
      flushDoneWindow();
      return pipeline.status();
    },
    listVersions,
    rollbackSnapshot,
  };
}
