import { Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatTime } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionRunHistory({ runs }: { runs: EvolutionOverviewPayload["runs"] }) {
  const columns: TableColumnsType<EvolutionOverviewPayload["runs"][number]> = [
    { title: "运行", dataIndex: "runId", render: (value: string) => <code>{value.slice(0, 10)}</code> },
    { title: "时间", dataIndex: "updatedAt", render: (value: string) => formatTime(value) },
    { title: "baseline → candidate", render: (_, row) => row.baseline === null || row.candidate === null ? "未知" : `${row.baseline.toFixed(3)} → ${row.candidate.toFixed(3)}` },
    { title: "improvement", dataIndex: "improvement", render: (value: number | null) => value === null ? "未知" : value.toFixed(3) },
    { title: "收益分", dataIndex: "gainScore", render: (value: number | null) => value === null ? <Tag>不评分</Tag> : <Tag color={value === 100 ? "green" : value === 0 ? "red" : "orange"}>{value}</Tag> },
    { title: "门禁", dataIndex: "gate", render: (value: string) => <Tag color={value === "accepted" ? "green" : value === "rejected-regression" ? "red" : "orange"}>{value}</Tag> },
  ];
  return <section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">运行历史</span><h2>每一次评估都可复盘</h2></div><span className="evolution-panel-count">{runs.length} 次</span></header><Table size="small" rowKey="runId" pagination={{ pageSize: 6, hideOnSinglePage: true }} locale={{ emptyText: "暂无运行历史" }} columns={columns} dataSource={runs} scroll={{ x: 720 }} /></section>;
}
