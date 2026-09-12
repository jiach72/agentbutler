/**
 * 运维总览大屏（/wall）：挂墙用只读结论层，3840×2160 基准画布等比缩放（4K 版，
 * 2026-09-12 由 1080p 升级：图表字号/栅格同步放大，新增成本用量列与底部记录行），
 * 暗色为主、浅色可切（解除品牌约束的主流水大屏风格，见 docs/dashboard-design-2026-09-11.md）。
 * 全部数值来自既有 /api 端点轮询；金额统一经 money() 折算 ¥；
 * 数据不可用时显示「待接入」灰态，不伪造数据。
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
import { formatBytes, formatTime, money, USD_TO_CNY } from "../../lib/format.js";
import "./wall.css";

const THEME_STORAGE_KEY = "butler.wallTheme";
const STAGE_WIDTH = 3840;
const STAGE_HEIGHT = 2160;

function readInitialTheme(): WallThemeMode {
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

const BACKUP_KIND_LABEL: Record<string, string> = { full: "全量备份", memory: "记忆备份", event: "事件备份" };

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
  const [stageScale, setStageScale] = useState(() =>
    Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT));
  useEffect(() => {
    const fit = () => {
      const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
      if (stageRef.current !== null) {
        stageRef.current.style.transform = `translate(-50%,-50%) scale(${scale})`;
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

  // 24h / 7 日 token 汇总（万）：注意 (a ?? 0) 必须带括号，?? 优先级低于 /（审计 P0-1 教训）。
  const latestTokensWan = llm === null ? null : Math.round((llm.days.at(-1)?.tokens ?? 0) / 10_000);
  const sevenDayTokensWan = llm === null
    ? null
    : Math.round(llm.days.reduce((sum, d) => sum + d.tokens, 0) / 10_000);

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
  const budgetTone = view.budgetEnabled && data.budget !== null && (data.budget.threshold === "100%" || data.budget.threshold === "over")
    ? "error"
    : view.budgetEnabled && data.budget?.threshold === "80%" ? "warn" : undefined;

  // ── 4K 新增：消息网关链路（/api/messages/status）──
  const bridge = view.bridge;
  const bridgeConnected = bridge?.connected === true;
  const linkRows: Array<{ k: string; v: string; ok: boolean | null }> = [
    { k: "Bridge 连接", v: bridge === null ? "状态未知" : bridgeConnected ? "已连接" : "离线（自愈重试中）", ok: bridge === null ? null : bridgeConnected },
    { k: "Bridge 进程", v: bridge?.running === undefined ? "—" : bridge.running ? "运行中" : "未运行", ok: bridge?.running ?? null },
    { k: "消息管线", v: relayText, ok: view.relayEnabled === null ? null : view.relayEnabled },
    { k: "Outbox 积压", v: `${view.pendingMessages} 条`, ok: view.pendingMessages === 0 },
  ];

  // ── 4K 新增：升级与备份记录（/api/versions · /api/backups）──
  const backupRows = view.recentBackups;
  const snapshotRows = view.recentSnapshots;
  const job = view.upgradeJob;

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

        {/* B KPI 行：9 卡（原有 7 + 30日成本 + 预算执行） */}
        <div className="wall-kpirow">
          <KpiCard
            label="实例在线"
            value={`${view.onlineInstances}`}
            unit={`/${view.totalInstances}`}
            foot="Hermes · OpenClaw"
            footExtra="↑ 15s"
            badge={{ text: view.totalInstances > 0 && view.onlineInstances === view.totalInstances ? "全部正常" : "部分离线", kind: view.onlineInstances === view.totalInstances ? "ok" : "warn" }}
          />
          <KpiCard
            label="7日 送达成功率"
            value={successRateText}
            unit="%"
            foot="messages/metrics"
            footExtra="↑ 60s"
          />
          <KpiCard
            label="P95 送达延迟"
            value={p95Text}
            foot={view.p95Ms === null ? "无样本" : "阈值内"}
            footExtra="↑ 60s"
          />
          <KpiCard label="待处理消息" value={`${view.pendingMessages}`} foot="Outbox 队列" footExtra="↑ 15s" />
          <KpiCard
            label="未处理告警"
            value={`${view.openAlerts}`}
            foot="含未解决项"
            footExtra="↑ 15s"
            tone={alertTone}
          />
          <KpiCard
            label="24h Token 消耗"
            value={latestTokensWan === null ? "—" : latestTokensWan.toLocaleString()}
            unit={latestTokensWan === null ? undefined : "万"}
            foot={sevenDayTokensWan === null ? "7 日待接入" : `7 日累计 ${sevenDayTokensWan.toLocaleString()} 万`}
            footExtra="↑ 60s"
            tone="brand"
            badge={latestTokensWan === null ? { text: "待接入", kind: "brass" } : { text: "已接入", kind: "ok" }}
          />
          <KpiCard
            label="30日 模型成本"
            value={costReady && view.costTotalUsd !== null ? (view.costTotalUsd * USD_TO_CNY).toFixed(2) : "—"}
            unit={costReady && view.costTotalUsd !== null ? "元" : undefined}
            foot={data.costSummary === null ? "cost/summary 读取中" : costReady ? "实际账单优先" : "金额字段未接入"}
            footExtra="↑ 60s"
            tone="brass"
            badge={data.costSummary === null
              ? { text: "读取中", kind: "off" }
              : costReady ? { text: "已接入", kind: "ok" } : { text: "待接入", kind: "brass" }}
          />
          <KpiCard
            label="月度预算执行"
            value={view.budgetEnabled && view.budgetRatioPct !== null ? `${view.budgetRatioPct}` : "—"}
            unit={view.budgetEnabled && view.budgetRatioPct !== null ? "%" : undefined}
            foot={data.budget === null ? "budget 读取中" : view.budgetEnabled ? `月度上限 ¥${((data.budget.budgetUsd) * USD_TO_CNY).toFixed(0)}` : "未设置预算"}
            footExtra="↑ 60s"
            tone={budgetTone}
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
                  <span>在线 <b>{view.onlineInstances}/{view.totalInstances}</b></span>
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

        {/* T 底部记录行（4K 新增）：通道投递汇总 / 消息网关链路 / 升级与备份 */}
        <div className="wall-bottom">
          <div className="wall-panel">
            <div className="wall-panel-title">通道投递汇总<span className="wall-psrc">messages/metrics?days=7 · 60s</span></div>
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

          <div className="wall-panel">
            <div className="wall-panel-title">升级与备份记录<span className="wall-psrc">versions · backups · 60s</span></div>
            <div className="wall-upgrid">
              <div className="wall-upcol">
                <div className="wall-uphead"><span style={{ width: 130 }}>最近备份</span></div>
                {backupRows.map((item) => (
                  <div className="wall-uprow" key={item.id}>
                    <span className="t">{formatTime(item.createdAt)}</span>
                    <span className="m">{item.label ?? BACKUP_KIND_LABEL[item.kind] ?? item.kind}</span>
                    <span className="wall-mono" style={{ fontSize: 22 }}>{formatBytes(item.sizeBytes)}</span>
                    <span className={`wall-badge ${item.status === "ok" || item.status === "completed" ? "b-ok" : "b-off"}`}>{item.status}</span>
                  </div>
                ))}
                {backupRows.length === 0 && <div className="wall-empty" style={{ fontSize: 24 }}>备份记录读取中或暂无备份。</div>}
              </div>
              <div className="wall-upcol">
                <div className="wall-uphead"><span>版本快照 / 升级</span></div>
                {job !== null && (
                  <div className="wall-uprow">
                    <span className="t">{formatTime(job.startedAt)}</span>
                    <span className="m">升级 → {job.targetVersion}{job.rolledBack ? "（已回滚）" : ""}</span>
                    <span className={`wall-badge ${job.status === "done" ? "b-ok" : job.status === "running" ? "b-info" : "b-err"}`}>{job.status}</span>
                  </div>
                )}
                {snapshotRows.map((snap) => (
                  <div className="wall-uprow" key={snap.id}>
                    <span className="t">{formatTime(snap.createdAt)}</span>
                    <span className="m">快照 {snap.label ?? `#${snap.id}`} · {snap.instance}</span>
                    <span className={`wall-badge ${snap.status === "ok" ? "b-ok" : "b-off"}`}>{snap.status}</span>
                  </div>
                ))}
                {job === null && snapshotRows.length === 0 && (
                  <div className="wall-empty" style={{ fontSize: 24 }}>暂无升级与快照记录。</div>
                )}
              </div>
            </div>
            <div className="wall-upfoot">
              当前版本 <b className="wall-mono">{versionText}</b>
              {data.versions?.watchReachable === false ? " · Watch 通道离线，记录可能滞后" : " · 升级/回滚前自动做数据卷备份"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WallPage;
