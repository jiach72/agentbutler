/**
 * 分类侧栏：粘性白卡 + 「全部技能」+ 固定中文分类（计数徽标）+ 底部同步说明。
 * 计数与选中态由父级传入；仅在计数 > 0 时渲染对应分类项。
 */
import { Flex, Typography } from "antd";
import {
  ALL_CATEGORY_LABEL,
  CATEGORY_ICON,
  CATEGORY_TONE,
  SKILL_CATEGORIES,
} from "./marketplace.js";
import "./marketplace.css";

const { Text } = Typography;

interface CategoryRailProps {
  /** 当前视图下的分类 → 数量映射（含「全部技能」）。 */
  counts: Record<string, number>;
  active: string;
  onSelect: (label: string) => void;
  /** 底部说明行，如「共 24 个技能 · 数据同步于本机」。 */
  footerNote?: string;
}

export function CategoryRail({ counts, active, onSelect, footerNote }: CategoryRailProps) {
  const items = [
    { label: ALL_CATEGORY_LABEL, icon: CATEGORY_ICON, tone: CATEGORY_TONE, count: counts[ALL_CATEGORY_LABEL] ?? 0 },
    ...SKILL_CATEGORIES.filter((category) => (counts[category.label] ?? 0) > 0).map((category) => ({
      label: category.label,
      icon: category.icon,
      tone: category.tone,
      count: counts[category.label] ?? 0,
    })),
  ];
  return (
    <aside className="skills-category-rail" style={{ width: 200, flexShrink: 0 }} aria-label="技能分类导航">
      <div
        style={{
          background: "var(--ant-color-bg-container, #fff)",
          border: "1px solid var(--ant-color-border-secondary, #e5e6eb)",
          borderRadius: 10,
          padding: 8,
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--ant-color-border-secondary, #e5e6eb)",
            marginBottom: 8,
          }}
        >
          <Text strong style={{ fontSize: 13 }}>
            全部分类
          </Text>
        </div>
        <Flex vertical gap={2}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => onSelect(item.label)}
                aria-pressed={active === item.label}
                className={`rail-item${active === item.label ? " active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  borderRadius: 6,
                  padding: "8px 12px",
                  cursor: "pointer",
                  color: "var(--ant-color-text, #1d2129)",
                  font: "inherit",
                  textAlign: "left",
                }}
              >
                <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                  <Icon style={{ color: "inherit", fontSize: 15, flexShrink: 0 }} />
                  <Text style={{ fontSize: 14, color: "inherit" }} ellipsis>
                    {item.label}
                  </Text>
                </Flex>
                <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {item.count}
                </Text>
              </button>
            );
          })}
        </Flex>
        {footerNote !== undefined && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--ant-color-fill-quaternary, #f9fafb)",
              fontSize: 11,
              lineHeight: 1.6,
              color: "var(--ant-color-text-tertiary, #86909c)",
            }}
          >
            {footerNote}
          </div>
        )}
      </div>
    </aside>
  );
}
