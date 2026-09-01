import { Button, Card, Empty, Flex, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { formatTime } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionActionQueue({
  items,
  busy,
  onRecheck,
}: {
  items: EvolutionOverviewPayload["actionItems"];
  busy?: string | null;
  onRecheck: (id: string) => void;
}) {
  const open = items.filter((item) => item.status !== "resolved" && item.status !== "ignored");
  return (
    <Card
      title={
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            行动清单
          </Typography.Text>
          <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
            下一步做什么
          </Typography.Title>
        </Flex>
      }
      extra={<Typography.Text type="secondary">{open.length} 待处理</Typography.Text>}
    >
      {open.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待处理事项" />
      ) : (
        <Flex vertical gap={12}>
          {open.slice(0, 6).map((item) => (
            <Flex key={item.actionId} wrap="wrap" justify="space-between" align="center" gap={12}>
              <Flex vertical gap={2} style={{ minWidth: 0 }}>
                <Typography.Text strong>{item.title}</Typography.Text>
                <Flex wrap="wrap" align="center" gap={4}>
                  <Tag color={item.impact === "blocking" ? "red" : "orange"}>
                    {item.impact === "blocking" ? "阻断进化" : "建议处理"}
                  </Tag>
                  <Typography.Text type="secondary">
                    {item.occurrences} 次 · 最近 {formatTime(item.lastSeenAt)}
                  </Typography.Text>
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.nextAction}
                </Typography.Text>
              </Flex>
              <Button
                icon={<ReloadOutlined />}
                loading={busy === item.actionId}
                onClick={() => onRecheck(item.actionId)}
              >
                重新检查
              </Button>
            </Flex>
          ))}
        </Flex>
      )}
    </Card>
  );
}
