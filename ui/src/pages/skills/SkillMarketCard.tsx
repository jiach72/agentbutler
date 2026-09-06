/**
 * 技能卡（WorkBuddy 市场风格）：头部 = 图标 + 名称 + 副标题 + 右上操作/状态；
 * 体部 = 两行简介；底部 = 左 meta / 右操作（均可选）。
 * 市场卡（SkillHub/精选/推荐）右上放「+」安装位，已安装卡右上放状态标签。
 */
import { Avatar, Card, Flex, Tag, Typography } from "antd";
import { categoryDefOf } from "./marketplace.js";
import "./marketplace.css";

const { Text } = Typography;

export interface CardStatusTag {
  text: string;
  color?: "success" | "processing" | "error" | "warning" | "default";
}

interface SkillMarketCardProps {
  name: string;
  /** 等宽副标题：来源 · 版本 / 作者等。 */
  subtitle?: string;
  description: string;
  /** 中文分类标签（决定图标与色调；无图标 URL 时的底色）。 */
  category: string;
  tags?: string[];
  /** 远程图标（SkillHub iconUrl）；缺失或加载失败回退分类色块字母。 */
  avatarUrl?: string | null;
  /** 右上角操作位（安装「+」按钮等）；优先于状态标签。 */
  action?: React.ReactNode;
  /** 右上角状态标签（已部署/未部署/有可用更新…）；action 缺省时展示。 */
  statusTag?: CardStatusTag;
  /** 底部左侧 meta（下载量/作者/更新状态）。 */
  footerLeft?: React.ReactNode;
  /** 底部右侧操作（详情/部署/更多）。 */
  footerRight?: React.ReactNode;
}

export function SkillMarketCard({
  name,
  subtitle,
  description,
  category,
  tags = [],
  avatarUrl,
  action,
  statusTag,
  footerLeft,
  footerRight,
}: SkillMarketCardProps) {
  const { icon: TileIcon, tone } = categoryDefOf(category);
  const corner = action !== undefined
    ? action
    : statusTag !== undefined && (
      <Tag color={statusTag.color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
        {statusTag.text}
      </Tag>
    );
  return (
    <Card size="small" className="skill-card wb-card" hoverable>
      <Flex vertical gap={8} style={{ height: "100%" }}>
        <Flex justify="space-between" align="flex-start" gap={8}>
          <Flex gap={10} style={{ minWidth: 0 }}>
            <Avatar
              size={38}
              shape="square"
              src={avatarUrl ?? undefined}
              className="wb-card-avatar"
              alt={name}
            >
              <span className={`skill-tile tone-${tone}`} aria-hidden="true">
                <TileIcon />
              </span>
            </Avatar>
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Text strong ellipsis style={{ fontSize: 15 }} title={name}>
                {name}
              </Text>
              {subtitle !== undefined && subtitle !== "" && (
                <Text type="secondary" className="mono" ellipsis style={{ fontSize: 11 }}>
                  {subtitle}
                </Text>
              )}
            </Flex>
          </Flex>
          {corner}
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
            style={{ marginTop: "auto", paddingTop: 4 }}
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
