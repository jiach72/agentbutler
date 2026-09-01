import { Progress, Statistic } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatDecimal, formatNumber, formatPercent } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

function percent(value: number | null): string { return formatPercent(value, 0, "未知"); }
function number(value: number | null): string { return value === null ? "未知" : formatNumber(value); }

export function EvolutionScoreStrip({ overview }: { overview: EvolutionOverviewPayload }) {
  const score = overview.totals.healthScore;
  const statusTone = overview.status === "healthy" ? "ok" : overview.status === "offline" || overview.status === "blocked" ? "error" : "warn";
  const latest = overview.evolution.latest;
  return <section className="evolution-score-strip" aria-label="自进化核心指标">
    <div className={`evolution-score-main is-${statusTone}`}>
      <div className="evolution-score-label">整体健康分</div>
      <strong>{score === null ? "样本不足" : `${formatDecimal(score, 1)} / 100`}</strong>
      <Progress percent={score ?? 0} showInfo={false} strokeColor="currentColor" railColor="var(--butler-rule)" />
      <span>{overview.statusDetail}</span>
    </div>
    <div className="evolution-kpi"><Statistic title="工具成功率" value={percent(overview.totals.successRate)} /></div>
    <div className="evolution-kpi"><Statistic title="会话" value={number(overview.totals.sessions)} suffix={<small>已完成 {overview.totals.completedSessions}</small>} /></div>
    <div className="evolution-kpi"><Statistic title="工具调用" value={number(overview.totals.toolCalls)} suffix={<small>未知 {overview.totals.unknownToolCalls}</small>} /></div>
    <div className="evolution-kpi"><Statistic title="真实样本" value={overview.datasets.realSamples} suffix={<small>/ {overview.datasets.realSamples + overview.datasets.gap}</small>} /></div>
    <div className="evolution-kpi"><Statistic title="最近 improvement" value={latest?.improvement === null || latest === null ? "未知" : formatDecimal(latest.improvement, 3)} suffix={latest?.gainScore === null || latest?.gainScore === undefined ? undefined : <StatusBadge tone={latest.gainScore >= 100 ? "ok" : latest.gainScore === 0 ? "error" : "warn"} label={`${formatNumber(latest.gainScore)} 分`} />} /></div>
  </section>;
}
