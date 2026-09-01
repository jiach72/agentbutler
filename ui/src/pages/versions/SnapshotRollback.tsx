/**
 * 版本页 · 退回上一版本：最近一次可用的升级前快照。
 */
import { Button, Empty, Flex, Typography } from "antd";
import { formatRelative } from "../../lib/format.js";
import { instanceLabel } from "./helpers.js";
import type { SnapshotView } from "./types.js";

const { Text } = Typography;

interface SnapshotRollbackProps {
  snapshot: SnapshotView | null;
  onRollback: (snapshot: SnapshotView) => void;
}

export function SnapshotRollback({ snapshot, onRollback }: SnapshotRollbackProps) {
  if (snapshot === null) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有上一版本恢复点；首次升级前会自动创建。"
      />
    );
  }
  return (
    <Flex justify="space-between" align="center" wrap="wrap" gap={16}>
      <Flex vertical gap={4}>
        <Text strong>{instanceLabel(snapshot.instance)}的上一版本</Text>
        <Text type="secondary">
          {snapshot.label ?? "升级前自动保存"} · {formatRelative(snapshot.createdAt)}
        </Text>
      </Flex>
      <Button onClick={() => onRollback(snapshot)}>退回上一版本</Button>
    </Flex>
  );
}
