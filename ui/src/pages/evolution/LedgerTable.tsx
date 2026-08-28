/**
 * 进化页历史记录：改进台账表格（含导出）与能力边界说明，收进 AdvancedDetails。
 */
import { Table } from "antd";
import type { TableColumnsType } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatTime } from "../../lib/format.js";
import type { LedgerEntry } from "./helpers.js";
import { dispositionLabel, formatMetric, outcomeTone, statusLabel } from "./helpers.js";

const LEDGER_COLUMNS: TableColumnsType<LedgerEntry> = [
  {
    title: "时间",
    render: (_, entry) => (
      <div className="ledger-time-cell">
        <strong>{entry.runId.slice(0, 8)}</strong>
        <span>{formatTime(entry.updatedAt)}</span>
      </div>
    ),
  },
  {
    title: "评估",
    width: 160,
    render: (_, entry) => <span className="is-mono">{formatMetric(entry)}</span>,
  },
  {
    title: "结论",
    width: 120,
    render: (_, entry) => (
      <StatusBadge tone={outcomeTone(entry.status)} label={statusLabel(entry.status)} />
    ),
  },
  {
    title: "结果",
    width: 120,
    render: (_, entry) => (
      <StatusBadge tone={outcomeTone(entry.disposition)} label={dispositionLabel(entry.disposition)} />
    ),
  },
  {
    title: "",
    width: 70,
    render: (_, entry) => (
      <a
        className="ledger-export-link"
        href={`/api/evolution/ledger/${encodeURIComponent(entry.runId)}/export`}
        download
      >
        导出
      </a>
    ),
  },
];

export function LedgerTable({ ledger }: { ledger: LedgerEntry[] }) {
  return (
    <AdvancedDetails
      summary={
        <span>
          <strong>查看历史记录</strong>
          <small>每次检查、评估和结果的完整记录</small>
        </span>
      }
      extra={ledger.length > 0 ? `${ledger.length} 条` : undefined}
    >
      <div className="evolution-ledger-table">
        <Table<LedgerEntry>
          size="small"
          rowKey="runId"
          pagination={false}
          dataSource={ledger}
          locale={{ emptyText: "还没有改进记录；完成一次检查和评估后，这里会生成可导出的记录。" }}
          columns={LEDGER_COLUMNS}
        />
      </div>

      <div className="evolution-scope-note">
        <span>目前能做到</span>
        <p>
          当前会先检查运行依赖、模型连接和测试样本，再备份并确认改进结果。运行中挂死监测、
          兼容性检查、模型档案和统计检验还没有完成，不会伪装成已支持。
        </p>
      </div>
    </AdvancedDetails>
  );
}
