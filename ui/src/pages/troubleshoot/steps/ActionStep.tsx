/**
 * 第 3 步：让用户选一个动作。
 *
 * 三条纪律：
 * 1）可用的排在前面，推荐的默认选中——用户不想选就直接用默认。
 * 2）不可用的动作不隐藏，折叠起来说明"为什么不能做"和"怎么才能做"，
 *    否则用户会以为是产品坏了。
 * 3）风险用后果说（会中断服务），不用等级说（high risk）。
 */
import { Alert, Card, Radio } from "antd";
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
    <div className="wizard-step">
      <h2 className="wizard-question">你想怎么处理？</h2>
      <p className="wizard-lead">
        已经按「先试影响最小的」排好序。没有把握就用推荐的那一个。
      </p>

      {available.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="现在没有可以自动执行的动作"
          description="检查项都通过了，或者当前环境不支持自动处理。可以先导出诊断报告，把它发给能帮你的人。"
        />
      ) : (
        <Radio.Group
          className="action-choices"
          value={selected ?? undefined}
          onChange={(event) => onSelect(String(event.target.value))}
        >
          {available.map((action) => {
            const risk = RISK_LABEL[action.risk];
            return (
              <div className="action-choice" key={action.id}>
                <Radio value={action.id}>
                  <span className="action-choice-title">
                    {action.label}
                    {recommended?.id === action.id && (
                      <StatusBadge tone="info" label="推荐" />
                    )}
                  </span>
                </Radio>
                <div className="action-choice-body">
                  <p>{action.description}</p>
                  <p className="action-choice-meta">
                    <StatusBadge tone={risk.tone} label={risk.text} />
                    <span>{action.impact}</span>
                    <span>约 {action.estimatedSeconds} 秒</span>
                  </p>
                </div>
              </div>
            );
          })}
        </Radio.Group>
      )}

      {unavailable.length > 0 && (
        <details className="action-unavailable">
          <summary>
            还有 {unavailable.length} 个动作现在用不了（点开看原因）
          </summary>
          <div className="action-unavailable-body">
            {unavailable.map((action) => (
              <Card size="small" key={action.id} className="action-unavailable-card">
                <strong>{action.label}</strong>
                <p>{action.unavailableReason ?? "当前环境不支持"}</p>
                {action.unavailableFix !== undefined && (
                  <small className="action-unavailable-fix">
                    想用上的话：{action.unavailableFix}
                  </small>
                )}
              </Card>
            ))}
          </div>
        </details>
      )}

      <WizardNav
        onBack={onBack}
        onNext={chosen === null ? undefined : () => onRun(chosen)}
        nextLabel={chosen === null ? "先选一个动作" : `执行「${chosen.label}」`}
        nextDisabled={chosen === null}
        busy={busy}
      />
    </div>
  );
}
