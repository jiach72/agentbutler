/**
 * 排查问题页（v2 自动体检版）。
 *
 * v1 的问题：用户带着焦虑来求助，第一屏却让他先选现象——把「看一眼结论」
 * 变成了四步流程。v2 改为「状态优先于流程」：进入页面即静默体检
 * （与向导同一后端诊断，无额外成本），正常用户 0 点击见结论；
 * 有问题时直接给「最可能原因 + 推荐动作 1 键执行」。
 * 完整四步向导保留（含从告警深链 ?symptom= 直达），供想手动分诊的进阶用户。
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Flex } from "antd";
import { PageHeader } from "../../components/PageHeader.js";
import { PageProgress } from "../../components/PageProgress.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { SymptomStep, WizardSteps } from "./steps/SymptomStep.js";
import { EvidenceStep } from "./steps/EvidenceStep.js";
import { ActionStep } from "./steps/ActionStep.js";
import { ResultStep } from "./steps/ResultStep.js";
import { TriageOverview } from "./steps/TriageOverview.js";
import { useTroubleshoot } from "./useTroubleshoot.js";
import { isSymptomId } from "./symptoms.js";
import "./troubleshoot.css";

const STAGE_INDEX: Record<string, number> = {
  symptom: 0,
  evidence: 1,
  action: 2,
  result: 3,
};

export function TroubleshootPage() {
  const wizard = useTroubleshoot();
  const [searchParams] = useSearchParams();
  const startedFromIssue = useRef(false);
  const requestedSymptom = searchParams.get("symptom");

  // 深链（告警/首页 issue 卡带 ?symptom=）直接进向导对应现象，跳过总览。
  useEffect(() => {
    if (startedFromIssue.current || wizard.stage !== null || !isSymptomId(requestedSymptom)) return;
    startedFromIssue.current = true;
    wizard.chooseSymptom(requestedSymptom);
  }, [requestedSymptom, wizard.chooseSymptom, wizard.stage]);

  const jobRunning = wizard.job !== null && wizard.job.status === "running";

  return (
    <section className="troubleshoot-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="排查问题"
          description={
            wizard.stage === null
              ? "进来就先做一轮完整体检：正常直接告诉你没事，有问题给出原因和最快的处理方式。"
              : "按现象一步步排查：先描述问题，管家收集证据并给出可执行的处理方案。"
          }
          extra={
            wizard.stage !== null ? (
              <Flex>
                <a
                  href="#back-to-overview"
                  onClick={(event) => {
                    event.preventDefault();
                    wizard.backToOverview();
                  }}
                  style={{ fontSize: 13 }}
                >
                  ← 回到体检总览
                </a>
              </Flex>
            ) : undefined
          }
        />

        {wizard.stage === null && (
          <TriageOverview
            triage={wizard.triage}
            triageBusy={wizard.triageBusy}
            diagnosis={wizard.diagnosis}
            recommended={wizard.recommended}
            alternatives={wizard.ranked.filter((action) => action.available && action.id !== wizard.recommended?.id)}
            jobRunning={jobRunning}
            jobDetail={wizard.job?.detail ?? ""}
            jobProgress={wizard.job?.progress ?? 0}
            busy={wizard.busy}
            onRerun={wizard.rerunTriage}
            onRunAction={wizard.requestAction}
            onOpenWizard={wizard.openWizard}
          />
        )}

        {wizard.stage !== null && (
          <>
            <WizardSteps current={STAGE_INDEX[wizard.stage] ?? 0} />

            {wizard.stage === "symptom" && (
              <SymptomStep busy={wizard.busy} onChoose={wizard.chooseSymptom} />
            )}

            {wizard.stage === "evidence" && wizard.diagnosis !== null && (
              <EvidenceStep
                diagnosis={wizard.diagnosis}
                symptom={wizard.symptom}
                onBack={() => wizard.setStage("symptom")}
                onNext={() => wizard.setStage("action")}
              />
            )}

            {wizard.stage === "action" && wizard.diagnosis !== null && (
              <ActionStep
                ranked={wizard.ranked}
                recommended={wizard.recommended}
                selected={wizard.selected}
                symptom={wizard.symptom}
                busy={wizard.busy}
                onSelect={wizard.setSelected}
                onBack={() => wizard.setStage("evidence")}
                onRun={wizard.requestAction}
              />
            )}

            {wizard.stage === "result" && (
              <ResultStep
                job={wizard.job}
                outcome={wizard.outcome}
                diagnosis={wizard.diagnosis}
                busy={wizard.busy}
                onBack={() => wizard.setStage("action")}
                onRestart={wizard.restart}
              />
            )}

            {wizard.stage !== "symptom" && wizard.diagnosis === null && (
              <PageProgress title="正在读取诊断结果" detail="查完后会自动进入下一步。" />
            )}
          </>
        )}

        <span id="back-to-overview" aria-hidden="true" />

        <DangerConfirmModal
          open={wizard.pendingAction !== null}
          title={wizard.pendingAction === null ? "确认执行" : `确认执行「${wizard.pendingAction.label}」？`}
          impact={wizard.pendingAction?.impact}
          reversible="可以。执行前会创建当前状态快照，可据此回退。"
          // 耗时用后端给的真实估算，不编数字。
          duration={
            wizard.pendingAction === null
              ? "通常几十秒内完成。"
              : `约 ${wizard.pendingAction.estimatedSeconds} 秒，期间相关服务可能短暂不可用。`
          }
          // 高风险动作（规范 03 §3.7）要求手动勾选，不能一键即走。
          acknowledge={wizard.pendingAction?.risk === "high" ? "我了解这项操作风险较高，仍要执行" : undefined}
          steps={wizard.pendingAction === null ? undefined : ["创建当前状态快照", wizard.pendingAction.description, "完成后自动复查结果"]}
          confirmLabel="确认执行"
          busy={wizard.busy}
          onCancel={wizard.cancelPendingAction}
          onConfirm={wizard.confirmAction}
        >
          {wizard.pendingAction === null
            ? ""
            : "这项操作会修改本机运行状态。请确认你了解上面的影响后再继续。"}
        </DangerConfirmModal>
      </Flex>
    </section>
  );
}
