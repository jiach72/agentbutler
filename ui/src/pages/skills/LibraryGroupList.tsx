/**
 * 通用分组折叠列表：技能库与插件库共用的 Collapse 分组渲染。
 * 此前两处各写一份几乎相同的 items 构造，现合并为一个泛型组件。
 */
import { Collapse, Tag } from "antd";
import type { ReactNode } from "react";

export interface LibraryGroup<T> {
  category: string;
  items: T[];
}

interface LibraryGroupListProps<T> {
  groups: Array<LibraryGroup<T>>;
  /** 渲染单条内容；返回的元素需自带 key。 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 分组内容容器的类名（技能行列表 / 插件卡片网格）。 */
  contentClassName: string;
  defaultOpenCount?: number;
}

export function LibraryGroupList<T>({
  groups,
  renderItem,
  contentClassName,
  defaultOpenCount = 2,
}: LibraryGroupListProps<T>) {
  return (
    <Collapse
      accordion={false}
      defaultActiveKey={groups.slice(0, defaultOpenCount).map((group) => group.category)}
      items={groups.map((group) => ({
        key: group.category,
        label: (
          <span className="skill-collapse-label">
            <strong>{group.category}</strong>
            <Tag>{group.items.length} 个</Tag>
          </span>
        ),
        children: (
          <div className={contentClassName}>{group.items.map((item, index) => renderItem(item, index))}</div>
        ),
      }))}
    />
  );
}
