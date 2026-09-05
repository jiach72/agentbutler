import { Button, Card, Col, Flex, Row, Segmented, Space, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import type { EvolutionOverviewPayload } from "./types.js";
import { EvolutionScoreStrip } from "./EvolutionScoreStrip.js";
import { EvolutionCharts } from "./EvolutionCharts.js";
import { FailureAttributionPanel } from "./FailureAttributionPanel.js";
import { EvolutionActionQueue } from "./EvolutionActionQueue.js";
import { EvolutionDatasetPanel } from "./EvolutionDatasetPanel.js";
import { EvolutionRunHistory } from "./EvolutionRunHistory.js";

export function EvolutionOverview({ overview, range, onRangeChange, onRefresh, onAnalyze, busy, onRecheck }: { overview: EvolutionOverviewPayload | null; range: "24h" | "7d" | "30d"; onRangeChange: (range: "24h" | "7d" | "30d") => void; onRefresh: () => void; onAnalyze: () => void; busy?: string | null; onRecheck: (id: string) => void }) {
  if (!overview) return null;
  return (
    <Flex vertical gap={16}>
      <Flex wrap="wrap" justify="space-between" align="flex-start" gap={16}>
        <Flex vertical gap={2} style={{ minWidth: 0 }}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            运营工作台
          </Typography.Text>
          <Typography.Title level={4} component="h2" style={{ marginBottom: 0 }}>
            自进化运行状态
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            用观测数据判断稳定性、进化收益和下一步行动。
          </Typography.Paragraph>
        </Flex>
        <Space wrap>
          <ConnectionChip
            reachable={overview.status !== "offline"}
            onlineText={`实例 ${overview.instanceId ?? "未知"}`}
            offlineText="管家服务离线"
          />
          <Segmented
            value={range}
            onChange={(value) => onRangeChange(value as "24h" | "7d" | "30d")}
            options={[
              { value: "24h", label: "24 小时" },
              { value: "7d", label: "7 天" },
              { value: "30d", label: "30 天" },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button>
          <Button type="primary" onClick={onAnalyze} loading={busy === "analyze"}>重新分析</Button>
        </Space>
      </Flex>
      <Flex wrap="wrap" gap={16}>
        <Typography.Text type="secondary">最近分析：{overview.analyzedAt}</Typography.Text>
        <Typography.Text type="secondary">数据来源：{overview.source}</Typography.Text>
        <Typography.Text type="secondary">{overview.completeness.note}</Typography.Text>
      </Flex>
      <EvolutionScoreStrip overview={overview} />
      <EvolutionCharts overview={overview} />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <FailureAttributionPanel items={overview.failures} />
        </Col>
        <Col xs={24} xl={12}>
          <EvolutionActionQueue items={overview.actionItems} busy={busy} onRecheck={onRecheck} />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <EvolutionDatasetPanel dataset={overview.datasets} />
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title={
              <Flex vertical gap={2}>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
                >
                  引擎摘要
                </Typography.Text>
                <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
                  评估是否有效
                </Typography.Title>
              </Flex>
            }
          >
            <Flex vertical gap={4}>
              <Typography.Text strong>{overview.evolution.runCount} 次运行</Typography.Text>
              <Typography.Text type="secondary">
                完成 {overview.evolution.completedRuns} 次 · 成功 {overview.evolution.successfulRuns} 次 · 运行成功率 {overview.evolution.successRate === null ? "未知" : `${Math.round(overview.evolution.successRate * 100)}%`}
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {overview.evolution.latest?.detail ?? "还没有进化运行"}
              </Typography.Paragraph>
            </Flex>
          </Card>
        </Col>
      </Row>
      <EvolutionRunHistory runs={overview.runs} />
    </Flex>
  );
}
