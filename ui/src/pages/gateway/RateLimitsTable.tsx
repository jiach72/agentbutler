/**
 * 消息频率观察面：调参建议 + 限流命中表（antd Table）。
 */
import { Alert, Button, Card, Empty, Flex, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatNumber, formatRelative } from "../../lib/format.js";
import { PARAM_LABELS, statusTone } from "./helpers.js";
import type { PatchSuggestion, RateLimitMatch, RateLimitView } from "./helpers.js";

interface RateLimitsTableProps {
  rateLimit: RateLimitView | null;
  onUseSuggestion: (suggestion: PatchSuggestion) => void;
}

const MATCHED_COLUMNS: TableColumnsType<RateLimitMatch> = [
  {
    title: "错误模板",
    width: 320,
    dataIndex: "template",
    render: (_, match) => (
      <Typography.Text code ellipsis={{ tooltip: match.template }} style={{ maxWidth: 280 }}>
        {match.template}
      </Typography.Text>
    ),
  },
  { title: "累计", dataIndex: "count", width: 84, align: "right", render: (value: number) => formatNumber(value) },
  {
    title: "状态",
    width: 96,
    dataIndex: "status",
    render: (_, match) => <StatusBadge {...statusTone(match.status)} />,
  },
  {
    title: "最近出现",
    width: 120,
    dataIndex: "lastSeen",
    render: (_, match) => formatRelative(match.lastSeen),
  },
];

export function RateLimitsTable({ rateLimit, onUseSuggestion }: RateLimitsTableProps) {
  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} component="h2" style={{ marginBottom: 0 }}>
        消息频率建议
      </Typography.Title>
      {rateLimit === null ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="管家服务连上后，这里会显示消息频率是否正常、是否需要调整。"
        />
      ) : (
        <>
          {rateLimit.suggestions.length === 0 ? (
            <Alert
              type="success"
              showIcon
              title="无需调整"
              description="近 24 小时没有形成需要调参的限流趋势。"
            />
          ) : (
            <Flex vertical gap={8}>
              {rateLimit.suggestions.map((suggestion) => (
                <Card size="small" key={`${suggestion.patchId}:${suggestion.param}`}>
                  <Flex wrap="wrap" justify="space-between" align="flex-start" gap={12}>
                    <div style={{ minWidth: 0 }}>
                      <Flex wrap="wrap" align="center" gap={8}>
                        <StatusBadge {...statusTone(suggestion.level)} />
                        <Typography.Text strong>
                          {PARAM_LABELS[suggestion.param] ?? suggestion.param}
                        </Typography.Text>
                        <Typography.Text type="secondary" code>
                          {suggestion.current} → {suggestion.suggested}
                        </Typography.Text>
                      </Flex>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                        {suggestion.reason}
                      </Typography.Paragraph>
                    </div>
                    <Button onClick={() => onUseSuggestion(suggestion)}>写入参数草稿</Button>
                  </Flex>
                </Card>
              ))}
            </Flex>
          )}

          {rateLimit.matched.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有发现频率相关的异常。" />
          ) : (
            <Card styles={{ body: { padding: 0 } }}>
              <Table<RateLimitMatch>
                size="small"
                rowKey="signature"
                columns={MATCHED_COLUMNS}
                dataSource={rateLimit.matched}
                scroll={{ x: 640 }}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
              />
            </Card>
          )}
        </>
      )}
    </Flex>
  );
}
