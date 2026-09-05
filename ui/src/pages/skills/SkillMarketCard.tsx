/**
 * 技能卡：市场 / 已安装两个视图共用的瀑布流卡片。
 * 头部 = 分类色图标 + 名称 + 等宽 id·来源 + 右上状态标签；
 * 体部 = 两行简介 + 标签；底部 = 左 meta / 右操作（由父级组装）。
 */
import { Card, Flex, Tag, Typography } from "antd";
import { categoryDefOf } from "./marketplace.js";
import "./marketplace.css";

const { Text } = Typography;

export interface CardStatusTag {
  text: string;
  color?: "success" | "processing" | "error" | "warning" | "default";
}

interface SkillMarketCardProps {
  name: string;
  /** 等宽副标题：技能 id · 来源。 */
  subtitle: string;
  description: string;
  /** 中文分类标签（决定图标与色调）。 */
  category: string;
  tags: string[];
  /** 右上角状态标签（已部署/未部署/本机运行中/有可用更新/已安装…）。 */
  statusTag?: CardStatusTag;
  /** 底部左侧 meta（作者/安装量/更新状态/最近使用）。 */
  footerLeft?: React.ReactNode;
  /** 底部右侧操作（安装/部署/详情/更多）。 */
  footerRight?: React.ReactNode;
}

export function SkillMarketCard({
  name,
  subtitle,
  description,
  category,
  tags,
  statusTag,
  footerLeft,
  footerRight,
}: SkillMarketCardProps) {
  const { icon: TileIcon, tone } = categoryDefOf(category);
  return (
    <Card size="small" className="skill-card" hoverable>
      <Flex vertical gap={10}>
        <Flex justify="space-between" align="flex-start" gap={8}>
          <Flex gap={10} style={{ minWidth: 0 }}>
            <span className={`skill-tile tone-${tone}`} aria-hidden="true">
              <TileIcon />
            </span>
            <Flex vertical gap={1} style={{ minWidth: 0 }}>
              <Text strong ellipsis style={{ fontSize: 15 }}>
                {name}
              </Text>
              <Text type="secondary" className="mono" ellipsis style={{ fontSize: 11 }}>
                {subtitle}
              </Text>
            </Flex>
          </Flex>
          {statusTag !== undefined && (
            <Tag color={statusTag.color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
              {statusTag.text}
            </Tag>
          )}
        </Flex>
        <Text type="secondary" className="skill-card-desc" style={{ fontSize: 13 }}>
          {description}
        </Text>
        {tags.length > 0 && (
          <Flex gap={4} wrap="wrap">
            {tags.slice(0, 3).map((tag) => (
              <Tag key={tag} style={{ marginInlineEnd: 0 }}>
                {tag}
              </Tag>
            ))}
          </Flex>
        )}
        {(footerLeft !== undefined || footerRight !== undefined) && (
          <Flex
            justify="space-between"
            align="center"
            gap={8}
            wrap="wrap"
            style={{ borderTop: "1px solid var(--ant-color-border-secondary, #e5e6eb)", paddingTop: 10, marginTop: "auto" }}
          >
            <div style={{ minWidth: 0 }}>{footerLeft}</div>
            <Flex align="center" gap={6} wrap="wrap" style={{ flexShrink: 0 }}>
              {footerRight}
            </Flex>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
