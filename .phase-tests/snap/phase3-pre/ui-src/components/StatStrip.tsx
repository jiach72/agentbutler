/**
 * 统计条：全站统一的「市场风」概览统计卡（图标 + 数值 + 单位 + 状态标签 + 副注 + 动作）。
 * 替代各页手写的 Statistic/Flex 统计横排；Col 弹性换行，窄屏自动降列。
 */
import { Card, Col, Flex, Row, Tag, Typography } from "antd";
import type { ComponentType, ReactNode } from "react";

const { Text } = Typography;

/** 图标组件：antd Outlined 图标（AntdIconProps 的结构随版本变化，这里放宽为任意 props 组件）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StatStripIcon = ComponentType<any>;

export interface StatStripItem {
  key: string;
  /** 统计名，如「今日送达」。 */
  label: string;
  /** 大号数值（数字或短文本，如「已开启」）。 */
  value: ReactNode;
  /** 数值后的单位小字，如「条」「个」。 */
  unit?: string;
  /** 图标（@ant-design/icons Outlined 组件引用）。 */
  icon?: StatStripIcon;
  /** 数值语义色调；缺省用正文色。 */
  tone?: "ok" | "info" | "warn" | "error";
  /** 数值旁的状态标签。 */
  tag?: { text: string; color?: "success" | "processing" | "error" | "warning" | "default" };
  /** 数值下方的一行副注（状态说明/时间）。 */
  sub?: ReactNode;
  /** 卡片底部动作区（直达链接/按钮）。 */
  action?: ReactNode;
  /** 附加到卡片的类名（供页面级样式或测试定位）。 */
  className?: string;
}

const TONE_COLOR: Record<NonNullable<StatStripItem["tone"]>, string> = {
  ok: "var(--ant-color-success, #52c41a)",
  info: "var(--ant-color-primary, #2f54eb)",
  warn: "var(--ant-color-warning, #faad14)",
  error: "var(--ant-color-error, #ff4d4f)",
};

export function StatStrip({ items }: { items: StatStripItem[] }) {
  return (
    <Row gutter={[16, 16]} aria-label="概览统计">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Col flex="1 1 220px" key={item.key} className={item.className}>
            <Card size="small" style={{ height: "100%" }}>
              <Flex vertical gap={4} style={{ height: "100%" }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {Icon !== undefined && <Icon style={{ marginInlineEnd: 6 }} aria-hidden="true" />}
                  {item.label}
                </Text>
                <Flex align="baseline" gap={6} wrap="wrap">
                  <span
                    style={{
                      fontSize: 24,
                      fontWeight: 600,
                      lineHeight: 1.2,
                      color: item.tone === undefined ? undefined : TONE_COLOR[item.tone],
                    }}
                  >
                    {item.value}
                  </span>
                  {item.unit !== undefined && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.unit}
                    </Text>
                  )}
                  {item.tag !== undefined && (
                    <Tag color={item.tag.color} style={{ marginInlineEnd: 0 }}>
                      {item.tag.text}
                    </Tag>
                  )}
                </Flex>
                {item.sub !== undefined && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {item.sub}
                  </Text>
                )}
                {item.action !== undefined && (
                  <Flex style={{ marginTop: "auto", paddingTop: 4 }}>{item.action}</Flex>
                )}
              </Flex>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
