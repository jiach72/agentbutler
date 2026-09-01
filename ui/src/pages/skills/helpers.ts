/**
 * 技能与记忆页共享类型与工具：载荷类型、来源/信号中文标签、
 * 分组与筛选 options 的去重构建，以及统一的预览条数上限。
 */
import { formatNumber, formatBytes, formatTime } from "../../lib/format.js";

export type InventoryMode = "driver" | "directory-fallback" | "unavailable";
export type AssetRiskStatus = "unscanned" | "clear" | "blocked";

export interface DirectoryInventory {
  roots: string[];
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillItem {
  ref: { name: string; version?: string; source?: string };
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  category?: string;
  description?: string;
  usage?: number;
  lastUsedAt?: string | null;
  successRate?: number | null;
  avgDurationMs?: number | null;
  usageCoverage?: { from: string | null; to: string | null; days: number; source: string; complete: boolean };
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
}

export interface PluginItem {
  ref: { name: string; version?: string; source?: string };
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  category?: string;
  description?: string;
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
}

export interface MemorySignalView {
  id: string;
  label: string;
  status: "ok" | "warn" | "error" | "unknown";
  detail: string;
}

export interface MemorySuggestionView {
  id: string;
  kind: string;
  title: string;
  detail: string;
  action?: string;
}

export interface MemoryHealthView {
  score: number;
  checkedAt: string;
  signals: MemorySignalView[];
  suggestions: MemorySuggestionView[];
}

export interface MemoryEntry {
  entryId: string;
  writtenAt: string;
  content: string;
  channel?: string;
  sessionId?: string;
  sizeBytes?: number;
  cold?: boolean;
}

export interface SkillsPayload {
  watchReachable: boolean;
  instance: null | {
    instanceId: string;
    frameworkId: string;
    state: string;
    version: string | null;
  };
  skills: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: SkillItem[];
    directory: DirectoryInventory;
    notice: string;
  };
  plugins: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: PluginItem[];
    directory: DirectoryInventory;
    notice: string;
  };
  memory: {
    mode: InventoryMode;
    driverId: string | null;
    stats: null | {
      totalEntries: number;
      byMonth: Array<{ month: string; count: number }>;
      coldCandidates: number;
      lastWriteAt: string | null;
      archivedEntries: number;
      probeEntries: number;
      recalledEntries: number;
      cumulativeRecalls: number;
      probeWriteAttempts: number;
      probeWriteFailures: number;
      probeRecallAttempts: number;
      probeRecallHits: number;
    };
    health: MemoryHealthView | null;
    preview: MemoryEntry[];
    previewLimit: number;
    writeActivity: { status: "active" | "stalled" | "external" | "empty" | "unknown"; detail: string };
    directory: DirectoryInventory;
    notice: string;
  };
}

export interface MemorySelfCheckView {
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
}

/** 记忆预览区独立于技能列表的检索状态。 */
export type MemoryPreview =
  | { status: "default" }
  | { status: "searching"; keyword: string }
  | { status: "ready"; keyword: string }
  | { status: "failed"; keyword: string; reason: string };

/** 预览条数上限：请求参数与展示兜底共用同一常量，不再出现两个不同的数。 */
export const PREVIEW_LIMIT = 50;

export function buildSkillsUrl(keyword: string): string {
  const params = new URLSearchParams();
  if (keyword.trim() !== "") params.set("keyword", keyword.trim());
  params.set("limit", String(PREVIEW_LIMIT));
  return `/api/skills?${params.toString()}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  builtin: "内置",
  market: "市场",
  "self-evolved": "自动改进",
  user: "用户",
};

const SIGNAL_LABELS: Record<string, string> = {
  integrity: "数据库完整性",
  "fts-index": "全文索引",
  "write-activity": "写入活跃度",
  "write-reliability": "写入失败率",
  "recall-hit-rate": "召回命中率",
  "recall-coverage": "召回覆盖",
  cold: "冷数据占比",
  "probe-hygiene": "探针残留",
};

export function signalLabel(id: string, fallback: string): string {
  return SIGNAL_LABELS[id] ?? fallback;
}

function channelLabel(channel: string | undefined): string {
  if (channel === undefined || channel === "") return "";
  const labels: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    discord: "Discord",
    wechat: "微信",
    email: "邮件",
    sms: "短信",
    cli: "终端",
  };
  return labels[channel.toLowerCase()] ?? channel;
}

export function modeLabel(mode: InventoryMode): string {
  if (mode === "driver") return "正常查看";
  if (mode === "directory-fallback") return "按文件查看";
  return "无法查看";
}

export function riskLabel(status: AssetRiskStatus | undefined): string {
  if (status === "blocked") return "受限";
  if (status === "clear") return "已扫描";
  return "未扫描";
}

export function riskDetail(item: { riskStatus?: AssetRiskStatus; riskDetail?: string }): string {
  if (item.riskDetail !== undefined && item.riskDetail.trim() !== "") return item.riskDetail;
  if (item.riskStatus === "blocked") return "清单解析失败，暂不把它当作可信资产";
  if (item.riskStatus === "clear") return "已完成风险扫描";
  return "尚未执行风险扫描";
}

export function skillsNotice(mode: InventoryMode): string {
  if (mode === "driver") return "管家正在正常读取本机技能；现在只能查看，不能开启、停用或删除。";
  if (mode === "directory-fallback")
    return "技能服务暂时没连上，先按文件统计；现在只能查看，不能开启、停用或删除。";
  return "暂时读不到技能列表；等管家服务恢复后再试。";
}

export function healthTone(score: number): string {
  if (score >= 85) return "good";
  if (score >= 65) return "ok";
  if (score >= 40) return "warn";
  return "bad";
}

/** 分类归一：空值归入「未分类」。 */
export function categoryOf(category: string | undefined): string {
  return category?.trim() || "未分类";
}

/** 去重排序：分类 / 来源 options 的唯一构建入口（此前技能与插件各写一份）。 */
export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function collectCategories<T extends { category?: string }>(items: T[]): string[] {
  return uniqueSorted(items.map((item) => categoryOf(item.category)));
}

export function collectSources<T extends { source: string }>(items: T[]): string[] {
  return uniqueSorted(items.map((item) => item.source));
}

export function toSelectOptions(
  values: string[],
  labelOf: (value: string) => string = (value) => value,
): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: labelOf(value) }));
}

export function groupByCategory<T extends { category?: string; name: string }>(items: T[]): Array<{
  category: string;
  items: T[];
}> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = categoryOf(item.category);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([category, list]) => ({ category, items: list }))
    .sort((a, b) => a.category.localeCompare(b.category, "zh-CN"));
}

export { formatNumber, formatBytes, formatTime, channelLabel };
