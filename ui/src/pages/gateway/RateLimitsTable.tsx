/**
 * 消息频率观察面：调参建议 + 限流命中表（antd Table）。
 */
import { Table } from "antd";
import type { TableColumnsType } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { PARAM_LABELS, statusTone } from "./helpers.js";
import type { PatchSuggestion, RateLimitMatch, RateLimitView } from "./helpers.js";

interface RateLimitsTableProps {
  rateLimit: RateLimitView | null;
  onUseSuggestion: (suggestion: PatchSuggestion) => void;
}

const MATCHED_COLUMNS: TableColumnsType<RateLimitMatch> = [
  {
    title: "错误模板",
    dataIndex: "template",
    render: (_, match) => (
      <div className="fp-sample" title={match.template}>
        {match.template}
      </div>
    ),
  },
  { title: "累计", dataIndex: "count" },
  {
    title: "状态",
    dataIndex: "status",
    render: (_, match) => <StatusBadge {...statusTone(match.status)} />,
  },
  {
    title: "最近出现",
    dataIndex: "lastSeen",
    render: (_, match) => formatRelative(match.lastSeen),
  },
];

export function RateLimitsTable({ rateLimit, onUseSuggestion }: RateLimitsTableProps) {
  return (
    <>
      <h2 className="section-title">消息频率建议</h2>
      {rateLimit === null ? (
        <div className="empty-state">
          管家服务连上后，这里会显示消息频率是否正常、是否需要调整。
        </div>
      ) : (
        <>
          {rateLimit.suggestions.length === 0 ? (
            <div className="gateway-quiet-state">
              <StatusBadge tone="ok" label="无需调整" />
              <span>近 24 小时没有形成需要调参的限流趋势。</span>
            </div>
          ) : (
            <div className="gateway-suggestions">
              {rateLimit.suggestions.map((suggestion) => (
                <div
                  className="gateway-suggestion"
                  key={`${suggestion.patchId}:${suggestion.param}`}
                >
                  <div>
                    <div className="gateway-suggestion-title">
                      <StatusBadge {...statusTone(suggestion.level)} />
                      <strong>{PARAM_LABELS[suggestion.param] ?? suggestion.param}</strong>
                      <span className="gateway-value-change">
                        {suggestion.current} → {suggestion.suggested}
                      </span>
                    </div>
                    <p>{suggestion.reason}</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onUseSuggestion(suggestion)}
                  >
                    写入参数草稿
                  </button>
                </div>
              ))}
            </div>
          )}

          {rateLimit.matched.length === 0 ? (
            <div className="empty-state gateway-spaced">暂时没有发现频率相关的异常。</div>
          ) : (
            <div className="card table-card gateway-spaced">
              <Table<RateLimitMatch>
                size="small"
                rowKey="signature"
                columns={MATCHED_COLUMNS}
                dataSource={rateLimit.matched}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
