import { Button, Select, Space } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import type { EvolutionOverviewPayload } from "./types.js";
import { EvolutionScoreStrip } from "./EvolutionScoreStrip.js";
import { EvolutionCharts } from "./EvolutionCharts.js";
import { FailureAttributionPanel } from "./FailureAttributionPanel.js";
import { EvolutionActionQueue } from "./EvolutionActionQueue.js";
import { EvolutionDatasetPanel } from "./EvolutionDatasetPanel.js";
import { EvolutionRunHistory } from "./EvolutionRunHistory.js";

export function EvolutionOverview({ overview, range, onRangeChange, onRefresh, onAnalyze, busy, onRecheck }: { overview: EvolutionOverviewPayload | null; range: "24h" | "7d" | "30d"; onRangeChange: (range: "24h" | "7d" | "30d") => void; onRefresh: () => void; onAnalyze: () => void; busy?: string | null; onRecheck: (id: string) => void }) {
  if (!overview) return null;
  return <div className="evolution-overview"><section className="evolution-overview-head"><div><span className="evolution-eyebrow">运营工作台</span><h2>自进化运行状态</h2><p>用观测数据判断稳定性、进化收益和下一步行动。</p></div><Space wrap><ConnectionChip reachable={overview.status !== "offline"} onlineText={`实例 ${overview.instanceId ?? "未知"}`} offlineText="Watch 离线" /><Select value={range} onChange={onRangeChange} options={[{ value: "24h", label: "24 小时" }, { value: "7d", label: "7 天" }, { value: "30d", label: "30 天" }]} /><Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button><Button type="primary" onClick={onAnalyze} loading={busy === "analyze"}>重新分析</Button></Space></section><div className="evolution-meta-line"><span>最近分析：{overview.analyzedAt}</span><span>数据来源：{overview.source}</span><span>{overview.completeness.note}</span></div><EvolutionScoreStrip overview={overview} /><EvolutionCharts overview={overview} /><div className="evolution-dashboard-grid"><FailureAttributionPanel items={overview.failures} /><EvolutionActionQueue items={overview.actionItems} busy={busy} onRecheck={onRecheck} /></div><div className="evolution-dashboard-grid"><EvolutionDatasetPanel dataset={overview.datasets} /><section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">引擎摘要</span><h2>评估是否有效</h2></div></header><div className="evolution-engine-summary"><strong>{overview.evolution.runCount} 次运行</strong><span>完成 {overview.evolution.completedRuns} 次 · 成功 {overview.evolution.successfulRuns} 次 · 运行成功率 {overview.evolution.successRate === null ? "未知" : `${Math.round(overview.evolution.successRate * 100)}%`}</span><p>{overview.evolution.latest?.detail ?? "还没有进化运行"}</p></div></section></div><EvolutionRunHistory runs={overview.runs} /></div>;
}
