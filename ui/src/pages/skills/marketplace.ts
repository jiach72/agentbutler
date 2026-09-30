/**
 * 技能市场（分类侧栏 + 瀑布流卡片）共享类型与工具：
 * 固定中文分类体系、关键词归类启发式与暂存风险解析。
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

/** Watch 在推荐技能暂存阶段返回的轻量风险扫描结果。 */
export interface StagedSkillRisk {
  status: "clear" | "blocked";
  externalDomains: string[];
  sensitivePaths: string[];
  dangerousCommands: string[];
  detail: string;
}

/** 容忍旧 Watch 不返回风险字段，避免升级期间把合法暂存误判为风险通过。 */
export function parseStagedRisk(value: unknown): StagedSkillRisk | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status !== "clear" && status !== "blocked") return null;
  return {
    status,
    externalDomains: stringArray(record["externalDomains"]),
    sensitivePaths: stringArray(record["sensitivePaths"]),
    dangerousCommands: stringArray(record["dangerousCommands"]),
    detail: typeof record["detail"] === "string" ? record["detail"] : "",
  };
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
