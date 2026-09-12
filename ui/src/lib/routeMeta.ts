/**
 * 路由元信息单一事实源（设计评审 P1-9）。
 *
 * 【为什么需要它】此前「侧栏分组 / 页头 eyebrow / 顶栏页题 / 侧栏图标」四处各写一份：
 *   · 核心文件在侧栏归「维护与升级」，页头却写「控制台」；
 *   · 智能体与记忆页是全站唯一没有 eyebrow 的页面；
 *   · ToolOutlined 同时用于「自进化」与「排查问题」，FileSearchOutlined 同时用于
 *     「核心文件」与「系统日志」，SettingOutlined 同时用于「连接体检」与「设置」——
 *     侧栏因此失去形状识别能力，只能靠逐行读字定位。
 *
 * 现在导航、页头、顶栏、移动 Tab 全部从本文件派生，图标唯一性由 tests/route-meta.test.ts 守住。
 *
 * 【新增页面的唯一动作】在 ROUTES 里加一行；导航/页头/顶栏/图标自动对齐。
 * 不进侧栏的页面（如 /canary，入口在「设置 → 进阶工具」）用 nav: false 显式声明。
 */
import {
  AlertOutlined,
  ApiOutlined,
  AuditOutlined,
  ClusterOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  DiffOutlined,
  DollarOutlined,
  ExperimentOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FundProjectionScreenOutlined,
  HistoryOutlined,
  NotificationOutlined,
  RocketOutlined,
  SettingOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { ComponentType } from "react";

/** 图标组件（antd Outlined 图标的结构随版本变化，这里放宽为任意 props 组件）。 */
export type NavIcon = ComponentType<{ className?: string; style?: React.CSSProperties }>;

export type NavGroupKey = "console" | "trust" | "maintain" | "settings";

export interface NavGroup {
  key: NavGroupKey;
  /** 分组标题，同时是页面 eyebrow 的真源。 */
  label: string;
  /** 可折叠分组渲染为 SubMenu（默认收起，进入组内页面时自动展开）。 */
  collapsible: boolean;
  /** 折叠分组标题下的一句副注。 */
  note?: string;
}

/**
 * 分组顺序即导航顺序。
 * 「信任层」是 9 项的重头，可折叠：展开后按语义再分「花了什么 / 管得住吗」两簇，
 * 收起时只占一行——这是把侧栏内容高压到 768px 首屏以内的关键。
 */
export const NAV_GROUPS: NavGroup[] = [
  { key: "console", label: "控制台", collapsible: false },
  { key: "trust", label: "信任层", collapsible: true, note: "成本、告警与审批" },
  { key: "maintain", label: "维护与升级", collapsible: false },
  { key: "settings", label: "设置", collapsible: false },
];

export interface RouteMeta {
  path: string;
  group: NavGroupKey;
  /** 侧栏与顶栏共用同一份页题。 */
  title: string;
  /** 侧栏第二行副注（也是折叠分组收起的唯一线索：让人知道里面有什么）。 */
  note: string;
  /** 全局唯一：同一图标不得出现在两个导航项上。 */
  icon: NavIcon;
  /** 是否出现在侧栏（false = 只能从其他页面进入，如「设置 → 进阶工具」）。 */
  nav: boolean;
  /** 短标签：移动端底部 Tab 等窄空间使用（缺省时回落到 title）。 */
  short?: string;
  /** 信任层内的分簇标题（仅 group === "trust" 时使用）。 */
  cluster?: string;
}

/** 信任层分簇顺序即渲染顺序。 */
export const TRUST_CLUSTERS = ["花了什么", "管得住吗"] as const;

export const ROUTES: RouteMeta[] = [
  /* ---- 控制台 ---- */
  { path: "/dashboard", group: "console", title: "首页", note: "运行总览与一键检查", icon: DashboardOutlined, nav: true },
  { path: "/skills", group: "console", title: "智能体与记忆", note: "技能、插件与记忆", icon: ApiOutlined, nav: true },
  { path: "/gateway", group: "console", title: "消息通知", note: "频率控制与送达记录", icon: NotificationOutlined, nav: true },

  /* ---- 信任层 · 花了什么 ---- */
  { path: "/cost", group: "trust", cluster: "花了什么", title: "成本", note: "花了多少钱、值不值", icon: DollarOutlined, nav: true, short: "成本" },
  { path: "/report", group: "trust", cluster: "花了什么", title: "Agent 周报", note: "每周一 08:00 自动汇总推送", icon: FileTextOutlined, nav: true, short: "周报" },
  { path: "/sessions", group: "trust", cluster: "花了什么", title: "会话追踪", note: "按会话回放 agent 的动作链", icon: HistoryOutlined, nav: true },
  { path: "/memory-diff", group: "trust", cluster: "花了什么", title: "记忆变更", note: "本周它记住了什么、忘了什么", icon: DiffOutlined, nav: true },

  /* ---- 信任层 · 管得住吗 ---- */
  { path: "/audit", group: "trust", cluster: "管得住吗", title: "行为审计", note: "动过哪些文件、发了什么", icon: FileDoneOutlined, nav: true },
  { path: "/events", group: "trust", cluster: "管得住吗", title: "事件中心", note: "一处看完所有告警与回归", icon: AlertOutlined, nav: true, short: "事件" },
  { path: "/approvals", group: "trust", cluster: "管得住吗", title: "操作审批", note: "高危动作先点头，超时默认拒绝", icon: AuditOutlined, nav: true },
  { path: "/progress", group: "trust", cluster: "管得住吗", title: "进度可信度", note: "它说做完了，是真的还是编的", icon: FundProjectionScreenOutlined, nav: true },
  { path: "/federation", group: "trust", cluster: "管得住吗", title: "实例联邦", note: "多实例成本、事件与急停合并看", icon: ClusterOutlined, nav: true },

  /* ---- 维护与升级 ---- */
  { path: "/core-files", group: "maintain", title: "核心文件", note: "查看、编辑与回滚 Markdown", icon: FileMarkdownOutlined, nav: true },
  { path: "/troubleshoot", group: "maintain", title: "排查问题", note: "按现象一步步处理", icon: ToolOutlined, nav: true },
  { path: "/evolution", group: "maintain", title: "自进化", note: "分析日志与优化方案", icon: ExperimentOutlined, nav: true },
  { path: "/logs", group: "maintain", title: "系统日志", note: "查看记录与修复建议", icon: FileSearchOutlined, nav: true },
  { path: "/setup", group: "maintain", title: "连接体检", note: "链路三环体检与修复", icon: DeploymentUnitOutlined, nav: true },

  /* ---- 设置（侧栏底部钉住，不参与分组渲染） ---- */
  { path: "/settings", group: "settings", title: "设置", note: "本机安全、备份与偏好", icon: SettingOutlined, nav: true },

  /* ---- 不进侧栏：入口在「设置 → 进阶工具」 ---- */
  { path: "/canary", group: "trust", cluster: "管得住吗", title: "升级策略", note: "影子环境验证后再切换", icon: RocketOutlined, nav: false },
];

/** 侧栏底部的钉住项（不随导航滚动）。 */
export const PINNED_ROUTE: RouteMeta = ROUTES.find((route) => route.path === "/settings") as RouteMeta;

export function groupLabel(key: NavGroupKey): string {
  return NAV_GROUPS.find((group) => group.key === key)?.label ?? "";
}

/**
 * 按路径解析路由元信息。用前缀匹配，保证 /sessions/:id 这类详情页命中父级
 * （与旧 Layout 的定位行为一致），并且优先匹配更长的路径避免歧义。
 */
export function routeMetaFor(pathname: string): RouteMeta | null {
  const candidates = ROUTES.filter((route) => pathname === route.path || pathname.startsWith(`${route.path}/`));
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, route) => (route.path.length > longest.path.length ? route : longest));
}

