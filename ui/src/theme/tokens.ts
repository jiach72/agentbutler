/**
 * 主题真源：管家蓝白色板、圆角、字体的唯一定义处。
 * antd ConfigProvider 与迁移期 CSS 变量都从这里取值，杜绝三方分裂。
 */
import { theme, type ThemeConfig } from "antd";

export const palette = {
  bg: "#f5f6f8",
  surface: "#ffffff",
  surfaceSubtle: "#f7f8fa",
  ink: "#1f2328",
  inkSoft: "#34354d",
  inkFaint: "#77788f",
  muted: "#59636e",
  rule: "#e2e5e9",
  accent: "#2456d8",
  accentSoft: "#eaf1fc",
  teal: "#0e9488",
  tealSoft: "#e4f4f2",
  ok: "#1a7f4e",
  okSoft: "#e7f4ec",
  warn: "#b25e09",
  warnSoft: "#fdf3e3",
  error: "#c83a3f",
  errorSoft: "#fdecec",
  shadow:
    "0 1px 2px rgb(16 24 40 / 5%), 0 1px 3px rgb(16 24 40 / 6%)",
  focusRing: "0 0 0 3px rgb(36 86 216 / 18%)",
} as const;

export const radius = {
  card: 12,
  control: 9,
} as const;

export const fontFamily =
  '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export const antdTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: palette.accent,
    colorInfo: palette.accent,
    colorSuccess: palette.ok,
    colorWarning: palette.warn,
    colorError: palette.error,
    colorBgLayout: palette.bg,
    colorText: palette.ink,
    colorTextSecondary: palette.muted,
    colorBorderSecondary: palette.rule,
    borderRadius: radius.control,
    borderRadiusLG: radius.card,
    boxShadowTertiary: palette.shadow,
    fontFamily,
  },
};

const cssVarBridge: Record<string, string> = {
  "--prd-bg": palette.bg,
  "--prd-surface": palette.surface,
  "--prd-surface-subtle": palette.surfaceSubtle,
  "--prd-ink": palette.ink,
  "--prd-muted": palette.muted,
  "--prd-rule": palette.rule,
  "--prd-accent": palette.accent,
  "--prd-accent-soft": palette.accentSoft,
  "--prd-teal": palette.teal,
  "--prd-teal-soft": palette.tealSoft,
  "--prd-ok": palette.ok,
  "--prd-ok-soft": palette.okSoft,
  "--prd-warn": palette.warn,
  "--prd-warn-soft": palette.warnSoft,
  "--prd-error": palette.error,
  "--prd-error-soft": palette.errorSoft,
  "--prd-text-muted": palette.muted,
  "--prd-shadow": palette.shadow,
  "--manager-radius-card": `${radius.card}px`,
  "--manager-radius-control": `${radius.control}px`,
  "--manager-focus-ring": palette.focusRing,
  "--manager-surface-strong": palette.surface,
  "--manager-ink-soft": palette.inkSoft,
  "--manager-ink-faint": palette.inkFaint,
};

/** 把 token 写入 :root 内联变量：优先级高于样式表里的历史 :root 声明。 */
export function applyThemeCssBridge(): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVarBridge)) {
    root.style.setProperty(name, value);
  }
}
