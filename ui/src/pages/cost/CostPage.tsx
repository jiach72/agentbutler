/**
 * 成本页（Trust Layer M1.1 成本中枢）：
 * - 顶部大数字：本月已花 / 预算余量 / 日均燃速 + 预计触线日；
 * - 中部：按模型成本排行（条形）+ 按日成本（迷你柱状）；
 * - 底部：最贵会话 TOP10 表格。
 * 数据真相原则：Hermes 未提供成本列时显示「待接入」而非 0——不伪造。
 */
import { Alert, Card, Empty, Flex, Progress, Segmented, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

interface CostSummary {
  rangeDays: number;
  costAvailable: boolean;
  total: { estimatedUsd: number | null; actualUsd: number | null; verifiedUsd: number | null };
  days: Array<{ date: string; tokens: number; estimatedCostUsd: number | null; actualCostUsd: number | null }>;
  models: Array<{ model: string; tokens: number; estimatedCostUsd: number | null; actualCostUsd: number | null }>;
  sessions: Array<{ sessionId: string; model: string; lastSeen: string; tokens: number; estimatedCostUsd: number | null; actualCostUsd: number | null }>;
}

interface BudgetStatus {
  enabled: boolean;
  budgetUsd: number;
  action: string;
  month: string;
  spentUsd: number | null;
  spentSource: "actual" | "estimated" | null;
  ratio: number | null;
  threshold: "ok" | "80%" | "100%" | "over";
  projectedExhaustedAt: string | null;
  lastCheckedAt: string | null;
}

const usd = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `$${value.toFixed(2)}`;

const RANGES = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
];

