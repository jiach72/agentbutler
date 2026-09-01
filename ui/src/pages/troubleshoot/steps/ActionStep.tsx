/**
 * 第 3 步：让用户选一个动作。
 *
 * 三条纪律：
 * 1）可用的排在前面，推荐的默认选中——用户不想选就直接用默认。
 * 2）不可用的动作不隐藏，折叠起来说明"为什么不能做"和"怎么才能做"，
 *    否则用户会以为是产品坏了。
 * 3）风险用后果说（会中断服务），不用等级说（high risk）。
 */
import { Alert, Card, Collapse, Flex, Radio, Typography } from "antd";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { RecoveryActionView } from "../../dashboard/types.js";
import type { SymptomId } from "../symptoms.js";
import { WizardNav } from "./SymptomStep.js";

const RISK_LABEL: Record<RecoveryActionView["risk"], { text: string; tone: "ok" | "warn" | "error" }> = {
  low: { text: "不影响使用", tone: "ok" },
  medium: { text: "会有短暂影响", tone: "warn" },
  high: { text: "会中断服务", tone: "error" },
};

interface ActionStepProps {
  ranked: RecoveryActionView[];
  recommended: RecoveryActionView | null;
  selected: string | null;
  symptom: SymptomId;
  busy: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  onRun: (action: RecoveryActionView) => void;
}

export function ActionStep({
  ranked,
  recommended,
  selected,
  busy,
  onSelect,
  onBack,
  onRun,
}: ActionStepProps) {
  const available = ranked.filter((action) => action.available);
  const unavailable = ranked.filter((action) => !action.available);
  const chosen = ranked.find((action) => action.id === selected) ?? null;

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ marginBottom: 0 }}>你想怎么处理？</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        已经按「先试影响最小的」排好序。没有把握就用推荐的那一个。
      </Typography.Paragraph>

      {available.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="现在没有可以自动执行的动作"
          description="检查项都通过了，或者当前环境不支持自动处理。可以先导出诊断报告，把它发给能帮你的人。"
        />
      ) : (
        <Radio.Group
          value={selected ?? undefined}
          onChange={(event) => onSelect(String(event.target.value))}
          style={{ display: "grid", gap: 12 }}
        >
          {available.map((action) => {
            const risk = RISK_LABEL[action.risk];
            return (
              <Card key={action.id} size="small" variant="outlined">
                <Radio value={action.id}>
                  <Flex vertical gap={6}>
                    <Flex align="center" gap={8} wrap>
                      <Typography.Text strong>{action.label}</Typography.Text>
                      {recommended?.id === action.id && (
                        <StatusBadge tone="info" label="推荐" />
                      )}
                    </Flex>
                    <Typography.Text type="secondary">{action.description}</Typography.Text>
                    <Flex wrap gap={10} align="center">
                      <StatusBadge tone={risk.tone} label={risk.text} />
                      <Typography.Text type="secondary">{action.impact}</Typography.Text>
                      <Typography.Text type="secondary">约 {action.estimatedSeconds} 秒</Typography.Text>
                    </Flex>
                  </Flex>
                </Radio>
              </Card>
            );
          })}
        </Radio.Group>
      )}

      {unavailable.length > 0 && (
        <Collapse
          items={[
            {
              key: "unavailable",
              label: `还有 ${unavailable.length} 个动作现在用不了（点开看原因）`,
              children: (
                <Flex vertical gap={12}>
                  {unavailable.map((action) => (
                    <Card size="small" key={action.id} variant="outlined">
                      <Flex vertical gap={4}>
                        <Typography.Text strong>{action.label}</Typography.Text>
                        <Typography.Text type="secondary">{action.unavailableReason ?? "当前环境不支持"}</Typography.Text>
                        {action.unavailableFix !== undefined && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            想用上的话：{action.unavailableFix}
                          </Typography.Text>
                        )}
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              ),
            },
          ]}
        />
      )}

      <WizardNav
        onBack={onBack}
        onNext={chosen === null ? undefined : () => onRun(chosen)}
        nextLabel={chosen === null ? "先选一个动作" : `执行「${chosen.label}」`}
        nextDisabled={chosen === null}
        busy={busy}
      />
    </Flex>
  );
}
