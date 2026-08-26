/**
 * 高级详情折叠区：专业字段默认收起，替代裸 <details>。
 * antd Collapse 自带展开态指示，修复此前「展开」文案不随状态更新的缺陷。
 */
import { Collapse } from "antd";
import type { CollapseProps } from "antd";

interface AdvancedDetailsProps {
  /** 折叠条标题，如「巡检明细」「修复方案」。 */
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultActive?: boolean;
  /** 折叠条右侧附加信息（如计数）。 */
  extra?: React.ReactNode;
}

export function AdvancedDetails({ summary, children, defaultActive = false, extra }: AdvancedDetailsProps) {
  const items: CollapseProps["items"] = [
    {
      key: "panel",
      label: (
        <span className="advanced-details-summary">
          <span>高级详情 · {summary}</span>
          {extra !== undefined && <span className="advanced-details-extra">{extra}</span>}
        </span>
      ),
      children,
    },
  ];
  return (
    <Collapse
      className="advanced-details"
      size="small"
      defaultActiveKey={defaultActive ? ["panel"] : []}
      items={items}
    />
  );
}
