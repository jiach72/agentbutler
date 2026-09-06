/**
 * SkillHub（skillhub.cn）市场数据的前端视图与请求工具：
 * 与 watch 端 skillhub.ts 的返回形状一一对应（已归一为安全类型）。
 */

export interface SkillHubCategory {
  key: string;
  name: string;
  nameEn: string | null;
}

export interface SkillHubCategoriesResult {
  items: SkillHubCategory[];
  syncedAt: string | null;
  error?: string;
  detail?: string;
  fix?: string;
}

export interface SkillHubSkill {
  slug: string;
  name: string;
  /** 中文描述（后端已做英文回退）。 */
  description: string;
  category: string;
  subCategories: Array<{ key: string; name: string }>;
  iconUrl: string | null;
  ownerName: string;
  version: string;
  homepage: string;
  downloads: number;
  installs: number;
  stars: number;
  updatedAt: string | null;
  source: string;
  requiresApiKey: boolean;
}

export interface SkillHubListResult {
  total: number;
  page: number;
  pageSize: number;
  items: SkillHubSkill[];
  error?: string;
  detail?: string;
  fix?: string;
}

export type SkillHubSortBy = "score" | "downloads" | "updated_at";

export const SKILLHUB_SORT_OPTIONS: Array<{ value: SkillHubSortBy; label: string }> = [
  { value: "score", label: "综合" },
  { value: "downloads", label: "下载量" },
  { value: "updated_at", label: "最近更新" },
];

/** 组装 SkillHub 列表请求 URL（page/pageSize 由调用方控制）。 */
export function buildSkillHubListUrl(params: {
  keyword?: string;
  category?: string;
  sortBy?: SkillHubSortBy;
  page?: number;
  pageSize?: number;
}): string {
  const search = new URLSearchParams();
  if (params.keyword !== undefined && params.keyword.trim() !== "") search.set("keyword", params.keyword.trim());
  if (params.category !== undefined && params.category.trim() !== "") search.set("category", params.category.trim());
  if (params.sortBy !== undefined) search.set("sortBy", params.sortBy);
  search.set("order", "desc");
  search.set("page", String(Math.max(1, params.page ?? 1)));
  search.set("pageSize", String(Math.max(1, params.pageSize ?? 24)));
  return `/api/skillhub/skills?${search.toString()}`;
}

/** 下载/收藏量人性化：1.2k / 3.4w，用于卡片 meta 行。 */
export function formatHubCount(count: number | undefined | null): string {
  if (count === undefined || count === null || !Number.isFinite(count) || count <= 0) return "0";
  if (count >= 10_000) return `${(count / 10_000).toFixed(1).replace(/\.0$/, "")}w`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}
