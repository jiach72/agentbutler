import { Button, Empty, List, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { formatTime } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionActionQueue({ items, busy, onRecheck }: { items: EvolutionOverviewPayload["actionItems"]; busy?: string | null; onRecheck: (id: string) => void }) {
  const open = items.filter((item) => item.status !== "resolved" && item.status !== "ignored");
  return <section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">行动清单</span><h2>下一步做什么</h2></div><span className="evolution-panel-count">{open.length} 待处理</span></header>{open.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待处理事项" /> : <List dataSource={open.slice(0, 6)} renderItem={(item) => <List.Item actions={[<Button key="recheck" size="small" icon={<ReloadOutlined />} loading={busy === item.actionId} onClick={() => onRecheck(item.actionId)}>重新检查</Button>]}><div className="evolution-list-row"><div><strong>{item.title}</strong><span><Tag color={item.impact === "blocking" ? "red" : "orange"}>{item.impact === "blocking" ? "阻断进化" : "建议处理"}</Tag> {item.occurrences} 次 · 最近 {formatTime(item.lastSeenAt)}</span><small>{item.nextAction}</small></div></div></List.Item>} />}</section>;
}
