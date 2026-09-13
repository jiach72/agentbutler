/**
 * 主题真源 —— 品牌视觉规范 v2.0（docs/brand/02 视觉识别规范 §1/§3/§5）。
 *
 * 【本文件的角色】全仓唯一允许出现具体色值的地方。界面样式只允许引用变量。
 *
 * 【v2.0 相对 v1.2 的角色变更】黄铜从"操作面"退回"品牌记忆点"：
 *   · 交互色（主按钮/链接/选中态/焦点环/进度）整体让给「管家蓝」butlerBlue；
 *   · 黄铜 brass 只用于标志、锁版、空状态插画、图表第二系列、"推荐"标记；
 *   · 信号色 signal 只表达状态，同一时刻界面上最多出现一个；
 *   · 中性色统一为 10 级墨阶 ink-50…ink-900，可推导、可换肤。
 *
 * 【迁移方式：合并，不要覆盖】docs/brand/tokens.v2.ts 不能整体替换本文件：
 *   1. 它缺少 isThemeMode / readStoredThemeMode / systemThemeMode /
 *      initialThemeMode / writeStoredThemeMode —— initialThemeMode 被 main.tsx 直接
 *      import，覆盖会破坏编译；
 *   2. 它的 CSS 变量桥只输出 13 个 --butler-* 别名，而页面引用了 53 个，
 *      缺失变量在 CSS 中不报错、只退化为继承值（静默塌陷）。
 *   本文件保留全部 5 个函数；别名桥（LEGACY_COLOR_VARS）曾在阶段 1-4 扩写为全量，
 *   于阶段 5B 删除。
 *
 * 【v2 规范 · 已落地】本文件现在只输出 --ab-* 变量，单一真源。
 */
import { theme, type ThemeConfig } from "antd";

export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "butler.theme";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

