/**
 * 页面标题头：eyebrow 小标签 + 主标题 + 可选描述/附加操作。
 * 全站唯一的 h1 出口（Title component="h1" 保证真实语义），
 * 样式全部走 antd Token，不依赖旧页面 CSS。
 */
import { Flex, Typography } from "antd";

const { Paragraph, Text, Title } = Typography;

interface PageHeaderProps {
  /** 页面所属区域的小标签，如「首页」「系统日志」。 */
  eyebrow: string;
  /** 页面主标题，渲染为真实 h1（字号跟随 Title level 3）。 */
  title: string;
  /** 标题下方的一句说明。 */
  description?: React.ReactNode;
  /** 标题右侧附加内容（状态徽标、操作按钮等）。 */
  extra?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, description, extra }: PageHeaderProps) {
  return (
    <header>
      <Flex wrap justify="space-between" align="flex-start" gap={16}>
        <div style={{ minWidth: 0 }}>
          <Text
            type="secondary"
            style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            {eyebrow}
          </Text>
          <Title level={3} component="h1" style={{ marginBottom: 0 }}>
            {title}
          </Title>
          {description !== undefined && (
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {description}
            </Paragraph>
          )}
        </div>
        {extra !== undefined && <div style={{ flexShrink: 0 }}>{extra}</div>}
      </Flex>
    </header>
  );
}