export function CostPage() {
  const [rangeDays, setRangeDays] = useState(30);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);

  const refresh = useCallback(() => {
    void loadJson<CostSummary>(`/api/llm/cost/summary?days=${rangeDays}`, 8_000).then((result) => {
      if (result.ok) {
        setSummary(result.data);
        setSummaryError(null);
      } else {
        setSummaryError(result.reason);
      }
    });
    void loadJson<BudgetStatus>("/api/budget", 6_000).then((result) => {
      if (result.ok) setBudget(result.data);
    });
  }, [rangeDays]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 60_000);

  const totalCost = summary?.total.actualUsd ?? summary?.total.estimatedUsd ?? null;
  const dayCount = summary?.days.length ?? 0;
  const dailyBurn = useMemo(() => {
    if (totalCost === null || dayCount === 0) return null;
    return totalCost / Math.max(1, dayCount);
  }, [totalCost, dayCount]);

  const maxModelCost = useMemo(
    () => Math.max(0.000001, ...(summary?.models ?? []).map((m) => m.actualCostUsd ?? m.estimatedCostUsd ?? 0)),
    [summary],
  );
  const maxDayCost = useMemo(
    () => Math.max(0.000001, ...(summary?.days ?? []).map((d) => d.actualCostUsd ?? d.estimatedCostUsd ?? 0)),
    [summary],
  );

  const budgetLeft = budget !== null && budget.enabled && budget.spentUsd !== null
    ? Math.max(0, budget.budgetUsd - budget.spentUsd)
    : null;

  const columns = [
    {
      title: "会话",
      dataIndex: "sessionId",
      key: "sessionId",
      ellipsis: true,
      width: 260,
      // M2.3 深链：成本页最贵会话一键进入会话时间线。
      render: (sessionId: string) => <Link to={`/sessions/${encodeURIComponent(sessionId)}`}>{sessionId}</Link>,
    },
    { title: "模型", dataIndex: "model", key: "model", ellipsis: true },
    {
      title: "成本",
      key: "cost",
      width: 110,
      render: (_: unknown, record: CostSummary["sessions"][number]) =>
        usd(record.actualCostUsd ?? record.estimatedCostUsd),
    },
    { title: "Token", dataIndex: "tokens", key: "tokens", width: 120, render: (v: number) => v.toLocaleString() },
    { title: "最近活动", dataIndex: "lastSeen", key: "lastSeen", width: 170, render: (v: string) => new Date(v).toLocaleString() },
  ];

  return (
    <section className="cost-page">
      <Flex vertical gap={16}>
        <PageHeader
          eyebrow="信任层"
          title="成本"
          description="每一分花在 agent 上的钱都应能归因到模型和会话——无黑箱。"
        />

        {summaryError !== null && (
          <Alert type="warning" showIcon message="成本数据不可用" description={summaryError} />
        )}
        {summary !== null && !summary.costAvailable && (
          <Alert
            type="info"
            showIcon
            message="成本明细待接入"
            description="Hermes 的用量表尚未提供成本（billing/cost）字段，金额将保持为空，不会用 token 数反推伪造。等 Hermes 侧写入成本列后本页自动点亮。"
          />
        )}

        <Flex gap={16} wrap="wrap">
          <Card style={{ flex: "1 1 200px" }}>
            <Statistic
              title={`${RANGES.find((r) => r.value === rangeDays)?.label ?? ""}已花`}
              value={totalCost === null ? "—" : totalCost.toFixed(2)}
              precision={totalCost === null ? undefined : 2}
              prefix={totalCost === null ? undefined : "$"}
              suffix={
                summary?.total.actualUsd !== null && summary?.total.actualUsd !== undefined
                  ? undefined
                  : summary !== null && summary.costAvailable
                    ? <Tooltip title="实际账单缺失，按估算列展示">（估算）</Tooltip>
                    : undefined
              }
            />
          </Card>
          <Card style={{ flex: "1 1 200px" }}>
            <Statistic
              title="预算余量"
              value={budgetLeft === null ? "未设预算" : budgetLeft.toFixed(2)}
              prefix={budgetLeft === null ? undefined : "$"}
              suffix={
                budget !== null && budget.enabled && budget.ratio !== null
                  ? `（已用 ${Math.round(budget.ratio * 100)}%）`
                  : undefined
              }
              valueStyle={
                budget !== null && budget.enabled && (budget.threshold === "100%" || budget.threshold === "over")
                  ? { color: "#cf1322" }
                  : budget !== null && budget.enabled && budget.threshold === "80%"
                    ? { color: "#d46b08" }
                    : undefined
              }
            />
          </Card>
          <Card style={{ flex: "1 1 200px" }}>
            <Statistic
              title="日均燃速"
              value={dailyBurn === null ? "—" : dailyBurn.toFixed(2)}
              prefix={dailyBurn === null ? undefined : "$"}
              suffix={
                budget !== null && budget.enabled && budget.projectedExhaustedAt !== null
                  ? `预计 ${new Date(budget.projectedExhaustedAt).toLocaleDateString()} 触线`
                  : undefined
              }
            />
          </Card>
        </Flex>

        {budget !== null && budget.enabled && budget.threshold !== "ok" && (
          <Alert
            type={budget.threshold === "100%" || budget.threshold === "over" ? "error" : "warning"}
            showIcon
            message={
              budget.threshold === "over"
                ? "本月成本已超出预算"
                : `本月成本已达预算 ${budget.threshold}`
            }
            description={`触线动作：${budget.action === "alert" ? "仅告警" : budget.action}。核算时间：${budget.lastCheckedAt !== null ? new Date(budget.lastCheckedAt).toLocaleString() : "—"}`}
          />
        )}

        <Card
          title="按模型成本"
          extra={
            <Segmented
              size="small"
              options={RANGES}
              value={rangeDays}
              onChange={(value) => setRangeDays(value as number)}
            />
          }
        >
          {summary === null || summary.models.length === 0 ? (
            <Empty description="窗口内暂无用量" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Flex vertical gap={12}>
              {summary.models.map((model) => {
                const cost = model.actualCostUsd ?? model.estimatedCostUsd ?? 0;
                return (
                  <div key={model.model}>
                    <Flex justify="space-between" style={{ marginBottom: 4 }}>
                      <Typography.Text ellipsis style={{ maxWidth: "70%" }}>{model.model}</Typography.Text>
                      <Typography.Text strong>{usd(model.actualCostUsd ?? model.estimatedCostUsd)}</Typography.Text>
                    </Flex>
                    <Progress
                      percent={Math.round((cost / maxModelCost) * 100)}
                      showInfo={false}
                      strokeColor={{ from: "#1677ff", to: "#69b1ff" }}
                      size="small"
                    />
                  </div>
                );
              })}
            </Flex>
          )}
        </Card>

        <Card title="按日成本">
          {summary === null || summary.days.length === 0 ? (
            <Empty description="窗口内暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Flex gap={4} align="flex-end" style={{ height: 120 }}>
              {summary.days.map((day) => {
                const cost = day.actualCostUsd ?? day.estimatedCostUsd ?? 0;
                const height = Math.max(2, Math.round((cost / maxDayCost) * 100));
                return (
                  <Tooltip key={day.date} title={`${day.date}：${usd(day.actualCostUsd ?? day.estimatedCostUsd)}`}>
                    <div
                      style={{
                        flex: 1,
                        height: `${height}%`,
                        background: "linear-gradient(180deg, #1677ff, #91caff)",
                        borderRadius: 2,
                        minWidth: 6,
                      }}
                    />
                  </Tooltip>
                );
              })}
            </Flex>
          )}
        </Card>

        <Card title="最贵会话 TOP10">
          <Table
            size="small"
            rowKey={(record) => `${record.sessionId}-${record.model}`}
            columns={columns}
            dataSource={summary?.sessions ?? []}
            pagination={false}
            locale={{ emptyText: <Empty description="暂无会话成本记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>
      </Flex>
    </section>
  );
}
