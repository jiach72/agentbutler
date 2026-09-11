/**
 * 排查向导：选现象 → 看证据 → 选动作 → 看结果。
 *
 * 这个页面存在的理由：原来的「诊断与修复」是一个平铺的动作卡片列表，
 * 用户打开看到六张卡不知道该点哪个，点完也不知道到底修好没有。
 * 向导把同样的后端能力重新组织成一条用户能走完的路。
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

  useEffect(() => {
    if (startedFromIssue.current || wizard.stage !== "symptom" || !isSymptomId(requestedSymptom)) return;
    startedFromIssue.current = true;
    wizard.chooseSymptom(requestedSymptom);
  }, [requestedSymptom, wizard.chooseSymptom, wizard.stage]);

  return (
    <section className="troubleshoot-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="维护与升级"
          title="排查问题"
          description="按现象一步步排查：先描述问题，管家收集证据并给出可执行的处理方案。"
        />

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

        <DangerConfirmModal
          open={wizard.pendingAction !== null}
          title={wizard.pendingAction === null ? "确认执行" : `确认执行「${wizard.pendingAction.label}」？`}
          impact={wizard.pendingAction?.impact}
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
