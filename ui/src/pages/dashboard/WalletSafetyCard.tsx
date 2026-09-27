import { useCallback, useEffect, useState } from "react";
import { App, Button, Form, InputNumber, Modal, Progress, Radio } from "antd";
import { SafetyCertificateOutlined, SettingOutlined, WarningOutlined } from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { USD_TO_CNY } from "../../lib/format.js";

export interface BudgetStatus {
  enabled: boolean;
  budgetUsd: number;
  action: "alert" | "downgrade" | "pause" | string;
  month: string;
  spentUsd: number | null;
  spentSource: "actual" | "estimated" | null;
  ratio: number | null;
  threshold: "ok" | "80%" | "100%" | "over";
  projectedExhaustedAt: string | null;
  lastCheckedAt: string | null;
}

export interface WalletSafetyCardProps {
  className?: string;
}

export function WalletSafetyCard({ className = "" }: WalletSafetyCardProps) {
  const { message } = App.useApp();
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ monthlyCny: number; action: "pause" | "downgrade" | "alert" }>();

  const fetchBudget = useCallback(async () => {
    const res = await loadJson<BudgetStatus>("/api/budget", 6_000);
    if (res.ok) {
      setBudget(res.data);
    }
  }, []);

  useEffect(() => {
    void fetchBudget();
  }, [fetchBudget]);

  const openConfig = useCallback(() => {
    const currentCny = budget !== null && budget.enabled && budget.budgetUsd > 0
      ? Math.round(budget.budgetUsd * USD_TO_CNY * 100) / 100
      : 100;
    form.setFieldsValue({
      monthlyCny: currentCny,
      action: (budget?.action as "pause" | "downgrade" | "alert") || "pause",
    });
    setModalOpen(true);
  }, [budget, form]);

  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const monthlyUsd = Math.round((values.monthlyCny / USD_TO_CNY) * 100) / 100;
      const res = await postJson("/api/budget", { monthlyUsd, action: values.action }, 15_000);
      setSaving(false);
      if (res.ok) {
        message.success(values.monthlyCny > 0 ? `预算安全阀已设定为 ¥${values.monthlyCny}/月` : "预算安全阀已停用");
        setModalOpen(false);
        await fetchBudget();
      } else {
        message.error(`保存失败（HTTP ${res.status}）`);
      }
    } catch {
      setSaving(false);
    }
  }, [form, message, fetchBudget]);

  const isEnabled = budget !== null && budget.enabled && budget.budgetUsd > 0;
  const spentUsd = budget?.spentUsd ?? 0;
  const budgetUsd = budget?.budgetUsd ?? 0;
  const ratio = isEnabled && budgetUsd > 0 ? Math.min(100, Math.round((spentUsd / budgetUsd) * 100)) : 0;
  const spentCny = (spentUsd * USD_TO_CNY).toFixed(2);
  const budgetCny = (budgetUsd * USD_TO_CNY).toFixed(2);
  const remainingCny = Math.max(0, (budgetUsd - spentUsd) * USD_TO_CNY).toFixed(2);

  const isOver = isEnabled && (budget?.threshold === "over" || budget?.threshold === "100%" || spentUsd >= budgetUsd);
  const isWarn = isEnabled && (budget?.threshold === "80%" || ratio >= 80);

  const actionLabel = budget?.action === "pause" ? "熔断暂停" : budget?.action === "downgrade" ? "降级模型" : "仅通知";

  return (
    <div
      className={`rounded-2xl bg-surface-container-lowest p-4 md:p-5 shadow-xs border border-outline-variant/15 flex flex-col justify-between bento-card-hover transition-all ${className}`}
    >
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b border-surface-container">
          <div className="flex items-center gap-2">
            <SafetyCertificateOutlined className={`text-base ${isOver ? "text-error" : isWarn ? "text-amber-500" : "text-tertiary"}`} />
            <h3 className="text-sm md:text-base font-semibold text-on-surface">AI 钱包与预算安全阀</h3>
          </div>
          <div className="flex items-center gap-2">
            {isEnabled ? (
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold flex items-center gap-1 ${
                  isOver
                    ? "bg-error-container/50 text-error"
                    : isWarn
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                    : "bg-tertiary-container/10 text-tertiary"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isOver ? "bg-error pulse-warning" : isWarn ? "bg-amber-500" : "bg-tertiary"}`} />
                {isOver ? "已触线熔断" : isWarn ? "消耗预警" : "安全守护中"}
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-xs font-medium">
                未启用安全阀
              </span>
            )}
          </div>
        </div>

        {/* Content Body */}
        {isEnabled ? (
          <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/15 space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                <span className="text-xs text-on-surface-variant">本月模型消耗</span>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className="text-2xl font-bold font-mono text-on-surface tracking-tight">¥{spentCny}</span>
                  <span className="text-xs text-on-surface-variant font-mono">/ ¥{budgetCny}</span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs text-on-surface-variant">触线策略</span>
                <div className="font-semibold text-xs text-on-surface mt-0.5">
                  <span className="px-2 py-0.5 rounded-md bg-surface-container font-mono">{actionLabel}</span>
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div>
              <div className="flex justify-between text-xs text-on-surface-variant mb-1 font-mono">
                <span>用量比例: {ratio}%</span>
                <span>剩余额度: ¥{remainingCny}</span>
              </div>
              <Progress
                percent={ratio}
                showInfo={false}
                strokeColor={isOver ? "var(--ab-error, #b4342a)" : isWarn ? "#f59e0b" : "var(--ab-ok, #0a7667)"}
                trailColor="var(--ab-surface-container, rgba(0,0,0,0.06))"
                size={["100%", 7]}
              />
            </div>

            <p className="text-xs text-on-surface-variant leading-relaxed">
              {isOver
                ? "⚠️ 本月消耗已达到或超过预设限额！管家已按策略触发保护，防止 API 费用失控。"
                : isWarn
                ? "⚡ 本月消耗已超过 80%，请留意高频自动化任务或调整预算额度。"
                : "🛡️ 实时防死循环扣费：若智能体陷入反复工具调用或死循环，达到限额将自动保护。"}
            </p>
          </div>
        ) : (
          <div className="p-3.5 rounded-xl bg-surface-container-low border border-dashed border-outline-variant/40 space-y-2.5">
            <div className="flex items-center gap-2">
              <WarningOutlined className="text-amber-500" />
              <span className="text-xs md:text-sm font-semibold text-on-surface">当前未设防刷限额</span>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              本月已消耗 <span className="font-mono font-semibold text-on-surface">¥{spentCny}</span>。建议开启月度预算安全阀，避免智能体陷入死循环或大上下文消耗导致 API 账单超支。
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="small" type="primary" onClick={openConfig}>
                立即开启安全阀
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="pt-3 flex items-center justify-between border-t border-surface-container mt-3">
        <span className="text-xs text-on-surface-variant font-mono">
          {isEnabled ? `结算周期: ${budget?.month ?? "本月"} · 汇率 1$ ≈ ¥7.2` : "保护您的模型 API Key 钱包"}
        </span>
        <Button
          size="small"
          icon={<SettingOutlined />}
          onClick={openConfig}
          className="text-xs font-medium"
        >
          {isEnabled ? "调整限额与动作" : "配置预算限额"}
        </Button>
      </div>

      {/* Settings Modal */}
      <Modal
        title={
          <div className="flex items-center gap-2">
            <SafetyCertificateOutlined className="text-primary text-base" />
            <span>配置月度预算安全阀</span>
          </div>
        }
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="保存配置"
        cancelText="取消"
        destroyOnClose
      >
        <div className="py-2 space-y-4">
          <p className="text-xs text-on-surface-variant leading-relaxed">
            设定单月允许智能体消耗的最高金额。超出后管家将按所选策略执行防护，彻底杜绝模型失控。
          </p>
          <Form form={form} layout="vertical" initialValues={{ monthlyCny: 100, action: "pause" }}>
            <Form.Item
              name="monthlyCny"
              label="月度预算上限（人民币 元）"
              rules={[{ required: true, message: "请输入月度预算金额" }]}
              extra="设为 0 可关闭限额保护"
            >
              <InputNumber
                min={0}
                max={50000}
                precision={2}
                prefix="¥"
                style={{ width: "100%" }}
                placeholder="例如 100"
              />
            </Form.Item>

            {/* Quick amount capsules */}
            <div className="flex items-center gap-2 -mt-2 mb-3">
              <span className="text-xs text-on-surface-variant">快捷金额:</span>
              {[50, 100, 200, 500].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => form.setFieldValue("monthlyCny", amt)}
                  className="px-2.5 py-0.5 rounded-full text-xs bg-surface-container hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer border border-outline-variant/20"
                >
                  ¥{amt}
                </button>
              ))}
            </div>

            <Form.Item
              name="action"
              label="达到上限后执行的动作"
              rules={[{ required: true }]}
            >
              <Radio.Group className="w-full space-y-2">
                <Radio value="pause" className="w-full p-2.5 rounded-xl border border-outline-variant/20 !flex items-start">
                  <div>
                    <div className="font-semibold text-xs md:text-sm text-on-surface">🛑 熔断暂停（推荐）</div>
                    <div className="text-xs text-on-surface-variant mt-0.5">达到上限后立即暂停受管任务和自动化执行，绝不超支</div>
                  </div>
                </Radio>
                <Radio value="downgrade" className="w-full p-2.5 rounded-xl border border-outline-variant/20 !flex items-start">
                  <div>
                    <div className="font-semibold text-xs md:text-sm text-on-surface">🔄 降级模型</div>
                    <div className="text-xs text-on-surface-variant mt-0.5">自动降级至本地或低成本小模型继续基础服务</div>
                  </div>
                </Radio>
                <Radio value="alert" className="w-full p-2.5 rounded-xl border border-outline-variant/20 !flex items-start">
                  <div>
                    <div className="font-semibold text-xs md:text-sm text-on-surface">🔔 仅发送告警通知</div>
                    <div className="text-xs text-on-surface-variant mt-0.5">向消息通道发送超额通知，不中断后台运行</div>
                  </div>
                </Radio>
              </Radio.Group>
            </Form.Item>
          </Form>
        </div>
      </Modal>
    </div>
  );
}
