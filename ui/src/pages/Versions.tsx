/**
 * 版本管理（Task 13.3）：升级流水线与快照回滚的展示入口。
 *
 * - 首屏经 /api/versions 聚合端点一次取齐（实例当前版本 / 升级 Job /
 *   可用版本源 / 快照历史）；
 * - 之后复用 /ws 事件流机制（同 Dashboard 的连接方式）：
 *   收到 type 以 "job-event" 开头的事件时节流 5s 重新拉取；
 * - 升级发起与快照回滚为"触发即走"；请求提交后立即显示本地启动进度，
 *   再由主动轮询与事件流接管真实 Job 状态；
 * - watch 控制通道离线（availableVersions.reachable=false）时显示降级横幅；
 *   db 不可达（degraded 含 db:unreachable）时实例与快照降级为空列表。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PageProgress, type PageProgressStep } from "../components/PageProgress.js";
import { fetchJson, postJson } from "../lib/api.js";
import { disposeWebSocket } from "../lib/websocket.js";

/* --------------------------------- 数据类型 -------------------------------- */

interface InstanceView {
  instanceId: string;
  state: string;
  runtime: string;
  version: string | null;
}

interface UpgradeStepView {
  id: string;
  label: string;
  status: string;
  detail?: string;
}

interface UpgradeJobView {
  jobId: string;
  instanceId: string;
  targetVersion: string;
  channel?: string;
  trigger?: string;
  status: string;
  rolledBack?: boolean;
  snapshotId?: string;
  steps: UpgradeStepView[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface ManagedUpgradeTarget {
  version: string;
  channel?: string;
  displayVersion?: string;
}

interface PendingManagedUpgrade {
  target: ManagedUpgradeTarget;
  jobId: string | null;
}

interface AvailableVersionEntry {
  version: string;
  channel?: string;
  displayVersion?: string;
  notes?: string;
  publishedAt?: string;
}

interface AvailableVersionsView {
  reachable: boolean;
  source?: string;
  versions: AvailableVersionEntry[];
}

interface SnapshotView {
  id: number;
  instance: string;
  label: string | null;
  createdAt: string;
  status: string;
}

interface VersionsPayload {
  instances?: InstanceView[];
  upgradeJob?: UpgradeJobView | null;
  availableVersions?: AvailableVersionsView;
  snapshots?: SnapshotView[];
  watchReachable?: boolean;
  degraded?: string[];
}

interface ButlerVersionView {
  reachable: boolean;
  version: string | null;
  source: string | null;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  changelog?: Array<{ hash: string; subject: string; at: string }> | null;
  checkedAt: string | null;
}

interface ButlerSelfPrefs {
  channel: "stable" | "beta";
  locked: boolean;
}

interface ButlerSelfSnapshot {
  id: string;
  at: string;
  version: string;
  commit: string;
  tag: string | null;
  channel: string;
  reason: string;
  backupId: number | null;
}

interface ButlerSelfJobView {
  jobId: string;
  kind: "upgrade" | "rollback";
  status: "running" | "done" | "failed" | "rolled-back";
  phase: string;
  target: string;
  from: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
}

interface ButlerAvailableUpdate {
  version: string;
  channel: "stable" | "beta";
  commit: string | null;
  tag: string | null;
  notes?: string;
}

interface ButlerSelfView {
  reachable: boolean;
  source: string;
  version: string;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  repoClean: boolean;
  remoteConfigured: boolean;
  prefs: ButlerSelfPrefs;
  snapshots: ButlerSelfSnapshot[];
  availableUpdates: ButlerAvailableUpdate[];
  lastJob: ButlerSelfJobView | null;
  checkedAt: string;
}

/** 事件流节流刷新间隔（收到 job-event* 事件后最多每 5s 拉一次聚合端点）。 */
const REFRESH_THROTTLE_MS = 5000;

/** 触发版本页刷新的事件类型前缀（升级/回滚 Job 进度事件族）。 */
const REFRESH_EVENT_PREFIX = "job-event";

/** 无 Job 时的静态预检说明清单（发起升级时由 watch 自动执行）。 */
const STATIC_PRECHECKS = ["文件可以访问", "管家可以运行", "版本有差异"];

/** 预检结果项（precheck 步骤 detail 的结构化形态，尽力解析）。 */
interface PrecheckItem {
  id: string;
  status: string;
  detail?: string;
}

type ConfirmAction =
  | { kind: "upgrade"; target: ManagedUpgradeTarget }
  | { kind: "rollback"; snapshot: SnapshotView }
  | { kind: "self-upgrade"; target: ButlerAvailableUpdate }
  | { kind: "self-rollback"; snapshot: ButlerSelfSnapshot };

function isRefreshRelevant(type: string): boolean {
  return type.startsWith(REFRESH_EVENT_PREFIX);
}

function instanceLabel(instanceId: string): string {
  if (instanceId === "hermes-main") return "Hermes 主实例";
  if (instanceId === "") return "主实例";
  return instanceId;
}

function instanceRuntimeLabel(runtime: string): string {
  const value = runtime.toLowerCase();
  if (value.includes("process")) return "本机运行";
  if (value.includes("docker") || value.includes("container")) return "容器运行";
  return runtime || "—";
}

function instanceStateLabel(state: string): string {
  return stateBadge(state).label;
}

/* --------------------------------- 展示辅助 -------------------------------- */

/** 实例状态徽标：运行绿 / 崩溃红 / 停止灰 / 其他黄。 */
function stateBadge(state: string): { cls: string; label: string } {
  const s = state.toLowerCase();
  if (s.includes("crash")) return { cls: "badge-down", label: "异常" };
  if (["serving", "running", "active"].includes(s))
    return { cls: "badge-healthy", label: "运行中" };
  if (["stopped", "removed", "idle"].includes(s)) return { cls: "badge-muted", label: "已停止" };
  return { cls: "badge-degraded", label: state || "未知" };
}

/** job 级状态徽标：running 黄（脉动）/ done 绿 / failed 红。 */
function jobBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "running":
      return { cls: "badge-degraded badge-pulse", label: "进行中" };
    case "done":
      return { cls: "badge-healthy", label: "已完成" };
    case "failed":
      return { cls: "badge-down", label: "失败" };
    case "pending":
      return { cls: "badge-muted", label: "等待中" };
    case "cancelled":
      return { cls: "badge-muted", label: "已取消" };
    case "rolled-back":
      return { cls: "badge-degraded", label: "已自动回滚" };
    default:
      return { cls: "badge-muted", label: status || "未知" };
  }
}

