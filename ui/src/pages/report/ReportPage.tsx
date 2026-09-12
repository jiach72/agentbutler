/**
 * Agent 周报页（Trust Layer M2.1）：
 * - 本周速览：成本 / 环比 / 月度预算用量 / 活跃事件 / 高危动作 / 最近全量备份；
 * - 周报正文（Markdown 原文预览）+「立即生成」；
 * - 历史存档 12 周（展开行查看正文）。
 * 数据真相原则：成本未接入显示「待接入」；审计未启用显式标注，不伪造 0。
 */
import { money, USD_TO_CNY } from "../../lib/format.js";
import { Button, Card, Flex, Space, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
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

/** 历史状态 → 状态徽标（不走 antd 预设色名，统一用语义 tone）。 */
const STATUS_TONE: Record<ReportRow["status"], "brand" | "ok" | "error"> = {
  generated: "brand",
  sent: "ok",
  "send-failed": "error",
};
const STATUS_LABEL: Record<ReportRow["status"], string> = {
  generated: "已生成",
  sent: "已推送",
  "send-failed": "推送失败",
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

  const columns: ColumnsType<ReportRow> = [
    { title: "周区间", key: "range", width: 200, render: (_: unknown, row: ReportRow) => `${row.weekStart} ~ ${row.weekEnd}` },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: ReportRow["status"]) => <StatusBadge tone={STATUS_TONE[status]} label={STATUS_LABEL[status]} />,
    },
    { title: "生成时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (v: string) => new Date(v).toLocaleString() },
    { title: "推送时间", dataIndex: "sentAt", key: "sentAt", width: 180, render: (v: string | null) => (v === null ? "—" : new Date(v).toLocaleString()) },
  ];

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 原「周报服务不可用」Alert 并入 offline 档；其它按严重度穷举，读不到就不下结论。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "周报服务暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在生成本周周报", copy: "正在汇总成本、事件、审计与备份。" }
        : data.events.critical > 0
          ? {
              tone: "error",
              title: `本周有 ${data.events.critical} 个 critical 事件`,
              copy: `活跃事件共 ${data.events.active} 个。点开下方事件明细或「实例联邦」页查看处理进展。`,
            }
          : data.backups.count === 0
            ? {
                tone: "warn",
                title: "还没有任何全量备份快照",
                copy: "升级或回滚前管家会自动先做一份；也可手动触发，别让「无快照」拖到真要回滚时。",
              }
            : data.cost.monthlyBudgetUsd !== null &&
                data.cost.monthSpentUsd !== null &&
                data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd > 0.9
              ? {
                  tone: "warn",
                  title: "本月预算已用九成以上",
                  copy: `已花 ${money(data.cost.monthSpentUsd)} / 预算 ${money(data.cost.monthlyBudgetUsd)}。`,
                }
              : {
                  tone: "ok",
                  title: `本周周报已生成（${data.weekStart} ~ ${data.weekEnd}）`,
                  copy: data.cost.available
                    ? `本周成本 ${money(data.cost.thisWeekUsd)}。`
                    : "本周成本口径尚未接入，金额留空展示。",
                };

  const reportStats: StatStripItem[] =
    data === null
      ? []
      : [
          {
            key: "cost",
            label: "本周成本",
            value: data.cost.available && data.cost.thisWeekUsd !== null ? (data.cost.thisWeekUsd * USD_TO_CNY).toFixed(2) : "待接入",
            unit: data.cost.available && data.cost.thisWeekUsd !== null ? "元" : undefined,
            sub: data.cost.deltaPct !== null ? `环比 ${data.cost.deltaPct >= 0 ? "+" : ""}${data.cost.deltaPct}%` : "环比待接入",
          },
          {
            key: "budget",
            label: "月度预算用量",
            value:
              data.cost.monthlyBudgetUsd !== null && data.cost.monthSpentUsd !== null
                ? `${Math.round((data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd) * 100)}%`
                : "未设预算",
            sub:
              data.cost.monthlyBudgetUsd !== null && data.cost.monthSpentUsd !== null
                ? `${money(data.cost.monthSpentUsd)} / ${money(data.cost.monthlyBudgetUsd)}`
                : undefined,
            tone:
              data.cost.monthlyBudgetUsd !== null &&
              data.cost.monthSpentUsd !== null &&
              data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd > 0.9
                ? "warn"
                : undefined,
          },
          {
            key: "events",
            label: "活跃事件",
            value: data.events.active,
            unit: data.events.active === 0 ? undefined : "个",
            sub: data.events.critical > 0 ? `critical ${data.events.critical}` : "无 critical",
            tone: data.events.critical > 0 ? "error" : undefined,
          },
          {
            key: "audit",
            label: "7 天高危动作",
            value: data.audit.enabled ? data.audit.highRisk : "未启用",
            sub: data.audit.enabled ? `共 ${data.audit.total} 次` : "审计未启用",
            tone: data.audit.enabled && data.audit.highRisk > 0 ? "warn" : undefined,
          },
          {
            key: "instances",
            label: "实例状态",
            value: data.instances.total === 0 ? "无实例" : `${data.instances.serving}/${data.instances.total} 在服`,
            sub:
              data.instances.degraded > 0 || data.instances.stopped > 0
                ? `降级 ${data.instances.degraded} / 其他 ${data.instances.stopped}`
                : "全部在服",
            tone: data.instances.degraded > 0 || data.instances.stopped > 0 ? "warn" : undefined,
          },
          {
            key: "backup",
            label: "最近全量备份",
            value:
              data.backups.count === 0
                ? "无快照"
                : data.backups.lastFullAt === "" || data.backups.lastFullAt === null
                  ? "时间未知"
                  : data.backups.lastFullAt.slice(0, 16).replace("T", " "),
            sub: data.backups.count > 0 ? `累计 ${data.backups.count}` : "升级/回滚前会自动做",
            tone: data.backups.count === 0 ? "warn" : undefined,
          },
        ];

  return (
    <section className="report-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="Agent 周报"
          description="每周一 08:00 自动生成并推送：成本、事件、审计、备份汇总在一页。内容由固定规则生成，不经过模型。"
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

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={reportStats} />

        {data !== null && (
          <Card
            title={`周报正文（${data.weekStart} ~ ${data.weekEnd}）`}
            extra={<Typography.Text type="secondary">实时快照，未落库</Typography.Text>}
          >
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0, fontFamily: "inherit" }}>
              {current?.markdown}
            </Typography.Paragraph>
          </Card>
        )}

        <Card title="历史存档（近 12 周）">
          {history.length === 0 ? (
            <Empty
              title="还没有周报存档"
              hint="等本周一 08:00 自动生成，或点上方「立即生成」试试。"
              mascotWidth={72}
            />
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
