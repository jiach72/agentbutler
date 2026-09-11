/**
 * 大屏（/wall）视觉与图表配置：暗色为主、浅色可切，双主题调色板 +
 * ECharts option 构建器。大屏经用户决策解除品牌 v2.0 约束，
 * 应用内其余页面仍以 theme/tokens.ts 为真源。
 */
import type { EChartsOption } from "echarts";

export type WallThemeMode = "dark" | "light";

export interface WallPalette {
  accent: string;
  cyan: string;
  brass: string;
  blue100: string;
  text: string;
  text2: string;
  text3: string;
  ok: string;
  warn: string;
  error: string;
  gridLine: string;
  axisLine: string;
  tipBg: string;
  tipBd: string;
  donutBorder: string;
  glow: number;
  font: string;
}

const FONT_STACK = '"Inter","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif';

export const WALL_PALETTES: Record<WallThemeMode, WallPalette> = {
  dark: {
    accent: "#4DA3FF",
    cyan: "#2EE6C8",
    brass: "#C8A15A",
    blue100: "#275A8C",
    text: "#E9F0F7",
    text2: "#AFC0D1",
    text3: "#7E93A8",
    ok: "#35D0BA",
    warn: "#FFC53D",
    error: "#FF7875",
    gridLine: "rgba(94,160,220,.13)",
    axisLine: "rgba(94,160,220,.30)",
    tipBg: "#0F2136",
    tipBd: "#274B6F",
    donutBorder: "#0F2136",
    glow: 12,
    font: FONT_STACK,
  },
  light: {
    accent: "#1B4F7A",
    cyan: "#0B9C8C",
    brass: "#C8A15A",
    blue100: "#B9D2EA",
    text: "#0B1728",
    text2: "#3A5468",
    text3: "#5F7488",
    ok: "#0B7F6F",
    warn: "#9A6B0B",
    error: "#B4342A",
    gridLine: "#E9EFF6",
    axisLine: "#C6D3E0",
    tipBg: "#FFFFFF",
    tipBd: "#E2E9F1",
    donutBorder: "#FFFFFF",
    glow: 0,
    font: FONT_STACK,
  },
};

/** 十六进制色 → rgba。 */
export function hexA(hex: string, a: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** 十六进制色向 dark 混合 t 比例，用于生成同色系深浅序列。 */
export function mixHex(a: string, t: number): string {
  const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
  const pb = [8, 18, 32]; // 混入深墨 #081220
  const out = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const axis = (c: WallPalette, fontSize = 11.5) => ({
  axisLine: { lineStyle: { color: c.axisLine } },
  axisTick: { show: false },
  axisLabel: { color: c.text3, fontSize, fontFamily: c.font },
});

const tooltip = (c: WallPalette) => ({
  backgroundColor: c.tipBg,
  borderColor: c.tipBd,
  textStyle: { color: c.text, fontSize: 12, fontFamily: c.font },
  extraCssText: "box-shadow:0 8px 24px rgba(0,0,0,.25);border-radius:8px;",
});

export interface TrendPoint {
  date: string;
  delivered: number;
  failed: number;
}

export function trendOption(points: TrendPoint[], c: WallPalette): EChartsOption {
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 600,
    grid: { left: 44, right: 16, top: 36, bottom: 24 },
    legend: {
      top: 0, right: 2, itemWidth: 16, itemHeight: 3, icon: "rect", itemGap: 14,
      textStyle: { color: c.text2, fontSize: 12 },
    },
    tooltip: { trigger: "axis", ...tooltip(c) },
    xAxis: { type: "category", data: points.map((p) => p.date), boundaryGap: false, ...axis(c) },
    yAxis: {
      type: "value", splitNumber: 3,
      splitLine: { lineStyle: { color: c.gridLine } },
      axisLabel: { color: c.text3, fontSize: 11, fontFamily: c.font },
    },
    series: [
      {
        name: "送达量", type: "line", smooth: 0.35, symbol: "none",
        data: points.map((p) => p.delivered),
        lineStyle: { width: 3, color: c.accent, shadowColor: c.accent, shadowBlur: 14, shadowOffsetY: 5 },
        itemStyle: { color: c.accent },
        areaStyle: {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: hexA(c.accent, 0.32) },
              { offset: 1, color: hexA(c.accent, 0) },
            ],
          },
        },
        markPoint: {
          data: [{ type: "max", name: "峰值" }], symbolSize: 48,
          itemStyle: { color: c.accent, shadowColor: c.accent, shadowBlur: 12 },
          label: { color: "#081220", fontSize: 10.5, fontWeight: 700, formatter: "{c}" },
        },
      },
      {
        name: "失败量", type: "line", smooth: 0.35, symbol: "none",
        data: points.map((p) => p.failed),
        lineStyle: { width: 1.5, type: "dashed", color: c.error, opacity: 0.75 },
        itemStyle: { color: c.error },
      },
    ],
  };
}

export interface TokenModelSeries {
  name: string;
  color: string;
  data: Array<number>;
}