/** 步骤状态徽标：running 黄（脉动）/ passed 绿 / failed 红 / pending、skipped 灰。 */
function stepBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "running":
      return { cls: "badge-degraded badge-pulse", label: "进行中" };
    case "passed":
      return { cls: "badge-healthy", label: "已通过" };
    case "failed":
      return { cls: "badge-down", label: "失败" };
    case "skipped":
      return { cls: "badge-muted", label: "已跳过" };
    case "pending":
      return { cls: "badge-muted", label: "等待中" };
    default:
      return { cls: "badge-muted", label: status || "未知" };
  }
}

/** channel 徽标：stable 绿 / beta 黄 / 其他灰。 */
function channelBadge(channel: string): { cls: string; label: string } {
  if (channel === "stable") return { cls: "badge-healthy", label: "稳定版" };
  if (channel === "beta") return { cls: "badge-degraded", label: "测试版" };
  return { cls: "badge-muted", label: channel || "未知" };
}

/** 预检项状态徽标：pass/passed/ok 绿 / fail/failed 红 / warn 黄 / 其他灰。 */
function precheckBadge(status: string): { cls: string; label: string } {
  const s = status.toLowerCase();
  if (["pass", "passed", "ok"].includes(s)) return { cls: "badge-healthy", label: "通过" };
  if (["fail", "failed"].includes(s)) return { cls: "badge-down", label: "失败" };
  if (s === "warn") return { cls: "badge-degraded", label: "需留意" };
  return { cls: "badge-muted", label: status || "未知" };
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，异常回退原始字符串。 */
function formatRelative(ts: string | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "—";
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return ts;
  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return "刚刚";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return `${Math.floor(diffMs / 86_400_000)} 天前`;
}

/** SemVer 近似比较，保留 beta/预发布编号，避免 beta.3 被误判为 beta.2 同版本。 */
function compareVersion(a: string, b: string): number {
  const normalize = (value: string) => {
    const normalized = value.trim().replace(/^v/i, "").split("+")[0] ?? "";
    const [core, pre = ""] = normalized.split("-");
    return { core: core.split(".").map((part) => Number(part) || 0), pre: pre === "" ? [] : pre.split(".") };
  };
  const left = normalize(a);
  const right = normalize(b);
  const pa = left.core;
  const pb = right.core;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) - Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l.localeCompare(r);
  }
  return 0;
}

/** 版本条目展示名：优先发布说明里的版本号，否则用更新标签。 */
function versionDisplay(entry: AvailableVersionEntry): string {
  return entry.displayVersion !== undefined && entry.displayVersion !== ""
    ? entry.displayVersion
    : entry.version;
}

function versionComparable(entry: AvailableVersionEntry): string {
  return entry.version !== "" ? entry.version : versionDisplay(entry);
}

/** 更新来源的中文名。 */
function versionSourceLabel(source: string): string {
  if (source === "github-releases") return "GitHub 官方发布";
  if (source === "github-releases-mirror") return "GitHub 镜像源";
  if (source === "docker-hub") return "Docker 镜像";
  return source;
}

