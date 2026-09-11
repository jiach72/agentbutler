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

/** 黄铜（品牌记忆色）：只用于标志、锁版、插画、图表第二系列、"推荐"标记。不做默认按钮、不做状态。 */
export const brass = {
  700: "#8A6A2A",
  600: "#A8823C",
  500: "#C8A15A",
  100: "#F2E4C6",
  50: "#F8F1E1",
} as const;

/** 墨阶（中性，10 级）。ink-300 及以下不可用于正文。 */
export const ink = {
  900: "#0B1728",
  800: "#16283C",
  700: "#233B52",
  600: "#3A5468",
  500: "#4A6076",
  400: "#5F7488",
  300: "#8496A8",
  200: "#C6D3E0",
  100: "#E2E9F1",
  50: "#F4F7FA",
} as const;

/**
 * 信号色（亮色主题）：状态专用。
 * 离线与未知同色，靠文案区分——离线是"确定连不上"，未知是"还不知道"。
 */
export const signal = {
  ok: "#0B7F6F",
  okSoft: "#EAF6F3",
  warn: "#9A6B0B",
  warnSoft: "#FDF6E4",
  error: "#B4342A",
  errorSoft: "#FDF0EE",
  offline: "#5F7488",
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
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  text4: string;
  primary: string;
  primaryHover: string;
  primaryPress: string;
  primarySoft: string;
  primarySoftBorder: string;
  onPrimary: string;
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

/** 亮色：雪白卡片 + 管家蓝交互 + 黄铜记忆点 + 信号色状态；发丝线优先于投影。 */
export const lightPalette: SemanticPalette = {
  canvas: "#F7F9FC",
  surface: "#FFFFFF",
  surface2: ink[50],
  sunken: ink[50],
  sider: "#FFFFFF",
  border: ink[100],
  borderStrong: ink[200],
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
  shadow1: "0 1px 2px rgb(11 23 40 / 5%), 0 4px 12px rgb(11 23 40 / 7%)",
  shadow2: "0 18px 44px rgb(11 23 40 / 16%), 0 6px 16px rgb(11 23 40 / 8%)",
  focusRing: "0 0 0 3px rgb(27 79 122 / 30%)",
};

/** 暗色：午夜墨底 + 管家蓝交互（提亮版）+ 黄铜记忆点 + 信号色状态。 */
export const darkPalette: SemanticPalette = {
  canvas: ink[900],
  surface: "#132538",
  surface2: "#1A2E44",
  sunken: "#081220",
  sider: "#0F2133",
  border: "#22374D",
  borderStrong: "#2E4760",
  text: "#E9F0F7",
  text2: "#AFC0D1",
  text3: "#7E93A8",
  text4: "#5F7488",
  primary: butlerBlue[300],
  primaryHover: "#7BB0DC",
  primaryPress: "#4A87BC",
  primarySoft: "#14293D",
  primarySoftBorder: "#1B3A55",
  onPrimary: ink[900],
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
  shadow1: "0 1px 2px rgb(0 0 0 / 45%), 0 4px 14px rgb(0 0 0 / 32%)",
  shadow2: "0 18px 44px rgb(0 0 0 / 55%), 0 6px 16px rgb(0 0 0 / 38%)",
  focusRing: "0 0 0 3px rgb(91 155 209 / 35%)",
};

export function paletteFor(mode: ThemeMode): SemanticPalette {
  return mode === "dark" ? darkPalette : lightPalette;
}

/* ────────  3. 圆角 / 字体 / 字阶 / 间距 / 动效 / 布局（规范 02 §3/§5、03 §2）  ──────── */

/** 圆角：卡片 14 / 控件 8 / 徽标与小标签 6。 */
export const radius = {
  card: 14,
  control: 8,
  tag: 6,
} as const;

/**
 * 品牌字体栈：Inter/SF Pro 优先，中文回退苹方/雅黑。
 * 本机优先产品不依赖网络字体，Inter 缺失时回退必须仍然可读。
 */
const fontStack =
  '"Inter", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export const fontFamily = fontStack;

/** 等宽栈：只用于日志、版本串、ID/哈希、端口号、JSON、代码块、指标数值。 */
export const monoFontFamily =
  '"Cascadia Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace';

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
      // 状态色以品牌信号色为真源：浅底状态文字用信号色深值，深底用提亮值。
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.error,
      colorBgLayout: p.canvas,
      ...(mode === "dark" ? { colorBgBase: p.canvas } : {}),
      // 暗色主题的主按钮是管家蓝浅底，实底文字用午夜墨而不是白。
      colorTextLightSolid: mode === "dark" ? p.onPrimary : "#ffffff",
      colorText: p.text,
      colorTextSecondary: p.text2,
      colorTextTertiary: p.text3,
      colorTextQuaternary: p.text4,
      colorBorder: p.borderStrong,
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
