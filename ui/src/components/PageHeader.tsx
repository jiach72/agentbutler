/**
 * 页面标题头：eyebrow 小标签 + 主标题 + 可选描述/附加操作。
 * 全站唯一的 h1 出口（Title component="h1" 保证真实语义），
 * 样式全部走 antd Token，不依赖旧页面 CSS。
 *
 * 【eyebrow 以路由元信息为真源（评审 P1-9）】
 * 分组名只在 lib/routeMeta.ts 里写一次，本组件按当前路径推导。
 * 此前各页手写 eyebrow，出现过「核心文件在侧栏归维护与升级、页内却写控制台」
 * 这类导航与页面互相矛盾的情况；传进来的 eyebrow 只作为非路由面板的兜底。
 */
import { Flex, Typography } from "antd";
import { useLocation } from "react-router-dom";
import { eyebrowFor } from "../lib/routeMeta.js";

const { Paragraph, Text, Title } = Typography;

interface PageHeaderProps {
  /** 页面所属区域的小标签；路由页面无需传，按当前路径自动推导。 */
  eyebrow?: string;
  /** 页面主标题，渲染为真实 h1（字号跟随 Title level 3）。 */
  title: string;
  /** 标题下方的一句说明。 */
  description?: React.ReactNode;
  /** 标题右侧附加内容（状态徽标、操作按钮等）。 */
  extra?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, description, extra }: PageHeaderProps) {
  const location = useLocation();
  const resolvedEyebrow = eyebrowFor(location.pathname) ?? eyebrow;
  return (
    <header>
      <Flex wrap justify="space-between" align="flex-start" gap={16}>
        <div style={{ minWidth: 0 }}>
          {resolvedEyebrow !== undefined && (
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              {resolvedEyebrow}
            </Text>
          )}
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
