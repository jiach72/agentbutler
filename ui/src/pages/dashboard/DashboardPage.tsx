/**
 * 管家首页编排层：组装数据流（useDashboardData）、
 * OpenClaw 安装（useOpenClawInstall）与各展示子组件；本文件不承载取数与轮询细节。
 *
 * - 「立即检查」触发即走（202 提示已启动，结果经事件流观察，不阻塞）；
 * - 管家控制通道离线（reachable:false）时如实展示降级，不伪造健康结论。
 */
import { useMemo, useState, type ReactNode } from "react";
import { App, Badge, Button, Collapse, Flex } from "antd";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageProgress } from "../../components/PageProgress.js";
import { postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { buildConclusions } from "./conclusions.js";
import { HeroConclusion } from "./HeroConclusion.js";
import { StatusRail } from "./StatusRail.js";
import { IssuesSection } from "./IssuesSection.js";
import { ReadinessSection } from "./ReadinessSection.js";
import { OnboardingContinuation } from "./OnboardingContinuation.js";
import { ConnectionSection } from "./ConnectionSection.js";
import { FingerprintsTable, InspectCard, RunbooksPanel } from "./AdvancedPanels.js";
import { InstanceHealthCard } from "./InstanceHealthCard.js";
import { useDashboardData } from "./useDashboardData.js";
import type { RunbookView } from "./types.js";

interface RuntimeDetailsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** 将资源、连接和实例检查统一放在默认关闭的运行详情中。 */
export function RuntimeDetails({ open, onOpenChange, children }: RuntimeDetailsProps) {
  return (
    <div id="runtime-details">
      <Collapse
        className="advanced-details runtime-details"
        size="small"
        activeKey={open ? ["runtime"] : []}
        onChange={(keys) => onOpenChange(Array.isArray(keys) && keys.includes("runtime"))}
        items={[
          {
            key: "runtime",
            label: (
              <span className="advanced-details-summary">
                <span>运行详情</span>
                <span className="advanced-details-extra">资源、连接与实例检查</span>
              </span>
            ),
            children,
          },
        ]}
      />
    </div>
  );
}

export function DashboardPage() {
  const { message } = App.useApp();
  const {
    dashboard,
    connections,
    openClawStatus,
    alerts,
    initialLoad,
    refresh,
    refreshConnections,
    criticalLoadFailed,
    inspectionHistory,
    runbooks,
    llmStatus,
    discoveredModels,
    readinessRefreshing,
    refreshReadiness,
    hostMetrics,
    serviceHealth,
  } = useDashboardData();

  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [runbookCandidate, setRunbookCandidate] = useState<RunbookView | null>(null);
  const [runbookBusy, setRunbookBusy] = useState(false);
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false);

  const openSection = (id: string, expandRuntime = false) => {
    if (expandRuntime) setRuntimeDetailsOpen(true);
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

  const runRunbook = async () => {
    if (runbookCandidate === null) return;
    setRunbookBusy(true);
    const result = await postJson(
      `/api/runbooks/${encodeURIComponent(runbookCandidate.id)}/execute`,
      { confirmed: true },
      70_000,
    );
    setRunbookBusy(false);
    setRunbookCandidate(null);
    await refresh();
    if (result.ok) {
      message.success(`已开始执行「${runbookCandidate.label}」，完成后会自动更新。`);
    } else if (result.status === 409) {
      message.error("这个处理方案暂时被保护机制暂停，请稍后再试。");
    } else {
      message.error("处理方案没有启动成功，请查看检查明细后重试。");
    }
  };

  const instances = dashboard?.instances ?? [];
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

  if (!initialLoad.finished) {
    return (
      <section className="dashboard-page">
        <Flex vertical gap={24}>
          <PageHeader
            title="本地管家"
            description="正在汇总服务、检查结果和消息状态。"
          />
          <PageProgress
            title="正在读取管家状态"
            detail="每一项完成后都会立即更新，不需要重复刷新页面。"
            steps={[
              { label: "运行与检查", state: initialLoad.dashboard ? "done" : "active" },
              { label: "消息状态", state: initialLoad.alerts ? "done" : initialLoad.dashboard ? "active" : "pending" },
            ]}
          />
        </Flex>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="本地管家"
          description="查看本机服务状态、连接情况和消息通知。"
          extra={
            <Badge
              status={inspectStatus?.reachable ? "success" : "error"}
              text={inspectStatus?.reachable ? "管家服务已连接" : "管家服务暂时连不上"}
            />
          }
        />

        {criticalLoadFailed && (
          <DegradedBanner
            severity="critical"
            message="关键状态暂时读不到"
            description="管家服务可能暂时不可用；页面显示的可能是旧数据，点击右侧按钮重新检查。"
            action={
              <Button danger onClick={() => { void refresh(); void refreshConnections(); }}>
                重新检查
              </Button>
            }
          />
        )}

        <HeroConclusion
          hero={hero}
          inspectStatus={inspectStatus}
          inspectRequested={inspectionRequested}
          onInspect={() => void runInspect()}
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
          runtimeDetailsOpen={runtimeDetailsOpen}
          onOpenRuntimeDetails={() => openSection("runtime-details", true)}
          onOpenIssues={() => openSection("dashboard-issues")}
        />

        <OnboardingContinuation />

        {attentionCount > 0 && (
          <div id="dashboard-issues">
            <IssuesSection
              issues={issues}
              attentionCount={attentionCount}
              onInspect={() => void runInspect()}
            />
          </div>
        )}

        <RuntimeDetails open={runtimeDetailsOpen} onOpenChange={setRuntimeDetailsOpen}>
          <Flex vertical gap={24}>
            <ReadinessSection
              connections={connections}
              llmStatus={llmStatus}
              discoveredModels={discoveredModels}
              refreshing={readinessRefreshing}
              onRefresh={() => void refreshReadiness()}
              hostMetrics={hostMetrics}
              serviceHealth={serviceHealth}
              inspectStatus={inspectStatus}
              inspectionHistory={inspectionHistory}
              latestInspections={dashboard?.latestInspections ?? []}
            />
            <ConnectionSection
              connections={connections}
              openClawStatus={openClawStatus}
              connectionBusy={connectionBusy}
              onCheckAll={() => void runConnectionCheck()}
              onCheckOne={(instanceId) => void runConnectionCheck(instanceId)}
              onToggleConnection={(instanceId, action) => void runConnectionAction(instanceId, action)}
            />
            <InstanceHealthCard
              instances={instances}
              inspections={dashboard?.latestInspections ?? []}
            />
            <Collapse
              className="advanced-details"
              size="small"
              items={[
                {
                  key: "schedule",
                  label: (
                    <span className="advanced-details-summary">
                      <span>检查安排</span>
                    </span>
                  ),
                  children: (
                    <InspectCard inspectStatus={inspectStatus} onInspect={() => void runInspect()} />
                  ),
                },
                {
                  key: "runbooks",
                  label: (
                    <span className="advanced-details-summary">
                      <span>可用的处理方案</span>
                    </span>
                  ),
                  children: <RunbooksPanel runbooks={runbooks} onRepair={setRunbookCandidate} />,
                },
                {
                  key: "fingerprints",
                  label: (
                    <span className="advanced-details-summary">
                      <span>经常出现的问题</span>
                    </span>
                  ),
                  children: (
                    <FingerprintsTable
                      fingerprints={dashboard?.fingerprints ?? []}
                      onOpenLogs={() => { window.location.assign("/logs"); }}
                    />
                  ),
                },
              ]}
            />
          </Flex>
        </RuntimeDetails>

        {(inspectionRequested || inspectStatus?.inFlight === true) && (
          <PageProgress
            compact
            indeterminate
            title="正在检查本机服务"
            detail="正在检查进程、接口、记忆、消息通道和模型连接，完成后本页会自动更新。"
          />
        )}

        <DangerConfirmModal
          open={runbookCandidate !== null}
          title="确认开始处理"
          confirmLabel="确认处理"
          cancelLabel="先不处理"
          busy={runbookBusy}
          onCancel={() => setRunbookCandidate(null)}
          onConfirm={() => void runRunbook()}
          impact={runbookCandidate?.impact ?? "该操作会修改本机服务状态，完成后会自动复核。"}
        >
          管家将执行「<strong>{runbookCandidate?.label ?? "处理方案"}</strong>」。
          确认后才会开始执行。
        </DangerConfirmModal>

      </Flex>
    </section>
  );
}
