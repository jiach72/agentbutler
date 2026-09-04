/**
 * 主题真源（antd v6 原生重构版）：
 * 以 antd v6 设计语言为唯一基准 —— 钴蓝品牌色、中性面板、扁平发丝线，
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

/** 亮色：冷灰白底 + 近黑文字 + 钴蓝交互，发丝线优先于投影。 */
export const lightPalette: SemanticPalette = {
  primary: "#2f54eb",
  primarySoft: "#f0f5ff",
  bg: "#f5f6f8",
  surface: "#ffffff",
  surfaceSubtle: "#f7f8fa",
  sunken: "#eef1f4",
  raised: "#ffffff",
  ink: "#1d2129",
  inkSoft: "#4e5969",
  inkFaint: "#86909c",
  muted: "#6b7280",
  rule: "#e5e6eb",
  ruleStrong: "#c9cdd4",
  ok: "#52c41a",
  okSoft: "#f6ffed",
  warn: "#faad14",
  warnSoft: "#fffbe6",
  error: "#ff4d4f",
  errorSoft: "#fff1f0",
  notificationBadge: "#b42318",
  notificationBadgeOn: "#ffffff",
  onPrimary: "#ffffff",
  teal: "#13c2c2",
  tealSoft: "#e6fffb",
  cinnabar: "#fa541c",
  cinnabarSoft: "#fff2e8",
  onPrimaryEmphasis: "#1d2129",
  shadow: "0 1px 2px rgb(15 23 42 / 5%), 0 4px 12px rgb(15 23 42 / 6%)",
  shadowStrong: "0 18px 44px rgb(15 23 42 / 16%), 0 6px 16px rgb(15 23 42 / 8%)",
  focusRing: "0 0 0 3px rgb(47 84 235 / 25%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.65)",
};

/** 暗色：石墨蓝黑底 + 柔白文字 + 提亮钴蓝；语义色整体提亮保证对比度。 */
export const nightPalette: SemanticPalette = {
  primary: "#85a5ff",
  primarySoft: "#1c2748",
  bg: "#0f1115",
  surface: "#16181d",
  surfaceSubtle: "#1b1e24",
  sunken: "#0c0e11",
  raised: "#1f2229",
  ink: "#e8eaed",
  inkSoft: "#b8bfc9",
  inkFaint: "#7c8590",
  muted: "#b8bfc9",
  rule: "#262a32",
  ruleStrong: "#363c46",
  ok: "#95de64",
  okSoft: "#1a2b1c",
  warn: "#ffc53d",
  warnSoft: "#2f2a12",
  error: "#ff7875",
  errorSoft: "#3a221f",
  notificationBadge: "#b42318",
  notificationBadgeOn: "#ffffff",
  onPrimary: "#0d1b4d",
  teal: "#36cfc9",
  tealSoft: "#123a3f",
  cinnabar: "#ff9a6e",
  cinnabarSoft: "#3d2417",
  onPrimaryEmphasis: "#e8eaed",
  shadow: "0 1px 2px rgb(0 0 0 / 45%), 0 4px 14px rgb(0 0 0 / 30%)",
  shadowStrong: "0 18px 44px rgb(0 0 0 / 55%), 0 6px 16px rgb(0 0 0 / 35%)",
  focusRing: "0 0 0 3px rgb(133 165 255 / 35%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.04)",
};

export function paletteFor(mode: ThemeMode): SemanticPalette {
  return mode === "dark" ? nightPalette : lightPalette;
}

export const radius = {
  card: 10,
  control: 8,
} as const;

const fontStack =
  '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export const fontFamily = fontStack;

/** 等宽栈：日志、ID、指标等数据型文本。 */
export const monoFontFamily =
  '"Cascadia Mono", Consolas, "SF Mono", Menlo, "Courier New", monospace';

/** ConfigProvider 主题：antd v6 原生观感，组件层零覆盖。 */
export function themeConfigFor(mode: ThemeMode): ThemeConfig {
  const palette = paletteFor(mode);
  return {
    // antd v6 起 cssVar 的类型为 { prefix?, key? } | false，空对象即开启（默认 --ant-* 前缀）。
    cssVar: {},
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: palette.primary,
      colorInfo: palette.primary,
      colorBgLayout: palette.bg,
      ...(mode === "dark" ? { colorBgBase: "#13151a" } : {}),
      colorText: palette.ink,
      colorTextSecondary: palette.inkSoft,
      colorTextTertiary: palette.muted,
      colorTextQuaternary: palette.inkFaint,
      colorBorder: palette.ruleStrong,
      colorBorderSecondary: palette.rule,
      borderRadius: radius.control,
      borderRadiusLG: radius.card,
      borderRadiusSM: 5,
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