/** Token 三件套未接入；接入后用此构建按模型堆叠面积图。 */
export function tokenTrendOption(
  days: Array<string>, models: Array<TokenModelSeries>, c: WallPalette,
): EChartsOption {
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 600,
    grid: { left: 44, right: 16, top: 36, bottom: 24 },
    legend: {
      top: 0, right: 2, itemWidth: 12, itemHeight: 8, icon: "roundRect", itemGap: 12,
      textStyle: { color: c.text2, fontSize: 11.5 },
    },
    tooltip: { trigger: "axis", ...tooltip(c) },
    xAxis: { type: "category", data: days, boundaryGap: false, ...axis(c) },
    yAxis: {
      type: "value", splitNumber: 3,
      splitLine: { lineStyle: { color: c.gridLine } },
      axisLabel: { color: c.text3, fontSize: 11, fontFamily: c.font },
    },
    series: models.map((m) => ({
      name: m.name, type: "line", stack: "token", smooth: 0.35, symbol: "none",
      data: m.data,
      lineStyle: { width: 1.5, color: m.color },
      itemStyle: { color: m.color },
      areaStyle: { opacity: 0.42, color: m.color },
    })),
  };
}

export interface SkillRow {
  name: string;
  calls: number;
}

export function skillBarOption(rows: Array<SkillRow>, c: WallPalette): EChartsOption {
  const shades = [c.brass, c.accent, mixHex(c.accent, 0.14), mixHex(c.accent, 0.28), mixHex(c.accent, 0.42)];
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 600,
    grid: { left: 70, right: 44, top: 10, bottom: 6 },
    tooltip: { trigger: "item", ...tooltip(c), formatter: (p: unknown) => {
      const point = p as { name: string; value: number };
      return `${point.name}：${point.value} 次`;
    } },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category", data: rows.map((r) => r.name), inverse: true,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: c.text, fontSize: 12.5, fontWeight: 500, fontFamily: c.font, margin: 8 },
    },
    series: [{
      type: "bar", barWidth: 12,
      data: rows.map((r, i) => ({
        value: r.calls,
        itemStyle: {
          color: {
            type: "linear", x: 0, y: 0, x2: 1, y2: 0,
            colorStops: [
              { offset: 0, color: hexA(shades[i] ?? c.accent, 0.55) },
              { offset: 1, color: shades[i] ?? c.accent },
            ],
          },
          borderRadius: [0, 7, 7, 0],
          shadowColor: shades[i] ?? c.accent,
          shadowBlur: c.glow > 0 ? 8 : 3,
          shadowOffsetY: 2,
        },
      })),
      showBackground: true,
      backgroundStyle: { color: c.gridLine, borderRadius: [0, 7, 7, 0] },
      label: { show: true, position: "right", color: c.text2, fontSize: 11.5, fontWeight: 600, fontFamily: c.font },
    }],
  };
}

export interface DonutSlice {
  name: string;
  value: number;
}

/** Token 三件套未接入；接入后用此构建模型占比环形图。 */
export function donutOption(slices: Array<DonutSlice>, c: WallPalette): EChartsOption {
  const colors = [c.accent, c.brass, c.cyan, c.blue100];
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 600,
    tooltip: { trigger: "item", ...tooltip(c) },
    legend: {
      orient: "vertical", right: 6, top: "middle", itemWidth: 12, itemHeight: 8,
      icon: "roundRect", textStyle: { color: c.text2, fontSize: 12 }, itemGap: 12,
    },
    series: [{
      type: "pie", radius: ["58%", "80%"], center: ["33%", "50%"],
      avoidLabelOverlap: true, padAngle: 2,
      itemStyle: { borderRadius: 6, borderColor: c.donutBorder, borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: false }, scaleSize: 4 },
      data: slices.map((s, i) => ({
        ...s,
        itemStyle: { color: colors[i % colors.length]!, shadowColor: colors[i % colors.length]!, shadowBlur: c.glow },
      })),
    }],
  };
}

export function gaugeOption(value: number, color: string, c: WallPalette): EChartsOption {
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 600,
    series: [{
      type: "gauge", startAngle: 90, endAngle: -270, radius: "96%",
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { show: false },
      axisLine: { lineStyle: { width: 11, color: [[1, c.gridLine]] } },
      progress: {
        show: true, width: 11, roundCap: true,
        itemStyle: { color, shadowColor: color, shadowBlur: c.glow },
      },
      detail: {
        valueAnimation: false, formatter: "{value}%", offsetCenter: [0, 0],
        fontSize: 18, fontWeight: 700, color: c.text, fontFamily: c.font,
      },
      data: [{ value }],
    }],
  };
}

export function sparkOption(data: Array<number>, c: WallPalette): EChartsOption {
  return {
    textStyle: { fontFamily: c.font },
    animationDuration: 400,
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: "category", show: false, data: data.map((_, i) => i) },
    yAxis: { type: "value", show: false, min: "dataMin", max: "dataMax" },
    series: [{
      type: "line", data, smooth: 0.5, symbol: "none",
      lineStyle: { width: 2, color: c.accent }, itemStyle: { color: c.accent },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hexA(c.accent, 0.3) },
            { offset: 1, color: hexA(c.accent, 0) },
          ],
        },
      },
    }],
  };
}
