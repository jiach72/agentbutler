/**
 * 图表视觉规范：把 tokens.ts 的语义色板桥接为 @ant-design/charts(G2 v5) 的通用配置。
 * 图表自身不允许出现硬编码色值；亮暗切换由 ConfigProvider 的 mode 驱动，
 * 与页面共用同一真源（paletteFor）。
 *
 * v2.0 变更：图表第二系列改由「黄铜」承担 —— v1.2 的信号青 teal 已退役，
 * 因为规范 02 §1.1 规定信号色只表达状态、不做装饰。
 * 色板字段同步 v2 命名：muted → text3、rule → border。
 */
import type { ThemeMode } from "../../theme/tokens.js";
import { paletteFor } from "../../theme/tokens.js";

export interface ChartTheme {
  /** G2 内置主题：暗色切 classicDark，底色/文字自动反转。 */
  g2Theme: "classic" | "classicDark";
  /** 系列色序：管家蓝（主）→ 黄铜（品牌记忆）→ 正常 → 提醒 → 异常。 */
  seriesColors: string[];
  /** 坐标轴标签色（辅助文字）。 */
  text3: string;
  /** 发丝线 / 网格色。 */
  border: string;
}

export function chartThemeFor(mode: ThemeMode): ChartTheme {
  const p = paletteFor(mode);
  return {
    g2Theme: mode === "dark" ? "classicDark" : "classic",
    seriesColors: [p.primary, p.brand, p.ok, p.warn, p.error],
    text3: p.text3,
    border: p.border,
  };
}

/** 常用语义系列（长表单数据用：key 即 colorField 域值）。 */
export function semanticSeries(
  mode: ThemeMode,
  defs: Array<
    [key: string, label: string, tone: "accent" | "brand" | "ok" | "warn" | "error" | "text3"]
  >,
): Array<{ key: string; label: string; color: string }> {
  const p = paletteFor(mode);
  const toneColor = {
    accent: p.primary,
    brand: p.brand,
    ok: p.ok,
    warn: p.warn,
    error: p.error,
    text3: p.text3,
  } as const;
  return defs.map(([key, label, tone]) => ({ key, label, color: toneColor[tone] }));
}

/** 单系列图的主填充色（primary），避免页面直接取色板。 */
export function primaryFill(mode: ThemeMode): string {
  return paletteFor(mode).primary;
}

/**
 * 公共坐标轴覆盖：无标题、细刻度、发丝线网格，贴合控制台信息密度。
 * 返回结构对应 G2 v5 的 axis.{x,y} 配置，经 Trend* 封装透传。
 */
export function quietAxes(
  theme: ChartTheme,
  options: { integerY?: boolean } = {},
): {
  x: Record<string, unknown>;
  y: Record<string, unknown>;
} {
  const integerY = options.integerY ?? true;
  return {
    x: {
      title: false,
      tick: false,
      labelFill: theme.text3,
      labelFontSize: 11,
      line: true,
      lineStroke: theme.border,
      lineStrokeOpacity: 0.9,
    },
    y: {
      title: false,
      tick: false,
      labelFill: theme.text3,
      labelFontSize: 11,
      line: false,
      grid: true,
      gridStroke: theme.border,
      gridStrokeOpacity: 0.7,
      gridStrokeDash: [3, 4],
      labelFormatter: (value: unknown) =>
        integerY && !Number.isInteger(Number(value)) ? "" : String(value),
    },
  };
}

/** 横向条形图使用可读的分类标签，数值轴仍维持安静的网格与刻度。 */
export function horizontalBarAxes(theme: ChartTheme): {
  x: Record<string, unknown>;
  y: Record<string, unknown>;
} {
  return {
    x: {
      title: false,
      tick: false,
      labelFill: theme.text3,
      labelFontSize: 11,
      line: false,
      grid: true,
      gridStroke: theme.border,
      gridStrokeOpacity: 0.7,
      gridStrokeDash: [3, 4],
      labelFormatter: (value: unknown) =>
        Number.isInteger(Number(value)) ? String(value) : "",
    },
    y: {
      title: false,
      tick: false,
      labelFill: theme.text3,
      labelFontSize: 11,
      line: false,
    },
  };
}

/** 堆叠图顶部横向图例，紧凑且颜色文案继承主题。 */
export function topLegend(theme: ChartTheme): Record<string, unknown> {
  return {
    color: {
      position: "top",
      title: false,
      itemLabelFill: theme.text3,
      itemLabelFontSize: 12,
    },
  };
}
