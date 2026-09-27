/**
 * 版本页 · 升级前检查：结构化清单 / 纯文本明细 / 静态说明三种形态。
 */
import { Flex, Typography } from "antd";
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
      <Flex vertical gap={6} className="divide-y divide-outline-variant/10">
        {precheck.items.map((item, idx) => {
          const badge = precheckBadge(item.status);
          return (
            <Flex
              key={item.id}
              align="center"
              gap={12}
              style={{ width: "100%" }}
              className={idx > 0 ? "pt-2" : undefined}
            >
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
          );
        })}
      </Flex>
    );
  }
  if (step !== null && precheck.lines.length > 0) {
    return <Text type="secondary">{precheck.lines.join("；")}</Text>;
  }
  if (step !== null) {
    const badge = stepBadge(step.status);
    return (
      <Flex align="center" gap={12} style={{ width: "100%" }}>
        <Text strong style={{ flexShrink: 0 }}>
          升级前检查
        </Text>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <Text type="secondary" style={{ marginLeft: "auto", textAlign: "right" }}>
          暂未返回明细
        </Text>
      </Flex>
    );
  }
  return (
    <Flex vertical gap={8}>
      <Flex vertical gap={6} className="divide-y divide-outline-variant/10">
        {STATIC_PRECHECKS.map((name, idx) => (
          <Flex
            key={name}
            align="center"
            gap={12}
            style={{ width: "100%" }}
            className={idx > 0 ? "pt-2" : undefined}
          >
            <Text strong>{name}</Text>
            <StatusBadge tone="unknown" label="待检" />
          </Flex>
        ))}
      </Flex>
      <Text type="secondary">不需要你手动操作；管家会在升级前自动检查。</Text>
    </Flex>
  );
}
