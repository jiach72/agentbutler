/**
 * 图表视觉规范：把 tokens.ts 的两套色板桥接为 @ant-design/charts(G2 v5) 的通用配置。
 * 图表自身不允许出现硬编码色值；亮暗切换由 ConfigProvider 的 mode 驱动，
 * 与页面共用同一真源（lightPalette / nightPalette）。
 */
import type { ThemeMode } from "../../theme/tokens.js";
import { lightPalette, nightPalette } from "../../theme/tokens.js";

export interface ChartTheme {
  /** G2 内置主题：暗色切 classicDark，底色/文字自动反转。 */
  g2Theme: "classic" | "classicDark";
  /** 系列色序：主交互 → 信息蓝 → 成功 → 警示 → 错误。 */
  seriesColors: string[];
  muted: string;
  rule: string;
}

const PALETTES: Record<ThemeMode, typeof lightPalette | typeof nightPalette> = {
  light: lightPalette,
  dark: nightPalette,
};

export function chartThemeFor(mode: ThemeMode): ChartTheme {
  const p = PALETTES[mode];
  return {
    g2Theme: mode === "dark" ? "classicDark" : "classic",
    seriesColors: [p.accent, p.teal, p.ok, p.warn, p.error],
    muted: p.muted,
    rule: p.rule,
  };
}

/** 常用语义系列（长表单数据用：key 即 colorField 域值）。 */
export function semanticSeries(
  mode: ThemeMode,
  defs: Array<
    [key: string, label: string, tone: "accent" | "teal" | "ok" | "warn" | "error" | "muted"]
  >,
): Array<{ key: string; label: string; color: string }> {
  const p = PALETTES[mode];
  const toneColor = {
    accent: p.accent,
    teal: p.teal,
    ok: p.ok,
    warn: p.warn,
    error: p.error,
    muted: p.muted,
  } as const;
  return defs.map(([key, label, tone]) => ({ key, label, color: toneColor[tone] }));
}

/** 单系列图的主填充色（accent），避免页面直接取色板。 */
export function primaryFill(mode: ThemeMode): string {
  return PALETTES[mode].accent;
}

/**
 * 公共坐标轴覆盖：无标题、细刻度、发丝线网格，贴合控制台信息密度。
 * 返回结构对应 G2 v5 的 axis.{x,y} 配置，经 Trend* 封装透传。
 */
export function quietAxes(theme: ChartTheme): {
  x: Record<string, unknown>;
  y: Record<string, unknown>;
} {
  return {
    x: {
      title: false,
      tick: false,
      labelFill: theme.muted,
      labelFontSize: 11,
      line: true,
      lineStroke: theme.rule,
      lineStrokeOpacity: 0.9,
    },
    y: {
      title: false,
      tick: false,
      labelFill: theme.muted,
      labelFontSize: 11,
      line: false,
      grid: true,
      gridStroke: theme.rule,
      gridStrokeOpacity: 0.7,
      gridStrokeDash: [3, 4],
      // 计数类指标不出现 0.5 这类小数刻度文字。
      labelFormatter: (value: unknown) => (Number.isInteger(Number(value)) ? String(value) : ""),
    },
  };
}

/** 堆叠图顶部横向图例，紧凑且颜色文案继承主题。 */
export function topLegend(theme: ChartTheme): Record<string, unknown> {
  return {
    color: {
      position: "top",
      title: false,
      itemLabelFill: theme.muted,
      itemLabelFontSize: 12,
    },
  };
}
