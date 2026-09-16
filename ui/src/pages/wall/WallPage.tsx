/**
 * 运维作战室大屏（/wall）：3840×2160 基准画布等比缩放，暗色为主、浅色可切，
 * 横向铺满一屏不滚动。保留原有图表矩阵（投递趋势 / Token 趋势 / 模型占比 /
 * 技能排行 / 成本趋势 / 资源仪表），只收敛重复的顶部 KPI，并把底部记录区
 * 换成作战室真正要盯的三件事：行动队列、未来 24 小时任务、消息网关链路。
 * 全部数值来自既有 /api 端点轮询；金额统一经 money() 折算 ¥；
 * 数据不可用时显示「待接入」灰态，不伪造数据；视口 <1024px 时改为可读的纵向布局。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import {
  WALL_PALETTES,
  type TokenModelSeries,
  type WallThemeMode,
  costTrendOption,
  donutOption,
  gaugeOption,
  skillBarOption,
  sparkOption,
  tokenTrendOption,
  trendOption,
  wallSequence,
} from "./wallTheme.js";
import { deriveWallView, useWallData, type WallLlmUsage } from "./useWallData.js";
import { formatTime, money, USD_TO_CNY } from "../../lib/format.js";
import "./wall.css";

const THEME_STORAGE_KEY = "butler.wallTheme";
const STAGE_WIDTH = 3840;
const STAGE_HEIGHT = 2160;
const MOBILE_BREAKPOINT = 1024;

export function readInitialTheme(): WallThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * ECharts 挂载组件：option 变化即 setOption，容器尺寸变化自动 resize。
 * dpr 必须传入「系统 dpr × stage 缩放比」：stage 被 transform scale 放大时，
 * canvas 位图若仍按基准渲染会被拉伸发虚（审计 P0-2），因此 scale
 * 变化时以新 dpr 重建图表实例，保证 2K/4K 下像素级清晰。
 */
function WallChart({ option, className, dpr }: { option: EChartsOption | null; className?: string; dpr: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    if (hostRef.current === null) return;
    chartRef.current = echarts.init(hostRef.current, undefined, { devicePixelRatio: dpr });
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [dpr]);

  useEffect(() => {
    if (chartRef.current !== null && option !== null) {
      chartRef.current.setOption(option, true);
    }
  }, [option, dpr]);

  return <div ref={hostRef} className={className ?? "wall-chart"} />;
}

