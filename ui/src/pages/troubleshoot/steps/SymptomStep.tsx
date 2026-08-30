/**
 * 第 1 步：让用户用自己的话描述现象。
 *
 * 这一步的意义是把用户从"我不知道该点哪个按钮"里解出来。
 * 选项不带任何技术分类，用户凭直觉选即可；选什么都不会漏掉后面的证据。
 */
import { Button, Card } from "antd";
import { SYMPTOMS, type SymptomId } from "../symptoms.js";

interface SymptomStepProps {
  busy: boolean;
  onChoose: (id: SymptomId) => void;
}

export function SymptomStep({ busy, onChoose }: SymptomStepProps) {
  return (
    <div className="wizard-step">
      <h2 className="wizard-question">哪里不对劲？</h2>
      <p className="wizard-lead">
        选一个最接近的描述，管家会照着这个方向重点排查。选错了也没关系，所有检查结果都会完整显示。
      </p>
      <div className="symptom-grid">
        {SYMPTOMS.map((symptom) => (
          <Card
            key={symptom.id}
            className="symptom-card"
            variant="outlined"
            hoverable={!busy}
            role="button"
            tabIndex={0}
            aria-label={symptom.label}
            onClick={() => !busy && onChoose(symptom.id)}
            onKeyDown={(event) => {
              if (busy) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onChoose(symptom.id);
              }
            }}
          >
            <strong>{symptom.label}</strong>
            <small>{symptom.hint}</small>
          </Card>
        ))}
      </div>
      {busy && (
        <p className="wizard-busy" role="status">
          正在检查，请稍等…
        </p>
      )}
    </div>
  );
}

/** 步骤条：告诉用户现在到哪一步了，还剩几步。 */
export function WizardSteps({ current }: { current: number }) {
  const labels = ["描述问题", "查看证据", "选择处理", "确认结果"];
  return (
    <ol className="wizard-steps" aria-label="排查进度">
      {labels.map((label, index) => (
        <li
          key={label}
          className={
            index === current ? "is-current" : index < current ? "is-done" : "is-todo"
          }
          aria-current={index === current ? "step" : undefined}
        >
          <span className="wizard-step-index" aria-hidden="true">
            {index < current ? "✓" : index + 1}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** 步骤之间的导航按钮。 */
export function WizardNav({
  onBack,
  onNext,
  nextLabel = "下一步",
  nextDisabled = false,
  busy = false,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="wizard-nav">
      {onBack !== undefined && (
        <Button onClick={onBack} disabled={busy}>
          上一步
        </Button>
      )}
      {onNext !== undefined && (
        <Button type="primary" onClick={onNext} disabled={nextDisabled} loading={busy}>
          {nextLabel}
        </Button>
      )}
    </div>
  );
}
