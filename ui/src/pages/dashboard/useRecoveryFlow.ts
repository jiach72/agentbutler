/**
 * 恢复流程：诊断 → 分级执行 → 复验。
 * 复验用条件轮询（进行中每 3 秒复诊，通过或超 60 秒窗口收口），
 * 替代此前散落的 2s/60s 定时器数组；所有反馈文案与原实现一致。
 */
import { useCallback, useState } from "react";
import { App } from "antd";
import { loadJson, postJson } from "../../lib/api.js";
import { isRecord, pickErrorText } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";
import type { RecoveryActionView, RecoveryDiagnosisView, RecoveryJobView } from "./types.js";

const VERIFY_POLL_MS = 3_000;
const VERIFY_WINDOW_MS = 60_000;

export function useRecoveryFlow() {
  const { message } = App.useApp();
  const [recovery, setRecovery] = useState<RecoveryDiagnosisView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<RecoveryActionView | null>(null);
  const [verifying, setVerifying] = useState<{ label: string; startedAt: number } | null>(null);
  const [job, setJob] = useState<RecoveryJobView | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);

  const pollJob = useCallback(async () => {
    if (job === null || job.status !== "running") return;
    const result = await loadJson<RecoveryJobView>(`/api/recovery/jobs/${encodeURIComponent(job.jobId)}`, 8_000);
    if (!result.ok) return;
    setJob(result.data);
    if (result.data.status !== "running") {
      if (result.data.status === "done") message.success(`「${result.data.label}」执行完成`);
      else message.error(`「${result.data.label}」执行未完成：${result.data.detail}`);
      setVerifying({ label: result.data.label, startedAt: Date.now() });
    }
  }, [job, message]);
  usePolling(() => void pollJob(), job?.status === "running" ? 1000 : null);

  const verifyTick = useCallback(async () => {
    if (verifying === null) return;
    const diagnosis = await postJson("/api/recovery/diagnose", {}, 15_000);
    if (!diagnosis.ok || !isRecord(diagnosis.data)) {
      if (Date.now() - verifying.startedAt >= VERIFY_WINDOW_MS) {
        message.error(`「${verifying.label}」复验失败：暂时无法确认当前状态`);
        setVerifying(null);
      }
      return;
    }
    const next = diagnosis.data as unknown as RecoveryDiagnosisView;
    setRecovery(next);
    if (next.severity === "ok") {
      message.success(`「${verifying.label}」已复验通过，问题已解决`);
      setVerifying(null);
      return;
    }
    if (Date.now() - verifying.startedAt >= VERIFY_WINDOW_MS) {
      message.error(
        `「${verifying.label}」复验未通过：${next.rootCause ?? next.primaryFinding?.title ?? "仍有未解决的问题"}，请查看诊断详情`,
      );
      setVerifying(null);
    }
  }, [message, verifying]);

  // 复验进行中时每 3 秒复诊一次，替代原 2s/60s 定时器数组。
  usePolling(() => void verifyTick(), verifying === null ? null : VERIFY_POLL_MS);

  const diagnose = useCallback(async (autoRepair = false) => {
    setBusy(true);
    const diagnosis = await postJson("/api/recovery/diagnose", {}, 15_000);
    if (!diagnosis.ok || !isRecord(diagnosis.data)) {
      setBusy(false);
      message.error("诊断没有完成，请确认管家服务和 Watch 控制通道是否在线");
      return;
    }
    const next = diagnosis.data as unknown as RecoveryDiagnosisView;
    setRecovery(next);
    if (autoRepair) {
      const lowRisk = next.recommendedActions.find((action) => action.available && action.risk === "low");
      if (lowRisk !== undefined) {
        const result = await postJson(`/api/recovery/actions/${encodeURIComponent(lowRisk.id)}/execute`, {}, 70_000);
        if (result.ok) {
          const payload = isRecord(result.data) ? result.data : {};
          setJob(typeof payload.jobId === "string" ? { jobId: payload.jobId, actionId: lowRisk.id, label: lowRisk.label, instanceId: null, status: "running", progress: 8, detail: "已确认，正在准备执行", startedAt: new Date().toISOString(), finishedAt: null } : null);
          setJobStartedAt(Date.now());
          message.success(`已启动「${lowRisk.label}」，可在进度条中查看执行状态`);
        }
        else message.error(`诊断完成，但「${lowRisk.label}」执行失败`);
      } else {
        message.error(
          `诊断完成：${next.rootCause ?? next.primaryFinding?.title ?? "需要处理的事项"}。没有可自动执行的低风险动作，需要人工确认`,
        );
      }
    }
    setBusy(false);
  }, [message]);

  const execute = useCallback(async (action: RecoveryActionView) => {
    setBusy(true);
    const result = await postJson(`/api/recovery/actions/${encodeURIComponent(action.id)}/execute`, { confirmed: true }, 70_000);
    setBusy(false);
    setConfirmAction(null);
    if (result.ok) {
      const payload = isRecord(result.data) ? result.data : {};
      setJob(typeof payload.jobId === "string" ? { jobId: payload.jobId, actionId: action.id, label: action.label, instanceId: null, status: "running", progress: 8, detail: "已确认，正在准备执行", startedAt: new Date().toISOString(), finishedAt: null } : null);
      setJobStartedAt(Date.now());
      if (!isRecord(result.data) || typeof payload.jobId !== "string") setVerifying({ label: action.label, startedAt: Date.now() });
    } else if (result.status === 409) {
      message.error(`「${action.label}」暂时不能执行：${pickErrorText(result.data, "保护机制或当前状态不允许")}`);
    } else {
      message.error(`「${action.label}」执行失败，请查看诊断详情`);
    }
  }, [message]);

  return {
    recovery,
    busy,
    confirmAction,
    job,
    jobStartedAt,
    requestConfirm: setConfirmAction,
    cancelConfirm: useCallback(() => setConfirmAction(null), []),
    diagnose,
    execute,
  };
}
