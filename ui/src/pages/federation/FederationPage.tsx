/**
 * 实例联邦（M4.4）：跨实例聚合视图 + 分组标签 + 成本分摊。
 *
 * 单实例也照常工作（聚合结果就是那一个实例的全貌）。
 * 关键呈现：「统一急停覆盖 x / y」——覆盖不全时用户必须看得见，而不是默认没事。
 */
import { money } from "../../lib/format.js";
import { Alert, App, Button, Card, Flex, Input, Select, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
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

export function FederationPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<FederationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");

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
      const res = await postJson("/api/federation/group", { instanceId, group }, 30_000);
      setBusyId(null);
      if (res.ok) {
        message.success("实例分组已更新");
        refresh();
      } else {
        message.error("分组更新失败，请稍后重试");
      }
    },
    [refresh, message],
  );

  const filteredInstances = useMemo(() => {
    if (!data?.instances) return [];
    return data.instances.filter((inst) => {
      const matchGroup = groupFilter === "all" || inst.group === groupFilter;
      if (!matchGroup) return false;
      if (!searchText.trim()) return true;
      const q = searchText.trim().toLowerCase();
      const groupLabel = data.groupLabels[inst.group] ?? inst.group;
      return (
        inst.instanceId.toLowerCase().includes(q) ||
        inst.frameworkId.toLowerCase().includes(q) ||
        groupLabel.toLowerCase().includes(q) ||
        inst.state.toLowerCase().includes(q)
      );
    });
  }, [data?.instances, data?.groupLabels, searchText, groupFilter]);

  const columns: ColumnsType<InstanceView> = [
    {
      title: "实例",
      dataIndex: "instanceId",
      key: "instanceId",
      render: (id: string, row) => (
        <Flex vertical gap={2}>
          <Typography.Text
            strong
            className="font-mono"
            copyable={{ text: id, tooltips: ["复制实例 ID", "已复制"] }}
          >
            {id}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.frameworkId} · {row.state}
          </Typography.Text>
        </Flex>
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
          aria-label={`实例 ${row.instanceId} 分组设置`}
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
      render: (value: number | null) => money(value),
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
        value === 0 ? (
          <Typography.Text type="secondary">0</Typography.Text>
        ) : (
          <StatusBadge tone={value > 2 ? "error" : "warn"} label={String(value)} />
        ),
    },
    {
      title: "急停覆盖",
      dataIndex: "killswitchCovered",
      key: "killswitchCovered",
      width: 110,
      render: (covered: boolean) =>
        covered ? <StatusBadge tone="ok" label="已覆盖" /> : <StatusBadge tone="warn" label="未覆盖" />,
    },
  ];

  const summary = data?.summary;
  const coverageFull =
    summary !== undefined && summary.killswitchCoverage === `${summary.totalInstances}/${summary.totalInstances}`;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 原「联邦视图不可用」Alert 并入 offline 档；「统一急停未覆盖全部实例」Alert 与本结论同源，移入此处（只说一次）。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "联邦视图暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在合并各实例视图", copy: "正在按实例聚合会话、成本与急停覆盖。" }
        : summary === undefined
          ? {
              tone: "unknown",
              title: "联邦视图已加载，但汇总数字未算出",
              copy: "实例明细照常展示；刷新可补上合计。",
            }
          : !coverageFull
            ? {
                tone: "warn",
                title: "统一急停没覆盖全部实例",
                copy: `当前覆盖 ${summary.killswitchCoverage}（共 ${summary.totalInstances} 个）。需要全量急停时，在顶栏重新执行「紧急暂停」，它会按能力路由停止全部实例。`,
              }
            : {
                tone: "ok",
                title: `${summary.totalInstances} 个实例已合并看`,
                copy: `合并成本 ${money(summary.totalCostUsd)}，活跃事件 ${summary.activeEvents} 个，急停已覆盖 ${summary.killswitchCoverage}。`,
              };

  const fedStats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          { key: "instances", label: "实例总数", value: summary.totalInstances, unit: "个" },
          {
            key: "cost",
            label: "合并成本（7 天）",
            value: money(summary.totalCostUsd),
            sub: summary.totalCostUsd === null ? "金额未回传" : undefined,
          },
          { key: "sessions", label: "会话总量", value: summary.totalSessions, unit: "个" },
          {
            key: "events",
            label: "活跃事件",
            value: summary.activeEvents,
            unit: summary.activeEvents === 0 ? undefined : "个",
            tone: summary.activeEvents > 0 ? "warn" : undefined,
            sub: summary.activeEvents > 0 ? "需关注" : "无活跃",
          },
          {
            key: "coverage",
            label: "急停覆盖",
            value: summary.killswitchCoverage,
            sub: coverageFull ? "全部覆盖" : "覆盖不全",
            tone: coverageFull ? "ok" : "warn",
          },
        ];

  return (
    <section className="federation-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="实例联邦"
          extra={
            <Button icon={<ReloadOutlined />} aria-label="刷新实例联邦数据" onClick={refresh}>
              刷新
            </Button>
          }
        />

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={fedStats} loading={data === null && error === null} skeletonCount={5} />

        {data !== null && data.orphanSessions > 0 && (
          <Alert
            type="info"
            showIcon
            title={`${data.orphanSessions} 个会话未归属到任何实例`}
            description="这些会话在采集时缺少实例信息（例如手工导入的历史数据），没有计入任何实例的成本。"
          />
        )}

        <Card
          title={
            <Flex align="center" gap={8}>
              <span>实例明细</span>
              {data !== null && data.instances.length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
                  （共 {data.instances.length} 个实例{filteredInstances.length !== data.instances.length ? `，匹配 ${filteredInstances.length} 个` : ""}）
                </Typography.Text>
              )}
            </Flex>
          }
          extra={
            data !== null && data.instances.length > 0 ? (
              <Flex align="center" gap={8} wrap="wrap">
                <Select
                  size="small"
                  value={groupFilter}
                  onChange={setGroupFilter}
                  style={{ width: 100 }}
                  options={[
                    { value: "all", label: "全部分组" },
                    { value: "work", label: "工作" },
                    { value: "lab", label: "实验" },
                    { value: "sandbox", label: "沙箱" },
                    { value: "unassigned", label: "未分组" },
                  ]}
                  aria-label="按分组筛选实例"
                />
                <Input
                  size="small"
                  placeholder="搜索实例 ID / 框架..."
                  prefix={<SearchOutlined style={{ color: "var(--ab-text-3)" }} />}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  allowClear
                  style={{ width: 190 }}
                  aria-label="搜索实例"
                />
              </Flex>
            ) : undefined
          }
        >
          {data !== null && data.instances.length === 0 ? (
            <Empty
              title="还没有观测到任何实例"
              hint="管家会按实例聚合会话与成本；有实例接入后这里会列出明细。"
              mascot={false}
            />
          ) : data !== null && filteredInstances.length === 0 ? (
            <Empty
              title="未找到匹配的实例"
              hint="没有与当前筛选条件匹配的实例，请尝试调整关键词或分组过滤。"
              mascot={false}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    setSearchText("");
                    setGroupFilter("all");
                  }}
                >
                  清空筛选条件
                </Button>
              }
            />
          ) : (
            <Table<InstanceView>
              rowKey="instanceId"
              columns={columns}
              dataSource={filteredInstances}
              loading={data === null}
              pagination={filteredInstances.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
              scroll={{ x: 900 }}
            />
          )}
        </Card>

        {data !== null && (
          <Alert type="info" showIcon title="聚合口径" description={data.basis} />
        )}
      </Flex>
    </section>
  );
}
