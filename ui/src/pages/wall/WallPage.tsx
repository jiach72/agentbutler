/**
 * 运维总览大屏（/wall）：挂墙用只读结论层，1920×1080 基准画布等比缩放，
 * 暗色为主、浅色可切（解除品牌约束的主流水大屏风格，见 docs/dashboard-design-2026-09-11.md）。
 * 全部数值来自既有 /api 端点轮询；Token 三件套来自 /api/llm/usage（Hermes
 * session_model_usage 只读聚合），不可用时显示「待接入」灰态，不伪造数据。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import {
  WALL_PALETTES,
  type TokenModelSeries,
  type WallThemeMode,
  donutOption,
  gaugeOption,
  skillBarOption,
  sparkOption,
  tokenTrendOption,
  trendOption,
} from "./wallTheme.js";
import { deriveWallView, useWallData, type WallLlmUsage } from "./useWallData.js";
import "./wall.css";

const THEME_STORAGE_KEY = "butler.wallTheme";
const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

function readInitialTheme(): WallThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** ECharts 挂载组件：option 变化即 setOption，容器尺寸变化自动 resize。 */
function WallChart({ option, className }: { option: EChartsOption | null; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    if (hostRef.current === null) return;
    chartRef.current = echarts.init(hostRef.current);
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (chartRef.current !== null && option !== null) {
      chartRef.current.setOption(option, true);
    }
  }, [option]);

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
  tone?: "brand" | "cyan" | "warn" | "error";
  badge?: { text: string; kind: "ok" | "warn" | "err" | "info" | "brass" | "off" };
  spark?: { data: Array<number>; theme: WallThemeMode };
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
          : <WallChart option={sparkOption(props.spark.data, WALL_PALETTES[props.spark.theme])} className="wall-spark" />}
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
          <div className="wall-pending-sub">需 Watch llm-probe 落地 model / prompt_tokens / completion_tokens 采集后启用</div>
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

  // 画布等比缩放：以 1920×1080 为基准，居中适配任意窗口（2K/4K 不失真，无滚动条）。
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const fit = () => {
      const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
      if (stageRef.current !== null) {
        stageRef.current.style.transform = `translate(-50%,-50%) scale(${scale})`;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const successRateText = view.successRate === null ? "—" : view.successRate.toFixed(1);
  const p95Text = view.p95Ms === null ? "—" : view.p95Ms >= 1000 ? `${(view.p95Ms / 1000).toFixed(1)}s` : `${view.p95Ms}ms`;
  const relayText = view.relayEnabled === null ? "消息状态未知" : view.relayEnabled ? "Butler 管线接管中" : "Hermes 通道直发";
  const versionText = data.health?.services.gateway.serviceVersion ?? "—";
  const updatedText = data.lastRefreshAt === null ? "--:--:--" : formatClock(data.lastRefreshAt).slice(11);
  const cpuText = view.cpuPercent === null ? "—" : Math.round(view.cpuPercent).toString();
  const memText = view.memPercent === null ? "—" : `${Math.round(view.memPercent)}%`;
  const diskText = view.diskPercent === null ? "—" : `${Math.round(view.diskPercent)}%`;
  const diskWarn = view.diskPercent !== null && view.diskPercent >= 75;
  const alertTone = view.openAlerts > 0 ? "warn" : undefined;

  const llmPending = data.llmUsage === "unavailable" || data.llmUsage === null;
  const llm: WallLlmUsage | null = llmPending || data.llmUsage === "unavailable" ? null : data.llmUsage;

  // Token 按模型堆叠序列：Top4 模型各一条 + 其余合并「其他」，单位万 token。
  // 服务端未带 daily（理论不发生）时退回单条「合计」。
  const tokenSeries: Array<TokenModelSeries> = useMemo(() => {
    if (llm === null) return [];
    const colorSeq = [palette.accent, palette.cyan, palette.brass, palette.ok];
    const hasDaily = llm.models.some((m) => Array.isArray(m.daily) && m.daily.length === llm.days.length);
    if (!hasDaily) {
      return [{ name: "合计", color: colorSeq[0]!, data: llm.days.map((d) => Math.round(d.tokens / 10_000)) }];
    }
    const sorted = [...llm.models].sort((a, b) => b.tokens - a.tokens);
    const series = sorted.slice(0, 4).map((m, i) => ({
      name: m.model,
      color: colorSeq[i % colorSeq.length]!,
      data: (m.daily ?? []).map((v) => Math.round(v / 10_000)),
    }));
    const rest = sorted.slice(4);
    if (rest.length > 0) {
      series.push({
        name: "其他",
        color: palette.blue100,
        data: llm.days.map((_, dayIndex) =>
          Math.round(rest.reduce((sum, m) => sum + (m.daily?.[dayIndex] ?? 0), 0) / 10_000)),
      });
    }
    return series;
  }, [llm, palette]);

  return (
    <div className="wall-root" data-wall-theme={theme}>
      <svg className="wall-corner tl" viewBox="0 0 140 140" aria-hidden="true">
        <path d="M0 0 H84 V3 H3 V84 H0 Z" fill="#4DA3FF" opacity=".5" />
        <path d="M0 26 H26 V0 H29 V29 H0 Z" fill="#4DA3FF" opacity=".25" />
      </svg>
      <svg className="wall-corner tr" viewBox="0 0 140 140" aria-hidden="true"><path d="M0 0 H84 V3 H3 V84 H0 Z" fill="#4DA3FF" opacity=".5" /></svg>
      <svg className="wall-corner bl" viewBox="0 0 140 140" aria-hidden="true"><path d="M0 0 H84 V3 H3 V84 H0 Z" fill="#4DA3FF" opacity=".5" /></svg>
      <svg className="wall-corner br" viewBox="0 0 140 140" aria-hidden="true"><path d="M0 0 H84 V3 H3 V84 H0 Z" fill="#4DA3FF" opacity=".5" /></svg>

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

        {/* B KPI 行 */}
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
            value={llm === null ? "—" : Math.round(llm.days.at(-1)?.tokens ?? 0 / 10_000).toString()}
            unit="万"
            foot="7 日待接入"
            footExtra="↑ 60s"
            tone="brand"
            badge={{ text: "待接入", kind: "brass" }}
          />
          <KpiCard
            label="主机 CPU"
            value={cpuText}
            unit="%"
            foot="watch/host-metrics"
            footExtra={`内存 ${memText}`}
            tone="cyan"
            spark={{ data: view.cpuSeries.length >= 2 ? view.cpuSeries : [0, 0], theme }}
          />
        </div>

        {/* 主体三列 */}
        <div className="wall-main">
          {/* C 左列 */}
          <div className="wall-col">
            <div className="wall-panel" style={{ flex: "280 0 0" }}>
              <div className="wall-panel-title">实例健康<span className="wall-psrc">lifecycle · connections · 30s</span></div>
              {(data.connections ?? []).slice(0, 4).map((conn) => (
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
              {(data.connections ?? []).length === 0 && <div className="wall-empty">实例状态读取中，若持续为空请检查管家服务。</div>}
            </div>

            <div className="wall-panel" style={{ flex: "250 0 0" }}>
              <div className="wall-panel-title">主机资源<span className="wall-psrc">watch/host-metrics · 15s</span></div>
              <div className="wall-gauges">
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(view.cpuPercent ?? 0, palette.accent, palette)} className="wall-gauge-chart" />
                  <span className="wall-gauge-label">CPU</span>
                </div>
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(Math.round(view.memPercent ?? 0), palette.cyan, palette)} className="wall-gauge-chart" />
                  <span className="wall-gauge-label">内存</span>
                </div>
                <div className="wall-gauge">
                  <WallChart option={gaugeOption(Math.round(view.diskPercent ?? 0), diskWarn ? palette.warn : palette.accent, palette)} className="wall-gauge-chart" />
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
                ? <WallChart option={trendOption(view.trend, palette)} className="wall-chart" />
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
                  />
                </div>
              )}

            <div className="wall-panel" style={{ flex: "220 0 0" }}>
              <div className="wall-panel-title">技能调用 TOP5<span className="wall-psrc">skills/usage · 60s</span></div>
              <div className="wall-skillwrap">
                <div className="wall-skgrid">
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.skillTotal}</div><div className="wall-gl">技能总数</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.active7d}</div><div className="wall-gl">7日活跃</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.calls24h}</div><div className="gl">24h 调用</div></div>
                  <div className="wall-gcell"><div className="wall-gv2 sm">{view.calls7d}</div><div className="wall-gl">7 日调用</div></div>
                </div>
                {view.topSkills.length > 0
                  ? <WallChart option={skillBarOption(view.topSkills, palette)} className="wall-chart" />
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
                  <WallChart option={donutOption(llm.models.map((m) => ({ name: m.model, value: Math.round(m.tokens / 10_000) })), palette)} className="wall-chart" />
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
        </div>

        {/* T1 明细表格：投递明细依赖 message_projection 单条视图，本期以通道汇总代替，避免伪造行级数据。 */}
        <div className="wall-panel" style={{ height: "196px", flex: "none" }}>
          <div className="wall-panel-title">通道投递汇总<span className="wall-psrc">messages/metrics?days=7 · 60s</span></div>
          <table className="wall-table">
            <thead>
              <tr><th>通道</th><th>送达</th><th>失败</th><th>不确定</th><th>成功率</th><th>P50</th><th>P95</th><th>重试</th></tr>
            </thead>
            <tbody>
              {(data.metrics?.channels ?? []).filter((ch) => ch.total > 0).map((ch) => (
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
    </div>
  );
}

export default WallPage;
