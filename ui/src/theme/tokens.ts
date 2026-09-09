/**
 * 主题真源（antd v6 原生重构版）：
 * 以品牌视觉规范 v1.2（docs/agent-butler-brand）为唯一基准 ——
 * 午夜蓝承担专业与"本地/私有化"的重量感，黄铜金是唯一品牌记忆色，
 * 信号青只用于状态。规范红线：金与青在白底上对比度不足，
 * 浅色主题一律使用各自的"深墨"变体（黄铜深 #8A6A2A / 信号青深 #0B7F6F），
 * 纯金 #C8A15A 与纯青 #35D0BA 只出现在深色主题或图形填充中。
 * 亮色走 defaultAlgorithm、暗色走 darkAlgorithm 派生，cssVar 显式开启。
 * 本文件是唯一允许出现具体色值的地方；界面样式只允许引用变量。
 *
 * 兼容说明：历史 CSS 使用 --butler-* 变量名。在页面 antd 化迁移完成前，
 * applyThemeCssBridge 继续以同名变量输出新设计的取值；迁移完成后该桥退役，
 * 残留样式统一改用 antd 的 --ant-* 变量。
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

/**
 * 语义色板：antd 算法产出的关键派生色的静态快照，
 * 供「CSS 兼容桥」与图表主题取值。antd 组件自身一律走 ConfigProvider 派生，
 * 不读取这里的值 —— 两处取值必须保持视觉一致，改色时同步修改。
 */
export interface SemanticPalette {
  primary: string;
  primarySoft: string;
  bg: string;
  surface: string;
  surfaceSubtle: string;
  sunken: string;
  raised: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  muted: string;
  rule: string;
  ruleStrong: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  error: string;
  errorSoft: string;
  notificationBadge: string;
  notificationBadgeOn: string;
  onPrimary: string;
  /** 图表第二系列（青色系）。 */
  teal: string;
  tealSoft: string;
  /** 暖橙强调（危险/降级类徽标的辅助色相）。 */
  cinnabar: string;
  cinnabarSoft: string;
  onPrimaryEmphasis: string;
  shadow: string;
  shadowStrong: string;
  focusRing: string;
  cardHighlight: string;
}

/** 亮色：雪白底 + 午夜蓝正文 + 黄铜深交互，信号青深只做状态；发丝线优先于投影。 */
export const lightPalette: SemanticPalette = {
  primary: "#8a6a2a",
  primarySoft: "#f6eedc",
  bg: "#f5f7fa",
  surface: "#ffffff",
  surfaceSubtle: "#f8fafc",
  sunken: "#edf2f8",
  raised: "#ffffff",
  ink: "#0e1b2a",
  inkSoft: "#3e5468",
  inkFaint: "#8296aa",
  muted: "#5a6b7c",
  rule: "#e4e9f0",
  ruleStrong: "#c9d4e0",
  ok: "#0b7f6f",
  okSoft: "#e7f4f1",
  warn: "#9a6b0b",
  warnSoft: "#faf3db",
  error: "#b4342a",
  errorSoft: "#f9e9e6",
  notificationBadge: "#b42318",
  notificationBadgeOn: "#ffffff",
  onPrimary: "#ffffff",
  teal: "#129483",
  tealSoft: "#e4f4f0",
  cinnabar: "#b85c2e",
  cinnabarSoft: "#f9ede3",
  onPrimaryEmphasis: "#0e1b2a",
  shadow: "0 1px 2px rgb(14 27 42 / 5%), 0 4px 12px rgb(14 27 42 / 7%)",
  shadowStrong: "0 18px 44px rgb(14 27 42 / 16%), 0 6px 16px rgb(14 27 42 / 8%)",
  focusRing: "0 0 0 3px rgb(138 106 42 / 30%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.65)",
};

/**
 * 暗色：午夜蓝底 + 黄铜金交互 + 信号青状态（规范推荐组合，
 * 金 on 午夜蓝 7.2:1、青 on 午夜蓝 9.0:1）。
 */
export const nightPalette: SemanticPalette = {
  primary: "#c8a15a",
  primarySoft: "#2c3e58",
  bg: "#0e1b2a",
  surface: "#16293e",
  surfaceSubtle: "#1a2e46",
  sunken: "#0a1521",
  raised: "#1e3852",
  ink: "#eaf1f8",
  inkSoft: "#b5c4d4",
  inkFaint: "#7e92a6",
  muted: "#8fa2b4",
  rule: "#23384f",
  ruleStrong: "#33506e",
  ok: "#35d0ba",
  okSoft: "#123531",
  warn: "#ffc53d",
  warnSoft: "#3a3014",
  error: "#ff7875",
  errorSoft: "#3c2426",
  notificationBadge: "#dc4a3a",
  notificationBadgeOn: "#ffffff",
  onPrimary: "#0d1b2a",
  teal: "#35d0ba",
  tealSoft: "#143c42",
  cinnabar: "#ff9a6e",
  cinnabarSoft: "#3e2a1b",
  onPrimaryEmphasis: "#eaf1f8",
  shadow: "0 1px 2px rgb(0 0 0 / 45%), 0 4px 14px rgb(0 0 0 / 32%)",
  shadowStrong: "0 18px 44px rgb(0 0 0 / 55%), 0 6px 16px rgb(0 0 0 / 38%)",
  focusRing: "0 0 0 3px rgb(200 161 90 / 35%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.05)",
};

