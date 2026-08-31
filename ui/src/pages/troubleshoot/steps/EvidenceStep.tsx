/**
 * 第 2 步：展示查到了什么，以及凭什么这么说。
 *
 * 关键设计：**先给证据，再给结论**。用户看到「最近一次 5 分钟前，累计 17 次」
 * 自己就能判断严不严重；只丢一句「系统错误」他只能瞎猜或者吓一跳。
 */
import { Alert, Button } from "antd";
import { formatRelative } from "../../../lib/format.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { RecoveryDiagnosisView, RecoveryEvidenceView } from "../../dashboard/types.js";
import type { SymptomId } from "../symptoms.js";
import { findSymptom } from "../symptoms.js";
import { WizardNav } from "./SymptomStep.js";

/** 把证据说成人话。 */
function evidenceText(evidence: RecoveryEvidenceView): string {
  const parts: string[] = [];
  if (evidence.lastSeenLabel !== null) parts.push(`最近一次 ${evidence.lastSeenLabel}`);
  if (evidence.occurrences > 0) parts.push(`累计 ${evidence.occurrences} 次`);
  if (evidence.source !== null && evidence.source !== "") parts.push(`来源 ${evidence.source}`);
  return parts.length === 0 ? "时间不明确" : parts.join(" · ");
}

const PROBE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "error" | "muted" }> = {
  pass: { label: "正常", tone: "ok" },
  warn: { label: "需留意", tone: "warn" },
  fail: { label: "不正常", tone: "error" },
};

interface EvidenceStepProps {
  diagnosis: RecoveryDiagnosisView;
  symptom: SymptomId;
  onBack: () => void;
  onNext: () => void;
}

export function EvidenceStep({ diagnosis, symptom, onBack, onNext }: EvidenceStepProps) {
  const primary = diagnosis.primaryFinding;
  const historical = diagnosis.historicalFindingCount;

  return (
    <div className="wizard-step">
      <h2 className="wizard-question">查完了，结果是这样</h2>
      <p className="wizard-lead">
        你反馈的是「{findSymptom(symptom).label}」，下面是各项检查的结果和依据。
      </p>

      {diagnosis.rootCause !== null ? (
        <Alert
          className="wizard-verdict"
          type="error"
          showIcon
          message={`找到明确的问题：${diagnosis.rootCause}`}
          description={`${diagnosis.summary ?? "这项检查没有通过"}${diagnosis.safeToRetry === false ? "；不建议直接重试，请先按下一步处理。" : "；下一步可以选择对应的处理方式。"}`}
        />
      ) : primary !== null ? (
        <Alert
          className="wizard-verdict"
          type="warning"
          showIcon
          message={`运行正常，但日志里有提醒：${primary.title}`}
          description={`${primary.detail}（${evidenceText(primary.evidence)}）`}
        />
      ) : (
        <Alert
          className="wizard-verdict"
          type="success"
          showIcon
          message="检查项全部通过"
          description={
            historical > 0
              ? `最近没有新问题。更早的日志里有 ${historical} 条历史提醒，不影响当前运行。`
              : "没有发现需要处理的问题。"
          }
        />
      )}

      <div className="evidence-probes">
        {diagnosis.probes.map((probe) => {
          const status = PROBE_STATUS[probe.status] ?? { label: probe.status, tone: "muted" as const };
          return (
            <div className="evidence-probe" key={probe.id}>
              <StatusBadge tone={status.tone} label={status.label} />
              <div>
                <strong>{probe.label}</strong>
                <small>{probe.detail}</small>
              </div>
            </div>
          );
        })}
      </div>

      {diagnosis.findings.length > 0 && (
        <div className="evidence-findings">
          <h3>最近一天共 {diagnosis.findings.length} 类提醒</h3>
          <ul>
            {diagnosis.findings.map((finding) => (
              <li key={finding.id}>
                <span className="evidence-finding-title">{finding.title}</span>
                <small>{evidenceText(finding.evidence)}</small>
                <p>{finding.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="evidence-time">检查时间：{formatRelative(diagnosis.checkedAt)}</p>

      <WizardNav onBack={onBack} onNext={onNext} nextLabel="看看能怎么处理" />
      <div className="wizard-nav">
        <Button type="link" size="small" href="/logs">
          想看原始日志
        </Button>
      </div>
    </div>
  );
}
