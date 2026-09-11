import { Card, Empty, Flex, Tag, Typography } from "antd";
import type { EvolutionOverviewPayload } from "./types.js";

const labels: Record<string, string> = {
  "environment-dependency": "环境依赖",
  runtime: "运行环境",
  dataset: "数据问题",
  engine: "引擎问题",
  target: "目标问题",
  unknown: "未知",
};

export function FailureAttributionPanel({ items }: { items: EvolutionOverviewPayload["failures"] }) {
  return (
    <Card
      title={
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            失败归因
          </Typography.Text>
          <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
            先处理阻断项
          </Typography.Title>
        </Flex>
      }
      extra={<Typography.Text type="secondary">{items.length} 类</Typography.Text>}
    >
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有失败归因" />
      ) : (
        <Flex vertical gap={12}>
          {items.slice(0, 8).map((item, index) => (
            <Flex key={index} wrap="wrap" justify="space-between" align="flex-start" gap={12}>
              <Flex vertical gap={2} style={{ minWidth: 0 }}>
                <Typography.Text strong>{item.title}</Typography.Text>
                <Typography.Text type="secondary">
                  {labels[item.category] ?? item.category} · {item.count} 次 · {item.source}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.evidence}
                </Typography.Text>
              </Flex>
              <Tag
                color={
                  item.impact === "blocking" ? "red" : item.impact === "high" ? "orange" : "default"
                }
              >
                {item.impact === "blocking" ? "阻断" : item.impact}
              </Tag>
            </Flex>
          ))}
        </Flex>
      )}
    </Card>
  );
}
