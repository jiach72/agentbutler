/**
 * 第 4 步：给一个明确的成败结论。
 *
 * 最忌讳的是"执行完了"这种没有结论的话。用户需要知道：
 * 到底修好了没有？没修好现在是什么状态（有没有被我搞坏）？接下来还能做什么？
 */
import { Alert, Button, Progress, Space } from "antd";
import type { RecoveryDiagnosisView, RecoveryJobView } from "../../dashboard/types.js";
import type { WizardOutcome } from "../useTroubleshoot.js";
import { useExportReport } from "../exportReport.js";
import { guidanceForDiagnosis } from "../guidance.js";

interface ResultStepProps {
  job: RecoveryJobView | null;
  outcome: WizardOutcome | null;
  diagnosis: RecoveryDiagnosisView | null;
  busy: boolean;
  onBack: () => void;
  onRestart: () => void;
}

export function ResultStep({ job, outcome, diagnosis, busy, onBack, onRestart }: ResultStepProps) {
  const { exportReport } = useExportReport();
  const running = job !== null && job.status === "running";
  const guidance = guidanceForDiagnosis(diagnosis);

  return (
    <div className="wizard-step">
      <h2 className="wizard-question">
        {running ? "正在处理…" : outcome === null ? "处理完成" : outcome.label}
      </h2>

      {running && job !== null && (
        <>
          <p className="wizard-lead">{job.detail}</p>
          <Progress percent={job.progress} status="active" />
          <p className="wizard-busy" role="status">
            这一步大概需要一点时间，页面会自动更新结果，不用手动刷新。
          </p>
        </>
      )}

      {!running && outcome !== null && (
        <Alert
          className="wizard-verdict"
          type={outcome.state === "fixed" ? "success" : "warning"}
          showIcon
          message={outcome.label}
          description={outcome.detail}
        />
      )}

      {!running && outcome === null && (
        <Alert
          className="wizard-verdict"
          type="info"
          showIcon
          message="正在复查处理结果"
          description="动作已经执行完，管家正在确认问题是否解决，稍等一下就会给出结论。"
        />
      )}

      {!running && (
        <div className="wizard-next-actions">
          <Space wrap>
            {outcome?.state === "unresolved" && (
              <>
                <Button type="primary" onClick={onBack}>换个办法再试</Button>
                <Button href={guidance.to}>{guidance.label}</Button>
              </>
            )}
            <Button onClick={() => void exportReport()} loading={busy}>
              下载诊断报告
            </Button>
            <Button type="link" onClick={onRestart}>
              重新排查
            </Button>
          </Space>
          <p className="wizard-hint">
            没修好也不用担心：管家在每个动作执行前都做了快照，不会把状态搞得更糟。
            {outcome?.state === "unresolved" ? ` ${guidance.detail}` : " 下载报告后贴到项目的 Issue 里，能帮你的人一眼就能看到全貌。"}
          </p>
        </div>
      )}
    </div>
  );
}
