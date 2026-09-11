/**
 * 实例联邦（M4.4）：跨实例聚合视图 + 分组标签 + 成本分摊。
 *
 * 单实例也照常工作（聚合结果就是那一个实例的全貌）。
 * 关键呈现：「统一急停覆盖 x / y」——覆盖不全时用户必须看得见，而不是默认没事。
 */
import { Alert, Button, Card, Empty, Flex, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ClusterOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

type Group = "work" | "lab" | "sandbox" | "unassigned";

interface InstanceView {
  instanceId: string;
  frameworkId: string;
  state: string;
  group: Group;
  sessions: number;
  costUsd: number | null;
  tokens: number;
  activeEvents: number;
  killswitchCovered: boolean;
}

interface FederationPayload {
  windowDays: number;
  instances: InstanceView[];
  summary: {
    totalInstances: number;
    byGroup: Record<Group, number>;
    totalCostUsd: number | null;
    totalSessions: number;
    activeEvents: number;
    killswitchCoverage: string;
  };
  orphanSessions: number;
  basis: string;
  groupLabels: Record<Group, string>;
}

const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(2)}`);

export function FederationPage() {
  const [data, setData] = useState<FederationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void loadJson<FederationPayload>("/api/federation?windowDays=7", 20_000).then((result) => {
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

  const setGroup = useCallback(
    async (instanceId: string, group: Group) => {
      setBusyId(instanceId);
      await postJson("/api/federation/group", { instanceId, group }, 30_000);
      setBusyId(null);
      refresh();
    },
    [refresh],
  );

  const columns: ColumnsType<InstanceView> = [
    {
      title: "实例",
      dataIndex: "instanceId",
      key: "instanceId",
      render: (id: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{id}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.frameworkId} · {row.state}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "分组",
      dataIndex: "group",
      key: "group",
      width: 150,
      render: (group: Group, row) => (
        <Select
          size="small"
          value={group}
          loading={busyId === row.instanceId}
          style={{ width: 110 }}
          onChange={(value) => void setGroup(row.instanceId, value as Group)}
          options={[
            { value: "work", label: "工作" },
            { value: "lab", label: "实验" },
            { value: "sandbox", label: "沙箱" },
            { value: "unassigned", label: "未分组" },
          ]}
        />
      ),
    },
    { title: "会话（7 天）", dataIndex: "sessions", key: "sessions", width: 110 },
    {
      title: "成本（7 天）",
      dataIndex: "costUsd",
      key: "costUsd",
      width: 110,
      render: (value: number | null) => usd(value),
    },
    {
      title: "Token",
      dataIndex: "tokens",
      key: "tokens",
      width: 110,
      render: (value: number) => value.toLocaleString(),
    },
    {
      title: "活跃事件",
      dataIndex: "activeEvents",
      key: "activeEvents",
      width: 90,
      render: (value: number) =>
        value === 0 ? <Typography.Text type="secondary">0</Typography.Text> : (
          <Tag color={value > 2 ? "red" : "orange"}>{value}</Tag>
        ),
    },
    {
      title: "急停覆盖",
      dataIndex: "killswitchCovered",
      key: "killswitchCovered",
      width: 100,
      render: (covered: boolean) =>
        covered ? <Tag color="red">已停</Tag> : <Tag>运行中</Tag>,
    },
  ];

  const summary = data?.summary;

  return (
    <section className="federation-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="实例联邦"
          description="多实例的成本、事件与急停在一张表里看——覆盖不全时，你会看得见。"
          extra={
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="联邦视图不可用" description={error} />}

        {summary !== undefined && (
          <Flex gap={16} wrap="wrap">
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="实例总数" value={summary.totalInstances} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="合并成本（7 天）" value={usd(summary.totalCostUsd)} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic title="会话总量" value={summary.totalSessions} />
            </Card>
            <Card style={{ flex: "1 1 150px" }}>
              <Statistic
                title="活跃事件"
                value={summary.activeEvents}
                valueStyle={summary.activeEvents > 0 ? { color: "#d46b08" } : undefined}
              />
            </Card>
            <Card style={{ flex: "1 1 170px" }}>
              <Statistic title="急停覆盖（已停/总数）" value={summary.killswitchCoverage} />
            </Card>
          </Flex>
        )}

        {data !== null && data.orphanSessions > 0 && (
          <Alert
            type="info"
            showIcon
            message={`${data.orphanSessions} 个会话未归属到任何实例`}
            description="这些会话在采集时缺少实例维度（如手工导入的历史数据），未计入任何实例的成本分摊——如实呈现，不做摊派。"
          />
        )}

        {summary !== undefined && summary.totalInstances > 1 && summary.killswitchCoverage !== `${summary.totalInstances} / ${summary.totalInstances}` && (
          <Alert
            type="warning"
            showIcon
            icon={<ClusterOutlined />}
            message="统一急停未覆盖全部实例"
            description={`当前急停覆盖 ${summary.killswitchCoverage}。如需全量急停，请在顶栏重新执行「紧急暂停」——它会按能力路由停止全部实例。`}
          />
        )}

        <Card title="实例明细">
          {data !== null && data.instances.length === 0 ? (
            <Empty description="还没有观测到任何实例" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table<InstanceView>
              rowKey="instanceId"
              columns={columns}
              dataSource={data?.instances ?? []}
              loading={data === null}
              pagination={false}
              scroll={{ x: 900 }}
            />
          )}
        </Card>

        {data !== null && (
          <Alert type="info" showIcon message="聚合口径" description={data.basis} />
        )}
      </Flex>
    </section>
  );
}
