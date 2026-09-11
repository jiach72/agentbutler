/**
 * 排查页数据流（v2 自动体检版）。
 *
 * v1 是纯向导：选现象 → 看证据 → 选动作 → 看结果，第一屏强制用户先做题。
 * v2 的关键改变：**进入页面即静默体检**（postJson /api/recovery/diagnose 与
 * chooseSymptom 走同一后端，没有额外成本），拿到结论后：
 * - 一切正常 → 用户 0 点击看到「没有需要处理的问题」+ 证据摘要，向导收进抽屉；
 * - 有问题    → 直接给「最可能的原因 + 推荐动作（1 键执行）」，现象选择降级为
 *               「按我的感受重新聚焦」——改变推荐排序，不隐藏任何证据；
 * - 想手动走完整向导的进阶用户 → 抽屉里保留全部 4 步。
 *
 * 与首页恢复流程的区别保持不变：这里始终保留完整的证据与全部动作
 * （不可用的也展示原因），现象选择只改变推荐顺序，不隐藏任何信息。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export interface TriageSummary {
  /** 体检总结论：正常 / 有提醒 / 有问题。 */
  tone: "ok" | "warn" | "error";
  /** 一句话标题（人话，不说码）。 */
  title: string;
  /** 补充说明（含证据摘要）。 */
  detail: string;
  /** 最可能的原因；只有探针真的失败时才有值。 */
  rootCause: string | null;
}

export function useTroubleshoot() {
  const { message } = App.useApp();
  // stage === null 表示「体检总览」模式（新默认）；设为具体 stage 即进入完整向导。
  const [stage, setStage] = useState<WizardStage | null>(null);
  const [symptom, setSymptom] = useState<SymptomId>(DEFAULT_SYMPTOM);
  const [diagnosis, setDiagnosis] = useState<RecoveryDiagnosisView | null>(null);
  const [triageBusy, setTriageBusy] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<RecoveryJobView | null>(null);
  const [outcome, setOutcome] = useState<WizardOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyingLabel, setVerifyingLabel] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<RecoveryActionView | null>(null);
  // 自动体检只做一次（失败可手动重试）；向导内的 chooseSymptom 不复用它。
  const autoTriageRef = useRef(false);

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
      return null;
    }
    const next = result.data as unknown as RecoveryDiagnosisView;
    setDiagnosis(next);
    setSelected(recommendAction(next.recommendedActions, selectedSymptom)?.id ?? null);
    return next;
  }, [message]);

  /** 进入页面即静默体检：不需要用户选择任何东西，直接拿结论。 */
  useEffect(() => {
    if (autoTriageRef.current) return;
    autoTriageRef.current = true;
    setTriageBusy(true);
    void postJson("/api/recovery/diagnose", {}, 15_000).then((result) => {
      setTriageBusy(false);
      if (!result.ok || !isRecord(result.data)) return;
      const next = result.data as unknown as RecoveryDiagnosisView;
      setDiagnosis(next);
      setSelected(recommendAction(next.recommendedActions, DEFAULT_SYMPTOM)?.id ?? null);
    });
  }, []);

  /** 体检总览的手动重试。 */
  const rerunTriage = useCallback(() => {
    setTriageBusy(true);
    void postJson("/api/recovery/diagnose", {}, 15_000).then((result) => {
      setTriageBusy(false);
      if (!result.ok || !isRecord(result.data)) {
        message.error("没有读到诊断结果，请确认管家服务是否在运行");
        return;
      }
      const next = result.data as unknown as RecoveryDiagnosisView;
      setDiagnosis(next);
      setSelected(recommendAction(next.recommendedActions, symptom)?.id ?? null);
    });
  }, [message, symptom]);

  /** 体检总结论（只依赖 diagnosis，不依赖用户选择）。 */
  const triage: TriageSummary | null = useMemo(() => {
    if (diagnosis === null) return null;
    if (diagnosis.rootCause !== null) {
      return {
        tone: "error",
        title: "找到了一个需要处理的问题",
        detail: diagnosis.summary ?? "有检查项没有通过，下面是最可能的原因和最快的处理方式。",
        rootCause: diagnosis.rootCause,
      };
    }
    if (diagnosis.primaryFinding !== null || diagnosis.severity === "warn") {
      const primary = diagnosis.primaryFinding;
      return {
        tone: "warn",
        title: primary === null ? "运行基本正常，有些提醒" : `运行正常，但日志里有提醒：${primary.title}`,
        detail: primary === null ? "不影响当前使用，可以留意或按建议处理。" : primary.detail,
        rootCause: null,
      };
    }
    return {
      tone: "ok",
      title: "没有需要处理的问题",
      detail: diagnosis.historicalFindingCount > 0
        ? `全部检查通过。更早的日志里有 ${diagnosis.historicalFindingCount} 条历史提醒，不影响当前运行。`
        : "全部检查通过，各探针状态正常。",
      rootCause: null,
    };
  }, [diagnosis]);

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

  /** 完整向导入口：从总览进入现象选择。 */
  const openWizard = useCallback(() => {
    setStage("symptom");
  }, []);

  /** 向导内选完现象就开始查，不需要用户多点一次。 */
  const chooseSymptom = useCallback(
    (next: SymptomId) => {
      setSymptom(next);
      void runDiagnose(next).then((result) => {
        if (result !== null) setStage("evidence");
      });
    },
    [runDiagnose],
  );

  /** 回到体检总览（向导内任意步骤可返回）。 */
  const backToOverview = useCallback(() => {
    setStage(null);
  }, []);

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
    // 总览（新增）
    stage,
    triage,
    triageBusy,
    rerunTriage,
    openWizard,
    backToOverview,
    // 向导（原有语义保留）
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
