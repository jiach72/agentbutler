/**
 * 实例状态卡片网格：实例概览 + 最近一次检查明细。
 */
import { useMemo } from "react";
import { Badge, Card, Col, Descriptions, Empty, Flex, Row, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import {
  CHECK_LABELS,
  checkBadge,
  formatDetail,
  formatDuration,
  instanceLabel,
  instanceRuntimeLabel,
  instanceStateLabel,
  overallBadge,
  stateDotClass,
} from "./helpers.js";
import type { InstanceView, InspectionView } from "./types.js";

const { Text } = Typography;

interface InstanceHealthCardProps {
  instances: InstanceView[];
  inspections: InspectionView[];
}

const stateDotBadgeStatus: Record<string, "success" | "error" | "warning" | "default"> = {
  up: "success",
  down: "error",
  warn: "warning",
  idle: "default",
};

export function InstanceHealthCard({ instances, inspections }: InstanceHealthCardProps) {
  const inspectionByInstance = useMemo(
    () => new Map(inspections.map((item) => [item.instanceId, item])),
    [inspections],
  );

  if (instances.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有发现可管理的实例：管家检查完成后，这里会显示状态。"
      />
    );
  }

  return (
    <Row gutter={[16, 16]}>
      {instances.map((instance) => {
        const inspection = inspectionByInstance.get(instance.instanceId) ?? null;
        const overall = overallBadge(inspection?.overall ?? null);
        const confidence = inspection?.confidence ?? instance.confidence;
        return (
          <Col xs={24} lg={12} xl={8} key={instance.instanceId}>
            <Card size="small" style={{ height: "100%" }}>
              <Flex vertical gap={8}>
                <Flex wrap="wrap" align="center" gap={8}>
                  <Badge status={stateDotBadgeStatus[stateDotClass(instance.state)]} />
                  <Text strong style={{ flex: 1, minWidth: 0 }}>
                    {instanceLabel(instance.instanceId)}
                  </Text>
                  <StatusBadge tone={overall.tone} label={overall.label} />
                </Flex>
                <Descriptions
                  size="small"
                  column={2}
                  items={[
                    { key: "state", label: "状态", children: instanceStateLabel(instance.state) },
                    { key: "runtime", label: "运行环境", children: instanceRuntimeLabel(instance.runtime) },
                    { key: "version", label: "版本", children: instance.version ?? "版本未知" },
                    { key: "confidence", label: "把握", children: `${Math.round((confidence ?? 0) * 100)}%` },
                  ]}
                />
                <Text type="secondary">
                  上次检查：{formatRelative(inspection?.ts)}
                  {inspection?.confidence !== null && inspection?.confidence !== undefined
                    ? ` · 把握 ${Math.round(inspection.confidence * 100)}%`
                    : ""}
                </Text>
                {inspection === null ? (
                  <Text type="secondary">尚无检查明细</Text>
                ) : (
                  <Flex wrap="wrap" align="center" gap={8}>
                    {inspection.checks.map((check) => {
                      const badge = checkBadge(check.status);
                      return (
                        <Flex align="center" gap={8} style={{ width: "100%" }} key={check.id}>
                          <Text style={{ flexShrink: 0 }} title={check.id}>
                            {CHECK_LABELS[check.id] ?? "其他检查"}
                          </Text>
                          <StatusBadge tone={badge.tone} label={badge.label} />
                          <span title={formatDetail(check.detail)} style={{ flex: 1, minWidth: 0 }}>
                            <Text type="secondary">{formatDetail(check.detail)}</Text>
                          </span>
                          <Text type="secondary">
                            {formatDuration(check.durationMs)}
                          </Text>
                        </Flex>
                      );
                    })}
                  </Flex>
                )}
              </Flex>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
