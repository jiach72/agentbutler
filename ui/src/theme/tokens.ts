/**
 * 主题真源：「Console Light」（亮色，默认）与「Graphite Night」（暗色）两套冷中性色板、
 * 圆角、字号、间距、动效的唯一定义处。
 * antd ConfigProvider 与 CSS 变量桥都从这里取值；界面样式只允许引用 --butler-* 变量，
 * 硬编码色值仅允许出现在本文件。
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

export interface ButlerPalette {
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
  accent: string;
  accentSoft: string;
  cinnabar: string;
  cinnabarSoft: string;
  teal: string;
  tealSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  error: string;
  errorSoft: string;
  onAccent: string;
  ruleStrong: string;
  shadow: string;
  shadowStrong: string;
  focusRing: string;
  /** 卡片表面顶部的一丝高光，让面板更立体（深浅主题不同的内阴影）。 */
  cardHighlight: string;
}

/** Console Light：冷灰白底 + 近黑文字 + 青蓝交互，发丝线边框优先于投影。 */
export const lightPalette: ButlerPalette = {
  bg: "#eef1f4",
  surface: "#ffffff",
  surfaceSubtle: "#f6f8fa",
  sunken: "#edf0f3",
  raised: "#ffffff",
  ink: "#16191e",
  inkSoft: "#40474f",
  // Used for secondary text on white surfaces; keep above WCAG AA for normal text.
  inkFaint: "#66717d",
  muted: "#5d6672",
  rule: "#e3e7eb",
  accent: "#0e7683",
  accentSoft: "#e2f3f5",
  cinnabar: "#ce3b45",
  cinnabarSoft: "#fbe9ea",
  teal: "#3a67c9",
  tealSoft: "#e7edfb",
  ok: "#16803c",
  okSoft: "#e6f5ea",
  warn: "#b25e09",
  warnSoft: "#fbf0dd",
  error: "#d02f35",
  errorSoft: "#fceaec",
  onAccent: "#ffffff",
  ruleStrong: "#cfd5db",
  // 两级阴影都刻意压高一档 alpha，保证在浅冷灰背景上纵深肉眼可见。
  shadow: "0 1px 2px rgb(16 24 40 / 7%), 0 3px 8px rgb(16 24 40 / 6%), 0 10px 24px -18px rgb(16 24 40 / 22%)",
  shadowStrong: "0 22px 44px rgb(16 24 40 / 16%), 0 8px 18px rgb(16 24 40 / 9%), 0 2px 6px rgb(16 24 40 / 6%)",
  focusRing: "0 0 0 3px rgb(14 118 131 / 28%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.9), inset 0 0 0 1px rgb(255 255 255 / 0.35)",
};

/** Graphite Night：石墨底 + 暖白文字 + 亮青交互；语义色整体提亮保证对比度。 */
export const nightPalette: ButlerPalette = {
  bg: "#0e1116",
  surface: "#151a20",
  surfaceSubtle: "#191f26",
  sunken: "#0a0d11",
  raised: "#1d242b",
  ink: "#e9edf0",
  inkSoft: "#c5ccd2",
  inkFaint: "#7f8993",
  muted: "#97a1ab",
  rule: "#262e36",
  accent: "#41b7c4",
  accentSoft: "#113b42",
  cinnabar: "#ef7d76",
  cinnabarSoft: "#3c2220",
  teal: "#8da6f2",
  tealSoft: "#1c2743",
  ok: "#55c583",
  okSoft: "#14301f",
  warn: "#e4af4c",
  warnSoft: "#3a2d12",
  error: "#ef7a70",
  errorSoft: "#3d211e",
  onAccent: "#06282e",
  ruleStrong: "#3a454f",
  shadow: "0 1px 2px rgb(0 0 0 / 35%), 0 4px 14px rgb(0 0 0 / 24%)",
  shadowStrong: "0 16px 38px rgb(0 0 0 / 42%), 0 6px 12px rgb(0 0 0 / 30%)",
  focusRing: "0 0 0 3px rgb(65 183 196 / 38%)",
  cardHighlight: "inset 0 1px 0 rgb(255 255 255 / 0.04)",
};

export const radius = {
  card: 12,
  control: 8,
} as const;

const fontStack =
  '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export const fontFamily = fontStack;

/** 等宽栈：日志、ID、指标等数据型文本。 */
export const monoFontFamily =
  '"Cascadia Mono", Consolas, "SF Mono", Menlo, "Courier New", monospace';

/** 展示型标题沿用正文字体（加字重），不再引入衬线/网络字体。 */
export const displayFontFamily = fontStack;

