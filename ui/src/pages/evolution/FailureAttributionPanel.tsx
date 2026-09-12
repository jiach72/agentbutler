import { Card, Flex, Typography } from "antd";
import { Empty } from "../../components/Empty.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import type { EvolutionOverviewPayload } from "./types.js";

const labels: Record<string, string> = {
  "environment-dependency": "环境依赖",
  runtime: "运行环境",
  dataset: "数据问题",
  engine: "引擎问题",
  target: "目标问题",
  unknown: "未知",
};

/** 影响程度 → 品牌语义 tone（阻断=error、高影响=warn、其余=中性标记）。 */
const IMPACT_TONE: Record<string, SemanticTone> = {
  blocking: "error",
  high: "warn",
  medium: "unknown",
  low: "unknown",
};

const IMPACT_LABEL: Record<string, string> = {
  blocking: "阻断",
  high: "高影响",
  medium: "一般",
  low: "轻微",
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
        <Empty mascot={false} title="当前范围还没有失败归因" />
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
              {/* 严重度用品牌语义 tone，不用 antd 预设色名——预设色由算法派生，
                  实测亮底 orange Tag 仅 3.34:1，不达 AA。 */}
              <StatusBadge
                tone={IMPACT_TONE[item.impact]}
                label={IMPACT_LABEL[item.impact]}
              />
            </Flex>
          ))}
        </Flex>
      )}
    </Card>
  );
}
