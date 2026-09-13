/**
 * 页面标题头：主标题（真实 h1）+ 可选描述/附加操作。
 * 全站唯一的 h1 出口（Title component="h1" 保证真实语义）。
 *
 * 【eyebrow 只在显式传入时渲染（shell-ux 测试守卫）】
 * 分组名已经在侧栏导航里可见——页头再自动重复一遍就是同一句话写两遍
 * （导航写着「日常使用」，页头小标签又是「日常使用」）。路由页一律不自动
 * 派生 eyebrow；只有非路由面板想标注业务上下文时才显式传入。
 */
import { Flex, Typography } from "antd";

const { Paragraph, Text } = Typography;

interface PageHeaderProps {
  /** 非路由面板显式标注业务上下文的小标签；路由页面不要传。 */
  eyebrow?: string;
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
          {eyebrow !== undefined && (
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", marginBottom: 2 }}
            >
              {eyebrow}
            </Text>
          )}
          {/* 真实 h1（antd Title component 属性在 v6 不生效，实际渲染 h3——
              全站会没有 h1 供读屏/浏览器跳转；这里用原生 h1 + 标题级样式）。 */}
          <h1
            style={{
              margin: 0,
              fontSize: "var(--ant-font-size-heading-3, 20px)",
              fontWeight: 600,
              lineHeight: 1.35,
              color: "var(--ant-color-text-heading, inherit)",
            }}
          >
            {title}
          </h1>
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