/** 发布时间的短格式（如 8 月 21 日发布）。 */
function formatPublishedAt(ts: string | undefined): string {
  if (ts === undefined || ts === "") return "";
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return ts;
  const date = new Date(time);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日发布`;
}

/** 从响应体提取 error 字段（无则空串）。 */
function errorText(data: unknown): string {
  if (data !== null && typeof data === "object") {
    const err = (data as Record<string, unknown>)["error"];
    if (typeof err === "string") return err;
  }
  return "";
}

function progressStepState(status: string): PageProgressStep["state"] {
  if (["passed", "done", "skipped"].includes(status)) return "done";
  if (status === "running") return "active";
  if (status === "failed") return "failed";
  return "pending";
}

export function managedUpgradeProgress(
  job: UpgradeJobView | null,
  pendingTarget: ManagedUpgradeTarget | null,
): {
  title: string;
  detail: string;
  indeterminate: boolean;
  steps: PageProgressStep[];
} | null {
  if (job?.status === "running") {
    return {
      title: `正在把 ${instanceLabel(job.instanceId)} 更新到 ${job.targetVersion}`,
      detail: "当前步骤完成后会自动进入下一步；失败时会使用上一版本恢复点。",
      indeterminate: false,
      steps: job.steps.map((step) => ({
        label: step.label,
        state: progressStepState(step.status),
      })),
    };
  }
  if (pendingTarget !== null) {
    return {
      title: `正在启动升级到 ${pendingTarget.displayVersion ?? pendingTarget.version}`,
      detail: "正在提交升级任务并等待管家返回第一步状态，请不要重复点击。",
      indeterminate: true,
      steps: [],
    };
  }
  return null;
}

const SELF_PROGRESS_PHASES = [
  { id: "snapshot", label: "保存上一版本" },
  { id: "checkout", label: "切换代码" },
  { id: "install-build", label: "安装并构建" },
  { id: "restart", label: "重启服务" },
  { id: "verify", label: "确认可用" },
] as const;

/**
 * 解析 precheck 步骤的 detail：
 * JSON 数组（元素含 id/name + status）→ 结构化清单；其他 → 按行拆分的纯文本。
 */
function parsePrecheckDetail(detail: string | undefined): {
  items: PrecheckItem[];
  lines: string[];
} {
  if (detail === undefined || detail === "") return { items: [], lines: [] };
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (Array.isArray(parsed)) {
      const items: PrecheckItem[] = [];
      for (const entry of parsed) {
        if (entry === null || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const id =
          typeof row["id"] === "string"
            ? row["id"]
            : typeof row["name"] === "string"
              ? row["name"]
              : "";
        if (id === "") continue;
        items.push({
          id,
          status: typeof row["status"] === "string" ? row["status"] : "unknown",
          detail: typeof row["detail"] === "string" ? row["detail"] : undefined,
        });
      }
      if (items.length > 0) return { items, lines: [] };
    }
  } catch {
    // 非 JSON：按纯文本行展示
  }
  const lines = detail
    .split(/\r?\n|；/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { items: [], lines };
}

/* --------------------------------- 页面主体 -------------------------------- */

export function VersionsPage() {
  const [data, setData] = useState<VersionsPayload | null>(null);
  const [butler, setButler] = useState<ButlerVersionView | null>(null);
  const [butlerSelf, setButlerSelf] = useState<ButlerSelfView | null>(null);
  const [selfBusy, setSelfBusy] = useState(false);
  const [managedUpgradePending, setManagedUpgradePending] =
    useState<PendingManagedUpgrade | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [selectedInstance, setSelectedInstance] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [initialLoad, setInitialLoad] = useState({
    managed: false,
    butler: false,
    self: false,
    finished: false,
  });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    },
    [],
  );

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

  // 首屏：聚合端点一次取齐。
  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // 实时性：复用 /ws 事件流机制（同 Dashboard），job-event* 事件触发节流 5s 的聚合刷新。
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = Date.now();
    let closed = false;

    const maybeRefresh = () => {
      const elapsed = Date.now() - lastRefresh;
      if (elapsed >= REFRESH_THROTTLE_MS) {
        lastRefresh = Date.now();
        void refresh();
        return;
      }
      if (pendingTimer === undefined) {
        pendingTimer = setTimeout(() => {
          pendingTimer = undefined;
          lastRefresh = Date.now();
          void refresh();
        }, REFRESH_THROTTLE_MS - elapsed);
      }
    };

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.onmessage = (msg) => {
        try {
          const frame = JSON.parse(msg.data as string) as {
            type?: string;
            items?: Array<{ type: string }>;
          };
          if (frame.type !== "events" || !Array.isArray(frame.items)) return;
          if (frame.items.some((event) => isRefreshRelevant(event.type))) maybeRefresh();
        } catch {
          // 忽略无法解析的帧
        }
      };
      socket.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 5000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      disposeWebSocket(socket);
    };
  }, [refresh]);

  // 管家自身升级/回滚在 detached 子进程执行：运行期间每 5s 轮询状态文件。
  useEffect(() => {
    if (butlerSelf?.lastJob?.status !== "running") return;
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [butlerSelf?.lastJob?.status, refresh]);

  // 受管实例升级不能只依赖 WebSocket：提交阶段和运行阶段都主动轮询真实 Job。
  useEffect(() => {
    if (managedUpgradePending === null && data?.upgradeJob?.status !== "running") return;
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [data?.upgradeJob?.status, managedUpgradePending, refresh]);

  // 服务端返回对应 Job 后，由真实五步进度接管本地启动态。
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

  const instances = data?.instances ?? [];
  const job = data?.upgradeJob ?? null;
  const available = data?.availableVersions ?? null;
  const snapshots = data?.snapshots ?? [];
  const targetInstance = selectedInstance || instances[0]?.instanceId || "";
  const currentVersion = instances.find((instance) => instance.instanceId === targetInstance)?.version ?? instances[0]?.version ?? "";
  const upgradeCandidates =
    available !== null && available.reachable
      ? available.versions
          .filter(
            (entry) =>
              currentVersion === "" || compareVersion(versionComparable(entry), currentVersion) > 0,
          )
          .sort((left, right) => compareVersion(versionComparable(right), versionComparable(left)))
          .slice(0, 1)
      : [];
  const precheckStep = job?.steps.find((step) => step.id === "precheck") ?? null;
  const precheck = parsePrecheckDetail(precheckStep?.detail);
  // 目标实例：未手动选择时默认第一个实例；无实例时留空（由 watch 自行选择服务实例）。
  const previousSnapshot = snapshots
    .filter(
      (snapshot) =>
        snapshot.status === "ok" &&
        (targetInstance === "" || snapshot.instance === targetInstance),
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  const selfUpgradeCandidate =
    butlerSelf?.availableUpdates
      .filter(
        (entry) =>
          (entry.channel === undefined || entry.channel === butlerSelf?.prefs.channel) &&
          (butlerSelf.commit === null || entry.commit !== butlerSelf.commit) &&
          compareVersion(entry.version, butlerSelf.version) > 0,
      )
      .sort((left, right) => compareVersion(right.version, left.version))[0] ?? null;
  const previousSelfSnapshot = butlerSelf?.snapshots[0] ?? null;
  const selfProgressSteps: PageProgressStep[] = (() => {
    if (butlerSelf?.lastJob?.status !== "running") return [];
    const currentIndex = Math.max(
      0,
      SELF_PROGRESS_PHASES.findIndex((phase) => phase.id === butlerSelf.lastJob?.phase),
    );
    return SELF_PROGRESS_PHASES.map((phase, index) => ({
      label: phase.label,
      state: index < currentIndex ? "done" : index === currentIndex ? "active" : "pending",
    }));
  })();
  const upgradeProgress = managedUpgradeProgress(
    job,
    managedUpgradePending?.target ?? null,
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
      showToast("ok", `管家自身开始升级到 ${target.version}，进度会自动更新`);
      void refresh();
    } else if (result.status === 400) {
      showToast("err", "管家自身升级请求被拒绝（可能已锁定版本或缺少目标版本）");
    } else if (result.status === 409) {
      showToast("err", "管家自身已经有升级或回滚正在进行，请等它完成");
    } else if (result.status === 503) {
      showToast("err", "源码目录还不是 Git 仓库，暂时不能自我升级");
    } else {
      showToast("err", "发起管家自身升级失败，请稍后重试");
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
      showToast("ok", `已开始回滚到 ${snapshot.version}（${snapshot.commit}），进度会自动更新`);
      void refresh();
    } else if (result.status === 404) {
      showToast("err", "没有找到这个快照，可能已被轮转清理");
    } else if (result.status === 409) {
      showToast("err", "管家自身已经有升级或回滚正在进行，请等它完成");
    } else if (result.status === 503) {
      showToast("err", "源码目录还不是 Git 仓库，暂时不能回滚");
    } else {
      showToast("err", "发起回滚失败，请稍后重试");
    }
  };

  const requestSelfRollback = (snapshot: ButlerSelfSnapshot) => {
    setConfirmAction({ kind: "self-rollback", snapshot });
  };

  const saveSelfPrefs = async (channel: "stable" | "beta", locked: boolean) => {
    if (selfBusy) return;
    setSelfBusy(true);
    const result = await postJson("/api/butler/self/prefs", { channel, locked }, 10_000);
    setSelfBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      const next = result.data as ButlerSelfPrefs;
      setButlerSelf((current) =>
        current === null ? current : { ...current, prefs: next },
      );
      showToast("ok", "管家自身更新偏好已保存");
    } else {
      showToast("err", "保存更新偏好失败，请稍后重试");
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

    const result = await postJson("/api/upgrade/run", body);
    if (result.status === 202) {
      const response =
        result.data !== null && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : null;
      const jobId = response !== null && typeof response["jobId"] === "string"
        ? response["jobId"]
        : null;
      setManagedUpgradePending((current) =>
        current === null ? null : { ...current, jobId },
      );
      showToast("ok", `已开始升级到 ${target.displayVersion ?? target.version}，进度会自动更新`);
      await refresh();
    } else if (result.status === 400) {
      setManagedUpgradePending(null);
      const err = errorText(result.data);
      showToast("err", `升级请求被拒绝${err !== "" ? `：${err}` : "，请稍后重试"}`);
    } else if (result.status === 409) {
      setManagedUpgradePending(null);
      showToast("err", "已经有升级正在进行，请等它完成后再试");
    } else if (result.status === 502) {
      setManagedUpgradePending(null);
      showToast("err", "管家服务暂时连不上，无法发起升级");
    } else if (result.status === 503) {
      setManagedUpgradePending(null);
      showToast("err", "暂时没有可以升级的管家");
    } else {
      setManagedUpgradePending(null);
      showToast("err", "发起升级失败，请稍后重试");
    }
  };

  const requestUpgrade = (target: ManagedUpgradeTarget) => {
    setConfirmAction({ kind: "upgrade", target });
  };

  const executeRollback = async (snapshot: SnapshotView) => {
    const result = await postJson(
      `/api/snapshots/${encodeURIComponent(String(snapshot.id))}/rollback`,
    );
    if (result.status === 200) {
      showToast("ok", `已开始还原备份 #${snapshot.id}，进度会自动更新`);
    } else if (result.status === 404) {
      showToast("err", `没有找到备份 #${snapshot.id}`);
    } else if (result.status === 502) {
      showToast("err", "管家服务暂时连不上，无法还原");
    } else if (result.status === 503) {
      showToast("err", "暂时没有可以还原的管家");
    } else {
      showToast("err", "还原失败，请稍后重试");
    }
  };

  const requestRollback = (snapshot: SnapshotView) => {
    setConfirmAction({ kind: "rollback", snapshot });
  };

  const confirmActionExecute = () => {
    if (confirmAction === null) return;
    const action = confirmAction;
    setConfirmAction(null);
    if (action.kind === "upgrade") {
      void executeUpgrade(action.target);
    } else if (action.kind === "rollback") {
      void executeRollback(action.snapshot);
    } else if (action.kind === "self-upgrade") {
      void executeSelfUpgrade(action.target);
    } else {
      void executeSelfRollback(action.snapshot);
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
        <span className={`page-live ${data?.watchReachable ? "is-online" : "is-offline"}`}>
          <i />
          {data?.watchReachable ? "管家服务已连接" : "管家服务暂时连不上"}
        </span>
      </header>
      {toast !== null && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
      {butlerSelf?.lastJob?.status === "running" && (
        <PageProgress
          compact
          title={butlerSelf.lastJob.kind === "upgrade" ? "正在更新管家自身" : "正在退回上一版本"}
          detail="页面会持续读取真实任务状态，服务重启期间无需重复点击。"
          steps={selfProgressSteps}
        />
      )}
      {(data?.degraded ?? []).includes("db:unreachable") && (
        <div className="banner banner-warn">
          ⚠ 本地数据暂时读不到：管家与备份信息需要等管家重新连接后查看。
        </div>
      )}

      <h2 className="section-title">管家自身</h2>
      <div className="card butler-version-card">
        {butler === null || butler.reachable !== true ? (
          <div className="empty-state">
            管家自身的版本信息暂时读不到；管家服务恢复后会显示在这里。
          </div>
        ) : (
          <>
            <div className="butler-version-main">
              <div>
                <span className="butler-version-label">Agent Butler</span>
                <strong className="butler-version-number">{butler.version ?? "版本未知"}</strong>
              </div>
              <span className="badge-pill badge-healthy">管家自身版本</span>
            </div>
            <dl className="kv butler-version-kv">
              <dt>代码仓库</dt>
              <dd>
                {butler.repository !== null && butler.repository !== "" ? (
                  <code title={butler.repository}>{butler.repository}</code>
                ) : (
                  "尚未配置源码仓库"
                )}
              </dd>
              <dt>分支 / 提交</dt>
              <dd>
                {butler.branch ?? "—"}
                {butler.commit !== null ? ` · ${butler.commit}` : ""}
              </dd>
              <dt>最近标签</dt>
              <dd>{butler.tag ?? "还没有打过 tag"}</dd>
              <dt>可用更新</dt>
              <dd>
                {butler.repository !== null && butler.repository !== ""
                  ? "仓库已连接，检查后在这里显示"
                  : "源码上传到仓库后自动检测"}
              </dd>
              <dt>源码位置</dt>
              <dd>
                <code title={butler.source ?? undefined}>{butler.source ?? "—"}</code>
              </dd>
            </dl>
            {butlerSelf !== null && butlerSelf.reachable && (
              <>
                <div className="butler-self-prefs">
                  <div>
                    <strong>更新偏好</strong>
                    <span>升级前会自动备份；失败自动回滚，不会让你自己处理。</span>
                  </div>
                  <div className="butler-self-prefs-controls">
                    <label className="field-label">
                      更新通道
                      <select
                        className="select"
                        value={butlerSelf.prefs.channel}
                        disabled={selfBusy}
                        onChange={(event) =>
                          void saveSelfPrefs(
                            event.target.value === "beta" ? "beta" : "stable",
                            butlerSelf.prefs.locked,
                          )
                        }
                      >
                        <option value="stable">稳定版</option>
                        <option value="beta">测试版（可能不稳定）</option>
                      </select>
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={butlerSelf.prefs.locked}
                        disabled={selfBusy}
                        onChange={(event) =>
                          void saveSelfPrefs(butlerSelf.prefs.channel, event.target.checked)
                        }
                      />
                      锁定版本（忽略更新提醒）
                    </label>
                  </div>
                </div>

                {butlerSelf.lastJob !== null && (
                  <div className="butler-self-job">
                    <div>
                      <strong>
                        {butlerSelf.lastJob.kind === "upgrade" ? "管家自身升级" : "管家自身回滚"}
                      </strong>
                      <span className={`badge-pill ${jobBadge(butlerSelf.lastJob.status).cls}`}>
                        {jobBadge(butlerSelf.lastJob.status).label}
                      </span>
                    </div>
                    <p>
                      {butlerSelf.lastJob.status === "running"
                        ? `正在${butlerSelf.lastJob.phase === "snapshot" ? "备份" : butlerSelf.lastJob.phase === "checkout" ? "切换版本" : butlerSelf.lastJob.phase === "install-build" ? "安装构建" : butlerSelf.lastJob.phase === "restart" ? "重启服务" : butlerSelf.lastJob.phase === "verify" ? "健康验收" : "处理"}中…`
                        : butlerSelf.lastJob.error ?? "已完成"}
                    </p>
                  </div>
                )}

                <div className="butler-self-updates">
                  <strong>最新可用版本</strong>
                  {selfUpgradeCandidate === null ? (
                    <p className="hint">
                      {butlerSelf.repository === null || butlerSelf.repository === ""
                        ? "没有检测到 Git 仓库地址，无法查询管家更新。请检查 BUTLER_SRC 与 origin。"
                        : butlerSelf.repoClean === false
                          ? "当前源码目录有未提交改动，升级入口已保护；请先提交或清理改动。"
                          : `已检查 ${formatRelative(butlerSelf.checkedAt)}，仓库 ${butlerSelf.repository} 暂无高于 ${butlerSelf.version} 的 ${butlerSelf.prefs.channel === "beta" ? "测试版" : "稳定版"} 标签。`}
                    </p>
                  ) : (
                    <ul className="self-update-list">
                      <li key={selfUpgradeCandidate.tag ?? selfUpgradeCandidate.version}>
                        <div>
                          <strong>{selfUpgradeCandidate.version}</strong>
                          <span className={`badge-pill ${channelBadge(selfUpgradeCandidate.channel).cls}`}>
                            {channelBadge(selfUpgradeCandidate.channel).label}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={
                            selfBusy ||
                            butlerSelf.lastJob?.status === "running" ||
                            butlerSelf.prefs.locked
                          }
                          onClick={() => requestSelfUpgrade(selfUpgradeCandidate)}
                        >
                          更新到最新版
                        </button>
                      </li>
                    </ul>
                  )}
                </div>

                <div className="butler-self-snapshots">
                  <strong>退回上一版本</strong>
                  {previousSelfSnapshot === null ? (
                    <p className="hint">
                      还没有上一版本恢复点；首次更新前会自动创建。
                    </p>
                  ) : (
                    <ul className="self-snapshot-list">
                      <li key={previousSelfSnapshot.id}>
                        <div>
                          <strong>{previousSelfSnapshot.version}</strong>
                          <span>{formatRelative(previousSelfSnapshot.at)}保存</span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={selfBusy || butlerSelf.lastJob?.status === "running"}
                          onClick={() => requestSelfRollback(previousSelfSnapshot)}
                        >
                          退回上一版本
                        </button>
                      </li>
                    </ul>
                  )}
                </div>
              </>
            )}

            <div className="hint">
              {butler.repository !== null && butler.repository !== ""
                ? "源码上传到仓库并打 tag 后，管家自身支持一键升级与回滚；升级失败会自动还原。"
                : "把源代码上传到 Git 仓库、配置远程地址并打上版本 tag 后，管家自身支持一键升级与回滚。"}
            </div>
          </>
        )}
      </div>

      <h2 className="section-title">当前使用的版本</h2>
      {instances.length === 0 ? (
        <div className="empty-state">
          还没有发现可管理的管家。扫描完成后，这里会显示它当前使用的版本。
        </div>
      ) : (
        <div className="cards-grid">
          {instances.map((instance) => {
            const badge = stateBadge(instance.state);
            return (
              <div className="card" key={instance.instanceId}>
                <div className="instance-title">
                  <span className="instance-name">{instanceLabel(instance.instanceId)}</span>
                </div>
                <div className="instance-meta">
                  <span>状态：{badge.label}</span>
                  <span>当前版本：{instance.version ?? "—"}</span>
                </div>
                <div className="advanced-details instance-advanced is-expanded">
                  <div className="advanced-details-body">
                    <dl className="kv">
                      <dt>内部编号</dt>
                      <dd title={instance.instanceId}>{instanceLabel(instance.instanceId)}</dd>
                      <dt>运行位置</dt>
                      <dd>{instanceRuntimeLabel(instance.runtime)}</dd>
                      <dt>当前状态</dt>
                      <dd>{instanceStateLabel(instance.state)}</dd>
                    </dl>
                  </div>
                </div>
                <div className="instance-kpi">
                  <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                  <span className="confidence">版本：{instance.version ?? "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="section-title">最新可升级版本</h2>
      {available !== null && !available.reachable && (
        <div className="banner banner-warn">
          {data?.watchReachable === false
            ? "⚠ 管家服务暂时连不上：现在无法查看新版本，也不能升级。"
            : "⚠ 暂时拉取不到新版本列表，稍后再试。"}
        </div>
      )}
      {available !== null && available.reachable && (
        <>
          <div className="version-toolbar">
            <span className="version-source">更新来源：{versionSourceLabel(available.source ?? "")}</span>
            <label htmlFor="upgrade-target">要升级的管家：</label>
            <select
              id="upgrade-target"
              className="select"
              value={targetInstance}
              onChange={(event) => setSelectedInstance(event.target.value)}
            >
              {instances.length === 0 ? (
                <option value="">（暂未发现管家，由管家自动选择）</option>
              ) : (
                instances.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instanceLabel(instance.instanceId)}
                  </option>
                ))
              )}
            </select>
          </div>
          {upgradeCandidates.length === 0 ? (
            <div className="empty-state version-empty-explained">
              {currentVersion === ""
                ? "尚未读取到目标实例当前版本；请先确认 Hermes 实例在线，再重新检查。"
                : `当前目标实例 ${instanceLabel(targetInstance)} 为 ${currentVersion}，版本源没有更高版本候选。`}
              <button type="button" className="btn btn-quiet" onClick={() => void refresh()}>重新检查版本</button>
            </div>
          ) : (
            <div className="cards-stack">
              {upgradeCandidates.map((entry) => {
                const badge =
                  entry.channel !== undefined && entry.channel !== ""
                    ? channelBadge(entry.channel)
                    : null;
                const isCurrent = currentVersion !== "" && compareVersion(versionComparable(entry), currentVersion) === 0;
                const published = formatPublishedAt(entry.publishedAt);
                return (
                  <div className="card version-item" key={entry.version}>
                    <div className="version-main">
                      <span className="version-name">{versionDisplay(entry)}</span>
                      {badge !== null && (
                        <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                      )}
                      {isCurrent && <span className="badge-pill badge-muted">当前版本</span>}
                      <small className="version-tag">
                        {entry.version}
                        {published !== "" ? ` · ${published}` : ""}
                      </small>
                      {entry.notes !== undefined && entry.notes !== "" && (
                        <p className="version-notes">{entry.notes}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        isCurrent || managedUpgradePending !== null || job?.status === "running"
                      }
                      onClick={() => requestUpgrade(entry)}
                    >
                      {isCurrent
                        ? "正在使用"
                        : managedUpgradePending !== null
                          ? "正在启动升级"
                          : job?.status === "running"
                            ? "升级进行中"
                            : "升级到这一版"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <h2 className="section-title">升级进度</h2>
      {upgradeProgress !== null && (
        <PageProgress
          compact
          title={upgradeProgress.title}
          detail={upgradeProgress.detail}
          indeterminate={upgradeProgress.indeterminate}
          steps={upgradeProgress.steps}
        />
      )}
      {job === null ? (
        <div className="empty-state">
          {managedUpgradePending !== null
            ? "正在创建升级任务，收到管家的第一步状态后会显示详细步骤。"
            : "目前没有正在进行的升级。选择上方版本后，进度会显示在这里。"}
        </div>
      ) : (
        <div className="card">
          <div className="pipeline-head">
            <span className="instance-name">{instanceLabel(job.instanceId)}</span>
            <span>→ {job.targetVersion}</span>
            {job.channel !== undefined && job.channel !== "" && (
              <span className={`badge-pill ${channelBadge(job.channel).cls}`}>
                {channelBadge(job.channel).label}
              </span>
            )}
            <span className={`badge-pill ${jobBadge(job.status).cls}`}>
              {jobBadge(job.status).label}
            </span>
          </div>
          {job.rolledBack === true && (
            <div className="banner banner-warn pipeline-note">
              ⚠ 升级后检查没有通过，管家已自动还原
              {job.snapshotId !== undefined ? `（备份 ${job.snapshotId}）` : ""}
            </div>
          )}
          <ol className="pipeline-steps">
            {job.steps.map((step, index) => {
              const badge = stepBadge(step.status);
              return (
                <li className={`pipeline-step step-${step.status}`} key={step.id}>
                  <span className="step-index">{index + 1}</span>
                  <span className="step-label">{step.label}</span>
                  <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                  {step.detail !== undefined && step.detail !== "" && (
                    <span className="step-detail" title={step.detail}>
                      {step.detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <dl className="kv pipeline-kv">
            <dt>开始于</dt>
            <dd>{formatRelative(job.startedAt)}</dd>
            <dt>结束于</dt>
            <dd>{job.finishedAt !== undefined ? formatRelative(job.finishedAt) : "—"}</dd>
            {job.trigger !== undefined && job.trigger !== "" && (
              <>
                <dt>触发方式</dt>
                <dd>{job.trigger}</dd>
              </>
            )}
            {job.error !== undefined && job.error !== "" && (
              <>
                <dt>错误</dt>
                <dd>{job.error}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <h2 className="section-title">升级前检查</h2>
      {precheckStep !== null && precheck.items.length > 0 ? (
        <div className="card">
          <ul className="check-list">
            {precheck.items.map((item) => {
              const badge = precheckBadge(item.status);
              return (
                <li className="check-row" key={item.id}>
                  <span className="check-name">{item.id}</span>
                  <span className={`badge-pill ${badge.cls}`}>{badge.label}</span>
                  <span className="check-detail" title={item.detail ?? undefined}>
                    {item.detail ?? "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : precheckStep !== null && precheck.lines.length > 0 ? (
        <div className="card">
          <div className="hint">{precheck.lines.join("；")}</div>
        </div>
      ) : precheckStep !== null ? (
        <div className="card">
          <ul className="check-list">
            <li className="check-row">
              <span className="check-name">升级前检查</span>
              <span className={`badge-pill ${stepBadge(precheckStep.status).cls}`}>
                {stepBadge(precheckStep.status).label}
              </span>
              <span className="check-detail">暂未返回明细</span>
            </li>
          </ul>
        </div>
      ) : (
        <div className="card">
          <ul className="check-list">
            {STATIC_PRECHECKS.map((name) => (
              <li className="check-row" key={name}>
                <span className="check-name">{name}</span>
                <span className="badge-pill badge-muted">待检</span>
              </li>
            ))}
          </ul>
          <div className="hint">不需要你手动操作；管家会在升级前自动检查。</div>
        </div>
      )}

      <h2 className="section-title">退回上一版本</h2>
      {previousSnapshot === null ? (
        <div className="empty-state">
          还没有上一版本恢复点；首次升级前会自动创建。
        </div>
      ) : (
        <div className="card previous-version-row">
          <div>
            <strong>{instanceLabel(previousSnapshot.instance)}的上一版本</strong>
            <span>
              {previousSnapshot.label ?? "升级前自动保存"} · {formatRelative(previousSnapshot.createdAt)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => requestRollback(previousSnapshot)}
          >
            退回上一版本
          </button>
        </div>
      )}

      {confirmAction !== null && (
        <div
          className="danger-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="versions-confirm-title"
        >
          <div className="danger-modal-card">
            <div className="danger-modal-icon">!</div>
            <h3 id="versions-confirm-title">
              {confirmAction.kind === "self-upgrade"
                ? "确认升级管家自身"
                : confirmAction.kind === "self-rollback"
                  ? "确认回滚管家自身"
                  : confirmAction.kind === "upgrade"
                    ? "确认升级"
                    : "确认还原备份"}
            </h3>
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
            <p className="danger-impact">请确认你理解这次操作的影响；管家只会在你确认后执行。</p>
            <div className="danger-modal-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirmAction(null)}
              >
                先不操作
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmActionExecute}>
                {confirmAction.kind === "self-upgrade" || confirmAction.kind === "upgrade"
                  ? "确认升级"
                  : confirmAction.kind === "self-rollback"
                    ? "确认回滚"
                    : "确认还原"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
