/**
 * 技能市场（分类侧栏 + 瀑布流卡片）共享类型与工具：
 * 固定中文分类体系、关键词归类启发式、skills-manager 载荷映射与操作状态标签。
 */
import {
  BarChartOutlined,
  CodeOutlined,
  EditOutlined,
  HddOutlined,
  ReadOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import type { ComponentType } from "react";

/** skills-manager 中央库技能条目（status 接口原始形状，字段宽松）。 */
export interface SkillsManagerSkill {
  name: string;
  skill_id?: string;
  description?: string;
  source_type?: string;
  source_ref?: string;
  tags?: string[];
  [key: string]: unknown;
}
export interface SkillsManagerStatusOk {
  available: true;
  cli: { path: string; version: string };
  repo: Record<string, unknown>;
  skills: SkillsManagerSkill[];
  deployTarget?: { agent: string; dir: string; symlinked: boolean };
  hermesSkillsDir?: string;
}
export type SkillsManagerStatus = SkillsManagerStatusOk | { available: false; installHint?: string };
export interface UpdateCheckItem {
  name?: string;
  skill_id?: string;
  update_status?: string | null;
  last_check_error?: string | null;
  [key: string]: unknown;
}
/** skills.sh 市场搜索结果。 */
export interface MarketSearchResult {
  install_ref?: string;
  name?: string;
  source?: string;
  skill_id?: string;
  installs?: number;
  [key: string]: unknown;
}
/** 公开趋势（GitHub）条目。 */
export interface TrendItem {
  name: string;
  url: string;
  stars: number;
  forks: number;
  updatedAt: string;
  description?: string;
}
/** 本机使用情况生成的推荐技能。 */
export interface Recommendation {
  id: string;
  name: string;
  reason: string;
  description?: string;
  sourceUrl: string;
}

export const DEPLOY_AGENT = "claude_code";
export const ACTION_TIMEOUT_MS = 120_000;

/** 分类色调：软底/前景成对（marketplace.css 的 tone-* 类同名）。 */
export type CategoryTone = "teal" | "blue" | "purple" | "cinnabar" | "green" | "gold" | "gray";

export interface SkillCategoryDef {
  key: string;
  label: string;
  icon: ComponentType;
  tone: CategoryTone;
}

/** 固定中文分类体系（顺序即侧栏展示顺序）。 */
export const SKILL_CATEGORIES: SkillCategoryDef[] = [
  { key: "efficiency", label: "效率工具", icon: ThunderboltOutlined, tone: "teal" },
  { key: "dev", label: "开发辅助", icon: CodeOutlined, tone: "blue" },
  { key: "data", label: "数据处理", icon: BarChartOutlined, tone: "purple" },
  { key: "content", label: "内容创作", icon: EditOutlined, tone: "cinnabar" },
  { key: "ops", label: "系统运维", icon: HddOutlined, tone: "green" },
  { key: "learning", label: "学习成长", icon: ReadOutlined, tone: "gold" },
  { key: "utility", label: "实用小工具", icon: ToolOutlined, tone: "gray" },
];

export const ALL_CATEGORY_LABEL = "全部技能";
export const FALLBACK_CATEGORY = "实用小工具";
export const CATEGORY_ICON = AppstoreOutlined;
export const CATEGORY_TONE: CategoryTone = "blue";

/** 关键词 → 分类标签（首个命中生效；顺序即优先级）。 */
const CATEGORY_RULES: Array<[string, string[]]> = [
  ["效率工具", ["邮件", "摘要", "日程", "提醒", "待办", "效率", "工作流", "剪贴板", "email", "summary", "workflow", "todo"]],
  ["开发辅助", ["代码", "开发", "调试", "测试", "脚本", "编程", "审查", "git", "api", "code", "debug", "sql", "cli", "终端"]],
  ["数据处理", ["数据", "图表", "分析", "统计", "向量", "爬虫", "数据库", "csv", "excel", "chart", "rag"]],
  ["内容创作", ["写作", "文案", "翻译", "润色", "文档", "博客", "周报", "报告", "纪要", "pdf", "markdown", "writing", "doc"]],
  ["系统运维", ["备份", "部署", "监控", "日志", "服务器", "运维", "定时", "系统", "docker", "cron", "deploy", "backup", "monitor"]],
  ["学习成长", ["学习", "课程", "单词", "英语", "教程", "读书", "笔记", "learn", "study"]],
];

/**
 * 启发式归类：先看标签里是否直接写着分类名，
 * 再按 名称+描述 的关键词匹配；都不中归入「实用小工具」。
 */
export function categorize(item: { name: string; description?: string; tags?: string[] }): string {
  const labels = SKILL_CATEGORIES.map((category) => category.label);
  for (const tag of item.tags ?? []) {
    if (labels.includes(tag.trim())) return tag.trim();
  }
  const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase();
  for (const [label, keywords] of CATEGORY_RULES) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return label;
  }
  return FALLBACK_CATEGORY;
}

export function categoryDefOf(label: string): { icon: ComponentType; tone: CategoryTone } {
  const found = SKILL_CATEGORIES.find((category) => category.label === label);
  return found ? { icon: found.icon, tone: found.tone } : { icon: CATEGORY_ICON, tone: CATEGORY_TONE };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function deployedToTarget(item: SkillsManagerSkill): boolean {
  const deployedTo = item["deployed_to"];
  if (Array.isArray(deployedTo)) return deployedTo.includes(DEPLOY_AGENT);
  return item["deployed"] === true;
}

export function hasAvailableUpdate(item: UpdateCheckItem | undefined): boolean {
  const status = item?.update_status;
  return (
    typeof status === "string" &&
    status !== "" &&
    !["up_to_date", "skipped", "local_only"].includes(status)
  );
}

export function updateStatusLabel(status: string | null | undefined): {
  text: string;
  color?: "success" | "warning" | "error" | "default";
} {
  if (status === "up_to_date") return { text: "已是最新", color: "success" };
  if (status === "local_only") return { text: "本地来源" };
  if (!status) return { text: "未检查" };
  if (status === "skipped") return { text: "已跳过" };
  return { text: "有可用更新", color: "warning" };
}

export function extractError(
  data: unknown,
  fallback = "操作失败，请稍后重试或查看管家日志。",
): string {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record["installHint"] === "string" && record["installHint"] !== "")
      return record["installHint"];
    const code = typeof record["code"] === "string" ? record["code"] : null;
    if (typeof record["message"] === "string" && record["message"] !== "")
      return code === null ? record["message"] : `${code}：${record["message"]}`;
    if (typeof record["error"] === "string" && record["error"] !== "") return record["error"];
  }
  return fallback;
}

/** 试运行预览的中文键名映射 + 有序键值对提取。 */
export function previewEntries(preview: unknown): Array<[string, string]> {
  if (preview === null || typeof preview !== "object") return [];
  const labels: Record<string, string> = {
    action: "动作",
    dry_run: "试运行",
    name: "名称",
    skill_count: "技能数",
    pair_count: "部署对数",
    changed_pairs: "将变更",
    message: "说明",
  };
  const record = preview as Record<string, unknown>;
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = record[key];
    return value === undefined || value === null
      ? []
      : [[label, typeof value === "object" ? JSON.stringify(value) : String(value)]];
  });
}

export function formatInstalls(count: number | undefined): string {
  if (count === undefined || Number.isNaN(count)) return "";
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k 安装`;
  return `${count} 安装`;
}