const motion = {
  durFast: "120ms",
  durBase: "200ms",
  durSlow: "320ms",
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

/**
 * 字号阶梯（px）：全站最小 12，正文 14，区块题 16-18，页面题 20-24。
 * CSS 一律通过 --butler-text-* 引用。
 */
const typeScale = {
  xs: "12px",
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  xxl: "24px",
} as const;

/** 4/8 间距网格。CSS 通过 --butler-space-* 引用。 */
const spaceScale = [4, 8, 12, 16, 24, 32] as const;

function buildThemeConfig(p: ButlerPalette, mode: ThemeMode): ThemeConfig {
  return {
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.accent,
      colorInfo: p.accent,
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.error,
      // 语义柔和底统一走本文件色板的 soft 变体，避免 antd 默认派生色与页面不协调。
      colorInfoBg: p.accentSoft,
      colorInfoBgHover: p.accentSoft,
      colorSuccessBg: p.okSoft,
      colorSuccessBgHover: p.okSoft,
      colorWarningBg: p.warnSoft,
      colorWarningBgHover: p.warnSoft,
      colorErrorBg: p.errorSoft,
      colorErrorBgHover: p.errorSoft,
      colorBgLayout: p.bg,
      colorBgContainer: p.surface,
      colorBgElevated: mode === "dark" ? p.raised : p.raised,
      colorText: p.ink,
      colorTextSecondary: p.muted,
      colorBorder: p.ruleStrong,
      colorBorderSecondary: p.rule,
      borderRadius: radius.control,
      borderRadiusLG: radius.card,
      borderRadiusSM: 4,
      boxShadowTertiary: p.shadow,
      fontFamily,
      fontSize: 14,
      // 全站统一控件高度（输入框/按钮/下拉等），避免同排控件因默认尺寸差异出现错位。
      controlHeight: 32,
    },
    components: {
      Button: {
        fontWeight: 500,
        primaryColor: p.onAccent,
        defaultBorderColor: p.ruleStrong,
      },
      Table: {
        headerBg: p.surfaceSubtle,
        headerSplitColor: "transparent",
        cellFontSizeSM: 13,
        cellPaddingBlockSM: 6,
        rowHoverBg: p.surfaceSubtle,
      },
      Tag: {
        defaultBg: p.sunken,
      },
      Modal: {
        titleFontSize: 16,
      },
      Tooltip: {
        fontSize: 12,
      },
      Collapse: {
        headerBg: p.surfaceSubtle,
      },
    },
  };
}

export function themeConfigFor(mode: ThemeMode): ThemeConfig {
  return buildThemeConfig(mode === "dark" ? nightPalette : lightPalette, mode);
}

const paletteVars = (p: ButlerPalette): Record<string, string> => ({
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
  "--butler-accent": p.accent,
  "--butler-accent-soft": p.accentSoft,
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
  "--butler-on-accent": p.onAccent,
  "--butler-rule-strong": p.ruleStrong,
  // 兼容历史命别名（text-muted 与 muted 同源），样式迁移期保留。
  "--butler-text-muted": p.muted,
  "--butler-shadow": p.shadow,
  "--butler-shadow-strong": p.shadowStrong,
  "--butler-card-highlight": p.cardHighlight,
  "--butler-surface-strong": p.raised,
});

/**
 * 把当前主题 token 写入 :root 内联变量并设置 data-theme：
 * 内联优先级高于任何样式表声明，杜绝历史 :root 残留干扰。
 */
export function applyThemeCssBridge(mode: ThemeMode): void {
  const p = mode === "dark" ? nightPalette : lightPalette;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  const vars: Record<string, string> = {
    ...paletteVars(p),
    "--butler-radius-card": `${radius.card}px`,
    "--butler-radius-control": `${radius.control}px`,
    "--butler-control-h": "32px",
    "--butler-focus-ring": p.focusRing,
    "--butler-dur-fast": motion.durFast,
    "--butler-dur-base": motion.durBase,
    "--butler-dur-slow": motion.durSlow,
    "--butler-ease": motion.ease,
    "--butler-body-font": fontFamily,
    "--butler-mono-font": monoFontFamily,
    ...Object.fromEntries(typeScaleEntries()),
    ...spaceVars(),
  };
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

function typeScaleEntries(): Array<[string, string]> {
  return Object.entries(typeScale).map(([key, value]) => [`--butler-text-${key}`, value]);
}

function spaceVars(): Record<string, string> {
  const entries: Array<[string, string]> = spaceScale.map((value, index) => [
    `--butler-space-${index + 1}`,
    `${value}px`,
  ]);
  return Object.fromEntries(entries);
}
