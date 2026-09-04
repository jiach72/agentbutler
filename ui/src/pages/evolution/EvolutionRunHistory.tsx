import { Card, Flex, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDecimal, formatNumber, formatTime } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionRunHistory({ runs }: { runs: EvolutionOverviewPayload["runs"] }) {
  const columns: TableColumnsType<EvolutionOverviewPayload["runs"][number]> = [
    {
      title: "运行",
      dataIndex: "runId",
      width: 120,
      render: (value: string) => <Typography.Text code>{value.slice(0, 10)}</Typography.Text>,
    },
    { title: "时间", dataIndex: "updatedAt", width: 140, render: (value: string) => formatTime(value) },
    {
      title: "基线 → 候选",
      width: 180,
      render: (_, row) =>
        row.baseline === null || row.candidate === null
          ? "未知"
          : `${formatDecimal(row.baseline, 3)} → ${formatDecimal(row.candidate, 3)}`,
    },
    {
      title: "提升幅度",
      dataIndex: "improvement",
      width: 120,
      align: "right",
      render: (value: number | null) => (value === null ? "未知" : formatDecimal(value, 3)),
    },
    {
      title: "收益分",
      dataIndex: "gainScore",
      width: 100,
      align: "right",
      render: (value: number | null) =>
        value === null ? (
          <Tag>不评分</Tag>
        ) : (
          <Tag color={value === 100 ? "green" : value === 0 ? "red" : "orange"}>
            {formatNumber(value)}
          </Tag>
        ),
    },
    {
      title: "门禁",
      dataIndex: "gate",
      render: (value: string) => (
        <Tag color={value === "accepted" ? "green" : value === "rejected-regression" ? "red" : "orange"}>
          {value === "accepted" ? "已采用" : value === "rejected-regression" ? "回归，已拒绝" : value === "rejected-preflight" ? "预检未通过" : value === "preflight-failed" ? "准备失败" : "待处理"}
        </Tag>
      ),
    },
  ];
  return (
    <Card
      title={
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            运行历史
          </Typography.Text>
          <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
            每一次评估都可复盘
          </Typography.Title>
        </Flex>
      }
      extra={<Typography.Text type="secondary">{formatNumber(runs.length)} 次</Typography.Text>}
      styles={{ body: { padding: 0 } }}
    >
      <Table
        size="small"
        rowKey="runId"
        pagination={{ pageSize: 6, hideOnSinglePage: true }}
        locale={{ emptyText: "暂无运行历史" }}
        columns={columns}
        dataSource={runs}
        scroll={{ x: 820 }}
      />
    </Card>
  );
}
