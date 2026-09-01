/**
 * 版本页 · 当前使用的版本：受管实例卡片栅格。
 * 卡片/描述列表走 antd 原语，状态仍由 StatusBadge 呈现。
 */
import { Card, Col, Descriptions, Empty, Flex, Row, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { instanceLabel, instanceRuntimeLabel, instanceStateLabel, stateBadge } from "./helpers.js";
import type { InstanceView } from "./types.js";

const { Text, Title } = Typography;

interface ManagedInstancesProps {
  instances: InstanceView[];
}

export function ManagedInstances({ instances }: ManagedInstancesProps) {
  if (instances.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有发现可管理的管家。扫描完成后，这里会显示它当前使用的版本。"
      />
    );
  }
  return (
    <Row gutter={[16, 16]}>
      {instances.map((instance) => {
        const badge = stateBadge(instance.state);
        return (
          <Col xs={24} sm={12} lg={8} key={instance.instanceId}>
            <Card size="small">
              <Flex justify="space-between" align="flex-start" gap={12}>
                <div style={{ minWidth: 0 }}>
                  <Text
                    type="secondary"
                    style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
                  >
                    受管 Hermes / OpenClaw
                  </Text>
                  <Title level={5} style={{ marginBottom: 0 }}>
                    {instanceLabel(instance.instanceId)}
                  </Title>
                </div>
                <StatusBadge tone={badge.tone} label={badge.label} />
              </Flex>
              <Descriptions
                column={1}
                size="small"
                style={{ marginTop: 12 }}
                items={[
                  { key: "version", label: "当前版本", children: instance.version ?? "版本未知" },
                  { key: "runtime", label: "运行位置", children: instanceRuntimeLabel(instance.runtime) },
                  {
                    key: "id",
                    label: "内部编号",
                    children: <Text type="secondary" ellipsis>{instance.instanceId}</Text>,
                  },
                  { key: "state", label: "当前状态", children: instanceStateLabel(instance.state) },
                ]}
              />
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
