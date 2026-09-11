import { Card, Descriptions, Flex, Progress, Tag, Typography } from "antd";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionDatasetPanel({ dataset }: { dataset: EvolutionOverviewPayload["datasets"] }) {
  const percent = Math.min(
    100,
    Math.round((dataset.realSamples / Math.max(1, dataset.realSamples + dataset.gap)) * 100),
  );
  return (
    <Card
      title={
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            数据资产
          </Typography.Text>
          <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
            {dataset.dataset} · {dataset.version}
          </Typography.Title>
        </Flex>
      }
      extra={
        <Tag color={dataset.formalReady ? "green" : "orange"}>
          {dataset.formalReady ? "可正式评估" : "样本不足"}
        </Tag>
      }
    >
      <Flex vertical gap={16}>
        <Progress
          percent={percent}
          format={() => `${dataset.realSamples} / ${dataset.realSamples + dataset.gap} 条真实样本`}
        />
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="正样本">{dataset.positiveSamples}</Descriptions.Item>
          <Descriptions.Item label="负样本">{dataset.negativeSamples}</Descriptions.Item>
          <Descriptions.Item label="Holdout">
            {dataset.holdoutCount} / {dataset.requiredHoldout}
          </Descriptions.Item>
          <Descriptions.Item label="数据完整度">{dataset.completeness}</Descriptions.Item>
          <Descriptions.Item label="最近采集">
            {dataset.lastCollectedAt ?? "未知"}
          </Descriptions.Item>
          <Descriptions.Item label="重复率">
            {dataset.duplicateRate === null
              ? "未知"
              : `${Math.round(dataset.duplicateRate * 100)}%`}
          </Descriptions.Item>
        </Descriptions>
      </Flex>
    </Card>
  );
}