export function paletteFor(mode: ThemeMode): SemanticPalette {
  return mode === "dark" ? nightPalette : lightPalette;
}

export const radius = {
  card: 14,
  control: 8,
} as const;

/** 品牌字体栈：Inter/SF Pro 优先，中文回退苹方/雅黑（规范 05 / 字体）。 */
const fontStack =
  '"Inter", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export const fontFamily = fontStack;

/** 等宽栈：日志、ID、指标等数据型文本。 */
export const monoFontFamily =
  '"Cascadia Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace';

/** ConfigProvider 主题：antd v6 原生观感 + 品牌色板，组件层零覆盖。 */
export function themeConfigFor(mode: ThemeMode): ThemeConfig {
  const palette = paletteFor(mode);
  return {
    // antd v6 起 cssVar 的类型为 { prefix?, key? } | false，空对象即开启（默认 --ant-* 前缀）。
    cssVar: {},
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: palette.primary,
      colorInfo: palette.primary,
      // 状态色同样以品牌语义板为真源：浅底状态文字必须可读
      // （信号青深/黄铜深系），深底用信号青/琥珀。antd 由此派生浅色底与描边。
      colorSuccess: palette.ok,
      colorWarning: palette.warn,
      colorError: palette.error,
      colorBgLayout: palette.bg,
      ...(mode === "dark" ? { colorBgBase: "#0e1b2a" } : {}),
      // 深色主题的主按钮是黄铜金底，实底文字改用午夜蓝而不是白（白 on 金仅 2.2:1）。
      colorTextLightSolid: mode === "dark" ? "#0d1b2a" : "#ffffff",
      colorText: palette.ink,
      colorTextSecondary: palette.inkSoft,
      colorTextTertiary: palette.muted,
      colorTextQuaternary: palette.inkFaint,
      colorBorder: palette.ruleStrong,
      colorBorderSecondary: palette.rule,
      borderRadius: radius.control,
      borderRadiusLG: radius.card,
      borderRadiusSM: 6,
      boxShadowTertiary: paletteFor(mode).shadow,
      fontFamily,
      fontSize: 14,
      controlHeight: 32,
    },
  };
}

const paletteVars = (p: SemanticPalette): Record<string, string> => ({
  "--butler-bg": p.bg,
  "--butler-surface": p.surface,
  "--butler-surface-subtle": p.surfaceSubtle,
  "--butler-sunken": p.sunken,
  "--butler-raised": p.raised,
  "--butler-ink": p.ink,
  "--butler-ink-soft": p.inkSoft,
  "--butler-ink-faint": p.inkFaint,
  "--butler-muted": p.muted,
  "--butler-rule": p.rule,
  "--butler-accent": p.primary,
  "--butler-accent-soft": p.primarySoft,
  "--butler-cinnabar": p.cinnabar,
  "--butler-cinnabar-soft": p.cinnabarSoft,
  "--butler-teal": p.teal,
  "--butler-teal-soft": p.tealSoft,
  "--butler-ok": p.ok,
  "--butler-ok-soft": p.okSoft,
  "--butler-warn": p.warn,
  "--butler-warn-soft": p.warnSoft,
  "--butler-error": p.error,
  "--butler-error-soft": p.errorSoft,
  "--butler-notification-badge": p.notificationBadge,
  "--butler-notification-badge-on": p.notificationBadgeOn,
  "--butler-on-accent": p.onPrimary,
  "--butler-rule-strong": p.ruleStrong,
  // 兼容历史命别名（text-muted 与 muted 同源），迁移期保留。
  "--butler-text-muted": p.muted,
  "--butler-shadow": p.shadow,
  "--butler-shadow-strong": p.shadowStrong,
  "--butler-card-highlight": p.cardHighlight,
  "--butler-surface-strong": p.raised,
});

/**
 * 把当前主题变量写入 :root 内联样式并设置 data-theme：
 * 内联优先级高于任何样式表声明，杜绝历史 :root 残留干扰。
 */
export function applyThemeCssBridge(mode: ThemeMode): void {
  const p = paletteFor(mode);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  const vars: Record<string, string> = {
    ...paletteVars(p),
    "--butler-radius-card": `${radius.card}px`,
    "--butler-radius-control": `${radius.control}px`,
    "--butler-control-h": "32px",
    "--butler-focus-ring": p.focusRing,
    "--butler-dur-fast": "120ms",
    "--butler-dur-base": "200ms",
    "--butler-dur-slow": "320ms",
    "--butler-ease": "cubic-bezier(0.2, 0, 0, 1)",
    "--butler-body-font": fontFamily,
    "--butler-mono-font": monoFontFamily,
    ...Object.fromEntries(typeScaleEntries()),
    ...spaceVars(),
  };
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

/** 字号阶梯（px）：全站最小 12，正文 14。CSS 通过 --butler-text-* 引用。 */
function typeScaleEntries(): Array<[string, string]> {
  const typeScale = {
    xs: "12px",
    sm: "13px",
    md: "14px",
    lg: "16px",
    xl: "20px",
    xxl: "24px",
  } as const;
  return Object.entries(typeScale).map(([key, value]) => [`--butler-text-${key}`, value]);
}

/** 4/8 间距网格。CSS 通过 --butler-space-* 引用。 */
function spaceVars(): Record<string, string> {
  const spaceScale = [4, 8, 12, 16, 24, 32] as const;
  return Object.fromEntries(
    spaceScale.map((value, index) => [`--butler-space-${index + 1}`, `${value}px`]),
  );
}
