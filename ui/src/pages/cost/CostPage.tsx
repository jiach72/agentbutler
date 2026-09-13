/**
 * 成本页（Trust Layer M1.1 成本中枢）：
 * - 顶部结论条：一句话说清「花了多少、会不会超」；
 * - 中部：三个关键数字（已花 / 预算余量 / 日均燃速）；
 * - 下方：按模型成本排行（条形）+ 按日成本（迷你柱状）；
 * - 底部：最贵会话 TOP10 表格。
 * 数据真相原则：Hermes 未提供成本列时显示「还没有金额字段」而非 0——不伪造。
 */
import { money, USD_TO_CNY } from "../../lib/format.js";
import { App, Button, Card, Flex, Form, InputNumber, Modal, Progress, Segmented, Select, Table, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SettingOutlined, ThunderboltOutlined, WalletOutlined } from "@ant-design/icons";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { useUrlState } from "../../hooks/useUrlState.js";
import { usePolling } from "../../hooks/usePolling.js";
import { loadJson, postJson } from "../../lib/api.js";

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

const RANGES = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
];

export function CostPage() {
  const { message } = App.useApp();
  // 时间区间同步到 URL（规范 03 §3.12），刷新/分享链接能还原同一视图（评审 P1-7）。
  const [rangeDays, setRangeDays] = useUrlState<number>("range", 30);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetForm] = Form.useForm<{ monthlyCny: number; action: "alert" | "downgrade" | "pause" }>();
  const navigate = useNavigate();

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

  const openBudgetModal = useCallback(() => {
    // 输入单位是元，存储是 USD：打开时按当前预算折算，方便直接改数字。
    budgetForm.setFieldsValue({
      monthlyCny: budget !== null && budget.budgetUsd > 0 ? Math.round(budget.budgetUsd * USD_TO_CNY * 100) / 100 : undefined,
      action: (budget?.action as "alert" | "downgrade" | "pause") ?? "alert",
    });
    setBudgetModalOpen(true);
  }, [budget, budgetForm]);

  const saveBudget = useCallback(async () => {
    const values = await budgetForm.validateFields();
    setBudgetSaving(true);
    const monthlyUsd = Math.round((values.monthlyCny / USD_TO_CNY) * 100) / 100;
    const result = await postJson("/api/budget", { monthlyUsd, action: values.action }, 15_000);
    setBudgetSaving(false);
    if (result.ok) {
      setBudgetModalOpen(false);
      message.success(values.monthlyCny > 0 ? `预算已设置为 ${values.monthlyCny} 元/月` : "预算已关闭");
      refresh();
      return;
    }
    message.error(`预算保存失败（HTTP ${result.status}）`);
  }, [budgetForm, message, refresh]);

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
        money(record.actualCostUsd ?? record.estimatedCostUsd),
    },
    { title: "Token", dataIndex: "tokens", key: "tokens", width: 120, render: (v: number) => v.toLocaleString() },
    { title: "最近活动", dataIndex: "lastSeen", key: "lastSeen", width: 170, render: (v: string) => new Date(v).toLocaleString() },
  ];

  const budgetEnabled = budget !== null && budget.enabled;
  const budgetRatioPct = budgetEnabled && budget.ratio !== null ? Math.round(budget.ratio * 100) : null;
  const projectedLabel =
    budgetEnabled && budget.projectedExhaustedAt !== null
      ? `预计 ${new Date(budget.projectedExhaustedAt).toLocaleDateString()} 触线`
      : "";
  /** 触线动作与核算时间：原来挂在一条独立 Alert 上，现在并入结论条的元信息行，避免说两遍。 */
  const budgetFootNote =
    budgetEnabled && budget.threshold !== "ok"
      ? `触线动作：${budget.action === "alert" ? "仅告警" : budget.action} · 核算于 ${
          budget.lastCheckedAt !== null ? new Date(budget.lastCheckedAt).toLocaleString() : "—"
        }`
      : null;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 成本页尤其需要：一排数字本身不说明「这算多还是少」（评审 P0-2）。
   */
  const conclusion: PageConclusionView =
    summaryError !== null
      ? {
          tone: "offline",
          title: "成本数据暂时读不到",
          copy: summaryError,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : summary === null
        ? { tone: "unknown", title: "正在读取成本", copy: "刚打开页面，稍等片刻。" }
        : !summary.costAvailable
          ? {
              tone: "unknown",
              title: "成本明细还没接入",
              copy: "管家已经记下用量，但用量表还没有金额字段，所以这里不会显示金额——不会用 token 数反推伪造。",
            }
          : totalCost === null
            ? {
                tone: "unknown",
                title: `近 ${rangeDays} 天还没有用量记录`,
                copy: "这个时间段内没有记录到调用，或成本列尚未回填。",
              }
            : budgetEnabled && (budget.threshold === "100%" || budget.threshold === "over")
              ? {
                  tone: "error",
                  title: budget.threshold === "over" ? "本月成本已超出预算" : "本月成本已达预算上限",
                  copy: `本月已花 ${money(budget.spentUsd)}，预算 ${money(budget.budgetUsd)}。`,
                  action: <Button onClick={() => navigate("/gateway")}>查看消息通知</Button>,
                }
              : budgetEnabled && budget.threshold === "80%"
                ? {
                    tone: "warn",
                    title: "本月成本已达预算的 80%",
                    copy: `还剩 ${money(budgetLeft)}。${projectedLabel === "" ? "按当前速度本月内不会超。" : projectedLabel + "。"}`,
                  }
                : {
                    /* 结论说判断，下面的数字卡说数值 —— 不要把同一句话写两遍。 */
                    tone: "ok",
                    title: budgetEnabled ? "花费在预算之内" : "还没有设置预算，只能看到已花金额",
                    copy: budgetEnabled
                      ? `预算余量 ${money(budgetLeft)}（已用 ${budgetRatioPct ?? "—"}%），按当前速度不会触线。`
                      : "点右上「预算设置」，设一个数字就能看到余量和触线预测。",
                  };

  const costStats: StatStripItem[] = [
    {
      key: "spent",
      icon: WalletOutlined,
      label: `${RANGES.find((r) => r.value === rangeDays)?.label ?? ""}已花`,
      value: totalCost === null ? "—" : (totalCost * USD_TO_CNY).toFixed(2),
      unit: totalCost === null ? undefined : "元",
      sub:
        summary?.total.actualUsd !== null && summary?.total.actualUsd !== undefined
          ? "为实际账单金额"
          : summary !== null && summary.costAvailable
            ? "实际账单缺失，按估算列展示"
            : "读取中",
    },
    {
      key: "budget-left",
      icon: WalletOutlined,
      label: "预算余量",
      value: budgetLeft === null ? "未设预算" : (budgetLeft * USD_TO_CNY).toFixed(2),
      unit: budgetLeft === null ? undefined : "元",
      tone: budgetEnabled && (budget.threshold === "100%" || budget.threshold === "over")
        ? "error"
        : budgetEnabled && budget.threshold === "80%"
          ? "warn"
          : undefined,
      sub: budgetRatioPct === null ? "点右上「预算设置」开始" : `本月已用 ${budgetRatioPct}%`,
    },
    {
      key: "daily-burn",
      icon: ThunderboltOutlined,
      label: "日均燃速",
      value: dailyBurn === null ? "—" : (dailyBurn * USD_TO_CNY).toFixed(2),
      unit: dailyBurn === null ? undefined : "元/天",
      sub: projectedLabel === "" ? `按 ${dayCount} 天窗口计算` : projectedLabel,
    },
  ];

  return (
    <section className="cost-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="成本"
          extra={
            <Button icon={<SettingOutlined />} onClick={openBudgetModal}>
              预算设置
            </Button>
          }
        />

        {/* §2.3 ② 结论条：把「花了多少、会不会超」放在数字之前。 */}
        <ConclusionBar
          tone={conclusion.tone}
          title={conclusion.title}
          copy={conclusion.copy}
          action={conclusion.action}
          extra={
            budgetFootNote === null ? undefined : (
              <Typography.Text type="secondary">{budgetFootNote}</Typography.Text>
            )
          }
        />

        <StatStrip items={costStats} />

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
            <Empty title="窗口内还没有用量" hint="换个时间区间看看，或等管家记录到新的调用。" mascotWidth={72} />
          ) : (
            <Flex vertical gap={12}>
              {summary.models.map((model) => {
                const cost = model.actualCostUsd ?? model.estimatedCostUsd ?? 0;
                return (
                  <div key={model.model}>
                    <Flex justify="space-between" style={{ marginBottom: 4 }}>
                      <Typography.Text ellipsis style={{ maxWidth: "70%" }}>{model.model}</Typography.Text>
                      <Typography.Text strong>{money(model.actualCostUsd ?? model.estimatedCostUsd)}</Typography.Text>
                    </Flex>
                    {/* 0 成本时不画条：空轨道会被读成「加载中」或「坏了」，
                        而「—」已经把「这条没有金额」说清楚了。 */}
                    {cost > 0 ? (
                      <Progress
                        percent={Math.round((cost / maxModelCost) * 100)}
                        showInfo={false}
                        strokeColor={{
                          from: "var(--ab-primary)",
                          to: "color-mix(in srgb, var(--ab-primary) 45%, var(--ab-surface))",
                        }}
                        size="small"
                      />
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        有调用记录，但金额字段还没回填
                      </Typography.Text>
                    )}
                  </div>
                );
              })}
            </Flex>
          )}
        </Card>

        <Card title="按日成本">
          {summary === null || summary.days.length === 0 ? (
            <Empty title="窗口内还没有按日数据" hint="管家按天汇总用量；有记录后这里会画出趋势。" mascotWidth={72} />
          ) : (
            <>
              {/* 键盘/触屏用户拿不到 hover Tooltip，所以把可读结论先写在卡头（评审 P2-5）。 */}
              <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                峰值 {money(maxDayCost >= 0.000001 ? maxDayCost : 0)} · 合计 {money(totalCost)}
              </Typography.Text>
              <Flex gap={4} align="flex-end" style={{ height: 120 }}>
                {summary.days.map((day) => {
                  const cost = day.actualCostUsd ?? day.estimatedCostUsd ?? 0;
                  const height = Math.max(2, Math.round((cost / maxDayCost) * 100));
                  return (
                    <Tooltip key={day.date} title={`${day.date}：${money(day.actualCostUsd ?? day.estimatedCostUsd)}`}>
                      <div
                        tabIndex={0}
                        role="img"
                        aria-label={`${day.date}：${money(day.actualCostUsd ?? day.estimatedCostUsd)}`}
                        style={{
                          flex: 1,
                          height: `${height}%`,
                          background:
                            "linear-gradient(180deg, var(--ab-primary), color-mix(in srgb, var(--ab-primary) 45%, var(--ab-surface)))",
                          borderRadius: 2,
                          minWidth: 6,
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </Flex>
            </>
          )}
        </Card>

        <Card title="最贵会话 TOP10">
          <Table
            size="small"
            rowKey={(record) => `${record.sessionId}-${record.model}`}
            columns={columns}
            dataSource={summary?.sessions ?? []}
            pagination={false}
            locale={{ emptyText: <Empty title="还没有会话成本记录" hint="管家会按会话归集用量；有调用后这里会列出最贵的几条。" mascot={false} /> }}
          />
        </Card>

        <Modal
          title="预算设置"
          open={budgetModalOpen}
          onCancel={() => setBudgetModalOpen(false)}
          onOk={() => void saveBudget()}
          okText="保存"
          confirmLoading={budgetSaving}
          destroyOnHidden
        >
          <Flex vertical gap={8} style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary">
              按自然月核算（优先真实账单，缺失时用估算）。达到 80% 告警一次，达到 100% 触发下方动作；
              填 0 表示关闭预算。
            </Typography.Text>
          </Flex>
          <Form form={budgetForm} layout="vertical" requiredMark={false}>
            <Form.Item
              name="monthlyCny"
              label="月度预算（元）"
              rules={[
                { required: true, message: "请输入月度预算（0 为关闭）" },
                { type: "number", min: 0, max: 720_000, message: "请输入 0 ~ 720,000 之间的金额" },
              ]}
            >
              <InputNumber
                style={{ width: "100%" }}
                min={0}
                max={720_000}
                step={50}
                precision={2}
                addonAfter="元 / 月"
                placeholder="例如 200"
              />
            </Form.Item>
            <Form.Item name="action" label="达到 100% 时的建议动作" initialValue="alert">
              <Select
                options={[
                  { value: "alert", label: "仅告警（推荐）" },
                  { value: "downgrade", label: "建议切换降级模型白名单" },
                  { value: "pause", label: "建议进入全局急停" },
                ]}
              />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              动作是「建议」而非自动执行——真正停掉 agent 仍需你在急停页确认。预算保存后立即生效，重启后仍保留。
            </Typography.Text>
          </Form>
        </Modal>
      </Flex>
    </section>
  );
}
