/**
 * 版本页编排层：三组数据拉取、事件流/轮询驱动刷新、升级与回滚动作分发。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { PageProgress, type PageProgressStep } from "../../components/PageProgress.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { useEventStream } from "../../hooks/useEventStream.js";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { compareVersion } from "../../lib/semver.js";
import { CandidateList } from "./CandidateList.js";
import { ManagedInstances } from "./ManagedInstances.js";
import { PrecheckList } from "./PrecheckList.js";
import { SelfUpgradeCard } from "./SelfUpgradeCard.js";
import { SnapshotRollback } from "./SnapshotRollback.js";
import { UpgradePipeline } from "./UpgradePipeline.js";
import { BackupCadenceChart } from "./BackupCadenceChart.js";
import {
  instanceLabel,
  managedUpgradeProgress,
  parsePrecheckDetail,
  SELF_PROGRESS_PHASES,
  versionComparable,
} from "./helpers.js";
import type {
  ButlerAvailableUpdate,
  ButlerSelfPrefs,
  ButlerSelfSnapshot,
  ButlerSelfView,
  ButlerVersionView,
  ConfirmAction,
  ManagedUpgradeTarget,
  PendingManagedUpgrade,
  SnapshotView,
  VersionsPayload,
} from "./types.js";

/** 事件流节流刷新间隔（收到升级相关事件后最多每 5s 拉一次聚合端点）。 */
const REFRESH_THROTTLE_MS = 5000;

/** 管家自身 Job 运行期间的轮询间隔。 */
const SELF_JOB_POLL_MS = 5000;

/** 受管实例升级提交/运行期间的轮询间隔。 */
const UPGRADE_POLL_MS = 2000;

