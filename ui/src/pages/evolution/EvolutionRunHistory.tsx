import { Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { formatDecimal, formatNumber, formatTime } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionRunHistory({ runs }: { runs: EvolutionOverviewPayload["runs"] }) {
  const columns: TableColumnsType<EvolutionOverviewPayload["runs"][number]> = [
    { title: "运行", dataIndex: "runId", width: 120, render: (value: string) => <code>{value.slice(0, 10)}</code> },
    { title: "时间", dataIndex: "updatedAt", width: 140, render: (value: string) => formatTime(value) },
    { title: "baseline → candidate", width: 180, render: (_, row) => row.baseline === null || row.candidate === null ? "未知" : `${formatDecimal(row.baseline, 3)} → ${formatDecimal(row.candidate, 3)}` },
    { title: "improvement", dataIndex: "improvement", width: 120, align: "right", render: (value: number | null) => value === null ? "未知" : formatDecimal(value, 3) },
    { title: "收益分", dataIndex: "gainScore", width: 100, align: "right", render: (value: number | null) => value === null ? <Tag>不评分</Tag> : <Tag color={value === 100 ? "green" : value === 0 ? "red" : "orange"}>{formatNumber(value)}</Tag> },
    { title: "门禁", dataIndex: "gate", render: (value: string) => <Tag color={value === "accepted" ? "green" : value === "rejected-regression" ? "red" : "orange"}>{value}</Tag> },
  ];
  return <section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">运行历史</span><h2>每一次评估都可复盘</h2></div><span className="evolution-panel-count">{formatNumber(runs.length)} 次</span></header><Table size="small" rowKey="runId" pagination={{ pageSize: 6, hideOnSinglePage: true }} locale={{ emptyText: "暂无运行历史" }} columns={columns} dataSource={runs} scroll={{ x: 820 }} /></section>;
}
