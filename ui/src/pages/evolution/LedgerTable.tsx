/**
 * 进化页历史记录：改进台账表格（含导出）与能力边界说明，收进 AdvancedDetails。
 */
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatTime } from "../../lib/format.js";
import type { LedgerEntry } from "./helpers.js";
import { dispositionLabel, formatMetric, outcomeTone, statusLabel } from "./helpers.js";

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
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>评估</th>
              <th>结论</th>
              <th>结果</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.runId}>
                <td>
                  <strong>{entry.runId.slice(0, 8)}</strong>
                  <span>{formatTime(entry.updatedAt)}</span>
                </td>
                <td className="is-mono">{formatMetric(entry)}</td>
                <td>
                  <StatusBadge
                    tone={outcomeTone(entry.status)}
                    label={statusLabel(entry.status)}
                  />
                </td>
                <td>
                  <StatusBadge
                    tone={outcomeTone(entry.disposition)}
                    label={dispositionLabel(entry.disposition)}
                  />
                </td>
                <td>
                  <a href={`/api/evolution/ledger/${encodeURIComponent(entry.runId)}/export`} download>
                    导出
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ledger.length === 0 && (
          <div className="evolution-empty">
            还没有改进记录；完成一次检查和评估后，这里会生成可导出的记录。
          </div>
        )}
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
