/**
 * 主题真源：「纸墨管家」（亮色，默认）与「墨青夜灯」（暗色）两套色板、圆角、字体、动效的唯一定义处。
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
  shadow: string;
  focusRing: string;
}

/** 纸墨管家：暖纸底 + 墨色文字 + 墨蓝交互 + 朱砂印记。 */
export const paperPalette: ButlerPalette = {
  bg: "#f7f4ee",
  surface: "#fffdf8",
  surfaceSubtle: "#f8f5ee",
  sunken: "#efe9dc",
  raised: "#ffffff",
  ink: "#2b2620",
  inkSoft: "#4a4438",
  inkFaint: "#97907f",
  muted: "#8a8072",
  rule: "#e6dfd1",
  accent: "#2e5e8f",
  accentSoft: "#e7eef4",
  cinnabar: "#b83a2e",
  cinnabarSoft: "#f9e9e5",
  teal: "#2f8a80",
  tealSoft: "#e3f1ef",
  ok: "#3d7a52",
  okSoft: "#e7f2ea",
  warn: "#a8681f",
  warnSoft: "#f9efdd",
  error: "#bf3b30",
  errorSoft: "#faeae7",
  shadow: "0 1px 2px rgb(62 50 34 / 6%), 0 2px 6px rgb(62 50 34 / 5%)",
  focusRing: "0 0 0 3px rgb(46 94 143 / 20%)",
};

/** 墨青夜灯：石墨墨蓝底 + 暖白文字 + 青瓷交互，语义色整体提亮保证对比度。 */
export const nightPalette: ButlerPalette = {
  bg: "#14181d",
  surface: "#1b2128",
  surfaceSubtle: "#1f262e",
  sunken: "#10141a",
  raised: "#232b33",
  ink: "#e9e6de",
  inkSoft: "#c9c6bc",
  inkFaint: "#767f78",
  muted: "#96a09b",
  rule: "#2b3540",
  accent: "#4aa89d",
  accentSoft: "#1d2e2c",
  cinnabar: "#e07a6b",
  cinnabarSoft: "#33211e",
  teal: "#56b3a8",
  tealSoft: "#16302c",
  ok: "#5cb385",
  okSoft: "#17281f",
  warn: "#d99a3d",
  warnSoft: "#2e2415",
  error: "#e0685a",
  errorSoft: "#32201d",
  shadow: "0 1px 2px rgb(0 0 0 / 40%), 0 2px 8px rgb(0 0 0 / 30%)",
  focusRing: "0 0 0 3px rgb(74 168 157 / 30%)",
};

export const radius = {
  card: 14,
  control: 10,
} as const;

export const fontFamily =
  '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 品牌印记字体：楷体系最接近印章手写感。走查备注：Windows 下 KaiTi 笔画偏细，
 * 若「管」字印记观感不佳，回退方案是 Microsoft YaHei 加粗。 */
export const sealFontFamily =
  '"Kaiti SC", "STKaiti", "KaiTi", "楷体", Georgia, serif';

/** 大号数字/展示性西文用衬线，配 tabular-nums 保证对齐。 */
export const displayFontFamily =
  'Georgia, "Times New Roman", "Songti SC", "SimSun", serif';

const motion = {
  durFast: "120ms",
  durBase: "200ms",
  durSlow: "320ms",
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

function buildThemeConfig(p: ButlerPalette, mode: ThemeMode): ThemeConfig {
  return {
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.accent,
      colorInfo: p.accent,
      colorSuccess: p.ok,
      colorWarning: p.warn,
      colorError: p.error,
      colorBgLayout: p.bg,
      colorBgContainer: p.surface,
      colorText: p.ink,
      colorTextSecondary: p.muted,
      colorBorderSecondary: p.rule,
      borderRadius: radius.control,
      borderRadiusLG: radius.card,
      boxShadowTertiary: p.shadow,
      fontFamily,
    },
  };
}

export function themeConfigFor(mode: ThemeMode): ThemeConfig {
  return buildThemeConfig(mode === "dark" ? nightPalette : paperPalette, mode);
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
  // 兼容历史命别名（text-muted 与 muted 同源），样式迁移期保留。
  "--butler-text-muted": p.muted,
  "--butler-shadow": p.shadow,
});

/**
 * 把当前主题 token 写入 :root 内联变量并设置 data-theme：
 * 内联优先级高于任何样式表声明，杜绝历史 :root 残留干扰。
 */
export function applyThemeCssBridge(mode: ThemeMode): void {
  const p = mode === "dark" ? nightPalette : paperPalette;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  const vars: Record<string, string> = {
    ...paletteVars(p),
    "--butler-radius-card": `${radius.card}px`,
    "--butler-radius-control": `${radius.control}px`,
    "--butler-focus-ring": p.focusRing,
    "--butler-dur-fast": motion.durFast,
    "--butler-dur-base": motion.durBase,
    "--butler-dur-slow": motion.durSlow,
    "--butler-ease": motion.ease,
    "--butler-body-font": fontFamily,
    "--butler-display-font": displayFontFamily,
    "--butler-seal-font": sealFontFamily,
  };
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
