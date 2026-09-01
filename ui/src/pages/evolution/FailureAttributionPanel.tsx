import { Empty, Tag } from "antd";
import type { EvolutionOverviewPayload } from "./types.js";

const labels: Record<string, string> = { "environment-dependency": "环境依赖", runtime: "运行环境", dataset: "数据问题", engine: "引擎问题", target: "目标问题", unknown: "未知" };
export function FailureAttributionPanel({ items }: { items: EvolutionOverviewPayload["failures"] }) {
  return <section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">失败归因</span><h2>先处理阻断项</h2></div><span className="evolution-panel-count">{items.length} 类</span></header>{items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有失败归因" /> : <ul className="app-list">{items.slice(0, 8).map((item, index) => <li key={index}><div className="evolution-list-row"><div><strong>{item.title}</strong><span>{labels[item.category] ?? item.category} · {item.count} 次 · {item.source}</span><small>{item.evidence}</small></div><Tag color={item.impact === "blocking" ? "red" : item.impact === "high" ? "orange" : "default"}>{item.impact === "blocking" ? "阻断" : item.impact}</Tag></div></li>)}</ul>}</section>;
}
