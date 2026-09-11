/**
 * Agent 周报页（Trust Layer M2.1）：
 * - 本周速览：成本 / 环比 / 月度预算用量 / 活跃事件 / 高危动作 / 最近全量备份；
 * - 周报正文（Markdown 原文预览）+「立即生成」；
 * - 历史存档 12 周（展开行查看正文）。
 * 数据真相原则：成本未接入显示「待接入」；审计未启用显式标注，不伪造 0。
 */
import { Alert, Button, Card, Empty, Flex, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

interface ReportData {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  cost: {
    available: boolean;
    thisWeekUsd: number | null;
    lastWeekUsd: number | null;
    deltaPct: number | null;
    monthlyBudgetUsd: number | null;
    monthSpentUsd: number | null;
    topModel: string | null;
    topSessions: Array<{ sessionId: string; model: string; costUsd: number | null }>;
  };
  instances: { total: number; serving: number; degraded: number; stopped: number; byState: Record<string, number> };
  events: { active: number; critical: number; top: Array<{ kind: string; severity: string; title: string; count: number; lastSeen: string }> };
  audit: { enabled: boolean; windowHours: number; total: number; highRisk: number; byKind: Record<string, number> };
  skills: { top: Array<{ name: string; calls: number; successRate: number | null }> };
  backups: { lastFullAt: string | null; count: number };
}

interface ReportRow {
  id: number;
  weekStart: string;
  weekEnd: string;
  status: "generated" | "sent" | "send-failed";
  markdown: string;
  sentAt: string | null;
  createdAt: string;
}

const usd = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `$${value.toFixed(2)}`;

const STATUS_TAG: Record<ReportRow["status"], { color: string; label: string }> = {
  generated: { color: "default", label: "已生成" },
  sent: { color: "green", label: "已推送" },
  "send-failed": { color: "red", label: "推送失败" },
};

export function ReportPage() {
  const [current, setCurrent] = useState<{ data: ReportData; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReportRow[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<{ data: ReportData; markdown: string }>("/api/trust/report", 15_000).then((result) => {
      if (result.ok) {
        setCurrent(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
    void loadJson<{ reports: ReportRow[] }>("/api/trust/report/history?limit=12", 8_000).then((result) => {
      if (result.ok) setHistory(result.data.reports);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 120_000);

  const runNow = useCallback(async () => {
    setBusy(true);
    const result = await postJson("/api/trust/report/run", { push: false }, 60_000);
    setBusy(false);
    if (result.ok) {
      refresh();
    }
  }, [refresh]);

  const data = current?.data ?? null;
  const costColor = data !== null && data.cost.deltaPct !== null && data.cost.deltaPct > 0 ? "#cf1322" : undefined;

  const columns: ColumnsType<ReportRow> = [
    { title: "周区间", key: "range", width: 200, render: (_: unknown, row: ReportRow) => `${row.weekStart} ~ ${row.weekEnd}` },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: ReportRow["status"]) => <Tag color={STATUS_TAG[status].color}>{STATUS_TAG[status].label}</Tag>,
    },
    { title: "生成时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (v: string) => new Date(v).toLocaleString() },
    { title: "推送时间", dataIndex: "sentAt", key: "sentAt", width: 180, render: (v: string | null) => (v === null ? "—" : new Date(v).toLocaleString()) },
  ];

  return (
    <section className="report-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="Agent 周报"
          description="每周一 08:00 自动生成并推送：成本、事件、审计、备份一页看完。全确定性组装，零 LLM 调用。"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Tooltip title="生成本周快照（不推送）">
                <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={() => void runNow()}>
                  立即生成
                </Button>
              </Tooltip>
            </Space>
          }
        />

        {error !== null && <Alert type="warning" showIcon message="周报服务不可用" description={error} />}

        {data !== null && (
          <>
            <Flex gap={16} wrap="wrap">
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="本周成本"
                  value={data.cost.available && data.cost.thisWeekUsd !== null ? data.cost.thisWeekUsd.toFixed(2) : "待接入"}
                  prefix={data.cost.available && data.cost.thisWeekUsd !== null ? "$" : undefined}
                  suffix={
                    data.cost.available && data.cost.deltaPct !== null ? (
                      <span style={{ fontSize: 13, color: costColor }}>
                        环比 {data.cost.deltaPct >= 0 ? "+" : ""}
                        {data.cost.deltaPct}%
                      </span>
                    ) : undefined
                  }
                />
              </Card>
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="月度预算用量"
                  value={
                    data.cost.monthlyBudgetUsd !== null && data.cost.monthSpentUsd !== null
                      ? `${Math.round((data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd) * 100)}%`
                      : "未设预算"
                  }
                  suffix={
                    data.cost.monthlyBudgetUsd !== null && data.cost.monthSpentUsd !== null
                      ? `（${usd(data.cost.monthSpentUsd)} / ${usd(data.cost.monthlyBudgetUsd)}）`
                      : undefined
                  }
                  valueStyle={
                    data.cost.monthlyBudgetUsd !== null &&
                    data.cost.monthSpentUsd !== null &&
                    data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd > 0.9
                      ? { color: "#cf1322" }
                      : undefined
                  }
                />
              </Card>
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="活跃事件"
                  value={data.events.active}
                  suffix={data.events.critical > 0 ? `（critical ${data.events.critical}）` : undefined}
                  valueStyle={data.events.critical > 0 ? { color: "#cf1322" } : undefined}
                />
              </Card>
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="7 天高危动作"
                  value={data.audit.enabled ? data.audit.highRisk : "未启用"}
                  suffix={data.audit.enabled ? `／共 ${data.audit.total} 次` : undefined}
                  valueStyle={data.audit.enabled && data.audit.highRisk > 0 ? { color: "#d46b08" } : undefined}
                />
              </Card>
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="实例状态"
                  value={data.instances.total === 0 ? "无实例" : `${data.instances.serving}/${data.instances.total} 在服`}
                  suffix={
                    data.instances.degraded > 0 || data.instances.stopped > 0
                      ? `（降级 ${data.instances.degraded} / 其他 ${data.instances.stopped}）`
                      : undefined
                  }
                />
              </Card>
              <Card style={{ flex: "1 1 200px" }}>
                <Statistic
                  title="最近全量备份"
                  value={data.backups.count === 0 ? "⚠️ 无快照" : data.backups.lastFullAt === "" ? "时间未知" : (data.backups.lastFullAt ?? "").slice(0, 16).replace("T", " ")}
                  suffix={data.backups.count > 0 ? `（累计 ${data.backups.count}）` : undefined}
                  valueStyle={data.backups.count === 0 ? { color: "#cf1322" } : undefined}
                />
              </Card>
            </Flex>

            <Card title={`周报正文（${data.weekStart} ~ ${data.weekEnd}）`} extra={<Typography.Text type="secondary">实时快照，未落库</Typography.Text>}>
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0, fontFamily: "inherit" }}>
                {current?.markdown}
              </Typography.Paragraph>
            </Card>
          </>
        )}

        <Card title="历史存档（近 12 周）">
          {history.length === 0 ? (
            <Empty description="暂无存档：等本周一 08:00 自动生成，或点「立即生成」" />
          ) : (
            <Table<ReportRow>
              rowKey="id"
              columns={columns}
              dataSource={history}
              pagination={false}
              expandable={{
                expandedRowRender: (row) => (
                  <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                    {row.markdown}
                  </Typography.Paragraph>
                ),
              }}
            />
          )}
        </Card>
      </Flex>
    </section>
  );
}
