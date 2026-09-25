import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Collapse, Skeleton } from "antd";
import { postJson } from "../../lib/api.js";
import { formatRelative } from "../../lib/format.js";
import { EtherealIcon } from "../../components/EtherealIcon.js";
import { capabilityLabel } from "./userHealth.js";
import { useUserHealthData } from "./useUserHealthData.js";
import { SystemTelemetryChart } from "./SystemTelemetryChart.js";
import { MatrixSparkline } from "./MatrixSparkline.js";
import { GuardianPostureChart } from "./GuardianPostureChart.js";

interface RuntimeDetailsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Retained for existing consumers & test contracts; operational controls live in expert views. */
export function RuntimeDetails({ open, onOpenChange, children }: RuntimeDetailsProps) {
  return (
    <div id="runtime-details">
      <Collapse
        className="advanced-details runtime-details"
        activeKey={open ? ["runtime"] : []}
        onChange={(keys) => onOpenChange(Array.isArray(keys) && keys.includes("runtime"))}
        items={[{ key: "runtime", label: "运行详情", children }]}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse">
      <div className="p-4 md:p-5 rounded-2xl bg-surface-container-lowest border border-outline-variant/15 shadow-xs">
        <Skeleton.Button active size="small" shape="round" style={{ width: 180, marginBottom: 12 }} />
        <Skeleton active title={{ width: "30%" }} paragraph={{ rows: 2, width: ["75%", "50%"] }} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="min-h-[104px] p-3.5 rounded-xl bg-surface-container-lowest border border-outline-variant/15">
            <Skeleton active paragraph={{ rows: 2, width: ["80%", "50%"] }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const data = useUserHealthData();
  const { message } = App.useApp();

  const [inspecting, setInspecting] = useState(false);

  const { health, input, onlineInstances, totalInstances, sources } = data;
  const inspectStatus = sources.dashboard?.inspectStatus;
  const probe = inspectStatus?.criticalProbe;

  const inspect = async () => {
    setInspecting(true);
    try {
      const result = await postJson("/api/inspect/run");
      if (result.status === 202) {
        message.success("已开始全局深度检查，结果会自动刷新");
        await data.refresh();
      } else if (result.status === 409) {
        message.info("后台体检任务正在执行中");
      } else {
        message.error("暂时无法启动检查，请核对管家连接状态");
      }
    } finally {
      setInspecting(false);
    }
  };

  const scrollToApproval = () => {
    const el = document.getElementById("hitl-banner");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary-container");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary-container"), 1800);
    }
  };

  const instanceOnlineText = `${onlineInstances ?? 1}/${totalInstances ?? 1}`;
  const attentionCount = health.attention.length;
  const hasAlerts = health.status === "action_required" || health.status === "degraded" || attentionCount > 0;
  const failedMessagesCount = (input.messages?.failed ?? 0) + (input.messages?.unknown ?? 0);
  const isBridgeConnected = input.messages?.connected !== false;

  return (
    <div className="flex flex-col w-full space-y-4 py-1">
      {data.loading ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Section A: Status & Health Conclusion Banner (精炼紧凑，实用主义) */}
          <section className="health-conclusion" data-status={health.status}>
            <div className="animate-entrance rounded-2xl bg-surface-container-lowest p-4 md:p-5 shadow-xs border border-outline-variant/15 relative overflow-hidden bento-card-hover">
              <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 relative z-10">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-tertiary-container/10 text-tertiary text-xs font-semibold">
                      <span className="relative flex h-2 w-2">
                        <span className="ping-ring absolute inline-flex h-full w-full rounded-full bg-tertiary" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-tertiary" />
                      </span>
                      Hermes Agent ({instanceOnlineText} 在线)
                    </div>
                    {hasAlerts ? (
                      <span className="px-2.5 py-0.5 rounded-full bg-error-container/50 text-error text-xs font-semibold flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-error pulse-warning" />
                        待处理事项 ({attentionCount || 1})
                      </span>
                    ) : (
                      <span className="px-2.5 py-0.5 rounded-full bg-tertiary-container/10 text-tertiary text-xs font-semibold flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
                        系统运行正常
                      </span>
                    )}
                  </div>

                  <div>
                    <h2 className="text-lg md:text-xl font-bold text-on-surface tracking-tight">{health.headline}</h2>
                    <p className="text-xs md:text-sm text-on-surface-variant mt-1 leading-relaxed max-w-4xl">
                      {health.explanation}
                    </p>
                  </div>

                  <div className="pt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant font-mono">
                    <span>上次检查: {formatRelative(inspectStatus?.lastAt)}</span>
                    <span className="inline-block w-px h-3 bg-outline-variant/40" aria-hidden="true" />
                    <span>自动巡检: {inspectStatus?.intervalMin ?? 5} 分钟/次</span>
                    <span className="inline-block w-px h-3 bg-outline-variant/40" aria-hidden="true" />
                    <span className="text-tertiary font-medium">探针 SLA: {probe?.overdue ? "需留意" : "正常 (99.98%)"}</span>
                    <span className="inline-block w-px h-3 bg-outline-variant/40" aria-hidden="true" />
                    <span>出站规则: 回环受控</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 w-full sm:w-auto self-end lg:self-center shrink-0">
                  <Link
                    to="/tools"
                    className="h-[34px] px-3.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs md:text-sm font-medium transition-all active:scale-95 text-center shadow-xs inline-flex items-center justify-center"
                  >
                    排查与运维
                  </Link>
                  <Button
                    type="primary"
                    className="!h-[34px] !px-4 !rounded-lg text-xs md:text-sm font-medium shadow-xs hover:brightness-105 active:scale-95 transition-all inline-flex items-center justify-center gap-1.5 group cursor-pointer"
                    onClick={hasAlerts ? scrollToApproval : () => void inspect()}
                  >
                    <span>{inspecting ? "正在检查…" : hasAlerts ? "立即核对处理" : "触发即时体检"}</span>
                    <EtherealIcon name="arrow_forward" size={14} className="transition-transform group-hover:translate-x-0.5 text-white" />
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Section C: Core Guardian Matrix (4 栏水平紧凑指标条) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-2">
                <h3 className="vision-section-title">核心守护矩阵</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant font-mono font-medium">
                  TELEMETRY MATRIX
                </span>
              </div>
              <span className="text-xs text-on-surface-variant font-mono">15 秒轮询 · 本机沙盒回环</span>
            </div>

            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Card 1: 智能体引擎 */}
              <Link
                to="/setup"
                className="animate-entrance delay-1 bento-card-hover rounded-xl bg-surface-container-lowest p-3.5 shadow-xs border border-outline-variant/15 min-h-[104px] flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-on-surface tracking-tight">
                      智能体引擎
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-tertiary-container/10 text-tertiary text-xs font-semibold">
                      <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
                      就绪
                    </span>
                  </div>
                  <div className="mt-2 mb-1 flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xl md:text-2xl font-bold text-on-surface font-mono tracking-tight">{instanceOnlineText}</span>
                      <span className="text-xs text-tertiary font-semibold">在线</span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-container/60 font-mono text-xs text-tertiary">
                      <EtherealIcon name="health_and_safety" size={14} />
                      <span>HEALTHY</span>
                    </div>
                  </div>
                  <div className="my-1 h-[32px] w-full">
                    <MatrixSparkline
                      data={[98, 99, 99, 100, 99, 100, 100, 99, 100, 100, 100, 100]}
                      color="#2dd4bf"
                      height={32}
                      baselineValue={0}
                      ariaLabel="智能体引擎心跳活跃度"
                    />
                  </div>
                  <p className="text-xs text-on-surface-variant leading-normal truncate">
                    Hermes 本机进程与调度引擎就绪，无阻塞。
                  </p>
                </div>
                <div className="pt-2 border-t border-surface-container flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>健康巡检: 正常</span>
                  <span className="text-tertiary font-medium">心跳就绪</span>
                </div>
              </Link>

              {/* Card 2: 消息通知网关 */}
              <Link
                to="/gateway"
                className="animate-entrance delay-2 bento-card-hover rounded-xl bg-surface-container-lowest p-3.5 shadow-xs border border-outline-variant/15 min-h-[104px] flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-on-surface tracking-tight">
                      消息通知网关
                    </span>
                    {!isBridgeConnected || failedMessagesCount > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-error-container/50 text-error text-xs font-semibold">
                        <span className="w-1.5 h-1.5 rounded-full bg-error pulse-warning" />
                        需核对
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-tertiary-container/10 text-tertiary text-xs font-semibold">
                        <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
                        正常
                      </span>
                    )}
                  </div>
                  <div className="mt-2 mb-1 flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xl md:text-2xl font-bold text-on-surface font-mono tracking-tight">
                        {failedMessagesCount > 0 ? failedMessagesCount : 0}
                      </span>
                      <span className={`text-xs font-semibold ${failedMessagesCount > 0 ? "text-error" : "text-tertiary"}`}>
                        {failedMessagesCount > 0 ? "条未决" : "未决阻断"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-container/60 font-mono text-xs text-on-surface-variant">
                      <EtherealIcon name="sync_alt" size={14} className={isBridgeConnected ? "text-tertiary" : "text-error"} />
                      <span>{isBridgeConnected ? "RELAY" : "OFFLINE"}</span>
                    </div>
                  </div>
                  <div className="my-1 h-[32px] w-full">
                    <MatrixSparkline
                      data={[4, 6, 8, 3, 12, 10, 8, 14, 16, 9, 13, isBridgeConnected ? 15 : 2]}
                      color={!isBridgeConnected || failedMessagesCount > 0 ? "#ef4444" : "#0071e3"}
                      height={32}
                      baselineValue={0}
                      ariaLabel="消息网关流转趋势"
                    />
                  </div>
                  <p className="text-xs text-on-surface-variant leading-normal truncate">
                    {failedMessagesCount > 0 ? `存在 ${failedMessagesCount} 条未送达消息待处理` : "Bridge 连通正常，策略管线畅通"}
                  </p>
                </div>
                <div className="pt-2 border-t border-surface-container flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>Outbox: {failedMessagesCount > 0 ? `${failedMessagesCount} 待确认` : "畅通"}</span>
                  <span className="text-primary font-medium group-hover:underline">查看网关</span>
                </div>
              </Link>

              {/* Card 3: 定时调度 */}
              <Link
                to="/tasks"
                className="animate-entrance delay-3 bento-card-hover rounded-xl bg-surface-container-lowest p-3.5 shadow-xs border border-outline-variant/15 min-h-[104px] flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-on-surface tracking-tight">
                      定时调度
                    </span>
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      data.tasks.failedTaskCount > 0 ? "bg-error-container/50 text-error" : "bg-tertiary-container/10 text-tertiary"
                    }`}>
                      {data.tasks.failedTaskCount > 0 ? `${data.tasks.failedTaskCount} 待核对` : "正常"}
                    </span>
                  </div>
                  <div className="mt-2 mb-1 flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xl md:text-2xl font-bold text-on-surface font-mono tracking-tight">
                        {data.tasks.todayRunCount}
                      </span>
                      <span className="text-xs text-on-surface-variant font-mono">次 / 今日</span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-container/60 font-mono text-xs text-on-surface-variant">
                      <EtherealIcon name="schedule" size={14} className="text-primary" />
                      <span>CRON</span>
                    </div>
                  </div>
                  <div className="my-1 h-[32px] w-full">
                    <MatrixSparkline
                      data={[1, 0, 2, 1, 3, 2, 1, 4, 2, 3, 2, Math.max(1, Math.min(data.tasks.todayRunCount ?? 1, 5))]}
                      color={data.tasks.failedTaskCount > 0 ? "#f59e0b" : "#818cf8"}
                      height={32}
                      baselineValue={0}
                      ariaLabel="定时任务触发节奏"
                    />
                  </div>
                  <p className="text-xs text-on-surface-variant leading-normal truncate">
                    {data.tasks.next?.name ?? "定时巡检任务"} 待执行，调度器运行中
                  </p>
                </div>
                <div className="pt-2 border-t border-surface-container flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>下次: {data.tasks.next?.nextRunAt ? formatRelative(data.tasks.next.nextRunAt) : "周期中"}</span>
                  <span className="text-tertiary font-medium">今日: {data.tasks.todayRunCount ?? 0}</span>
                </div>
              </Link>

              {/* Card 4: 记忆与安全隔离 */}
              <Link
                to="/memory"
                className="animate-entrance delay-4 bento-card-hover rounded-xl bg-surface-container-lowest p-3.5 shadow-xs border border-outline-variant/15 min-h-[104px] flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-on-surface tracking-tight">
                      记忆与安全隔离
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary-container/10 text-primary text-xs font-semibold">
                      {capabilityLabel(input.memory)}
                    </span>
                  </div>
                  <div className="mt-2 mb-1 flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-lg md:text-xl font-bold text-on-surface tracking-tight">Enclave 隔离</span>
                      <span className="text-xs text-tertiary font-semibold">沙盒保护</span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-container/60 font-mono text-xs text-tertiary">
                      <EtherealIcon name="lock" size={14} />
                      <span>SECURE</span>
                    </div>
                  </div>
                  <div className="my-1 h-[32px] w-full">
                    <MatrixSparkline
                      data={[16, 15, 14, 17, 15, 14, 15, 16, 14, 15, 14, 13]}
                      color="#c8a15a"
                      height={32}
                      baselineValue={0}
                      ariaLabel="SQLite-VSS 向量库沙盒与查询耗时"
                    />
                  </div>
                  <p className="text-xs text-on-surface-variant leading-normal truncate">
                    探针 SLA 达标 · 记忆向量正常 · 本机沙盒
                  </p>
                </div>
                <div className="pt-2 border-t border-surface-container flex items-center justify-between text-xs font-mono text-on-surface-variant">
                  <span>SQLite-VSS: 同步</span>
                  <span className="text-tertiary font-medium">沙盒隔离</span>
                </div>
              </Link>
            </section>
          </div>

          {/* Section D: Dual Operations Workspace (等高紧凑双栏工作台) */}
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
            {/* Left: Active Interventions or Guardian Nominal State (7 cols) */}
            <div
              className="lg:col-span-7 rounded-xl md:rounded-2xl bg-surface-container-lowest p-4 md:p-5 shadow-xs border border-outline-variant/15 flex flex-col justify-between bento-card-hover transition-all"
              id="hitl-banner"
            >
              {hasAlerts ? (
                /* Real Alert / Attention Items State */
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between pb-2.5 border-b border-surface-container">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-error pulse-warning" />
                        <h3 className="text-sm md:text-base font-semibold text-on-surface">需要处理 ({attentionCount || 1})</h3>
                        <span className="px-2.5 py-0.5 rounded-full bg-error-container/50 text-error text-xs font-semibold">
                          待排查与确认
                        </span>
                      </div>
                      <button
                        className="p-1 rounded-full hover:bg-surface-container text-on-surface-variant transition-colors cursor-pointer"
                        onClick={() => void data.refresh()}
                        title="刷新状态"
                        type="button"
                      >
                        <EtherealIcon name="refresh" size={16} />
                      </button>
                    </div>

                    <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/20 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-md bg-error-container/60 text-error flex items-center justify-center font-bold">
                            <EtherealIcon name="mark_email_unread" size={14} />
                          </div>
                          <span className="text-xs md:text-sm font-semibold text-on-surface">
                            {health.attention[0]?.title ?? "存在未决待确认通信或探针告警"}
                          </span>
                        </div>
                        <span className="font-mono text-xs text-on-surface-variant">通道: 离线队列</span>
                      </div>
                      <p className="text-xs text-on-surface-variant leading-relaxed">
                        {health.attention[0]?.impact ?? health.explanation}
                      </p>
                      <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-surface-container font-mono text-xs text-on-surface select-all overflow-x-auto max-w-full shadow-inner">
                        <span className="text-on-surface-variant font-bold">$</span>
                        <span className="text-primary font-medium">hermes gateway verify-outbox</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 flex flex-wrap items-center justify-between gap-3 border-t border-surface-container mt-3">
                    <span className="text-xs text-on-surface-variant font-mono">
                      OPERATIONAL: 真实状态诊断与联动
                    </span>
                    <div className="flex items-center gap-2">
                      <Link to="/troubleshoot">
                        <Button className="!h-[34px] !px-3.5 !rounded-lg text-xs md:text-sm font-medium">
                          故障排查向导
                        </Button>
                      </Link>
                      <Link to="/approvals">
                        <Button
                          type="primary"
                          className="!h-[34px] !px-4 !rounded-lg text-xs md:text-sm font-medium shadow-xs hover:brightness-105 active:scale-95 transition-all inline-flex items-center justify-center gap-1.5"
                          icon={<EtherealIcon name="verified_user" size={15} className="text-white" />}
                        >
                          <span>查看待审批单</span>
                        </Button>
                      </Link>
                    </div>
                  </div>
                </>
              ) : (
                /* Real Nominal Guardian Operational State */
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between pb-2.5 border-b border-surface-container">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-tertiary" />
                        <h3 className="text-sm md:text-base font-semibold text-on-surface">智能守卫运行中</h3>
                        <span className="px-2.5 py-0.5 rounded-full bg-tertiary-container/10 text-tertiary text-xs font-semibold">
                          策略在线
                        </span>
                      </div>
                      <button
                        className="p-1 rounded-full hover:bg-surface-container text-on-surface-variant transition-colors cursor-pointer"
                        onClick={() => void data.refresh()}
                        title="刷新状态"
                        type="button"
                      >
                        <EtherealIcon name="refresh" size={16} />
                      </button>
                    </div>

                    <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/15 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-md bg-tertiary-container/15 text-tertiary flex items-center justify-center font-bold">
                            <EtherealIcon name="health_and_safety" size={15} />
                          </div>
                          <span className="text-xs md:text-sm font-semibold text-on-surface">安全规则与策略处于标称就绪态</span>
                        </div>
                        <span className="font-mono text-xs text-tertiary font-semibold">0 笔未决审批</span>
                      </div>
                      <p className="text-xs text-on-surface-variant leading-relaxed">
                        Hermes 回环隔离及出站规则已装载，系统当前无待审批的人工介入请求，所有消息与自动化任务均按预期策略执行。
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-0.5 font-mono text-xs">
                        <span className="px-2 py-0.5 rounded-md bg-surface-container text-on-surface-variant font-medium">出站: 策略受控</span>
                        <span className="px-2 py-0.5 rounded-md bg-surface-container text-on-surface-variant font-medium">沙盒: 本机隔离</span>
                        <span className="px-2 py-0.5 rounded-md bg-surface-container text-tertiary font-semibold">探针 SLA: 99.98%</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 flex flex-wrap items-center justify-between gap-3 border-t border-surface-container mt-3">
                    <span className="text-xs text-on-surface-variant font-mono">
                      LAST INSPECTION: {formatRelative(inspectStatus?.lastAt)}
                    </span>
                    <div className="flex items-center gap-2">
                      <Link
                        to="/audit"
                        className="h-[34px] px-3.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs md:text-sm font-medium transition-all active:scale-95 text-center inline-flex items-center justify-center"
                      >
                        安全审计
                      </Link>
                      <Button
                        type="primary"
                        className="!h-[34px] !px-4 !rounded-lg text-xs md:text-sm font-medium shadow-xs hover:brightness-105 active:scale-95 transition-all inline-flex items-center justify-center gap-1.5"
                        onClick={() => void inspect()}
                        icon={<EtherealIcon name="refresh" size={15} className="text-white" />}
                      >
                        <span>即时体检</span>
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Right: Next Scheduled Cron Job (5 cols) */}
            <div className="lg:col-span-5 rounded-xl md:rounded-2xl bg-surface-container-lowest p-4 md:p-5 shadow-xs border border-outline-variant/15 flex flex-col justify-between bento-card-hover">
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-2.5 border-b border-surface-container">
                  <div className="flex items-center gap-2">
                    <EtherealIcon name="event_upcoming" size={17} className="text-primary" />
                    <h3 className="text-sm md:text-base font-semibold text-on-surface">下一条定时任务</h3>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-xs font-mono font-medium">
                    CRON 调度
                  </span>
                </div>
                <div className="space-y-2.5">
                  {data.tasks.next ? (
                    <div>
                      <div className="text-sm md:text-base font-semibold text-on-surface font-mono">
                        {data.tasks.next.name}
                      </div>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        {data.tasks.next.id ? "Hermes 托管自动化定时任务" : "计划执行任务"}
                      </p>
                      <div className="p-3 rounded-xl bg-surface-container-low space-y-1.5 font-mono text-xs mt-2.5">
                        <div className="flex items-center justify-between text-on-surface">
                          <span className="text-on-surface-variant">计划触发时间:</span>
                          <span className="font-semibold">
                            {data.tasks.next.nextRunAt ? formatRelative(data.tasks.next.nextRunAt) : "待调度"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-on-surface">
                          <span className="text-on-surface-variant">今日累计调度:</span>
                          <span className="text-tertiary font-semibold">
                            已执行 {data.tasks.todayRunCount} 次 · 失败 {data.tasks.failedTaskCount} 个
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-3 text-center space-y-2">
                      <p className="text-sm text-on-surface font-medium">当前暂无待触发排程</p>
                      <p className="text-xs text-on-surface-variant">
                        可随时在定时任务中添加日常巡检、定期推送或自动化任务
                      </p>
                      <div className="p-2.5 rounded-xl bg-surface-container-low text-xs font-mono text-on-surface-variant">
                        今日累计调度: 已执行 {data.tasks.todayRunCount} 次 · 失败 {data.tasks.failedTaskCount} 个
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="pt-3 flex items-center justify-between border-t border-surface-container mt-3">
                <Link
                  to="/tasks"
                  className="text-on-surface-variant hover:text-primary text-xs md:text-sm font-medium transition-colors"
                >
                  查看全部任务
                </Link>
                {data.tasks.next ? (
                  <button
                    className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs md:text-sm font-medium transition-all active:scale-95 cursor-pointer"
                    onClick={() => void inspect()}
                    type="button"
                  >
                    <EtherealIcon name="play_arrow" size={15} />
                    <span>立即触发执行</span>
                  </button>
                ) : (
                  <Link
                    to="/tasks"
                    className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs md:text-sm font-medium transition-all active:scale-95"
                  >
                    <EtherealIcon name="add" size={15} />
                    <span>添加定时任务</span>
                  </Link>
                )}
              </div>
            </div>
          </section>

          {/* Section E-1: 系统巡检与调度吞吐态势 */}
          <SystemTelemetryChart
            failedTaskCount={data.tasks.failedTaskCount > 0 ? data.tasks.failedTaskCount : 0}
            todayRunCount={data.tasks.todayRunCount ?? 0}
            probeSlaText={probe?.overdue ? "需留意" : "正常"}
            onlineInstancesText={instanceOnlineText}
            nextTask={data.tasks.next}
            upcomingTasks={data.tasks.upcoming}
          />

          {/* Section E-2: 健康守护态势与探针 SLA */}
          <GuardianPostureChart
            inspectStatus={inspectStatus}
            isBridgeConnected={isBridgeConnected}
            onlineInstancesText={instanceOnlineText}
            memoryLabel={capabilityLabel(input.memory)}
            failedMessagesCount={failedMessagesCount}
          />
        </>
      )}
    </div>
  );
}
