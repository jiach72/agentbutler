/**
 * 管家首页编排层：组装数据流（useDashboardData）、恢复流程（useRecoveryFlow）、
 * OpenClaw 安装（useOpenClawInstall）与各展示子组件；本文件不承载取数与轮询细节。
 *
 * - 「立即检查」和「修复一下」都是触发即走（202 提示已启动，结果经事件流观察，不阻塞）；
 * - 管家控制通道离线（reachable:false）时如实展示降级，不伪造健康结论。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { App, Button } from "antd";
import { PageProgress } from "../../components/PageProgress.js";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { buildConclusions } from "./conclusions.js";
import { HeroConclusion } from "./HeroConclusion.js";
import { StatusRail } from "./StatusRail.js";
import { IssuesSection } from "./IssuesSection.js";
import { ConnectionSection } from "./ConnectionSection.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import { InstanceHealthCard } from "./InstanceHealthCard.js";
import { FingerprintsTable, InspectCard, RunbooksPanel } from "./AdvancedPanels.js";
import { LogPanel } from "./LogPanel.js";
import { useDashboardData } from "./useDashboardData.js";
import { useOpenClawInstall } from "./useOpenClawInstall.js";
import { useRecoveryFlow } from "./useRecoveryFlow.js";
import type { RunbookView } from "./types.js";

export function DashboardPage() {
  const { message } = App.useApp();
  const {
    dashboard,
    connections,
    openClawStatus,
    openClawInstallJob,
    setOpenClawInstallJob,
    runbooks,
    alerts,
    initialLoad,
    refresh,
    refreshConnections,
    criticalLoadFailed,
  } = useDashboardData();
  const recovery = useRecoveryFlow();
  const openClawInstall = useOpenClawInstall({
    status: openClawStatus,
    job: openClawInstallJob,
    setJob: setOpenClawInstallJob,
    onStarted: () => void refreshConnections(),
  });

  const [confirmRunbook, setConfirmRunbook] = useState<RunbookView | null>(null);
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement>(null);

  const executeRunbook = async (runbook: RunbookView) => {
    const result = await postJson(`/api/runbooks/${encodeURIComponent(runbook.id)}/execute`);
    if (result.status === 202) {
      message.success(`已开始处理「${runbook.label}」，完成后页面会自动刷新`);
    } else if (result.status === 409) {
      message.error(`「${runbook.label}」已在执行或当前条件不满足，请稍后再试`);
    } else if (result.status === 404) {
      message.error(`「${runbook.label}」不存在或已被移除`);
    } else if (result.status === 502) {
      message.error("管家暂时连接不上，无法开始处理");
    } else if (result.status === 503) {
      message.error(`「${runbook.label}」暂时不能处理（管家忙碌或已暂停）`);
    } else {
      message.error(`「${runbook.label}」执行失败，请稍后重试`);
    }
  };

  const runInspect = async () => {
    setInspectionRequested(true);
    try {
      const result = await postJson("/api/inspect/run");
      if (result.status === 202) {
        message.success("已开始检查，完成后页面会自动更新");
        await refresh();
      } else if (result.status === 409) {
        message.error("检查正在进行中，请稍后再试");
      } else if (result.status === 502) {
        message.error("管家检查通道连接不上，无法开始检查");
      } else {
        message.error("开始检查失败，请稍后重试");
      }
    } finally {
      setInspectionRequested(false);
    }
  };

  const runConnectionCheck = async (instanceId?: string) => {
    const key = instanceId ?? "all";
    setConnectionBusy(`check-${key}`);
    const targets = instanceId
      ? [instanceId]
      : (connections?.connections ?? []).map((item) => item.instanceId);
    if (targets.length === 0) {
      setConnectionBusy(null);
      message.error("还没有发现可检查的 Hermes 或 OpenClaw 实例");
      return;
    }
    const results = await Promise.all(
      targets.map((target) => postJson("/api/connections/check", { instanceId: target }, 15_000)),
    );
    await refreshConnections();
    setConnectionBusy(null);
    const passed = results.every((result) => {
      if (!result.ok || !isRecord(result.data)) return false;
      return result.data.status === "checked";
    });
    if (passed) {
      message.success("连接检查已完成，状态信息已更新");
    } else {
      message.error("部分连接检查失败，请查看实例卡片中的原因");
    }
  };

  const runConnectionAction = async (instanceId: string, action: "connect" | "disconnect") => {
    setConnectionBusy(`${action}-${instanceId}`);
    const result = await postJson(
      `/api/connections/${encodeURIComponent(instanceId)}/${action}`,
      {},
      70_000,
    );
    await refreshConnections();
    setConnectionBusy(null);
    if (result.ok) {
      message.success(action === "connect" ? "已发起连接并完成复核" : "已断开连接并完成复核");
    } else if (result.status === 409) {
      message.error("操作未完成，请查看实例卡片中的错误原因");
    } else if (result.status === 502) {
      message.error("管家控制通道暂时连不上");
    } else {
      message.error(action === "connect" ? "连接失败，请先检查配置和服务" : "断开失败，请稍后重试");
    }
  };

  const instances = dashboard?.instances ?? [];
  const latestInspections = dashboard?.latestInspections ?? [];
  const fingerprints = dashboard?.fingerprints ?? [];
  const inspectStatus = dashboard?.inspectStatus ?? null;
  const conclusions = useMemo(() => buildConclusions(dashboard, alerts), [alerts, dashboard]);
  const {
    issues,
    hero,
    attentionCount,
    hasError,
    hasWarn,
    healthyInspectionCount,
    downInstanceCount,
    degradedInstanceCount,
    messageStats,
  } = conclusions;

  const openAdvanced = useCallback(() => {
    advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (!initialLoad.finished) {
    return (
      <section className="page product-page dashboard-page manager-home">
        <header className="page-heading product-heading manager-heading">
          <div>
            <span className="product-eyebrow">首页</span>
            <h1>你的本地 AI 管家</h1>
            <p className="hint">正在汇总服务、检查结果和消息状态。</p>
          </div>
        </header>
        <PageProgress
          title="正在读取管家状态"
          detail="每一项完成后都会立即更新，不需要重复刷新页面。"
          steps={[
            { label: "运行与检查", state: initialLoad.dashboard ? "done" : "active" },
            {
              label: "修复方案",
              state: initialLoad.runbooks ? "done" : initialLoad.dashboard ? "active" : "pending",
            },
            {
              label: "消息状态",
              state: initialLoad.alerts ? "done" : initialLoad.runbooks ? "active" : "pending",
            },
          ]}
        />
      </section>
    );
  }

  return (
    <section className="page product-page dashboard-page manager-home">
      <header className="page-heading product-heading manager-heading">
        <div>
          <span className="product-eyebrow">首页</span>
          <h1>你的本地 AI 管家</h1>
          <p className="hint">集中查看本机 AI 状态，按优先级处理异常。</p>
        </div>
        <span className={`page-live ${inspectStatus?.reachable ? "is-online" : "is-offline"}`}>
          <i />
          {inspectStatus?.reachable ? "管家服务已连接" : "管家服务暂时连不上"}
        </span>
      </header>

      {criticalLoadFailed && (
        <DegradedBanner
          severity="critical"
          message="关键状态暂时读不到"
          description="管家服务可能暂时不可用；页面显示的可能是旧数据，点击右侧按钮重新检查。"
          action={
            <Button danger size="small" onClick={() => { void refresh(); void refreshConnections(); }}>
              重新检查
            </Button>
          }
        />
      )}

      <HeroConclusion
        hero={hero}
        inspectStatus={inspectStatus}
        inspectRequested={inspectionRequested}
        recoveryBusy={recovery.busy}
        canDiagnose={hasError || hasWarn}
        onInspect={() => void runInspect()}
        onDiagnose={() => void recovery.diagnose(true)}
      />

      <StatusRail
        attentionCount={attentionCount}
        hasError={hasError}
        hasWarn={hasWarn}
        healthyInspectionCount={healthyInspectionCount}
        instanceCount={instances.length}
        downInstanceCount={downInstanceCount}
        degradedInstanceCount={degradedInstanceCount}
        inspectStatus={inspectStatus}
        messageStats={messageStats}
        onOpenAdvanced={openAdvanced}
      />

      <ConnectionSection
        connections={connections}
        openClawStatus={openClawStatus}
        openClawInstallJob={openClawInstallJob}
        connectionBusy={connectionBusy}
        openClawInstallBusy={openClawInstall.busy}
        onCheckAll={() => void runConnectionCheck()}
        onCheckOne={(instanceId) => void runConnectionCheck(instanceId)}
        onToggleConnection={(instanceId, action) => void runConnectionAction(instanceId, action)}
        onInstall={openClawInstall.install}
        onCancelInstall={() => void openClawInstall.cancel()}
      />

      <IssuesSection
        issues={issues}
        attentionCount={attentionCount}
        onRepair={setConfirmRunbook}
        onOpenAdvanced={openAdvanced}
      />

      <section className="manager-advanced">
        <RecoveryPanel
          recovery={recovery.recovery}
          busy={recovery.busy}
          onDiagnose={() => void recovery.diagnose(false)}
          onExecute={(action) => void recovery.execute(action)}
          onRequestConfirm={recovery.requestConfirm}
        />

        <div ref={advancedRef}>
          <AdvancedDetails summary="检查明细、AI 助手状态、处理方案、管家检查和经常出现的问题">
            <div className="advanced-details-body">
              <h3 className="manager-subhead">AI 助手状态</h3>
              <InstanceHealthCard instances={instances} inspections={latestInspections} />

              <h3 className="manager-subhead">可以一键处理</h3>
              <RunbooksPanel runbooks={runbooks} onRepair={setConfirmRunbook} />

              <h3 className="manager-subhead">管家最近检查</h3>
              <InspectCard inspectStatus={inspectStatus} onInspect={() => void runInspect()} />

              <h3 className="manager-subhead">经常出现的问题</h3>
              <FingerprintsTable fingerprints={fingerprints} onOpenLogs={() => setLogPanelOpen(true)} />

              <div className="manager-logs-entry">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setLogPanelOpen(true)}
                >
                  打开系统日志
                </button>
                <span>Hermes 运行日志、网关日志与探针日志（只读查看，不会修改任何文件）</span>
              </div>
            </div>
          </AdvancedDetails>
        </div>
      </section>

      <DangerConfirmModal
        open={confirmRunbook !== null}
        title="确认处理这个问题"
        confirmLabel="确认执行"
        cancelLabel="先不修复"
        impact={confirmRunbook?.impact ? confirmRunbook.impact : undefined}
        steps={confirmRunbook?.steps}
        onCancel={() => setConfirmRunbook(null)}
        onConfirm={() => {
          const runbook = confirmRunbook;
          setConfirmRunbook(null);
          if (runbook !== null) void executeRunbook(runbook);
        }}
      >
        管家将处理「<strong>{confirmRunbook?.label}</strong>」。
        {confirmRunbook?.description !== undefined && confirmRunbook.description !== ""
          ? ` ${confirmRunbook.description}`
          : null}
        <p className="danger-impact">
          请确认你理解这次操作会影响什么。管家只会执行你确认的处理。
        </p>
      </DangerConfirmModal>

      {(inspectionRequested || inspectStatus?.inFlight === true) && (
        <PageProgress
          compact
          indeterminate
          title="正在检查本机 AI"
          detail="管家正在检查进程、接口、记忆、消息通道和模型连接，完成后本页会自动更新。"
        />
      )}

      <DangerConfirmModal
        open={recovery.confirmAction !== null}
        title={`确认执行「${recovery.confirmAction?.label ?? ""}」`}
        confirmLabel="确认执行"
        cancelLabel="取消"
        busy={recovery.busy}
        impact={
          recovery.confirmAction !== null
            ? `影响：${recovery.confirmAction.impact}。预计耗时约 ${recovery.confirmAction.estimatedSeconds} 秒。`
            : undefined
        }
        onCancel={recovery.cancelConfirm}
        onConfirm={() => {
          const action = recovery.confirmAction;
          if (action !== null) void recovery.execute(action);
        }}
      >
        {recovery.confirmAction?.description}
      </DangerConfirmModal>

      <LogPanel open={logPanelOpen} onClose={() => setLogPanelOpen(false)} />
    </section>
  );
}
