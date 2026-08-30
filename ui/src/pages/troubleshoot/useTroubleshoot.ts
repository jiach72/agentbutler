/**
 * 排查向导的数据流：按现象诊断 → 执行动作 → 复验 → 收口。
 *
 * 与首页恢复流程的区别：这里始终保留完整的证据与全部动作（不可用的也展示原因），
 * 现象选择只改变推荐顺序，不隐藏任何信息。
 */
import { useCallback, useMemo, useState } from "react";
import { App } from "antd";
import { loadJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";
import type { RecoveryActionView, RecoveryDiagnosisView, RecoveryJobView } from "../dashboard/types.js";
import type { SymptomId } from "./symptoms.js";
import { DEFAULT_SYMPTOM, rankActions, recommendAction } from "./symptoms.js";

const JOB_POLL_MS = 1_000;
const VERIFY_POLL_MS = 3_000;
const VERIFY_WINDOW_MS = 90_000;

export type WizardStage = "symptom" | "evidence" | "action" | "result";

export interface WizardOutcome {
  /** 修好了 / 没修好 / 还没结论。 */
  state: "fixed" | "unresolved" | "unknown";
  label: string;
  detail: string;
}

export function useTroubleshoot() {
  const { message } = App.useApp();
  const [stage, setStage] = useState<WizardStage>("symptom");
  const [symptom, setSymptom] = useState<SymptomId>(DEFAULT_SYMPTOM);
  const [diagnosis, setDiagnosis] = useState<RecoveryDiagnosisView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<RecoveryJobView | null>(null);
  const [outcome, setOutcome] = useState<WizardOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyingLabel, setVerifyingLabel] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<RecoveryActionView | null>(null);

  const actions = diagnosis?.recommendedActions ?? [];
  const ranked = useMemo(() => rankActions(actions, symptom), [actions, symptom]);
  const recommended = useMemo(() => recommendAction(actions, symptom), [actions, symptom]);

  const runDiagnose = useCallback(async (selectedSymptom: SymptomId) => {
    setBusy(true);
    setOutcome(null);
    const result = await postJson("/api/recovery/diagnose", {}, 15_000);
    setBusy(false);
    if (!result.ok || !isRecord(result.data)) {
      message.error("没有读到诊断结果，请确认管家服务是否在运行");
      return;
    }
    const next = result.data as unknown as RecoveryDiagnosisView;
    setDiagnosis(next);
    setSelected(recommendAction(next.recommendedActions, selectedSymptom)?.id ?? null);
    setStage("evidence");
  }, [message]);

  /** 选完现象就开始查，不需要用户多点一次。 */
  const chooseSymptom = useCallback(
    (next: SymptomId) => {
      setSymptom(next);
      void runDiagnose(next);
    },
    [runDiagnose],
  );

  const pollJob = useCallback(async () => {
    if (job === null || job.status !== "running") return;
    const result = await loadJson<RecoveryJobView>(
      `/api/recovery/jobs/${encodeURIComponent(job.jobId)}`,
      8_000,
    );
    if (!result.ok) return;
    setJob(result.data);
    if (result.data.status === "running") return;
    setStage("result");
    if (result.data.status === "done") {
      setVerifyingLabel(result.data.label);
    } else {
      setOutcome({
        state: "unresolved",
        label: "没能自动修复",
        detail: `「${result.data.label}」执行未完成：${result.data.detail}。管家已在操作前做了快照，当前状态没有被破坏。`,
      });
    }
  }, [job]);
  usePolling(() => void pollJob(), job?.status === "running" ? JOB_POLL_MS : null);

  const verifyTick = useCallback(async () => {
    if (verifyingLabel === null) return;
    const started = job?.startedAt !== undefined ? Date.parse(job.startedAt) : Date.now();
    const result = await postJson("/api/recovery/diagnose", {}, 15_000);
    if (!result.ok || !isRecord(result.data)) return;
    const next = result.data as unknown as RecoveryDiagnosisView;
    setDiagnosis(next);

    if (next.severity === "ok") {
      setOutcome({
        state: "fixed",
        label: "修好了",
        detail: `「${verifyingLabel}」执行完成，复查确认问题已经解决。`,
      });
      setVerifyingLabel(null);
      return;
    }
    // 还没好就继续复查，超过窗口才收口——避免刚重启完就被判失败。
    if (Date.now() - started >= VERIFY_WINDOW_MS) {
      setOutcome({
        state: "unresolved",
        label: "试过了，还是没好",
        detail: `「${verifyingLabel}」执行完成，但复查发现：${next.rootCause ?? next.primaryFinding?.title ?? "仍有未解决的问题"}。可以换个动作再试，或者导出诊断报告求助。`,
      });
      setVerifyingLabel(null);
    }
  }, [job, verifyingLabel]);
  usePolling(() => void verifyTick(), verifyingLabel === null ? null : VERIFY_POLL_MS);

  const executeAction = useCallback(
    async (action: RecoveryActionView) => {
      setBusy(true);
      setOutcome(null);
      const result = await postJson(
        `/api/recovery/actions/${encodeURIComponent(action.id)}/execute`,
        action.requiresConfirmation ? { confirmed: true } : {},
        70_000,
      );
      setBusy(false);
      if (!result.ok) {
        message.error(
          `「${action.label}」没能启动：${result.status === 409 ? "当前状态不允许执行这个动作" : "请稍后重试"}`,
        );
        return;
      }
      const payload = isRecord(result.data) ? result.data : {};
      if (typeof payload.jobId === "string") {
        setJob({
          jobId: payload.jobId,
          actionId: action.id,
          label: action.label,
          instanceId: null,
          status: "running",
          progress: 8,
          detail: "已确认，正在准备执行",
          startedAt: new Date().toISOString(),
          finishedAt: null,
        });
        setStage("result");
        return;
      }
      // 没有 jobId 的轻量动作（如重新探测）直接复查
      setVerifyingLabel(action.label);
      setStage("result");
    },
    [message],
  );

  const requestAction = useCallback(
    (action: RecoveryActionView) => {
      if (action.requiresConfirmation) {
        setPendingAction(action);
        return;
      }
      void executeAction(action);
    },
    [executeAction],
  );

  const confirmAction = useCallback(() => {
    if (pendingAction === null) return;
    const action = pendingAction;
    setPendingAction(null);
    void executeAction(action);
  }, [executeAction, pendingAction]);

  const restart = useCallback(() => {
    setStage("symptom");
    setDiagnosis(null);
    setSelected(null);
    setJob(null);
    setOutcome(null);
    setVerifyingLabel(null);
    setPendingAction(null);
  }, []);

  return {
    stage,
    setStage,
    symptom,
    chooseSymptom,
    diagnosis,
    ranked,
    recommended,
    selected,
    setSelected,
    job,
    outcome,
    busy,
    pendingAction,
    requestAction,
    confirmAction,
    cancelPendingAction: () => setPendingAction(null),
    restart,
  };
}
