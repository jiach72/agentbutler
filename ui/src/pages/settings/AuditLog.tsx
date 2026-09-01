/**
 * 设置页操作记录面板：管家历史操作的只读时间线。
 * 审计数据独立三态，失败时显示降级横幅与重试。
 */
import { Button, Empty, Flex, Spin, Timeline, Typography } from "antd";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { formatTime } from "../../lib/format.js";
import type { FetchState } from "../../lib/api.js";
import {
  actorLabel,
  auditActionLabel,
  type AuditPayload,
  DEGRADED_TEXT,
} from "./helpers.js";

const { Text } = Typography;

interface AuditLogProps {
  audit: FetchState<AuditPayload>;
  onRetry: () => void;
}

export function AuditLog({ audit, onRetry }: AuditLogProps) {
  return (
    <section>
      <Flex vertical gap={12}>
        <SectionHeader compact kicker="操作记录" title="管家做过的操作" />
        {audit.status === "ready" && audit.data.items.length > 0 && (
          <Timeline
            items={audit.data.items.slice(0, 10).map((item) => ({
              key: item.id,
              children: (
                <div title={item.target}>
                  <Text strong>
                    {actorLabel(item.actor)} · {auditActionLabel(item.action)}
                  </Text>
                  <br />
                  <Text type="secondary">{formatTime(item.ts)}</Text>
                </div>
              ),
            }))}
          />
        )}
        {audit.status === "loading" && (
          <Flex align="center" gap={8}>
            <Spin size="small" />
            <Text type="secondary">正在读取操作记录…</Text>
          </Flex>
        )}
        {audit.status === "failed" && (
          <DegradedBanner
            severity="warn"
            message={DEGRADED_TEXT}
            description={audit.reason}
            action={
              <Button onClick={onRetry}>
                重试
              </Button>
            }
          />
        )}
        {audit.status === "ready" && audit.data.items.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有操作记录；管家每次操作都会记在这里。"
          />
        )}
      </Flex>
    </section>
  );
}
