/**
 * 版本页 · 升级前检查：结构化清单 / 纯文本明细 / 静态说明三种形态。
 */
import { Flex, List, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { precheckBadge, STATIC_PRECHECKS, stepBadge } from "./helpers.js";
import type { PrecheckDetail, UpgradeStepView } from "./types.js";

const { Text } = Typography;

interface PrecheckListProps {
  step: UpgradeStepView | null;
  precheck: PrecheckDetail;
}

export function PrecheckList({ step, precheck }: PrecheckListProps) {
  if (step !== null && precheck.items.length > 0) {
    return (
      <List
        size="small"
        dataSource={precheck.items}
        renderItem={(item) => {
          const badge = precheckBadge(item.status);
          return (
            <List.Item>
              <Flex align="center" gap={12} style={{ width: "100%" }}>
                <Text strong style={{ flexShrink: 0 }}>
                  {item.id}
                </Text>
                <StatusBadge tone={badge.tone} label={badge.label} />
                <Text
                  type="secondary"
                  title={item.detail ?? undefined}
                  style={{ marginLeft: "auto", textAlign: "right" }}
                >
                  {item.detail ?? "—"}
                </Text>
              </Flex>
            </List.Item>
          );
        }}
      />
    );
  }
  if (step !== null && precheck.lines.length > 0) {
    return <Text type="secondary">{precheck.lines.join("；")}</Text>;
  }
  if (step !== null) {
    const badge = stepBadge(step.status);
    return (
      <List size="small">
        <List.Item>
          <Flex align="center" gap={12} style={{ width: "100%" }}>
            <Text strong style={{ flexShrink: 0 }}>
              升级前检查
            </Text>
            <StatusBadge tone={badge.tone} label={badge.label} />
            <Text type="secondary" style={{ marginLeft: "auto", textAlign: "right" }}>
              暂未返回明细
            </Text>
          </Flex>
        </List.Item>
      </List>
    );
  }
  return (
    <Flex vertical gap={8}>
      <List
        size="small"
        dataSource={STATIC_PRECHECKS}
        renderItem={(name) => (
          <List.Item>
            <Flex align="center" gap={12} style={{ width: "100%" }}>
              <Text strong>{name}</Text>
              <StatusBadge tone="muted" label="待检" />
            </Flex>
          </List.Item>
        )}
      />
      <Text type="secondary">不需要你手动操作；管家会在升级前自动检查。</Text>
    </Flex>
  );
}
