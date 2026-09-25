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

const { Text } = Typography;

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
    <header className="mb-4">
      <Flex wrap justify="space-between" align="flex-start" gap={12}>
        <div style={{ minWidth: 0 }}>
          {eyebrow !== undefined && (
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 2 }}
            >
              {eyebrow}
            </Text>
          )}
          {/* 真实 h1：字阶收敛至 20~22px (headline-md)，维持与内容卡片 1.4~1.6x 黄金视觉比 */}
          <h1
            className="text-xl md:text-2xl font-bold tracking-tight text-on-surface"
            style={{
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            {title}
          </h1>
          {description !== undefined && (
            <div className="text-xs md:text-sm text-on-surface-variant mt-1 leading-relaxed">
              {description}
            </div>
          )}
        </div>
        {extra !== undefined && <div style={{ flexShrink: 0 }}>{extra}</div>}
      </Flex>
    </header>
  );
}
