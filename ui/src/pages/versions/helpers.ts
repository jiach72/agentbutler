/**
 * 版本页展示辅助：实例/徽标/版本号的标签映射与升级进度派生计算。
 */
import type { PageProgressStep } from "../../components/PageProgress.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import type {
  AvailableVersionEntry,
  ButlerVersionView,
  ManagedUpgradeTarget,
  PrecheckDetail,
  PrecheckItem,
  UpgradeJobView,
} from "./types.js";

/** 徽标的语义形态：tone 交给 <StatusBadge> 渲染。 */
export interface ToneBadge {
  tone: SemanticTone;
  label: string;
}

export function instanceLabel(instanceId: string): string {
  if (instanceId === "hermes-main") return "Hermes 主实例";
  if (instanceId === "") return "主实例";
  return instanceId;
}

export function instanceRuntimeLabel(runtime: string): string {
  const value = runtime.toLowerCase();
  if (value.includes("process")) return "本机运行";
  if (value.includes("docker") || value.includes("container")) return "容器运行";
  return runtime || "—";
}

export function instanceStateLabel(state: string): string {
  return stateBadge(state).label;
}

/** 实例状态徽标：运行绿 / 崩溃红 / 停止灰 / 其他黄。 */
export function stateBadge(state: string): ToneBadge {
  const s = state.toLowerCase();
  if (s.includes("crash")) return { tone: "error", label: "异常" };
  if (["serving", "running", "active"].includes(s)) return { tone: "ok", label: "运行中" };
  if (["stopped", "removed", "idle"].includes(s)) return { tone: "muted", label: "已停止" };
  return { tone: "warn", label: state || "未知" };
}

/** job 级状态徽标：running 脉动 / done 绿 / failed 红。 */
export function jobBadge(status: string): ToneBadge {
  switch (status) {
    case "running":
      return { tone: "pulse", label: "进行中" };
    case "done":
      return { tone: "ok", label: "已完成" };
    case "failed":
      return { tone: "error", label: "失败" };
    case "pending":
      return { tone: "muted", label: "等待中" };
    case "cancelled":
      return { tone: "muted", label: "已取消" };
    case "rolled-back":
      return { tone: "warn", label: "已自动回滚" };
    default:
      return { tone: "muted", label: status || "未知" };
  }
}

/** 步骤状态徽标：running 脉动 / passed 绿 / failed 红 / pending、skipped 灰。 */
export function stepBadge(status: string): ToneBadge {
  switch (status) {
    case "running":
      return { tone: "pulse", label: "进行中" };
    case "passed":
      return { tone: "ok", label: "已通过" };
    case "failed":
      return { tone: "error", label: "失败" };
    case "skipped":
      return { tone: "muted", label: "已跳过" };
    case "pending":
      return { tone: "muted", label: "等待中" };
    default:
      return { tone: "muted", label: status || "未知" };
  }
}

/** channel 徽标：stable 绿 / beta 黄 / 其他灰。 */
export function channelBadge(channel: string): ToneBadge {
  if (channel === "stable") return { tone: "ok", label: "稳定版" };
  if (channel === "beta") return { tone: "warn", label: "测试版" };
  return { tone: "muted", label: channel || "未知" };
}

/** 预检项状态徽标：pass/passed/ok 绿 / fail/failed 红 / warn 黄 / 其他灰。 */
export function precheckBadge(status: string): ToneBadge {
  const s = status.toLowerCase();
  if (["pass", "passed", "ok"].includes(s)) return { tone: "ok", label: "通过" };
  if (["fail", "failed"].includes(s)) return { tone: "error", label: "失败" };
  if (s === "warn") return { tone: "warn", label: "需留意" };
  return { tone: "muted", label: status || "未知" };
}

export function repositoryBadge(butler: ButlerVersionView): ToneBadge {
  if (butler.repositorySource === "git-origin") {
    return { tone: "ok", label: "仓库已连接" };
  }
  if (
    butler.repositorySource === "configured-default" ||
    butler.repositoryConfigured === true ||
    (typeof butler.repository === "string" && butler.repository.trim() !== "")
  ) {
    return { tone: "warn", label: "仓库已配置" };
  }
  return { tone: "error", label: "仓库未配置" };
}

/** 版本条目展示名：优先发布说明里的版本号，否则用更新标签。 */
export function versionDisplay(entry: AvailableVersionEntry): string {
  return entry.displayVersion !== undefined && entry.displayVersion !== ""
    ? entry.displayVersion
    : entry.version;
}

export function versionComparable(entry: AvailableVersionEntry): string {
  return entry.version !== "" ? entry.version : versionDisplay(entry);
}

/** 更新来源的中文名。 */
export function versionSourceLabel(source: string): string {
  if (source === "github-releases") return "GitHub 官方发布";
  if (source === "github-releases-mirror") return "GitHub 镜像源";
  if (source === "docker-hub") return "Docker 镜像";
  return source;
}

/** 发布时间的短格式（如 8 月 21 日发布）。 */
export function formatPublishedAt(ts: string | undefined): string {
  if (ts === undefined || ts === "") return "";
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return ts;
  const date = new Date(time);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日发布`;
}

export function progressStepState(status: string): PageProgressStep["state"] {
  if (["passed", "done", "skipped"].includes(status)) return "done";
  if (status === "running") return "active";
  if (status === "failed") return "failed";
  return "pending";
}

export interface ManagedUpgradeProgressView {
  title: string;
  detail: string;
  indeterminate: boolean;
  steps: PageProgressStep[];
}

export function managedUpgradeProgress(
  job: UpgradeJobView | null,
  pendingTarget: ManagedUpgradeTarget | null,
): ManagedUpgradeProgressView | null {
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

export const SELF_PROGRESS_PHASES = [
  { id: "snapshot", label: "保存上一版本" },
  { id: "checkout", label: "切换代码" },
  { id: "install-build", label: "安装并构建" },
  { id: "restart", label: "重启服务" },
  { id: "verify", label: "确认可用" },
] as const;

/** 自身 Job phase 的中文动词（“正在…中”句式）。 */
export function selfPhaseVerb(phase: string): string {
  switch (phase) {
    case "snapshot":
      return "备份";
    case "checkout":
      return "切换版本";
    case "install-build":
      return "安装构建";
    case "restart":
      return "重启服务";
    case "verify":
      return "健康验收";
    default:
      return "处理";
  }
}

/** 无 Job 时的静态预检说明清单（发起升级时由 watch 自动执行）。 */
export const STATIC_PRECHECKS = ["文件可以访问", "管家可以运行", "版本有差异"];

/**
 * 解析 precheck 步骤的 detail：
 * JSON 数组（元素含 id/name + status）→ 结构化清单；其他 → 按行拆分的纯文本。
 */
export function parsePrecheckDetail(detail: string | undefined): PrecheckDetail {
  if (detail === undefined || detail === "") return { items: [], lines: [] };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(detail) as unknown;
  } catch {
    parsed = null;
  }
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
  const lines = detail
    .split(/\r?\n|；/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { items: [], lines };
}
