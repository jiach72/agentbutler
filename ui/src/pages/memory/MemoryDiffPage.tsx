/**
 * 记忆变更流（Trust Layer M4.3）。
 *
 * 解决的问题是「重启失忆」的焦虑——用户看不见记忆在被维护，就会怀疑它哪天把重要的事忘了。
 * 这里把已采到的动作流翻译成人能读的「它记住了什么 / 改了什么 / 忘了什么」。
 *
 * 诚实呈现：页面显式声明观测口径与边界（只覆盖被 agent 动作过的记忆文件，不做内容级 diff），
 * 不冒称「完整记忆快照」。「不在受管清单内」也不写成「已删除」——那是两件事。
 */
import { Alert, Button, Card, Empty, Flex, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, InfoCircleOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

type Change = "added" | "modified" | "forgotten";

interface MemoryEntry {
  path: string;
  change: Change;
  firstAt: string;
  lastAt: string;
  writes: number;
  deletes: number;
  sessionIds: string[];
  stillPresent: boolean | null;
}

interface MemoryDiffPayload {
  windowDays: number;
  entries: MemoryEntry[];
  top: MemoryEntry[];
  summary: { added: number; modified: number; forgotten: number; total: number };
  basis: string;
  basisLimits: string[];
  lastActionAt: string | null;
}

const CHANGE_META: Record<Change, { color: string; label: string; icon: typeof PlusOutlined }> = {
  added: { color: "green", label: "新增", icon: PlusOutlined },
  modified: { color: "blue", label: "修改", icon: EditOutlined },
  forgotten: { color: "red", label: "遗忘", icon: DeleteOutlined },
};

/** 长路径只显示尾部（面包屑式），完整值放 tooltip，避免表格被撑爆。 */
const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
};

export function MemoryDiffPage() {
  const [data, setData] = useState<MemoryDiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Change>("all");

  const refresh = useCallback(() => {
    void loadJson<MemoryDiffPayload>("/api/memory-diff?windowDays=7", 20_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 60_000);

  const columns: ColumnsType<MemoryEntry> = [
    {
      title: "变化",
      dataIndex: "change",
      key: "change",
      width: 100,
      render: (change: Change) => {
        const meta = CHANGE_META[change];
        return (
          <Tag color={meta.color} icon={<meta.icon />}>
            {meta.label}
          </Tag>
        );
      },
    },
    {
      title: "记忆文件",
      dataIndex: "path",
      key: "path",
      ellipsis: true,
      render: (path: string) => (
        <Tooltip title={path}>
          <Typography.Text code>{shortPath(path)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: "写入 / 删除",
      key: "counts",
      width: 120,
      render: (_: unknown, row) => (
        <span>
          {row.writes}
          {row.deletes > 0 && <Typography.Text type="danger"> / {row.deletes}</Typography.Text>}
        </span>
      ),
    },
    {
      title: "在受管清单内",
      dataIndex: "stillPresent",
      key: "stillPresent",
      width: 130,
      render: (value: boolean | null) =>
        value === true ? (
          <Tag color="green">是</Tag>
        ) : (
          <Tooltip title="不在受管清单内，或该目录未被清单覆盖——这不等于文件已被删除">
            <Tag>未知</Tag>
          </Tooltip>
        ),
    },
    {
      title: "最近变化",
      dataIndex: "lastAt",
      key: "lastAt",
      width: 165,
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: "相关会话",
      key: "sessions",
      width: 200,
      ellipsis: true,
      render: (_: unknown, row) =>
        row.sessionIds.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tooltip title={row.sessionIds.join(" / ")}>
            <span>{row.sessionIds.length} 个会话</span>
          </Tooltip>
        ),
    },
  ];

  const summary = data?.summary;
  const entries = (data?.entries ?? []).filter((entry) => filter === "all" || entry.change === filter);

  return (
    <section className="memory-diff-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="记忆变更流"
          description="本周它记住了什么、改了什么、忘了什么——记忆在被维护，你应该看得见。"
          extra={
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="记忆变更视图不可用" description={error} />}

        {summary !== undefined && (
          <Flex gap={16} wrap="wrap">
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="新增" value={summary.added} valueStyle={{ color: "#389e0d" }} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="修改" value={summary.modified} valueStyle={{ color: "#0958d9" }} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="遗忘" value={summary.forgotten} valueStyle={{ color: "#cf1322" }} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="涉及文件" value={summary.total} />
            </Card>
          </Flex>
        )}

        {data !== null && data.top.length > 0 && (
          <Card size="small" title="本周它记住的重点（TOP5）">
            <Flex gap={8} wrap="wrap">
              {data.top.map((entry) => {
                const meta = CHANGE_META[entry.change];
                return (
                  <Tooltip key={entry.path} title={entry.path}>
                    <Tag color={meta.color}>
                      {meta.label} {shortPath(entry.path)}
                    </Tag>
                  </Tooltip>
                );
              })}
            </Flex>
          </Card>
        )}

        <Card
          title="记忆变更明细"
          extra={
            <Segmented
              options={[
                { label: "全部", value: "all" },
                { label: "新增", value: "added" },
                { label: "修改", value: "modified" },
                { label: "遗忘", value: "forgotten" },
              ]}
              value={filter}
              onChange={(value) => setFilter(value as "all" | Change)}
            />
          }
        >
          {data !== null && entries.length === 0 ? (
            <Empty
              description={
                filter === "all"
                  ? "本周观测到 agent 没有改动记忆类文件"
                  : `本周没有「${CHANGE_META[filter as Change].label}」的记忆文件`
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Table<MemoryEntry>
              rowKey="path"
              columns={columns}
              dataSource={entries}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1000 }}
            />
          )}
        </Card>

        {data !== null && (
          <Alert
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
            message="这份数据是什么、不是什么"
            description={
              <Flex vertical gap={4}>
                <span>口径：{data.basis}。</span>
                {data.basisLimits.map((limit) => (
                  <span key={limit}>· {limit}</span>
                ))}
                <span>隐私：只读取动作元数据与路径，不展示记忆正文内容。</span>
              </Flex>
            }
          />
        )}
      </Flex>
    </section>
  );
}
