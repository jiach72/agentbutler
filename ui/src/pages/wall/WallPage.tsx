import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HomeOutlined, MoonOutlined, ReloadOutlined, SunOutlined } from "@ant-design/icons";
import { isInstanceOnline, normalizeInstanceState } from "@butler/contract";
import * as echarts from "echarts";
import { deriveWallView, useWallData } from "./useWallData.js";
import { messageTrendOption, type TrendPoint, type WallThemeMode, WALL_PALETTES } from "./wallTheme.js";
import { AttentionList, TaskPreview, taskTime } from "../dashboard/HealthOverview.js";
import "../dashboard/dashboard.css";
import "./wall.css";

export function readInitialTheme(): WallThemeMode {
  try { return window.localStorage.getItem("butler.wallTheme") === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

export function latencyConclusion(p95Ms: number | null, thresholdMs: number | null = null): string {
  if (p95Ms === null || !Number.isFinite(p95Ms)) return "暂无延迟样本";
  const value = p95Ms >= 1000 ? `${(p95Ms / 1000).toFixed(1)} 秒` : `${Math.round(p95Ms)} 毫秒`;
  if (thresholdMs === null || !Number.isFinite(thresholdMs) || thresholdMs <= 0) return `P95 ${value}，未设阈值`;
  return `P95 ${value}，${p95Ms > thresholdMs ? "超过阈值" : "阈值内"}`;
}

function MessageTrend({ points, theme }: { points: TrendPoint[]; theme: WallThemeMode }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = echarts.init(host.current);
    chart.setOption(messageTrendOption(points, WALL_PALETTES[theme]));
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [points, theme]);
  return <div ref={host} className="wall-chart" role="img" aria-label="近七日消息送达与失败趋势" />;
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="wall-kpi"><dt>{label}</dt><dd>{value}</dd><p>{note}</p></div>;
}

export function WallPage() {
  const data = useWallData();
  const view = useMemo(() => deriveWallView(data), [data]);
  const [theme, setTheme] = useState<WallThemeMode>(readInitialTheme);
  const { shared } = data;
  const health = view.healthSummary;
  const connectionKnown = view.healthInput.messages?.connected;
  const instanceText = view.totalInstances === null ? "待确认" : `${view.onlineInstances}/${view.totalInstances}`;
  const messageText = connectionKnown === true
    ? (view.healthInput.messages?.failed ?? 0) + (view.healthInput.messages?.unknown ?? 0) > 0 ? "需核对投递" : "已连接"
    : connectionKnown === false ? "连接中断" : "待确认";
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { window.localStorage.setItem("butler.wallTheme", next); } catch { /* Theme still works without storage. */ }
  };
  const percent = (value: number | null) => value === null ? "待确认" : `${Math.round(value)}%`;
  const nextTime = shared.tasks.next && shared.tasks.running ? taskTime(shared.tasks.next.nextRunAt) : "待确认";
  return (
    <main className="wall-root" data-wall-theme={theme}>
      <div className="wall-stage">
        <header className="wall-header">
          <h1>Hermes 运行总览</h1>
          <nav aria-label="大屏操作">
            <Link to="/dashboard"><HomeOutlined />打开首页</Link>
            <button type="button" onClick={data.refreshAll} disabled={shared.refreshing} aria-label="刷新状态" title="刷新状态"><ReloadOutlined /></button>
            <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "切换浅色" : "切换暗色"} title={theme === "dark" ? "切换浅色" : "切换暗色"}>{theme === "dark" ? <SunOutlined /> : <MoonOutlined />}</button>
          </nav>
        </header>
        <section className="wall-conclusion" data-status={health.status} aria-live="polite">
          <h2>{shared.loading ? "正在读取运行状态" : health.headline}</h2>
          <p>{shared.loading ? "等待连接与能力检查结果。" : health.explanation}</p>
        </section>
        <dl className="wall-kpirow">
          <Kpi label="总体状态" value={{ healthy: "正常", degraded: "待确认", action_required: "需处理", blocked: "受阻" }[health.status]} note={shared.loading ? "正在读取" : "连接与能力综合结论"} />
          <Kpi label="智能体" value={instanceText} note={view.totalInstances !== null && view.totalInstances > 0 && view.onlineInstances === view.totalInstances ? "正常" : "运行与连接状态"} />
          <Kpi label="待处理事项" value={shared.loading ? "待确认" : String(health.attention.length)} note="当前仍需行动或核对" />
          <Kpi label="消息链路" value={messageText} note={view.healthInput.messages?.unknown ? `${view.healthInput.messages.unknown} 条结果未知` : `${view.pendingMessages} 条等待投递`} />
          <Kpi label="下一任务" value={nextTime} note={shared.tasks.label} />
          <Kpi label="主机资源" value={`CPU ${percent(view.cpuPercent)}`} note={`内存 ${percent(view.memPercent)} · 磁盘 ${percent(view.diskPercent)}`} />
        </dl>
        <div className="wall-main">
          <section className="wall-attention" aria-labelledby="wall-attention-title">
            <h2 id="wall-attention-title">需要关注</h2>
            {shared.loading ? <p>正在读取待处理事项。</p> : <AttentionList attention={health.attention} />}
          </section>
          <TaskPreview tasks={shared.tasks} wall />
          <section className="wall-trends" aria-labelledby="wall-trends-title">
            <h2 id="wall-trends-title">消息与实例</h2>
            <h3>近 7 日消息投递</h3>
            {view.trend.length > 0 ? <MessageTrend points={view.trend} theme={theme} /> : <p className="health-muted">暂无可用的投递趋势。</p>}
            <details className="wall-evidence"><summary>{latencyConclusion(view.p95Ms)}</summary><p>近 7 日消息投递记录的第 95 百分位延迟；未配置阈值时不作正常或异常判断。</p>
              <table><caption>每日投递数量</caption><thead><tr><th>日期</th><th>送达</th><th>失败</th></tr></thead><tbody>{view.trend.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.delivered}</td><td>{point.failed}</td></tr>)}</tbody></table>
            </details>
            <h3>智能体连接</h3>
            <ul className="wall-instances">{(view.healthInput.instances ?? []).slice(0, 4).map((instance) => (
              <li key={instance.instanceId}><span>{data.connections?.find((connection) => connection.instanceId === instance.instanceId)?.displayName ?? instance.instanceId}</span><strong>{isInstanceOnline(instance) ? "正常" : normalizeInstanceState(instance.state) === "offline" ? "不可用" : instance.connected === false ? "未连接" : "待确认"}</strong></li>
            ))}</ul>
            {(view.totalInstances ?? 0) > 4 && <Link to="/setup">查看全部 {view.totalInstances} 个实例</Link>}
          </section>
        </div>
        <footer className="wall-footer">最近读取：{data.lastRefreshAt ? data.lastRefreshAt.toLocaleTimeString("zh-CN", { hour12: false }) : "尚未完成"}</footer>
      </div>
    </main>
  );
}

export default WallPage;
