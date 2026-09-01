/**
 * 通用分组折叠列表：技能库与插件库共用的 Collapse 分组渲染。
 * 此前两处各写一份几乎相同的 items 构造，现合并为一个泛型组件。
 */
import { Collapse, Flex, Tag } from "antd";
import type { ReactNode } from "react";

export interface LibraryGroup<T> {
  category: string;
  items: T[];
}

interface LibraryGroupListProps<T> {
  groups: Array<LibraryGroup<T>>;
  /** 渲染单条内容；返回的元素需自带 key。 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 默认展开前 N 组（0 表示全部折叠）。 */
  defaultOpenCount?: number;
}

export function LibraryGroupList<T>({
  groups,
  renderItem,
  defaultOpenCount = 0,
}: LibraryGroupListProps<T>) {
  return (
    <Collapse
      accordion={false}
      defaultActiveKey={groups.slice(0, defaultOpenCount).map((group) => group.category)}
      items={groups.map((group) => ({
        key: group.category,
        label: (
          <Flex align="center" gap={8}>
            <span style={{ fontWeight: 600 }}>{group.category}</span>
            <Tag>{group.items.length} 个</Tag>
          </Flex>
        ),
        children: <div>{group.items.map((item, index) => renderItem(item, index))}</div>,
      }))}
    />
  );
}
