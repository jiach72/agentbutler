/**
 * 区块标题：kicker 小标签 + 区块标题 + 右侧附加插槽。
 * 统一替代各页此前手写的 settings-section-head / preferences-section-head
 * 组合；样式走 antd Typography Token，不依赖旧页面 CSS。
 */
import { Flex, Typography } from "antd";

const { Text, Title } = Typography;

interface SectionHeaderProps {
  /** 区块所属分组的小标签，如「本机安全」「迁移助手」。 */
  kicker: string;
  /** 区块标题。 */
  title: string;
  /** 紧凑模式（子区块）：标题降为 h3，与顶层 h2 区分层级。 */
  compact?: boolean;
  /** 标题右侧附加内容（状态徽标、操作按钮等）。 */
  extra?: React.ReactNode;
}

export function SectionHeader({ kicker, title, compact = false, extra }: SectionHeaderProps) {
  return (
    <Flex wrap justify="space-between" align="flex-start" gap={16}>
      <div style={{ minWidth: 0 }}>
        <Text
          type="secondary"
          style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
        >
          {kicker}
        </Text>
        {compact ? (
          <Title level={5} component="h3" style={{ marginBottom: 0 }}>
            {title}
          </Title>
        ) : (
          <Title level={4} component="h2" style={{ marginBottom: 0 }}>
            {title}
          </Title>
        )}
      </div>
      {extra !== undefined && <div style={{ flexShrink: 0 }}>{extra}</div>}
    </Flex>
  );
}