/** 页面 eyebrow 的真源：分组名。找不到路由时返回 undefined，由调用方决定兜底。 */
export function eyebrowFor(pathname: string): string | undefined {
  const meta = routeMetaFor(pathname);
  return meta === null ? undefined : groupLabel(meta.group);
}

/**
 * 侧栏可见项（按分组切分，保持 ROUTES 的声明顺序）。
 * 「设置」是底部钉住项（PINNED_ROUTE），不参与分组渲染，因此这里恒返回空数组。
 */
export function navRoutesFor(group: NavGroupKey): RouteMeta[] {
  if (group === "settings") return [];
  return ROUTES.filter((route) => route.nav && route.group === group);
}

/** 折叠分组的默认展开键（= 分组 key），供 Layout 控制 openKeys。 */
export function collapsibleGroupKeys(): string[] {
  return NAV_GROUPS.filter((group) => group.collapsible).map((group) => group.key);
}

/**
 * 移动端底部 Tab 的路径（顺序即展示顺序）。
 * 与桌面侧栏同源于 ROUTES —— 不再另写一套一级信息架构（评审 P0-1）。
 *
 * 【必须有首页】原设计只放了 周报/事件/成本/急停 四格，结果是「回到首页」这个最高频动作
 * 只能靠左上角汉堡 —— 这违背了拇指可达区的本意。现在首页排第一。
 */
export const MOBILE_TAB_PATHS = ["/dashboard", "/report", "/events", "/cost"] as const;

export function shortTitleOf(route: RouteMeta): string {
  return route.short ?? route.title;
}