export function VersionsPage() {
  const { message } = App.useApp();
  const { mode } = useTheme();
  const [data, setData] = useState<VersionsPayload | null>(null);
  const [butler, setButler] = useState<ButlerVersionView | null>(null);
  const [butlerSelf, setButlerSelf] = useState<ButlerSelfView | null>(null);
  const [selfBusy, setSelfBusy] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [managedUpgradePending, setManagedUpgradePending] =
    useState<PendingManagedUpgrade | null>(null);
  const [selectedInstance, setSelectedInstance] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [initialLoad, setInitialLoad] = useState({
    managed: false,
    butler: false,
    self: false,
    finished: false,
  });

  const refresh = useCallback(async (trackInitial = false) => {
    const mark = (key: "managed" | "butler" | "self") => {
      if (trackInitial) setInitialLoad((current) => ({ ...current, [key]: true }));
    };
    await Promise.all([
      fetchJson<VersionsPayload>("/api/versions").then((payload) => {
        if (payload !== null) setData(payload);
        mark("managed");
      }),
      fetchJson<ButlerVersionView>("/api/butler/version").then((payload) => {
        if (payload !== null) setButler(payload);
        mark("butler");
      }),
      fetchJson<ButlerSelfView>("/api/butler/self").then((payload) => {
        if (payload !== null) setButlerSelf(payload);
        mark("self");
      }),
    ]);
    if (trackInitial) setInitialLoad((current) => ({ ...current, finished: true }));
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEventStream({
    prefixes: ["job-event", "upgrade", "snapshot"],
    onSignal: () => {
      void refresh();
    },
    throttleMs: REFRESH_THROTTLE_MS,
  });

  usePolling(
    () => {
      void refresh();
    },
    butlerSelf?.lastJob?.status === "running" ? SELF_JOB_POLL_MS : null,
  );

  usePolling(
    () => {
      void refresh();
    },
    managedUpgradePending !== null || data?.upgradeJob?.status === "running"
      ? UPGRADE_POLL_MS
      : null,
  );

  useEffect(() => {
    if (managedUpgradePending === null) return;
    const serverJob = data?.upgradeJob;
    if (serverJob === null || serverJob === undefined) return;
    const matches =
      managedUpgradePending.jobId !== null
        ? serverJob.jobId === managedUpgradePending.jobId
        : serverJob.status === "running" &&
          serverJob.targetVersion === managedUpgradePending.target.version;
    if (matches) setManagedUpgradePending(null);
  }, [data?.upgradeJob, managedUpgradePending]);

  const instances = useMemo(() => data?.instances ?? [], [data]);
  const snapshots = useMemo(() => data?.snapshots ?? [], [data]);
  const available = data?.availableVersions ?? null;
  const job = data?.upgradeJob ?? null;
  const targetInstance = selectedInstance || instances[0]?.instanceId || "";
  const currentVersion =
    instances.find((instance) => instance.instanceId === targetInstance)?.version ??
    instances[0]?.version ??
    "";

  const upgradeCandidates = useMemo(() => {
    if (available === null || !available.reachable) return [];
    return available.versions
      .filter(
        (entry) =>
          currentVersion === "" || compareVersion(versionComparable(entry), currentVersion) > 0,
      )
      .sort((left, right) => compareVersion(versionComparable(right), versionComparable(left)))
      .slice(0, 1);
  }, [available, currentVersion]);

  const precheckStep = job?.steps.find((step) => step.id === "precheck") ?? null;
  const precheck = useMemo(() => parsePrecheckDetail(precheckStep?.detail), [precheckStep]);

  const previousSnapshot = useMemo(
    () =>
      snapshots
        .filter(
          (snapshot) =>
            snapshot.status === "ok" &&
            (targetInstance === "" || snapshot.instance === targetInstance),
        )
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null,
    [snapshots, targetInstance],
  );

  const selfUpgradeCandidate = useMemo<ButlerAvailableUpdate | null>(() => {
    if (butlerSelf === null) return null;
    return (
      butlerSelf.availableUpdates
        .filter(
          (entry) =>
            (entry.channel === undefined || entry.channel === butlerSelf.prefs.channel) &&
            (butlerSelf.commit === null || entry.commit !== butlerSelf.commit) &&
            compareVersion(entry.version, butlerSelf.version) > 0,
        )
        .sort((left, right) => compareVersion(right.version, left.version))[0] ?? null
    );
  }, [butlerSelf]);

  const previousSelfSnapshot: ButlerSelfSnapshot | null = butlerSelf?.snapshots[0] ?? null;

  const selfProgressSteps: PageProgressStep[] = useMemo(() => {
    if (butlerSelf?.lastJob?.status !== "running") return [];
    const lastJob = butlerSelf.lastJob;
    const currentIndex = Math.max(
      0,
      SELF_PROGRESS_PHASES.findIndex((phase) => phase.id === lastJob.phase),
    );
    return SELF_PROGRESS_PHASES.map((phase, index) => ({
      label: phase.label,
      state: index < currentIndex ? "done" : index === currentIndex ? "active" : "pending",
    }));
  }, [butlerSelf]);

  const upgradeProgress = useMemo(
    () => managedUpgradeProgress(job, managedUpgradePending?.target ?? null),
    [job, managedUpgradePending],
  );

  const executeSelfUpgrade = async (target: ButlerAvailableUpdate) => {
    if (selfBusy) return;
    setSelfBusy(true);
    const result = await postJson(
      "/api/butler/self/upgrade",
      { target: target.tag ?? target.version, channel: target.channel, confirmed: true },
      10 * 60_000,
    );
    setSelfBusy(false);
    if (result.status === 202) {
      message.success(`管家自身开始升级到 ${target.version}，进度会自动更新`);
      void refresh();
    } else if (result.status === 400) {
      message.error("管家自身升级请求被拒绝（可能已锁定版本或缺少目标版本）");
    } else if (result.status === 409) {
      message.error("管家自身已经有升级或回滚正在进行，请等它完成");
    } else if (result.status === 503) {
      message.error("自更新服务暂不可用，请确认 updater sidecar 已启动");
    } else {
      message.error("发起管家自身升级失败，请稍后重试");
    }
  };

  const requestSelfUpgrade = (target: ButlerAvailableUpdate) => {
    setConfirmAction({ kind: "self-upgrade", target });
  };

  const executeSelfRollback = async (snapshot: ButlerSelfSnapshot) => {
    if (selfBusy) return;
    setSelfBusy(true);
    const result = await postJson(
      "/api/butler/self/rollback",
      { snapshotId: snapshot.id, confirmed: true },
      10_000,
    );
    setSelfBusy(false);
    if (result.status === 202) {
      message.success(`已开始回滚到 ${snapshot.version}（${snapshot.commit}），进度会自动更新`);
      void refresh();
    } else if (result.status === 404) {
      message.error("没有找到这个快照，可能已被轮转清理");
    } else if (result.status === 409) {
      message.error("管家自身已经有升级或回滚正在进行，请等它完成");
    } else if (result.status === 503) {
      message.error("自更新服务暂不可用，请确认 updater sidecar 已启动");
    } else {
      message.error("发起回滚失败，请稍后重试");
    }
  };

  const requestSelfRollback = (snapshot: ButlerSelfSnapshot) => {
    setConfirmAction({ kind: "self-rollback", snapshot });
  };

  const saveSelfPrefs = async (channel: ButlerSelfPrefs["channel"], locked: boolean) => {
    if (selfBusy) return;
    setSelfBusy(true);
    const result = await postJson("/api/butler/self/prefs", { channel, locked }, 10_000);
    setSelfBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      const next = result.data as ButlerSelfPrefs;
      setButlerSelf((current) =>
        current === null ? current : { ...current, prefs: next },
      );
      message.success("管家自身更新偏好已保存");
    } else {
      message.error("保存更新偏好失败，请稍后重试");
    }
  };

  const executeUpgrade = async (target: ManagedUpgradeTarget) => {
    if (managedUpgradePending !== null || job?.status === "running") return;
    setManagedUpgradePending({ target, jobId: null });
    const body: { targetVersion: string; channel?: string; instanceId?: string } = {
      targetVersion: target.version,
    };
    if (target.channel !== undefined && target.channel !== "") body.channel = target.channel;
    if (targetInstance !== "") body.instanceId = targetInstance;

    const result = await postJson("/api/upgrade/run", body, 120_000);
    if (result.status === 202) {
      const response = isRecord(result.data) ? result.data : null;
      const jobId =
        response !== null && typeof response.jobId === "string" ? response.jobId : null;
      setManagedUpgradePending((current) =>
        current === null ? null : { ...current, jobId },
      );
      message.success(`已开始升级到 ${target.displayVersion ?? target.version}，进度会自动更新`);
      await refresh();
    } else if (result.status === 400) {
      setManagedUpgradePending(null);
      const err =
        isRecord(result.data) && typeof result.data.error === "string" ? result.data.error : "";
      message.error(`升级请求被拒绝${err !== "" ? `：${err}` : "，请稍后重试"}`);
    } else if (result.status === 409) {
      setManagedUpgradePending(null);
      message.error("已经有升级正在进行，请等它完成后再试");
    } else if (result.status === 0) {
      message.warning("请求等待超时，正在继续查询后台升级任务，请不要重复点击");
      await refresh();
    } else if (result.status === 502) {
      setManagedUpgradePending(null);
      message.error("管家服务暂时连不上，无法发起升级");
    } else if (result.status === 503) {
      setManagedUpgradePending(null);
      message.error("暂时没有可以升级的管家");
    } else {
      setManagedUpgradePending(null);
      message.error("发起升级失败，请稍后重试");
    }
  };

  const requestUpgrade = (target: ManagedUpgradeTarget) => {
    setConfirmAction({ kind: "upgrade", target });
  };

  const executeRollback = async (snapshot: SnapshotView) => {
    if (rollbackBusy) return;
    setRollbackBusy(true);
    const result = await postJson(
      `/api/snapshots/${encodeURIComponent(String(snapshot.id))}/rollback`,
    );
    setRollbackBusy(false);
    if (result.status === 200) {
      message.success(`已开始还原备份 #${snapshot.id}，进度会自动更新`);
    } else if (result.status === 404) {
      message.error(`没有找到备份 #${snapshot.id}`);
    } else if (result.status === 502) {
      message.error("管家服务暂时连不上，无法还原");
    } else if (result.status === 503) {
      message.error("暂时没有可以还原的管家");
    } else {
      message.error("还原失败，请稍后重试");
    }
  };

  const requestRollback = (snapshot: SnapshotView) => {
    setConfirmAction({ kind: "rollback", snapshot });
  };

  const confirmActionExecute = async () => {
    if (confirmAction === null || confirmBusy) return;
    const action = confirmAction;
    setConfirmBusy(true);
    try {
      if (action.kind === "upgrade") {
        await executeUpgrade(action.target);
      } else if (action.kind === "rollback") {
        await executeRollback(action.snapshot);
      } else if (action.kind === "self-upgrade") {
        await executeSelfUpgrade(action.target);
      } else {
        await executeSelfRollback(action.snapshot);
      }
    } finally {
      setConfirmBusy(false);
      setConfirmAction(null);
    }
  };

  if (!initialLoad.finished) {
    return (
      <section className="page product-page versions-page">
        <header className="page-heading product-heading">
          <div>
            <span className="product-eyebrow">版本管理</span>
            <h1>正在确认可用版本</h1>
            <p className="hint">正在读取当前版本、最新更新和上一版本恢复点。</p>
          </div>
        </header>
        <PageProgress
          title="正在加载版本信息"
          detail="三组真实数据会分别完成；全部读取后自动进入版本管理。"
          steps={[
            { label: "受管 AI 版本", state: initialLoad.managed ? "done" : "active" },
            {
              label: "管家当前版本",
              state: initialLoad.butler ? "done" : initialLoad.managed ? "active" : "pending",
            },
            {
              label: "更新与恢复点",
              state: initialLoad.self ? "done" : initialLoad.butler ? "active" : "pending",
            },
          ]}
        />
      </section>
    );
  }

  return (
    <section className="page product-page versions-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">更新与恢复</span>
          <h1>版本管理</h1>
          <p className="hint">这里只显示当前版本、最新更新和退回上一版本，不展示冗长历史。</p>
        </div>
        <ConnectionChip
          reachable={data?.watchReachable ?? false}
          onlineText="管家服务已连接"
          offlineText="管家服务暂时连不上"
        />
      </header>
      {butlerSelf?.lastJob?.status === "running" && (
        <PageProgress
          compact
          title={butlerSelf.lastJob.kind === "upgrade" ? "正在更新管家自身" : "正在退回上一版本"}
          detail="页面会持续读取真实任务状态，服务重启期间无需重复点击。"
          steps={selfProgressSteps}
        />
      )}
      {(data?.degraded ?? []).includes("db:unreachable") && (
        <DegradedBanner
          severity="warn"
          message="本地数据暂时读不到：管家与备份信息需要等管家重新连接后查看。"
        />
      )}

      <h2 className="section-title">管家自身</h2>
      <SelfUpgradeCard
        butler={butler}
        butlerSelf={butlerSelf}
        candidate={selfUpgradeCandidate}
        previousSelfSnapshot={previousSelfSnapshot}
        selfBusy={selfBusy}
        onSavePrefs={(channel, locked) => void saveSelfPrefs(channel, locked)}
        onRequestUpgrade={requestSelfUpgrade}
        onRequestRollback={requestSelfRollback}
      />

      <h2 className="section-title">当前使用的版本</h2>
      <ManagedInstances instances={instances} />

      <h2 className="section-title">最新可升级版本</h2>
      <CandidateList
        available={available}
        watchReachable={data?.watchReachable}
        instances={instances}
        targetInstance={targetInstance}
        currentVersion={currentVersion}
        candidates={upgradeCandidates}
        launchPending={managedUpgradePending !== null}
        jobRunning={job?.status === "running"}
        onSelectInstance={setSelectedInstance}
        onUpgrade={requestUpgrade}
        onRefresh={() => void refresh()}
      />

      <h2 className="section-title">升级进度</h2>
      <UpgradePipeline
        job={job}
        launchPending={managedUpgradePending !== null}
        progress={upgradeProgress}
      />

      <h2 className="section-title">升级前检查</h2>
      <PrecheckList step={precheckStep} precheck={precheck} />

      <h2 className="section-title">备份节奏</h2>
      <BackupCadenceChart
        snapshots={snapshots}
        selfSnapshots={butlerSelf?.snapshots ?? []}
        mode={mode}
      />

      <h2 className="section-title">退回上一版本</h2>
      <SnapshotRollback snapshot={previousSnapshot} onRollback={requestRollback} />

      {confirmAction !== null && (
        <DangerConfirmModal
          open
          title={
            confirmAction.kind === "self-upgrade"
              ? "确认升级管家自身"
              : confirmAction.kind === "self-rollback"
                ? "确认回滚管家自身"
                : confirmAction.kind === "upgrade"
                  ? "确认升级"
                  : "确认还原备份"
          }
          busy={confirmBusy}
          confirmLabel={
            confirmAction.kind === "self-upgrade" || confirmAction.kind === "upgrade"
              ? "确认升级"
              : confirmAction.kind === "self-rollback"
                ? "确认回滚"
                : "确认还原"
          }
          impact="请确认你理解这次操作的影响；管家只会在你确认后执行。"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void confirmActionExecute()}
        >
          {confirmAction.kind === "self-upgrade" ? (
            <p>
              管家自身会升级到 <strong>{confirmAction.target.version}</strong>
              {confirmAction.target.commit !== null ? `（commit ${confirmAction.target.commit}）` : ""}。
              升级前自动备份，失败自动回滚；期间管家服务会短暂重启。
            </p>
          ) : confirmAction.kind === "self-rollback" ? (
            <p>
              管家自身会回滚到 <strong>{confirmAction.snapshot.version}</strong>（commit{" "}
              <code>{confirmAction.snapshot.commit}</code>），并重新构建、重启管家服务。
            </p>
          ) : confirmAction.kind === "upgrade" ? (
            <p>
              管家会把当前 AI 升级到{" "}
              <strong>{confirmAction.target.displayVersion ?? confirmAction.target.version}</strong>。
              升级前会自动备份，失败会自动还原；期间本机 AI 会短暂不可用。
            </p>
          ) : (
            <p>
              管家会用备份 <strong>#{confirmAction.snapshot.id}</strong> 还原{" "}
              <strong>{instanceLabel(confirmAction.snapshot.instance)}</strong>。 还原期间，本机
              AI 会短暂不可用。
            </p>
          )}
        </DangerConfirmModal>
      )}
    </section>
  );
}
