/**
 * 设置页 · 关于面板：Chrome 式「状态优先」布局。
 * 顶部一行产品名+版本，中间一行动态状态（最新/有更新/更新中/回滚中），
 * 次要功能（受管实例、更新偏好、回滚、备份节奏）收进可展开的简单行。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { App, Button, Card, Flex, Select, Spin, Switch, Typography } from "antd";
import { CheckCircleFilled, DownOutlined, UpOutlined } from "@ant-design/icons";
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
import { SnapshotRollback } from "./SnapshotRollback.js";
import { UpgradePipeline } from "./UpgradePipeline.js";
import { BackupCadenceChart } from "./BackupCadenceChart.js";
import {
  instanceLabel,
  managedUpgradeProgress,
  parsePrecheckDetail,
  versionComparable,
} from "./helpers.js";
import type {
  ButlerAvailableUpdate,
  ButlerSelfSnapshot,
  ButlerSelfPrefs,
  ButlerSelfView,
  ButlerVersionView,
  ConfirmAction,
  ManagedUpgradeTarget,
  PendingManagedUpgrade,
  SnapshotView,
  VersionsPayload,
} from "./types.js";

const { Text, Title } = Typography;

const REFRESH_THROTTLE_MS = 5000;
const SELF_JOB_POLL_MS = 5000;
const SELF_REFRESH_TIMEOUT_MS = 30_000;
const UPGRADE_POLL_MS = 2000;

export function VersionsPanel() {
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
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    await Promise.all([
      fetchJson<VersionsPayload>("/api/versions").then((payload) => {
        if (payload !== null) setData(payload);
      }),
      fetchJson<ButlerVersionView>("/api/butler/version").then((payload) => {
        if (payload !== null) setButler(payload);
      }),
      fetchJson<ButlerSelfView>("/api/butler/self", SELF_REFRESH_TIMEOUT_MS).then((payload) => {
        if (payload !== null) setButlerSelf(payload);
      }),
    ]);
  }, []);

  useEffect(() => {
    void refresh();
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
      message.success("更新偏好已保存");
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

  const requestUpgrade = (target: ManagedUpgradeTarget) => {
    setConfirmAction({ kind: "upgrade", target });
  };

  const requestSelfRollback = (snapshot: ButlerSelfSnapshot) => {
    setConfirmAction({ kind: "self-rollback", snapshot });
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

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ---- 状态行：更新中 > 回滚中 > 有可用更新 > 已是最新 ---- */
  const prefs = butlerSelf?.prefs ?? { channel: "beta" as const, locked: false };
  const runningSelfJob = butlerSelf?.lastJob?.status === "running" ? butlerSelf.lastJob : null;
  const managedRunning =
    managedUpgradePending !== null || job?.status === "running" ? { target: managedUpgradePending?.target ?? null } : null;
  const displayVersion =
    butler?.version ?? butlerSelf?.version ?? (butlerSelf?.commit ? butlerSelf.commit : null);

  let statusLine: ReactElement;
  if (runningSelfJob !== null) {
    statusLine = (
      <Flex align="center" gap={10}>
        <Spin />
        <Text>
          {runningSelfJob.kind === "upgrade" ? "正在更新管家" : "正在回滚管家"}
          {displayVersion !== null ? `（版本 ${displayVersion}）` : ""}
        </Text>
      </Flex>
    );
  } else if (managedRunning !== null) {
    statusLine = (
      <Flex align="center" gap={10}>
        <Spin />
        <Text>
          正在升级受管实例
          {managedRunning.target !== null
            ? `（目标 ${managedRunning.target.displayVersion ?? managedRunning.target.version}）`
            : ""}
        </Text>
      </Flex>
    );
  } else if (selfUpgradeCandidate !== null) {
    statusLine = (
      <Flex wrap align="center" gap={12}>
        <Text>
          有可用更新 <Text strong>{selfUpgradeCandidate.version}</Text>
          （{selfUpgradeCandidate.channel === "beta" ? "测试" : "正式"} 通道）
        </Text>
        <Button
          type="primary"
          size="small"
          disabled={selfBusy || prefs.locked}
          onClick={() => setConfirmAction({ kind: "self-upgrade", target: selfUpgradeCandidate })}
        >
          更新管家
        </Button>
      </Flex>
    );
  } else {
    statusLine = (
      <Flex align="center" gap={8}>
        <CheckCircleFilled style={{ color: "var(--ant-color-success)" }} />
        <Text>已是最新版本</Text>
      </Flex>
    );
  }

  const rowItems: Array<{ key: string; label: string; content: ReactElement }> = [
    {
      key: "instances",
      label: "受管实例版本与候选升级",
      content: (
        <Flex vertical gap={16}>
          <ManagedInstances instances={instances} />
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
          {(job?.status === "running" || managedUpgradePending !== null) && (
            <UpgradePipeline
              job={job}
              launchPending={managedUpgradePending !== null}
              progress={upgradeProgress}
            />
          )}
          {precheckStep !== null && <PrecheckList step={precheckStep} precheck={precheck} />}
        </Flex>
      ),
    },
    {
      key: "prefs",
      label: "更新偏好",
      content: (
        <Flex wrap gap={16} align="center">
          <Flex align="center" gap={8}>
            <Text type="secondary">更新通道</Text>
            <Select
              size="small"
              style={{ minWidth: 120 }}
              value={prefs.channel}
              onChange={(value) => void saveSelfPrefs(value, prefs.locked)}
              options={[
                { value: "beta", label: "测试版（beta 标签）" },
                { value: "stable", label: "稳定版（正式标签）" },
              ]}
            />
          </Flex>
          <Flex align="center" gap={8}>
            <Text type="secondary">锁定版本</Text>
            <Switch
              size="small"
              checked={prefs.locked}
              onChange={(locked) => void saveSelfPrefs(prefs.channel, locked)}
            />
          </Flex>
          <Text type="secondary" style={{ fontSize: 12 }}>
            本项目当前以 beta 标签发布，默认测试版通道即可收到更新。
          </Text>
        </Flex>
      ),
    },
    {
      key: "rollback-self",
      label: "回滚管家自身",
      content:
        previousSelfSnapshot === null ? (
          <Text type="secondary">还没有可回滚的自身升级快照。</Text>
        ) : (
          <Flex wrap gap={12} align="center">
            <Text>
              上一次升级：{previousSelfSnapshot.version}（commit {previousSelfSnapshot.commit}）
            </Text>
            <Button size="small" disabled={selfBusy} onClick={() => requestSelfRollback(previousSelfSnapshot)}>
              回滚到该版本
            </Button>
          </Flex>
        ),
    },
    {
      key: "rollback-snapshot",
      label: "还原受管实例（备份）",
      content:
        previousSnapshot === null ? (
          <Text type="secondary">还没有可用的实例备份。</Text>
        ) : (
          <SnapshotRollback snapshot={previousSnapshot} onRollback={requestRollback} />
        ),
    },
    {
      key: "cadence",
      label: "备份节奏趋势",
      content: (
        <BackupCadenceChart
          snapshots={snapshots}
          selfSnapshots={butlerSelf?.snapshots ?? []}
          mode={mode}
        />
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      {(data?.degraded ?? []).includes("db:unreachable") && (
        <DegradedBanner
          severity="warn"
          message="本地数据暂时读不到：管家与备份信息需要等管家重新连接后查看。"
        />
      )}

      <Card>
        <Flex vertical gap={16}>
          <Flex align="center" gap={16}>
            <div
              aria-hidden="true"
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: "var(--ant-color-primary-bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
              }}
            >
              🤖
            </div>
            <Flex vertical gap={2}>
              <Title level={4} style={{ marginBottom: 0 }}>
                管家 Butler
              </Title>
              <Text type="secondary">
                版本 {displayVersion ?? "—"}
                （{prefs.channel === "beta" ? "测试版" : "正式版"} 通道
                {butlerSelf?.commit !== null && butlerSelf?.commit !== undefined
                  ? ` · commit ${butlerSelf.commit}`
                  : ""}
                ）
              </Text>
            </Flex>
          </Flex>
          {statusLine}
        </Flex>
      </Card>

      <Card size="small" styles={{ body: { paddingInline: 0, paddingBlock: 0 } }}>
        {rowItems.map((row, index) => {
          const isExpanded = expandedRows.has(row.key);
          return (
            <div
              key={row.key}
              role="button"
              aria-expanded={isExpanded}
              onClick={() => toggleRow(row.key)}
              style={{
                cursor: "pointer",
                padding: "14px 16px",
                borderTop: index === 0 ? "none" : "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Flex justify="space-between" align="center" gap={12}>
                <Text>{row.label}</Text>
                {isExpanded ? (
                  <UpOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />
                ) : (
                  <DownOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />
                )}
              </Flex>
              {isExpanded && (
                <div style={{ paddingTop: 12, cursor: "default" }} onClick={(e) => e.stopPropagation()}>
                  {row.content}
                </div>
              )}
            </div>
          );
        })}
      </Card>

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
    </Flex>
  );
}