function formatClock(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function relativeTime(iso: string | null): string {
  if (iso === null) return "—";
  const delta = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(delta) || delta < 0) return "刚刚";
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s 前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * P95 结论：只有真的配置了阈值才能声称「阈值内/超阈值」。
 * 当前上游没有延迟阈值配置，所以默认只给数值，不生成正常/异常判断。
 */
export function latencyConclusion(p95Ms: number | null, thresholdMs: number | null = null): string {
  if (p95Ms === null || !Number.isFinite(p95Ms)) return "暂无延迟样本";
  const value = p95Ms >= 1000 ? `${(p95Ms / 1000).toFixed(1)} 秒` : `${Math.round(p95Ms)} 毫秒`;
  if (thresholdMs === null || !Number.isFinite(thresholdMs) || thresholdMs <= 0) return `P95 ${value}，未设阈值`;
  return `P95 ${value}，${p95Ms > thresholdMs ? "超过阈值" : "阈值内"}`;
}

/** 任务时刻：HH:MM，供大屏大字显示。 */
function taskClockText(iso: string | null): string {
  const time = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 任务日别：今天 / 明天 / 后天 / M月D日，避免只看 HH:MM 误读成今天。 */
function taskDayText(iso: string | null, now: number): string {
  const time = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(time)) return "时间待确认";
  const startOfDay = (value: number) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days === 2) return "后天";
  const date = new Date(time);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

const TASK_STATUS_LABEL: Record<string, string> = {
  success: "上次成功",
  failed: "上次失败",
  delivery_failed: "通知未送达",
  running: "执行中",
  never: "尚未执行",
  unknown: "状态未知",
};

/** 独立时钟组件：每秒自转，不触发整屏重渲染。 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="wall-chip">{formatClock(now)}</span>;
}

function KpiCard(props: {
  label: string;
  value: string;
  unit?: string;
  foot: string;
  footExtra?: string;
  tone?: "brand" | "cyan" | "warn" | "error" | "brass";
  badge?: { text: string; kind: "ok" | "warn" | "err" | "info" | "brass" | "off" };
  spark?: { data: Array<number>; theme: WallThemeMode };
  dpr?: number;
}) {
  const toneClass = props.tone === undefined ? "" : ` tone-${props.tone}`;
  const badge = props.badge === undefined
    ? null
    : <span className={`wall-badge b-${props.badge.kind}`}>{props.badge.text}</span>;
  return (
    <div className={`wall-kpi${toneClass}`}>
      <div className="wall-kpi-label">{props.label} {badge}</div>
      <div className="wall-kpi-value">
        {props.value}
        {props.unit === undefined ? null : <small>{props.unit}</small>}
      </div>
      <div className="wall-kpi-foot">
        <span>{props.foot}</span>
        {props.spark === undefined
          ? props.footExtra === undefined ? null : <span>{props.footExtra}</span>
          : <WallChart option={sparkOption(props.spark.data, WALL_PALETTES[props.spark.theme])} className="wall-spark" dpr={props.dpr ?? 1} />}
      </div>
    </div>
  );
}

function PendingPanel({ title, source, hint }: { title: string; source: string; hint: string }) {
  return (
    <div className="wall-panel wall-panel-pending" style={{ display: "flex", flexDirection: "column" }}>
      <div className="wall-panel-title">{title}<span className="wall-psrc">{source}<span className="wall-todo">待接入</span></span></div>
      <div className="wall-pending-body">
        <div className="wall-pending-mark">◌</div>
        <div>
          <div className="wall-pending-title">{hint}</div>
          <div className="wall-pending-sub">需数据端补齐字段后自动亮起，这里不会用估算值顶替。</div>
        </div>
      </div>
    </div>
  );
}


export function WallPage() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<WallThemeMode>(readInitialTheme);
  const data = useWallData();
  const view = useMemo(() => deriveWallView(data), [data]);
  const palette = WALL_PALETTES[theme];

  useEffect(() => {
    document.documentElement.setAttribute("data-wall-theme", theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [theme]);

  // 画布等比缩放：以 3840×2160 为基准，居中适配任意窗口（无滚动条）。
  // scale 存入 state 驱动 WallChart 以「系统 dpr × scale」重建位图，
  // 否则 transform 放大后 canvas 文字/线条会像素化（审计 P0-2）。
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 宽屏（≥1024px）：等比缩放到铺满 16:9，无滚动条；
  // 窄屏：不再把 3840×2160 压成读不清的缩略图，改用原生像素的纵向布局（CSS 接管）。
  const [stageScale, setStageScale] = useState(() =>
    window.innerWidth < MOBILE_BREAKPOINT
      ? 1
      : Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT));
  useEffect(() => {
    const fit = () => {
      const scaled = window.innerWidth >= MOBILE_BREAKPOINT;
      const scale = scaled
        ? Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT)
        : 1;
      if (stageRef.current !== null) {
        stageRef.current.style.transform = scaled ? `translate(-50%,-50%) scale(${scale})` : "";
      }
      setStageScale(scale);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  // 位图分辨率上限 3：超过后收益趋零且显存占用陡增。
  const chartDpr = Math.min(window.devicePixelRatio * stageScale, 3);

  const successRateText = view.successRate === null ? "—" : view.successRate.toFixed(1);
  const p95Text = view.p95Ms === null ? "—" : view.p95Ms >= 1000 ? `${(view.p95Ms / 1000).toFixed(1)}s` : `${view.p95Ms}ms`;
  const relayText = view.relayEnabled === null
    ? "消息状态未知"
    : view.relayEnabled
      ? (view.relayPending === true ? "管线切换待生效" : "Butler 管线接管中")
      : "Hermes 通道直发";
  const versionText = data.health?.services.gateway.serviceVersion ?? "—";
  const updatedText = data.lastRefreshAt === null ? "--:--:--" : formatClock(data.lastRefreshAt).slice(11);
  const cpuText = view.cpuPercent === null ? "—" : Math.round(view.cpuPercent).toString();
  const memText = view.memPercent === null ? "—" : `${Math.round(view.memPercent)}%`;
  const diskText = view.diskPercent === null ? "—" : `${Math.round(view.diskPercent)}%`;
  const diskWarn = view.diskPercent !== null && view.diskPercent >= 75;
  const alertTone = view.openAlerts > 0 ? "warn" : undefined;

  // 实例健康摘要：单实例时填充面板空白（审计 P1-1）。
  const conns = data.connections ?? [];
  const lastCheckedIso = conns.reduce<string | null>(
    (acc, c) => (c.lastCheckedAt !== null && (acc === null || c.lastCheckedAt > acc) ? c.lastCheckedAt : acc),
    null,
  );
  const runtimeSet = Array.from(new Set(conns.map((c) => c.runtime).filter((r) => r !== "")));

  const llmPending = data.llmUsage === "unavailable" || data.llmUsage === null;
  const llm: WallLlmUsage | null = llmPending || data.llmUsage === "unavailable" ? null : data.llmUsage;


  // Token 按模型堆叠序列：Top7 模型各一条 + 其余合并「其他」，单位万 token。
  const tokenSeries: Array<TokenModelSeries> = useMemo(() => {
    if (llm === null) return [];
    const colorSeq = wallSequence(palette);
    const hasDaily = llm.models.some((m) => Array.isArray(m.daily) && m.daily.length === llm.days.length);
    if (!hasDaily) {
      return [{ name: "合计", color: colorSeq[0]!, data: llm.days.map((d) => Math.round(d.tokens / 10_000)) }];
    }
    const sorted = [...llm.models].sort((a, b) => b.tokens - a.tokens);
    const series = sorted.slice(0, 7).map((m, i) => ({
      name: m.model,
      color: colorSeq[i % colorSeq.length]!,
      data: (m.daily ?? []).map((v) => Math.round(v / 10_000)),
    }));
    const rest = sorted.slice(7);
    if (rest.length > 0) {
      series.push({
        name: "其他",
        color: palette.text3,
        data: llm.days.map((_, dayIndex) =>
          Math.round(rest.reduce((sum, m) => sum + (m.daily?.[dayIndex] ?? 0), 0) / 10_000)),
      });
    }
    return series;
  }, [llm, palette]);

  // ── 4K 新增：成本与用量（/api/llm/cost/summary · /api/budget）──
  const costReady = data.costSummary !== null && view.costAvailable;
  const costTrendOptionMemo = useMemo(() => costTrendOption(
    view.costDays.map((d) => ({
      date: d.date,
      costCny: d.costUsd === null ? null : Math.round(d.costUsd * USD_TO_CNY * 100) / 100,
      tokensWan: d.tokensWan,
    })),
    palette,
  ), [view.costDays, palette]);
  const costModelRows = useMemo(() => {
    const total = view.costModels.reduce(
      (sum, m) => sum + (m.actualCostUsd ?? m.estimatedCostUsd ?? 0), 0);
    return view.costModels.map((m) => {
      const usd = m.actualCostUsd ?? m.estimatedCostUsd ?? null;
      const share = usd !== null && total > 0 ? Math.round((usd / total) * 100) : null;
      return { model: m.model, tokensWan: Math.round(m.tokens / 10_000), usd, share };
    });
  }, [view.costModels]);

  // ── 4K 新增：消息网关链路（/api/messages/status）──
  const bridge = view.bridge;
  const bridgeConnected = bridge?.connected === true;
  const linkRows: Array<{ k: string; v: string; ok: boolean | null }> = [
    { k: "Bridge 连接", v: bridge === null ? "状态未知" : bridgeConnected ? "已连接" : "离线（自愈重试中）", ok: bridge === null ? null : bridgeConnected },
    { k: "Bridge 进程", v: bridge?.running === undefined ? "—" : bridge.running ? "运行中" : "未运行", ok: bridge?.running ?? null },
    { k: "消息管线", v: relayText, ok: view.relayEnabled === null ? null : view.relayEnabled },
    { k: "Outbox 积压", v: `${view.pendingMessages} 条`, ok: view.pendingMessages === 0 },
  ];

  // ── 作战室专用：行动队列（与首页同一结论）与未来 24 小时任务 ──
  const attention = view.attention;
  const tasks = view.tasks;
  const nextRunAt = tasks.next?.nextRunAt ?? null;
  const nextTaskFoot = tasks.next === null
    ? tasks.label
    : `${taskDayText(nextRunAt, view.observedAtMs)} · ${tasks.next.name}`;
  const taskBadge = tasks.known
    ? tasks.failedTaskCount > 0
      ? { text: `失败任务 ${tasks.failedTaskCount}`, kind: "warn" as const }
      : { text: tasks.running ? `今日执行 ${tasks.todayRunCount} 次` : "调度未运行", kind: (tasks.running ? "ok" : "warn") as "ok" | "warn" }
    : { text: "待接入", kind: "brass" as const };

  return (
    <div className="wall-root" data-wall-theme={theme}>
      {/* 四角装饰：统一双 path + currentColor，颜色随主题切换（审计 P2-2）。 */}
      <svg className="wall-corner tl" viewBox="0 0 140 140" aria-hidden="true">
        <path d="M0 0 H84 V3 H3 V84 H0 Z" fill="currentColor" opacity=".5" />
        <path d="M0 26 H26 V0 H29 V29 H0 Z" fill="currentColor" opacity=".25" />
      </svg>
      <svg className="wall-corner tr" viewBox="0 0 140 140" aria-hidden="true">
        <path d="M0 0 H84 V3 H3 V84 H0 Z" fill="currentColor" opacity=".5" />
        <path d="M0 26 H26 V0 H29 V29 H0 Z" fill="currentColor" opacity=".25" />
      </svg>
      <svg className="wall-corner bl" viewBox="0 0 140 140" aria-hidden="true">
        <path d="M0 0 H84 V3 H3 V84 H0 Z" fill="currentColor" opacity=".5" />
        <path d="M0 26 H26 V0 H29 V29 H0 Z" fill="currentColor" opacity=".25" />
      </svg>
      <svg className="wall-corner br" viewBox="0 0 140 140" aria-hidden="true">
        <path d="M0 0 H84 V3 H3 V84 H0 Z" fill="currentColor" opacity=".5" />
        <path d="M0 26 H26 V0 H29 V29 H0 Z" fill="currentColor" opacity=".25" />
      </svg>

      <div className="wall-stage" ref={stageRef}>
        {/* A 标题区 */}
        <header className="wall-header">
          <img className="wall-logo wall-logo-light" src="/brand/ab-lockup-h.svg" alt="Agent Butler" />
          <span className="wall-logo-dark">
            <img src="/brand/ab-mark-inverse.svg" alt="" />
            <span className="wall-logo-text">Agent <i>Butler</i></span>
          </span>
          <div className="wall-hdiv" />
          <div>
            <div className="wall-title">运维总览大屏</div>
            <div className="wall-subtitle">AGENT OPS OVERVIEW · Hermes / OpenClaw 统一运维</div>
          </div>
          <div className="wall-hspacer" />
          <div className={`wall-chip ${view.relayEnabled === true ? "wall-relay-on" : ""}`}>
            <span className="wall-pulse" />{relayText}
          </div>
          <div className="wall-chip">当前版本 <b className="wall-mono">{versionText}</b></div>
          <Clock />
          <div className="wall-chip">最后更新 <b>{updatedText}</b> · 自动刷新 15s</div>
          <button
            type="button"
            className="wall-chip wall-theme-toggle"
            onClick={() => setTheme((mode) => (mode === "dark" ? "light" : "dark"))}
          >
            ◐ {theme === "dark" ? "深色" : "浅色"}
          </button>
          <button type="button" className="wall-chip wall-theme-toggle" onClick={() => void navigate("/dashboard")}>
            ⇤ 返回控制台
          </button>
        </header>

        {/* B KPI 行：7 卡（运行 / 投递 / 待办 / 调度 / 资源）；Token 与成本交给下方图表，不重复占位 */}
        <div className="wall-kpirow">
          <KpiCard
            label="实例在线"
            value={view.onlineInstances === null ? "—" : `${view.onlineInstances}`}
            unit={view.totalInstances === null ? undefined : `/${view.totalInstances}`}
            foot="Hermes · OpenClaw"
            footExtra="↑ 15s"
            badge={view.onlineInstances === null || view.totalInstances === null
              ? { text: "状态待确认", kind: "off" }
              : view.totalInstances === 0
                ? { text: "尚未连接智能体", kind: "warn" }
                : view.onlineInstances === view.totalInstances
                  ? { text: "全部正常", kind: "ok" }
                  : { text: "部分离线", kind: "warn" }}
          />
          <KpiCard
            label="7日 送达成功率"
            value={successRateText}
            unit="%"
            foot="近 7 日投递记录"
            footExtra="↑ 60s"
          />
          <KpiCard
            label="P95 送达延迟"
            value={p95Text}
            foot={latencyConclusion(view.p95Ms)}
            footExtra="↑ 60s"
          />
          <KpiCard label="待处理消息" value={`${view.pendingMessages}`} foot="Outbox 队列" footExtra="↑ 15s" />
          <KpiCard
            label="未处理告警"
            value={`${view.openAlerts}`}
            foot={view.openAlerts === 0 ? "当前无需处理" : "仍需你处理"}
            footExtra="↑ 15s"
            tone={alertTone}
          />
          <KpiCard
            label="下一条定时任务"
            value={taskClockText(nextRunAt)}
            foot={nextTaskFoot}
            footExtra="↑ 15s"
            tone={tasks.known && tasks.failedTaskCount > 0 ? "warn" : "brand"}
            badge={taskBadge}
          />
          <KpiCard
            label="主机 CPU"
            value={cpuText}
            unit="%"
            foot="watch/host-metrics"
            footExtra={`内存 ${memText}`}
            tone="cyan"
            spark={{ data: view.cpuSeries.length >= 2 ? view.cpuSeries : [0, 0], theme }}
            dpr={chartDpr}
          />
        </div>

        {/* 主体四列（第 4 列为 4K 新增的成本与用量） */}
        <div className="wall-main">
          {/* C 左列 */}
          <div className="wall-col">
            <div className="wall-panel" style={{ flex: "250 0 0" }}>
              <div className="wall-panel-title">实例健康<span className="wall-psrc">lifecycle · connections · 30s</span></div>
              {conns.slice(0, 4).map((conn) => (
                <div className="wall-inst" key={conn.instanceId}>
                  <span
                    className="wall-idot"
                    style={{ background: conn.connected ? palette.ok : palette.text3, boxShadow: conn.connected ? `0 0 8px ${palette.ok}` : "none" }}
                  />
                  <div>
                    <div className="wall-inst-name">{conn.displayName}</div>
                    <div className="wall-inst-meta">
                      <span className="wall-mono">{conn.version ?? "版本未知"}</span> · {conn.runtime} · 检查 {relativeTime(conn.lastCheckedAt)}
                    </div>
                  </div>
                  <div className="wall-inst-right">
                    <span className={`wall-badge ${conn.connected ? "b-ok" : "b-off"}`}>{conn.connected ? "已连接" : conn.state}</span>
                  </div>
                </div>
              ))}
              {conns.length === 0 && <div className="wall-empty">实例状态读取中，若持续为空请检查管家服务。</div>}
              {conns.length > 0 && (
                <div className="wall-inst-summary">
                  <span>在线 <b>{view.onlineInstances ?? "—"}/{view.totalInstances ?? "—"}</b></span>
                  <span>最近检查 <b>{relativeTime(lastCheckedIso)}</b></span>
                  {runtimeSet.length > 0 && <span>运行时 <b>{runtimeSet.join(" / ")}</b></span>}
                </div>
              )}
            </div>

            <div className="wall-panel" style={{ flex: "250 0 0" }}>
              <div className="wall-panel-title">主机资源<span className="wall-psrc">watch/host-metrics · 15s</span></div>
              <div className="wall-gauges">
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(view.cpuPercent ?? 0, palette.accent, palette)} className="wall-gauge-chart" dpr={chartDpr} />
                  <span className="wall-gauge-label">CPU</span>
                </div>
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(Math.round(view.memPercent ?? 0), palette.cyan, palette)} className="wall-gauge-chart" dpr={chartDpr} />
                  <span className="wall-gauge-label">内存</span>
                </div>
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(Math.round(view.diskPercent ?? 0), diskWarn ? palette.warn : palette.accent, palette)} className="wall-gauge-chart" dpr={chartDpr} />
                  <span className={`wall-gauge-label ${diskWarn ? "w" : ""}`}>磁盘 {diskText}</span>
                </div>
              </div>
              <div className="wall-agents">
                {view.rssTop.length > 0
                  ? `Agent 进程 RSS Top3：${view.rssTop.map((a) => `${a.id} ${a.mb}MB`).join(" · ")}`
                  : "Agent 进程采样暂不可用。"}
              </div>
            </div>

            <div className="wall-panel" style={{ flex: "120 0 0" }}>
              <div className="wall-panel-title">通道质量<span className="wall-psrc">messages/metrics · 60s</span></div>
              {view.channels.map((ch) => (
                <div className="wall-lane" key={ch.channel}>
                  <span className="wall-lane-name">{ch.channel}</span>
                  <span className="wall-lane-rate">{(ch.successRate * 100).toFixed(1)}%</span>
                  <span className={`wall-badge ${(ch.successRate * 100) >= 98 ? "b-ok" : "b-warn"}`}>
                    {ch.p95LatencyMs === null ? "无延迟样本" : `P95 ${ch.p95LatencyMs >= 1000 ? `${(ch.p95LatencyMs / 1000).toFixed(1)}s` : `${ch.p95LatencyMs}ms`}`}
                  </span>
                </div>
              ))}
              {view.channels.length === 0 && <div className="wall-empty">暂无通道投递数据。</div>}
            </div>
          </div>

          {/* D 中列 */}
          <div className="wall-col">
            <div className="wall-panel" style={{ flex: "245 0 0" }}>
              <div className="wall-panel-title">近 7 日消息投递趋势<span className="wall-psrc">message_outcome_history · 60s</span></div>
              {view.trend.length >= 2
                ? <WallChart option={trendOption(view.trend, palette)} className="wall-chart" dpr={chartDpr} />
                : <div className="wall-empty">投递历史不足或消息服务暂不可达。</div>}
            </div>

            {llm === null
              ? (
                <PendingPanel
                  title="Token 消耗趋势（7 日 · 按模型）"
                  source="session_model_usage"
                  hint="Token 按模型堆叠面积图待接入"
                />
              )
              : (
                <div className="wall-panel" style={{ flex: "230 0 0" }}>
                  <div className="wall-panel-title">Token 消耗趋势（7 日 · 按模型）<span className="wall-psrc">session_model_usage · 60s</span></div>
                  <WallChart
                    option={tokenTrendOption(
                      llm.days.map((d) => d.date),
                      tokenSeries.length > 0
                        ? tokenSeries
                        : [{ name: "合计", color: palette.accent, data: llm.days.map((d) => Math.round(d.tokens / 10_000)) }],
                      palette,
                    )}
                    className="wall-chart"
                    dpr={chartDpr}
                  />
                </div>
              )}

            <div className="wall-panel" style={{ flex: "250 0 0" }}>
              <div className="wall-panel-title">技能调用概览<span className="wall-psrc">skills/usage · 60s</span></div>
              <div className="wall-skillwrap">
                <div className="wall-skgrid">
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.skillTotal}</div><div className="wall-gl">技能总数</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.active7d}</div><div className="wall-gl">7日活跃</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.calls24h}</div><div className="wall-gl">24h 调用</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.calls7d}</div><div className="wall-gl">7 日调用</div></div>
                </div>
                {view.topSkills.length > 0
                  ? <WallChart option={skillBarOption(view.topSkills, palette)} className="wall-chart" dpr={chartDpr} />
                  : <div className="wall-empty">近 30 天暂无技能调用记录。</div>}
              </div>
            </div>
          </div>

          {/* E 右列 */}
          <div className="wall-col">
            {llm === null
              ? (
                <PendingPanel
                  title="模型 Token 占比（24h）"
                  source="llm-probe"
                  hint="模型占比环形图待接入"
                />
              )
              : (
                <div className="wall-panel" style={{ flex: "225 0 0" }}>
                  <div className="wall-panel-title">模型 Token 占比（24h）<span className="wall-psrc">llm-probe · 60s</span></div>
                  <WallChart option={donutOption(llm.models.map((m) => ({ name: m.model, value: Math.round(m.tokens / 10_000) })), palette)} className="wall-chart" dpr={chartDpr} />
                </div>
              )}

            <div className="wall-panel" style={{ flex: "245 0 0" }}>
              <div className="wall-panel-title">告警与事件<span className="wall-psrc">/api/alerts · 15s</span></div>
              {view.alertEvents.map((evt, index) => {
                const kind = evt.severity === "error" ? "error" : evt.severity === "warn" || evt.severity === "warning" ? "warn" : evt.status === "resolved" ? "idle" : "info";
                return (
                  <div className="wall-evt" key={index}>
                    <span className={`wall-dot dot-${kind}`} />
                    <span className="wall-evt-text">{evt.title ?? "（无标题告警）"}</span>
                    <span className="wall-evt-time">{evt.status ?? ""}</span>
                  </div>
                );
              })}
              {view.alertEvents.length === 0 && <div className="wall-empty">当前没有告警，一切正常。</div>}
            </div>

            <div className="wall-panel" style={{ flex: "190 0 0" }}>
              <div className="wall-panel-title">进化守门<span className="wall-psrc">fingerprints · proposals · 60s</span></div>
              <div className="wall-guard">
                <div className="wall-gcell">
                  <div className="wall-gv2">{view.fingerprints ?? "—"}</div>
                  <div className="wall-gl">错误指纹</div>
                </div>
                <div className="wall-gcell">
                  <div className="wall-gv2">{data.proposals?.proposals?.length ?? "—"}</div>
                  <div className="wall-gl">待确认建议</div>
                </div>
                <div className="wall-gcell">
                  <div className="wall-gv2">{(data.connections ?? []).filter((c) => c.connected).length}</div>
                  <div className="wall-gl">活跃连接</div>
                </div>
              </div>
            </div>
          </div>

          {/* F 第 4 列（4K 新增）：成本与用量 */}
          <div className="wall-col">
            {data.costSummary === null
              ? (
                <PendingPanel
                  title="成本与用量趋势（30 日）"
                  source="llm/cost/summary"
                  hint="成本汇总读取中"
                />
              )
              : !costReady
                ? (
                  <PendingPanel
                    title="成本与用量趋势（30 日）"
                    source="llm/cost/summary"
                    hint="用量已记录，金额字段未接入"
                  />
                )
                : (
                  <div className="wall-panel" style={{ flex: "255 0 0" }}>
                    <div className="wall-panel-title">成本与用量趋势（30 日）<span className="wall-psrc">llm/cost/summary · 60s</span></div>
                    <WallChart option={costTrendOptionMemo} className="wall-chart" dpr={chartDpr} />
                  </div>
                )}

            <div className="wall-panel" style={{ flex: "225 0 0" }}>
              <div className="wall-panel-title">模型成本分解<span className="wall-psrc">按汇率 7.2 折算 · 60s</span></div>
              {costReady && costModelRows.length > 0
                ? (
                  <table className="wall-costtable">
                    <thead>
                      <tr><th>模型</th><th>Token 万</th><th>成本</th><th>占比</th></tr>
                    </thead>
                    <tbody>
                      {costModelRows.map((row, index) => (
                        <tr key={row.model}>
                          <td><span className="wall-cost-rank">{index + 1}</span><span className="wall-cost-model">{row.model}</span></td>
                          <td className="num">{row.tokensWan.toLocaleString()}</td>
                          <td className="num">{money(row.usd)}</td>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "12px" }}>
                              <span className="wall-cost-bar"><i style={{ width: `${row.share ?? 0}%` }} /></span>
                              <span className="num">{row.share === null ? "—" : `${row.share}%`}</span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
                : (
                  <div className="wall-empty">
                    {data.costSummary === null ? "成本分解读取中。" : "金额字段未接入，先看 30 日成本趋势上方的用量曲线。"}
                  </div>
                )}
            </div>

            <div className="wall-panel" style={{ flex: "150 0 0" }}>
              <div className="wall-panel-title">预算执行<span className="wall-psrc">/api/budget · 60s</span></div>
              {data.budget === null
                ? <div className="wall-empty">预算状态读取中。</div>
                : !view.budgetEnabled
                  ? <div className="wall-empty">未设置月度预算。到「成本」页设置后，这里给出余量与触线预测。</div>
                  : (
                    <div className="wall-guard">
                      <div className="wall-gcell">
                        <div className="wall-gv2">{view.budgetRatioPct ?? "—"}<small style={{ fontSize: 24 }}>%</small></div>
                        <div className="wall-gl">本月已执行</div>
                      </div>
                      <div className="wall-gcell">
                        <div className="wall-gv2">{data.budget.spentUsd === null ? "—" : money(data.budget.spentUsd)}</div>
                        <div className="wall-gl">本月已花</div>
                      </div>
                      <div className="wall-gcell">
                        <div className="wall-gv2">{money(Math.max(0, data.budget.budgetUsd - (data.budget.spentUsd ?? 0)))}</div>
                        <div className="wall-gl">预算余量</div>
                      </div>
                    </div>
                  )}
            </div>
          </div>
        </div>

        {/* T 底部作战行：行动队列 / 通道投递汇总 / 未来 24 小时任务 / 消息网关链路 */}
        <div className="wall-bottom">
          <div className="wall-panel">
            <div className="wall-panel-title">行动队列<span className="wall-psrc">dashboard · alerts · approvals · 15-30s</span></div>
            {attention.length === 0
              ? <div className="wall-empty">当前没有需要处理的事项。</div>
              : (
                <div className="wall-actions">
                  {attention.slice(0, 4).map((item) => (
                    <button
                      type="button"
                      className="wall-action"
                      key={item.id}
                      data-severity={item.severity}
                      onClick={() => void navigate(item.actionHref)}
                    >
                      <span className="wall-dot" />
                      <span className="wall-action-main">
                        <span className="wall-action-title">{item.title}</span>
                        <span className="wall-action-impact">{item.impact}</span>
                      </span>
                      <span className="wall-action-go">{item.actionLabel}</span>
                    </button>
                  ))}
                </div>
              )}
            <div className="wall-upfoot">
              {attention.length > 4 ? `另有 ${attention.length - 4} 项待处理，可在首页继续处理。` : "只列仍需你处理的阻断、行动与待确认项，与首页同一口径。"}
            </div>
          </div>

          <div className="wall-panel">
            <div className="wall-panel-title">通道投递汇总<span className="wall-psrc">messages/metrics?days=7 · 60s</span></div>
            <div className="wall-tablewrap">
              <table className="wall-table">
                <thead>
                  <tr><th>通道</th><th>送达</th><th>失败</th><th>不确定</th><th>成功率</th><th>P50</th><th>P95</th><th>重试</th></tr>
                </thead>
                <tbody>
                  {(data.metrics?.channels ?? []).filter((ch) => ch.total > 0).slice(0, 4).map((ch) => (
                    <tr key={ch.channel}>
                      <td>{ch.channel}</td>
                      <td>{ch.delivered}</td>
                      <td className={ch.failed > 0 ? "wall-num-error" : ""}>{ch.failed}</td>
                      <td>{ch.uncertain}</td>
                      <td>{(ch.successRate * 100).toFixed(1)}%</td>
                      <td className="wall-mono">{ch.p50LatencyMs === null ? "—" : `${ch.p50LatencyMs}ms`}</td>
                      <td className="wall-mono">{ch.p95LatencyMs === null ? "—" : `${ch.p95LatencyMs}ms`}</td>
                      <td>{ch.retries}</td>
                    </tr>
                  ))}
                  {(data.metrics?.channels ?? []).every((ch) => ch.total === 0) && (
                    <tr><td colSpan={8} className="wall-empty">近 7 天暂无投递记录。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wall-panel">
            <div className="wall-panel-title">未来 24 小时任务<span className="wall-psrc">scheduled-tasks · 15s</span></div>
            {!tasks.known
              ? <div className="wall-empty">{tasks.label}：尚未获得任务列表，就不做时间推测。</div>
              : !tasks.running
                ? <div className="wall-empty">{tasks.label}。请先确认 Hermes 调度器状态，再核对执行时间。</div>
                : tasks.upcoming.length === 0
                  ? <div className="wall-empty">未来 24 小时暂无已确认的任务安排。</div>
                  : (
                    <div className="wall-tasks">
                      {tasks.upcoming.slice(0, 4).map((task) => (
                        <div className="wall-task" key={task.id}>
                          <span className="wall-task-name">{task.name}</span>
                          <span className="wall-task-meta">
                            <time dateTime={task.nextRunAt ?? undefined}>{formatTime(task.nextRunAt)}</time>
                            <span>· {TASK_STATUS_LABEL[task.lastStatus] ?? task.lastStatus}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
            <div className="wall-upfoot">
              {tasks.known
                ? `今日执行 ${tasks.todayRunCount} 次 · 失败任务 ${tasks.failedTaskCount} 个`
                : "任务读数来自 Hermes 调度器；读不到时保持待接入，不用估算值顶替。"}
            </div>
          </div>

          <div className="wall-panel">
            <div className="wall-panel-title">消息网关链路<span className="wall-psrc">messages/status · 15s</span></div>
            <div className="wall-link">
              {linkRows.map((row) => (
                <div className="wall-link-row" key={row.k}>
                  <span className="k">{row.k}</span>
                  <span
                    className="wall-dot"
                    style={{
                      background: row.ok === null ? "var(--text-3)" : row.ok ? "var(--ok)" : row.k === "Outbox 积压" ? "var(--warn)" : "var(--error)",
                      marginTop: 0,
                    }}
                  />
                  <span className="v">{row.v}</span>
                </div>
              ))}
              <div className="wall-link-foot">
                断线自愈：Bridge 离线只标记不退出，每秒重试；恢复后续传 Outbox，无需人工干预。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WallPage;
