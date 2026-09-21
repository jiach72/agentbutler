import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Collapse, Skeleton, Tag } from "antd";
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { postJson } from "../../lib/api.js";
import { formatRelative } from "../../lib/format.js";
import { PageHeader } from "../../components/PageHeader.js";
import { AttentionList, TaskPreview } from "./HealthOverview.js";
import { capabilityLabel } from "./userHealth.js";
import { useUserHealthData } from "./useUserHealthData.js";
import "./dashboard.css";

interface RuntimeDetailsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Retained for existing consumers; operational controls live in expert views. */
export function RuntimeDetails({ open, onOpenChange, children }: RuntimeDetailsProps) {
  return <div id="runtime-details"><Collapse
    className="advanced-details runtime-details"
    activeKey={open ? ["runtime"] : []}
    onChange={(keys) => onOpenChange(Array.isArray(keys) && keys.includes("runtime"))}
    items={[{ key: "runtime", label: "运行详情", children }]}
  /></div>;
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ padding: "20px 24px", background: "var(--ab-surface)", border: "1px solid var(--ab-border)", borderRadius: "var(--ab-r-card, 14px)" }}>
        <Skeleton.Button active size="small" shape="round" style={{ width: 180, marginBottom: 14 }} />
        <Skeleton active title={{ width: "35%" }} paragraph={{ rows: 2, width: ["75%", "55%"] }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <div style={{ height: 110, padding: 16, background: "var(--ab-surface)", border: "1px solid var(--ab-border)", borderRadius: "var(--ab-r-card, 14px)" }}>
          <Skeleton active paragraph={{ rows: 2, width: ["80%", "40%"] }} />
        </div>
        <div style={{ height: 110, padding: 16, background: "var(--ab-surface)", border: "1px solid var(--ab-border)", borderRadius: "var(--ab-r-card, 14px)" }}>
          <Skeleton active paragraph={{ rows: 2, width: ["80%", "40%"] }} />
        </div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const data = useUserHealthData();
  const { message } = App.useApp();
  const [inspecting, setInspecting] = useState(false);
  const inspect = async () => {
    setInspecting(true);
    try {
      const result = await postJson("/api/inspect/run");
      if (result.status === 202) { message.success("已开始检查，结果会自动更新"); await data.refresh(); }
      else if (result.status === 409) message.info("检查正在进行中");
      else message.error("暂时无法开始检查，请检查管家连接");
    } finally { setInspecting(false); }
  };
  const { health, input, onlineInstances, totalInstances, sources } = data;
  const messageState = input.messages?.connected === true
    && input.messages.failed === 0 && input.messages.unknown === 0 ? "可用"
    : input.messages?.connected === false ? "连接中断"
      : (input.messages?.failed ?? 0) + (input.messages?.unknown ?? 0) > 0 ? "需核对投递" : "待确认";

  const inspectStatus = sources.dashboard?.inspectStatus;
  const probe = inspectStatus?.criticalProbe;
  const checks = sources.dashboard?.latestInspections?.[0]?.checks ?? [];

  return (
    <section className="dashboard-page dashboard-simple">
      <PageHeader title="首页" extra={<Link className="health-wall-link" to="/wall"><DashboardOutlined />大屏模式</Link>} />
      {data.loading ? <DashboardSkeleton /> : <>
        {/* 顶部结论横幅 */}
        <section className="health-conclusion" data-status={health.status} aria-labelledby="health-headline">
          <div className="health-conclusion-header">
            {(() => {
              const pulseStatus: "online" | "offline" | "discovering" =
                onlineInstances && onlineInstances > 0
                  ? "online"
                  : totalInstances !== null && totalInstances > 0
                    ? "offline"
                    : "discovering";
              const pulseText =
                pulseStatus === "online"
                  ? `Hermes Agent 就绪待命 (${onlineInstances}/${totalInstances ?? 1} 在线)`
                  : pulseStatus === "offline"
                    ? `Hermes Agent 离线 (${totalInstances} 个实例均未连接)`
                    : "正在探测 Hermes Agent 连接…";
              return (
                <div className="agent-pulse-badge" data-pulse={pulseStatus}>
                  <span className="pulse-dot" aria-hidden="true" />
                  <span className="pulse-text">{pulseText}</span>
                </div>
              );
            })()}
            <h2 id="health-headline">{health.headline}</h2>
            <p>{health.explanation}</p>
            <div className="health-conclusion-meta">
              <span>上次检查：{formatRelative(inspectStatus?.lastAt)}</span>
              <span className="meta-sep">·</span>
              <span>自动巡检：{inspectStatus?.intervalMin ?? 10} 分钟/次</span>
              <span className="meta-sep">·</span>
              <span>探针 SLA：{probe?.overdue ? "需留意" : "正常"}</span>
            </div>
          </div>
          <div className="health-conclusion-actions">
            <Button
              type="primary"
              icon={<SafetyCertificateOutlined />}
              loading={inspecting}
              onClick={() => { void inspect(); }}
            >
              立即检查
            </Button>
            <Link to="/tools">
              <Button icon={<ToolOutlined />}>运维工具</Button>
            </Link>
          </div>
        </section>

        {/* 管家快捷通道 */}
        <section className="butler-quick-actions" aria-label="管家快捷通道">
          <div className="butler-quick-grid">
            <Link to="/tasks" className="butler-quick-card ab-card-hover">
              <div className="butler-quick-icon action-task">
                <FieldTimeOutlined />
              </div>
              <div className="butler-quick-content">
                <strong>新建定时任务</strong>
                <span>自动化巡检与消息播报</span>
              </div>
              <ArrowRightOutlined className="butler-quick-arrow" />
            </Link>

            <Link to="/gateway" className="butler-quick-card ab-card-hover">
              <div className="butler-quick-icon action-chat">
                <MessageOutlined />
              </div>
              <div className="butler-quick-content">
                <strong>智能体即时通讯</strong>
                <span>直接与 Hermes 对话与发信</span>
              </div>
              <ArrowRightOutlined className="butler-quick-arrow" />
            </Link>

            <Link to="/skills" className="butler-quick-card ab-card-hover">
              <div className="butler-quick-icon action-skill">
                <AppstoreOutlined />
              </div>
              <div className="butler-quick-content">
                <strong>技能与插件库</strong>
                <span>管理 Agent 技能与记忆</span>
              </div>
              <ArrowRightOutlined className="butler-quick-arrow" />
            </Link>

            <Link to="/tools" className="butler-quick-card ab-card-hover">
              <div className="butler-quick-icon action-tool">
                <ToolOutlined />
              </div>
              <div className="butler-quick-content">
                <strong>专家诊断与工具</strong>
                <span>现象排查与实时守护日志</span>
              </div>
              <ArrowRightOutlined className="butler-quick-arrow" />
            </Link>
          </div>
        </section>

        {/* 核心守护能力矩阵 */}
        <section aria-labelledby="health-capabilities-title" className="health-capabilities ab-card-hover ab-rise">
          <div className="health-section-heading">
            <h2 id="health-capabilities-title">核心守护矩阵</h2>
            <Link to="/settings">偏好设置</Link>
          </div>
          <dl className="health-capability-list ab-stagger">
            <div style={{ ["--ab-stagger-i" as string]: 0 }}>
              <dt>
                <Link to="/setup" className="capability-title-link">
                  <RobotOutlined /> 智能体引擎
                </Link>
                <Tag color={onlineInstances && onlineInstances > 0 ? "success" : "default"}>
                  {onlineInstances && onlineInstances > 0 ? "就绪" : "待命"}
                </Tag>
              </dt>
              <dd>{totalInstances === null ? "待确认" : `${onlineInstances}/${totalInstances} 在线`}</dd>
              <p className="health-cap-desc">Hermes 本机进程与调度引擎就绪</p>
            </div>

            <div style={{ ["--ab-stagger-i" as string]: 1 }}>
              <dt>
                <Link to="/gateway" className="capability-title-link">
                  <MessageOutlined /> 消息网关
                </Link>
                <Tag color={messageState === "可用" ? "success" : messageState === "连接中断" ? "error" : "warning"}>
                  {messageState}
                </Tag>
              </dt>
              <dd>{messageState}</dd>
              <p className="health-cap-desc">Bridge 本机回环连通，投递队列畅通</p>
            </div>

            <div style={{ ["--ab-stagger-i" as string]: 2 }}>
              <dt>
                <Link to="/tasks" className="capability-title-link">
                  <ClockCircleOutlined /> 定时调度
                </Link>
                <Tag color={data.tasks.running ? "processing" : "default"}>
                  {data.tasks.running ? "运行中" : "未启动"}
                </Tag>
              </dt>
              <dd>{data.tasks.running ? `今日已执行 ${data.tasks.todayRunCount} 次` : "未启动"}</dd>
              <p className="health-cap-desc">
                {data.tasks.failedTaskCount > 0 ? `${data.tasks.failedTaskCount} 个失败待核对` : "调度引擎周期轮询正常"}
              </p>
            </div>

            <div style={{ ["--ab-stagger-i" as string]: 3 }}>
              <dt>
                <Link to="/skills?tab=memory" className="capability-title-link">
                  <CheckCircleOutlined /> 记忆与模型
                </Link>
                <Tag color={capabilityLabel(input.model) === "可用" ? "success" : "warning"}>
                  {capabilityLabel(input.model)}
                </Tag>
              </dt>
              <dd>{capabilityLabel(input.memory)}</dd>
              <p className="health-cap-desc">探针 SLA {probe?.overdue ? "需留意" : "达标"} · 记忆库正常</p>
            </div>
          </dl>
        </section>

        {/* 主工作区：需要处理 + 定时任务速览 */}
        <div className="health-main">
          <section className="health-issues ab-card-hover ab-rise" aria-labelledby="health-attention-title">
            <div className="health-section-heading">
              <h2 id="health-attention-title">需要处理 <span>{health.attention.length}</span></h2>
              <Button icon={<ReloadOutlined />} loading={data.refreshing} onClick={() => { void data.refresh(); }}>刷新</Button>
            </div>
            <AttentionList attention={health.attention} />
          </section>
          <TaskPreview tasks={data.tasks} />
        </div>

        {/* 高级详情折叠：管家巡检与探针明细 */}
        <section className="health-telemetry-section" aria-label="高级巡检详情">
          <Collapse
            className="advanced-details"
            items={[{
              key: "inspection-telemetry",
              label: "高级详情：管家自动化巡检与探针状态",
              children: (
                <div className="health-telemetry-content">
                  <div className="telemetry-grid">
                    <div className="telemetry-card">
                      <span className="telemetry-label">上次体检时间</span>
                      <strong className="telemetry-value">{inspectStatus?.lastAt ? new Date(inspectStatus.lastAt).toLocaleString("zh-CN") : "暂未执行"}</strong>
                    </div>
                    <div className="telemetry-card">
                      <span className="telemetry-label">自动体检周期</span>
                      <strong className="telemetry-value">{inspectStatus?.intervalMin ?? 10} 分钟 / 次</strong>
                    </div>
                    <div className="telemetry-card">
                      <span className="telemetry-label">关键探针 SLA</span>
                      <strong className="telemetry-value">{probe ? `${probe.slaMin} 分钟内达标` : "默认保护"}</strong>
                    </div>
                    <div className="telemetry-card">
                      <span className="telemetry-label">探针总运行计数</span>
                      <strong className="telemetry-value">{probe?.runCount ?? 0} 次</strong>
                    </div>
                  </div>
                  {checks.length > 0 && (
                    <div className="telemetry-checks-list">
                      <span className="telemetry-checks-title">最近一次探针明细：</span>
                      <div className="telemetry-tags">
                        {checks.map((chk) => (
                          <Tag key={chk.id} color={chk.status === "pass" ? "success" : chk.status === "warn" ? "warning" : "default"}>
                            {chk.id}: {chk.status} ({chk.durationMs ?? 0}ms)
                          </Tag>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="telemetry-footer-links">
                    <Link to="/tools">查看脱敏运行日志与诊断</Link>
                    <span className="meta-sep">·</span>
                    <Link to="/troubleshoot">进入排障向导</Link>
                  </div>
                </div>
              ),
            }]}
          />
        </section>
      </>}
    </section>
  );
}