export function readStoredThemeMode(storage?: Pick<Storage, "getItem">): ThemeMode | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function systemThemeMode(
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">,
): ThemeMode {
  try {
    return matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function initialThemeMode(
  storage?: Pick<Storage, "getItem">,
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">,
): ThemeMode {
  return readStoredThemeMode(storage) ?? systemThemeMode(matchMedia);
}

export function writeStoredThemeMode(
  storage: Pick<Storage, "setItem"> | undefined,
  mode: ThemeMode,
): boolean {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────  1. 色板常量（规范 02 §1）  ───────────────────────── */

/**
 * 管家蓝：所有交互。亮色 #1B4F7A（on 白 8.6:1 AAA），暗色 #5B9BD1（on 墨 6.1:1 AA+）。
 * 不表达状态好坏。
 */
export const butlerBlue = {
  600: "#143C5C",
  500: "#1B4F7A",
  400: "#2F6C9B",
  300: "#5B9BD1",
  100: "#DCE8F4",
  50: "#EEF4FA",
} as const;

/**
 * 黄铜（品牌记忆色）：只用于标志、锁版、插画、图表第二系列、"推荐"标记。不做默认按钮、不做状态。
 *
 * 【v2.1 修订 · 实测驱动】brass-700 作为「推荐」徽标与「由模型生成」标记的文字色时，
 * 落在 brandSoft 底上实测只有 4.47:1（12px 不达 AA）→ 改为 #826428，soft 底 4.91:1 / 白底 5.52:1。
 * 暗色档 #C8A15A 在暗底 6.38–6.45:1，达标不动。
 */
export const brass = {
  700: "#826428",
  600: "#A8823C",
  500: "#C8A15A",
  100: "#F2E4C6",
  50: "#F8F1E1",
} as const;

/**
 * 墨阶（中性，10 级）。ink-300 及以下不可用于正文。
 *
 * 【v2.1 修订 · 由真实 DOM 实测驱动（2026-09-12）】
 * 用 Playwright 在渲染后的界面里遍历全部文本节点、计算「前景色 × 实际生效背景」的
 * WCAG 对比度，发现 ink-400（#5F7488）在 ink-50 底上只有 4.37:1、在画布底上 4.50:1——
 * 12px 正文不达 AA（差 0.13）。改为 #596D80 后：白底 5.35:1、画布 5.07:1、ink-50 底 4.98:1。
 * 这是「三级文字」这一档必须满足的下限，不要再调浅回去。
 */
export const ink = {
  900: "#0B1728",
  800: "#16283C",
  700: "#233B52",
  600: "#3A5468",
  500: "#4A6076",
  400: "#596D80",
  300: "#8496A8",
  200: "#C6D3E0",
  100: "#E2E9F1",
  50: "#F4F7FA",
} as const;

/**
 * 信号色（亮色主题）：状态专用。
 * 离线与未知同色，靠文案区分——离线是"确定连不上"，未知是"还不知道"。
 *
 * 【v2.1 修订 · 实测驱动】徽标是「signal 色 × 自己的 soft 底」，这一对才是真正的约束：
 *   · ok  #0B7F6F on okSoft  实测 4.43:1 → 改为 #0A7667，soft 底 4.99:1 / 白底 5.53:1
 *   · warn #9A6B0B on warnSoft 实测 4.35:1 → 改为 #8F630A，soft 底 4.92:1 / 白底 5.31:1
 *   · error #B4342A on errorSoft 实测 5.45:1，达标不动
 *   · offline 与三级文字同值（#596D80），保持「离线与未知同色」的既有语义
 * 12px/500 的徽标文字不属于 WCAG 的「大字」，必须按 4.5:1 判，不能按 3:1。
 */
export const signal = {
  ok: "#0A7667",
  okSoft: "#EAF6F3",
  warn: "#8F630A",
  warnSoft: "#FDF6E4",
  error: "#B4342A",
  errorSoft: "#FDF0EE",
  offline: ink[400],
  offlineSoft: "#F4F7FA",
} as const;

/** 信号色（暗色主题）：青/琥珀/朱红提亮，黄铜保持 #C8A15A。 */
export const signalDark = {
  ok: "#35D0BA",
  okSoft: "#123430",
  warn: "#FFC53D",
  warnSoft: "#3A3014",
  error: "#FF7875",
  errorSoft: "#3C2426",
  offline: "#7E93A8",
  offlineSoft: "#16283C",
} as const;

/* ─────────────────────────  2. 语义色板（规范 02 §1）  ───────────────────────── */

/**
 * 语义色板：v2.0 字段结构。
 * 供「CSS 变量桥」与图表主题取值；antd 组件自身走 ConfigProvider 派生。
 * 两处取值必须保持视觉一致，改色时同步修改。
 */
export interface SemanticPalette {
  canvas: string;
  surface: string;
  surface2: string;
  sunken: string;
  sider: string;
  /** 装饰性描边：卡片、分隔线、表格线。不承担「标识控件」的职责，不适用 SC 1.4.11。 */
  border: string;
  borderStrong: string;
  /**
   * 控件描边：输入框 / 下拉 / 按钮等**需要被认出是控件**的边界。
   * SC 1.4.11 要求非文本元素 3:1——我们的输入框填充色与画布几乎同色（白 on #F7F9FC），
   * 边界就是唯一的识别特征，所以这一档必须 ≥3:1（实测：亮 3.04:1 / 暗 3.28:1）。
   */
  borderControl: string;
  text: string;
  text2: string;
  /** 三级文字：正文级下限，两个主题都必须 ≥4.5:1（实测亮 5.35:1 白底）。 */
  text3: string;
  /** 四级文字：**只许用于图标、禁用态、装饰线条**，不可用于正文或占位符文案（实测亮底仅 3.04:1）。 */
  text4: string;
  primary: string;
  primaryHover: string;
  primaryPress: string;
  primarySoft: string;
  primarySoftBorder: string;
  onPrimary: string;
  /** 危险实底（红）之上的文字色：两种主题都用白，红底白字是对比度最高的组合。 */
  onError: string;
  brand: string;
  brandSoft: string;
  brandLine: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  error: string;
  errorSoft: string;
  offline: string;
  offlineSoft: string;
  shadow1: string;
  shadow2: string;
  focusRing: string;
}

/** 亮色：雪白卡片 + 管家蓝交互 + 黄铜记忆点 + 信号色状态；发丝线优先于投影。
 *  表面系统已中性化（macOS 灰，去蓝调）：不再引用 ink 阶；文字四档仍取自 ink。 */
export const lightPalette: SemanticPalette = {
  canvas: "#F5F5F7",
  surface: "#FFFFFF",
  surface2: "#EEEFF2",
  sunken: "#EEEFF2",
  sider: "#F5F5F7",
  border: "#E4E4E9",
  borderStrong: "#D2D2D7",
  borderControl: ink[300],
  text: ink[900],
  text2: ink[600],
  text3: ink[400],
  text4: ink[300],
  primary: butlerBlue[500],
  primaryHover: butlerBlue[400],
  primaryPress: butlerBlue[600],
  primarySoft: butlerBlue[50],
  primarySoftBorder: butlerBlue[100],
  onPrimary: "#FFFFFF",
  onError: "#FFFFFF",
  brand: brass[700],
  brandSoft: brass[50],
  brandLine: brass[100],
  ok: signal.ok,
  okSoft: signal.okSoft,
  warn: signal.warn,
  warnSoft: signal.warnSoft,
  error: signal.error,
  errorSoft: signal.errorSoft,
  offline: signal.offline,
  offlineSoft: signal.offlineSoft,
  // 亮色阴影：发丝线 + 双层极淡（macOS「纸片浮在玻璃上」）；发丝线在亮色下承担卡片边界（P0-7）。
  shadow1: "0 0 0 0.5px rgb(0 0 0 / 4%), 0 1px 2px rgb(0 0 0 / 5%), 0 4px 12px rgb(0 0 0 / 4%)",
  shadow2: "0 0 0 0.5px rgb(0 0 0 / 8%), 0 2px 8px rgb(0 0 0 / 6%), 0 16px 48px rgb(0 0 0 / 12%)",
  focusRing: "0 0 0 3px rgb(27 79 122 / 30%)",
};

/** 暗色：中性深灰面板（macOS 暗色，去深海军蓝）+ 管家蓝交互（提亮版）+ 黄铜记忆点 + 信号色状态。 */
export const darkPalette: SemanticPalette = {
  canvas: "#141519",
  surface: "#1D1F24",
  surface2: "#25272D",
  sunken: "#101114",
  sider: "#191B20",
  border: "#31333A",
  borderStrong: "#3E4148",
  borderControl: "#547699",
  text: "#ECECEE",
  text2: "#AFC0D1",
  /**
   * 三级文字（暗）：必须对 surface(#132538) **和** elevated(#1A2E44) 都 ≥4.5:1——
   * elevated 更亮、更苛刻。#7E93A8 对 elevated 只有 4.36:1（实测）→ 改为 #8FA5BA（5.44:1）。
   */
  text3: "#8FA5BA",
  /** 四级文字（暗）：ink-400 加深后会掉到 3:1 以下，所以暗色单独用更亮的值，实测 vs surface 4.01:1。 */
  text4: "#6F8496",
  primary: butlerBlue[300],
  primaryHover: "#7BB0DC",
  primaryPress: "#4A87BC",
  primarySoft: "#14293D",
  primarySoftBorder: "#1B3A55",
  onPrimary: ink[900],
  onError: "#FFFFFF",
  brand: brass[500],
  brandSoft: "#2A2417",
  brandLine: "#4A3C22",
  ok: signalDark.ok,
  okSoft: signalDark.okSoft,
  warn: signalDark.warn,
  warnSoft: signalDark.warnSoft,
  error: signalDark.error,
  errorSoft: signalDark.errorSoft,
  offline: signalDark.offline,
  offlineSoft: signalDark.offlineSoft,
  // 暗色阴影：发丝高光 + 深投影（暗色阴影要更深才能分离面板）。
  shadow1: "0 0 0 0.5px rgb(255 255 255 / 5%), 0 2px 8px rgb(0 0 0 / 35%)",
  shadow2: "0 0 0 0.5px rgb(255 255 255 / 7%), 0 8px 24px rgb(0 0 0 / 45%), 0 24px 64px rgb(0 0 0 / 40%)",
  focusRing: "0 0 0 3px rgb(91 155 209 / 35%)",
};

export function paletteFor(mode: ThemeMode): SemanticPalette {
  return mode === "dark" ? darkPalette : lightPalette;
}

/* ────────  3. 圆角 / 字体 / 字阶 / 间距 / 动效 / 布局（规范 02 §3/§5、03 §2）  ──────── */

/** 圆角：卡片 16（macOS Big Sur 后 12–16 连续观感取中）/ 控件 8 / 徽标与小标签 6 / 浮层 20。 */
export const radius = {
  card: 16,
  control: 8,
  tag: 6,
  /** Modal / Popover / Drawer / Dropdown 等浮层档。 */
  float: 20,
} as const;

/**
 * 品牌字体栈：mac 系统字体最前（SF Pro / 苹方自动命中），Windows 命中 Segoe + 雅黑。
 * Inter 不删，移到 Segoe 之后作 Windows 回退（装了 Inter 的 Windows 用户观感不变）。
 * 本机优先产品不依赖网络字体，不新增 @font-face。
 */
const fontStack =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI Variable Text", "Segoe UI", "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export const fontFamily = fontStack;

/** 等宽栈：只用于日志、版本串、ID/哈希、端口号、JSON、代码块、指标数值。 */
export const monoFontFamily =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace';

/** 字阶（px）。最小 12，正文 14，中文行高不低于 1.6。 */
export const typeScale = {
  display: { size: 30, lineHeight: 1.2, weight: 700 },
  h1: { size: 24, lineHeight: 1.3, weight: 600 },
  h2: { size: 20, lineHeight: 1.4, weight: 600 },
  h3: { size: 16, lineHeight: 1.5, weight: 600 },
  body: { size: 14, lineHeight: 1.6, weight: 400 },
  bodySm: { size: 13, lineHeight: 1.55, weight: 400 },
  caption: { size: 12, lineHeight: 1.5, weight: 500 },
} as const;

/** 动效时长（ms）与曲线。无弹性、无回弹、无循环闪烁。 */
export const motion = {
  fast: 120,
  base: 200,
  slow: 320,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

/** 间距刻度（4 的倍数）。 */
export const space = [4, 8, 12, 16, 24, 32, 48] as const;

/** 布局骨架：侧栏 240 / 顶栏 56 / 内容最大 1440 / padding 24 / 12 列栅格。 */
export const layout = {
  siderWidth: 240,
  topbarHeight: 56,
  contentMax: 1440,
  contentPadding: 24,
  columns: 12,
  gutter: 16,
} as const;

/**
 * 响应式断点（规范 03 §8）。
 *
 * 【为什么是这两个数】此前 CSS 里散着 520 / 600 / 760 / 860 / 899 / 1200 六个阈值，
 * 结果是 601–899px 区间（平板竖屏、手机横屏、分屏窗口）侧栏仍以 240px 常驻，
 * 内容区被压到 320–660px——卡片换行严重、表格横向溢出（评审 P1-4）。
 *
 * 收敛为两档后：≥900 侧栏常驻展开；768–899 侧栏进 Drawer；<768 单列 + 正文 16px。
 * 媒体查询里的数值必须以本文件为准同步修改（CSS 无法引用 JS 常量）。
 */
export const breakpoints = {
  /** 低于此宽度：侧栏收进 Drawer，顶栏出现汉堡按钮。 */
  drawer: 900,
  /** 低于此宽度：单列布局、正文与表单控件提到 16px、内容 padding 16。 */
  single: 768,
} as const;

/* ────────────────────────  4. antd 主题（ConfigProvider）  ──────────────────────── */

/** ConfigProvider 主题：antd v6 原生观感 + 品牌色板，组件层零覆盖。 */
export function themeConfigFor(mode: ThemeMode): ThemeConfig {
  const p = paletteFor(mode);
  return {
    // antd v6 起 cssVar 的类型为 { prefix?, key? } | false，空对象即开启（默认 --ant-* 前缀）。
    cssVar: {},
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorInfo: p.primary,
      // hover/press 也必须显式给：色板里定义了 primaryHover/primaryPress，
      // 但此前从没传进 ConfigProvider，antd 一直在自己派生 —— ghost / link 形态的
      // 文字色因此落到 press 档（实测暗色只剩 4.06:1）。
      colorPrimaryHover: p.primaryHover,
      colorPrimaryActive: p.primaryPress,
      // 状态色以品牌信号色为真源：浅底状态文字用信号色深值，深底用提亮值。
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.error,
      colorBgLayout: p.canvas,
      ...(mode === "dark" ? { colorBgBase: p.canvas } : {}),
      /**
       * 【必须显式锁住，不能让算法派生】
       * 只传 colorBgBase 时，antd v6 的暗色算法会自己把容器色往蓝色方向提亮：
       * 实测渲染出 #0D284F，而令牌声称的 surface 是 #132538 —— 同一屏出现两种暗色面板，
       * 且所有按令牌算好的对比度全部失准（这是静态审查发现不了、只有渲染后才能看到的缺陷）。
       */
      colorBgContainer: p.surface,
      colorBgElevated: p.surface2,
      // 链接色同理：不锁的话暗色下被派生成 #5087B5，对 #0D284F 只有 3.82:1，不达 AA。
      colorLink: p.primary,
      colorLinkHover: p.primaryHover,
      colorLinkActive: p.primaryPress,
      // 暗色主题的主按钮是管家蓝浅底，实底文字用午夜墨而不是白。
      colorTextLightSolid: mode === "dark" ? p.onPrimary : "#ffffff",
      colorText: p.text,
      colorTextSecondary: p.text2,
      colorTextTertiary: p.text3,
      colorTextQuaternary: p.text4,
      /**
       * antd v6 把 Typography 的 `type="secondary"` 映射到 colorTextDescription，
       * 而 description 默认派生成**三级**色 —— 全站的「次要文字」于是都掉到了三级档，
       * 实测暗色下只剩 4.06:1。这里显式指到二级色，让「次要」真的是次要。
       */
      colorTextDescription: p.text2,
      // 控件描边走 borderControl（≥3:1），不是装饰性的 borderStrong（1.5:1）。
      // 我们的输入框填充与画布几乎同色，边界是唯一识别特征，SC 1.4.11 要求 3:1。
      colorBorder: p.borderControl,
      colorBorderSecondary: p.border,
      borderRadius: radius.control,
      borderRadiusLG: radius.card,
      borderRadiusSM: radius.tag,
      boxShadowTertiary: p.shadow1,
      fontFamily,
      fontSize: typeScale.body.size,
      controlHeight: 32,
    },
    components: {
      // Alert（各页结论条 / 危险确认 / 降级横幅）的底色必须与品牌信号色同源：
      // antd 算法派生的底色（黄绿系）与品牌青绿/琥珀不同相，同屏并存显脏。
      Alert: {
        colorSuccessBg: p.okSoft,
        colorWarningBg: p.warnSoft,
        colorErrorBg: p.errorSoft,
        colorInfoBg: p.primarySoft,
      },
      // 卡片边界体系（P0-7）：亮色卡片 1px 边交还给 shadow1 的发丝线；
      // 暗色发丝线是高光色，承担不了分隔，保留实体边。
      Card: {
        colorBorderSecondary: mode === "light" ? "transparent" : p.border,
      },
      // 显式钉住：Card 的 transparent 档不得波及表格线（表格线是结构边界）。
      Table: {
        colorBorderSecondary: p.border,
      },
    },
  };
}

/* ───────────────────────────  5. CSS 变量桥  ─────────────────────────── */

/** 间距变量刻度（--ab-space-1..7）。 */
const SPACE_SCALE = space;

/** 字阶变量刻度（--ab-text-size-{xs..xxl}）。与 v1.2 逐字一致。 */
const TEXT_SCALE = {
  xs: "12px",
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  xxl: "24px",
} as const;

/**
 * v2 语义色变量（--ab-*）：规范 02 §1.1 的三个角色（管家蓝 / 黄铜 / 信号色）+ 表面与文字。
 * 页面 CSS 的目标状态就是只引用这一组。
 */
const AB_COLOR_VARS: Array<[name: string, pick: (p: SemanticPalette) => string]> = [
  ["--ab-canvas", (p) => p.canvas],
  ["--ab-surface", (p) => p.surface],
  ["--ab-surface-2", (p) => p.surface2],
  ["--ab-sunken", (p) => p.sunken],
  ["--ab-sider", (p) => p.sider],
  ["--ab-border", (p) => p.border],
  ["--ab-border-strong", (p) => p.borderStrong],
  ["--ab-border-control", (p) => p.borderControl],
  ["--ab-text", (p) => p.text],
  ["--ab-text-2", (p) => p.text2],
  ["--ab-text-3", (p) => p.text3],
  ["--ab-text-4", (p) => p.text4],
  ["--ab-muted", (p) => p.text3],
  ["--ab-primary", (p) => p.primary],
  ["--ab-primary-hover", (p) => p.primaryHover],
  ["--ab-primary-press", (p) => p.primaryPress],
  ["--ab-primary-soft", (p) => p.primarySoft],
  ["--ab-primary-soft-border", (p) => p.primarySoftBorder],
  ["--ab-on-primary", (p) => p.onPrimary],
  ["--ab-on-error", (p) => p.onError],
  ["--ab-brand", (p) => p.brand],
  ["--ab-brand-soft", (p) => p.brandSoft],
  ["--ab-brand-line", (p) => p.brandLine],
  ["--ab-ok", (p) => p.ok],
  ["--ab-ok-soft", (p) => p.okSoft],
  ["--ab-warn", (p) => p.warn],
  ["--ab-warn-soft", (p) => p.warnSoft],
  ["--ab-error", (p) => p.error],
  ["--ab-error-soft", (p) => p.errorSoft],
  ["--ab-offline", (p) => p.offline],
  ["--ab-offline-soft", (p) => p.offlineSoft],
  // 图表第二系列在 v2 由黄铜承担（v1.2 的信号青已退役）。
  ["--ab-chart-2", (p) => p.brand],
  ["--ab-chart-2-soft", (p) => p.brandSoft],
  ["--ab-shadow-1", (p) => p.shadow1],
  ["--ab-shadow-2", (p) => p.shadow2],
  ["--ab-focus", (p) => p.focusRing],
];

/**
 * 把当前主题变量写入 :root 内联样式并设置 data-theme：
 * 内联优先级高于任何样式表声明，杜绝历史 :root 残留干扰。
 */
export function applyThemeCssBridge(mode: ThemeMode): void {
  const p = paletteFor(mode);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  const vars: Record<string, string> = {};

  for (const [name, pick] of AB_COLOR_VARS) vars[name] = pick(p);

  const r = (n: number) => `${n}px`;
  const ms = (n: number) => `${n}ms`;

  // 结构型变量（间距/字阶/圆角/动效/字体）：与 v1.2 逐字一致，只加 --ab-* 前缀。
  for (let i = 0; i < SPACE_SCALE.length; i += 1) {
    vars[`--ab-space-${i + 1}`] = r(SPACE_SCALE[i]);
  }
  for (const [key, value] of Object.entries(TEXT_SCALE)) {
    vars[`--ab-text-size-${key}`] = value;
  }

  vars["--ab-r-card"] = r(radius.card);
  vars["--ab-r-ctl"] = r(radius.control);
  vars["--ab-r-tag"] = r(radius.tag);
  vars["--ab-r-float"] = r(radius.float);

  vars["--ab-dur-fast"] = ms(motion.fast);
  vars["--ab-dur-base"] = ms(motion.base);
  vars["--ab-dur-slow"] = ms(motion.slow);
  vars["--ab-ease"] = motion.ease;

  vars["--ab-font"] = fontFamily;
  vars["--ab-mono"] = monoFontFamily;

  // 阶段 5B 补齐的 --ab-* 镜像（吸收 taste.css :root 里的局部变量）。
  // 旧 taste.css 在 :root 块里定义 --butler-content-max / --butler-focus-offset / --butler-stat-accent，
  // 现统一上移到 tokens.ts，让所有页面走同一份语义令牌。
  vars["--ab-control-h"] = "32px";
  vars["--ab-focus-offset"] = "2px";
  vars["--ab-stat-accent"] = "color-mix(in srgb, var(--ab-primary) 86%, var(--ab-text-3))";

  // 布局标量，供 CSS 引用，避免 240/1440 这类魔法值散落各处。
  vars["--ab-sider-w"] = r(layout.siderWidth);
  vars["--ab-topbar-h"] = r(layout.topbarHeight);
  vars["--ab-content-max"] = r(layout.contentMax);
  vars["--ab-content-pad"] = r(layout.contentPadding);

  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
