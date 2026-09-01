/**
 * 目录兜底统计块：技能服务不可达时按本机文件展示规模。
 */
import { Card, Col, Row, Statistic, Tooltip, Typography } from "antd";
import type { DirectoryInventory } from "./helpers.js";
import { formatBytes, formatNumber } from "../../lib/format.js";

export function DirectoryFallback({ directory }: { directory: DirectoryInventory }) {
  return (
    <Card size="small" title="按本机文件统计">
      <Row gutter={[16, 12]}>
        <Col xs={8}>
          <Statistic title="文件" value={formatNumber(directory.fileCount)} />
        </Col>
        <Col xs={8}>
          <Statistic title="文件夹" value={formatNumber(directory.directoryCount)} />
        </Col>
        <Col xs={8}>
          <Statistic title="占用空间" value={formatBytes(directory.sizeBytes)} />
        </Col>
      </Row>
      <Tooltip title={directory.roots.join(" · ")}>
        <Typography.Text type="secondary">
          {directory.truncated
            ? "只显示了部分文件，详细位置见提示。"
            : "已按本机文件统计，未修改任何内容。"}
        </Typography.Text>
      </Tooltip>
    </Card>
  );
}
