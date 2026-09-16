import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Segmented, Skeleton, Space, Switch, Tag, Tooltip } from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { ScheduledTaskDraft, ScheduledTaskSummary, ScheduledTaskStatus, ScheduledTaskIncidents } from "@butler/contract";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, mutateJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { TaskEditorDrawer, TASK_TEMPLATES } from "./TaskEditorDrawer.js";
import { TaskRunHistory } from "./TaskRunHistory.js";
import { TaskTestRunModal } from "./TaskTestRunModal.js";
import { compareTasks, taskFailureLabel, taskMutationError, taskStatusLabel, taskTime } from "./taskCopy.js";
import "./tasks.css";

interface TasksPayload { supported: boolean; reachable: boolean; reason?: string; items: ScheduledTaskSummary[] }
type StatusView = ScheduledTaskStatus & { reachable: boolean; writesSupported?: boolean; timezone?: string | null };
type TaskView = ScheduledTaskSummary & { editable?: boolean; failureReason?: string | null };
type Editor = { key: string; taskId?: string; initialDraft?: ScheduledTaskDraft };
type Action = "pause" | "resume" | "run" | "delete";

function formatRelativeNext(nextRunAt: string | null): string {
  if (!nextRunAt) return "暂无排程";
  const diffMs = new Date(nextRunAt).getTime() - Date.now();
  if (diffMs <= 0) return "即将执行";
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) return `约 ${diffMinutes} 分钟后`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `约 ${diffHours} 小时后`;
  const diffDays = Math.round(diffHours / 24);
  return `约 ${diffDays} 天后`;
}

export function TasksPage() {
  const { message, modal } = App.useApp();
  const [data, setData] = useState<TasksPayload | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [incidents, setIncidents] = useState<ScheduledTaskIncidents | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [statusTab, setStatusTab] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [history, setHistory] = useState<TaskView | null>(null);
  const [testRunningTask, setTestRunningTask] = useState<TaskView | null>(null);
  const [deleting, setDeleting] = useState<TaskView | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setRefreshing(true);
    const [listResult, statusResult, incidentResult] = await Promise.all([
      loadJson<TasksPayload>("/api/scheduled-tasks", 20_000),
      loadJson<StatusView>("/api/scheduled-tasks/status", 20_000),
      loadJson<ScheduledTaskIncidents>("/api/scheduled-tasks/incidents", 20_000),
    ]);
    if (current !== generation.current) return;
    setRefreshing(false);
    setFailed(!listResult.ok || !statusResult.ok);
    setData(listResult.ok ? listResult.data : null);
    setStatus(statusResult.ok ? statusResult.data : null);
    setIncidents(incidentResult.ok ? incidentResult.data : null);
  }, []);
  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);
  usePolling(() => void refresh(), 30_000);
  const reachable = !failed && data?.reachable === true && status?.reachable === true;
  const supported = data?.supported !== false && status?.supported !== false;
  const timezone = status?.timezone ?? "";
  const writable = reachable && supported && status?.writesSupported === true && Boolean(timezone);
  const items: TaskView[] = [...(data?.items ?? [])].sort(compareTasks);

  const attentionTasks = items.filter((task) => ["failed", "delivery_failed", "unknown"].includes(task.lastStatus));
  const activeCount = items.filter((t) => t.enabled).length;
  const pausedCount = items.filter((t) => !t.enabled).length;
  const attentionCount = attentionTasks.length;

  const filteredByTab = items.filter((task) => {
    if (statusTab === "active") return task.enabled;
    if (statusTab === "paused") return !task.enabled;
    if (statusTab === "attention") return ["failed", "delivery_failed", "unknown"].includes(task.lastStatus);
    return true;
  });

  const visible = filteredByTab.filter((task) =>
    task.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) ||
    task.scheduleLabel.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
  );

  const nowMs = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const upcomingTimeline = items
    .filter((task) => {
      if (!task.enabled || !task.nextRunAt) return false;
      const t = new Date(task.nextRunAt).getTime();
      return !isNaN(t) && t >= nowMs - 60_000 && t <= nowMs + oneDayMs;
    })
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());

  const failureFor = (task: TaskView) => {
    // Hermes reports the delivery error itself; there is no run failure to look up.
    if (task.lastStatus === "delivery_failed") return taskFailureLabel("delivery");
    if (task.lastStatus !== "failed") return null;
    const incident = incidents?.items.filter((item) => item.taskId === task.id && item.state !== "closed")
      .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))[0];
    return taskFailureLabel(incident?.failureType ?? "unknown");
  };

  const mutate = async (task: TaskView, action: Action) => {
    if (busy !== null) return;
    const key = `${task.id}:${action}`;
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    setBusy(key);
    setActionError(null);
    const result = await mutateJson(action === "delete" ? "DELETE" : "POST",
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}${action === "delete" ? "" : `/${action}`}`,
      { requestId, ...(action === "delete" ? { confirmName } : {}) });
    setBusy(null);
    if (!result.ok || (result.data as { outcome?: string } | null)?.outcome !== "succeeded") {
      setActionError(taskMutationError(result.status, result.data));
      return;
    }
    requestIds.current.delete(key);
    if (action === "delete") { setDeleting(null); setConfirmName(""); }
    message.success(({ pause: "任务已暂停", resume: "任务已恢复", run: "已请求下一轮执行", delete: "任务已删除" })[action]);
    await refresh();
  };
  const edit = async (task: TaskView) => {
    setBusy(`${task.id}:edit`);
    const result = await loadJson<{ reachable: boolean; editable: boolean; draft: ScheduledTaskDraft }>(
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}`, 20_000,
    );
    setBusy(null);
    if (!result.ok || result.data.reachable === false || !result.data.editable || !result.data.draft) {
      setActionError("当前任务无法在面板编辑。脚本和特殊任务请在 Hermes 中维护。");
      return;
    }
    setEditor({ key: crypto.randomUUID(), taskId: task.id, initialDraft: result.data.draft });
  };
  const toggle = (task: TaskView, enabled: boolean) => modal.confirm({
    title: `${enabled ? "恢复" : "暂停"}“${task.name}”？`,
    content: enabled ? "Hermes 将恢复此任务的计划执行。" : "暂停后不再自动执行，已经开始的执行不会被终止。",
    okText: enabled ? "恢复任务" : "暂停任务", cancelText: "取消",
    onOk: () => mutate(task, enabled ? "resume" : "pause"),
  });

  return <div className="page-stack tasks-page">
    <PageHeader title="定时任务" extra={<Space>
      <Tooltip title="刷新"><Button aria-label="刷新定时任务" icon={<ReloadOutlined />} loading={refreshing}
        onClick={() => void refresh()} /></Tooltip>
      {supported && <Button type="primary" icon={<PlusOutlined />} disabled={!writable}
        onClick={() => setEditor({ key: crypto.randomUUID() })}>新建任务</Button>}
    </Space>} />
    {!supported ? <Alert type="info" showIcon title="当前仅 Hermes 支持定时任务" />
      : failed || (data && !reachable) ? <Alert type="warning" showIcon title="暂时无法读取 Hermes 定时任务"
        description="连接恢复后可以继续查看和管理，现有任务仍由 Hermes 调度。" />
      : status && <section className="tasks-summary" aria-label="定时任务概况">
        <div className="summary-card">
          <div className="summary-card-header">
            <ClockCircleOutlined className="summary-icon" />
            <span>调度服务</span>
          </div>
          <span>调度状态</span><strong>{status.schedulerRunning ? "正在运行" : "未确认运行"}</strong>
          <span className="summary-subtext">Hermes 守护进程 · {timezone || "系统默认"}</span>
        </div>
        <div className="summary-card">
          <div className="summary-card-header">
            <ThunderboltOutlined className="summary-icon" />
            <span>任务规模</span>
          </div>
          <strong>{status.activeCount} <span style={{ fontSize: "14px", fontWeight: "normal", color: "var(--ab-text-2)" }}>/ {items.length} 已启用</span></strong>
          <span className="summary-subtext">今日已自动执行 {status.todayRunCount ?? 0} 次调度</span>
        </div>
        <div className="summary-card">
          <div className="summary-card-header">
            <CheckCircleOutlined className="summary-icon" style={{ color: attentionCount > 0 ? "var(--ab-warning)" : "var(--ab-success)" }} />
            <span>运行健康</span>
          </div>
          <strong style={{ color: attentionCount > 0 ? "var(--ab-warning)" : undefined }}>
            {attentionCount === 0 ? "全部健康" : `${attentionCount} 个需关注`}
          </strong>
          <span className="summary-subtext">{attentionCount === 0 ? "全部任务运行健康无阻塞" : "存在执行失败或投递中断"}</span>
        </div>
        <div className="summary-card">
          <div className="summary-card-header">
            <HistoryOutlined className="summary-icon" />
            <span>下一次触发</span>
          </div>
          <strong style={{ fontSize: "18px" }}>{taskTime(status.nextRunAt, timezone)}</strong>
          <span className="summary-subtext">{status.nextRunAt ? formatRelativeNext(status.nextRunAt) : "暂无待触发排程"}</span>
        </div>
      </section>}
    {supported && reachable && !writable && <Alert type="info" showIcon title="当前为只读模式"
      description="宿主控制服务尚未确认写入能力或执行时区，现有任务可以继续查看。" />}
    {actionError && <Alert type="error" showIcon title={actionError} closable onClose={() => setActionError(null)} />}
    {supported && <section className="tasks-list-section">
      <div className="tasks-main-layout">
        {/* 左栏：工具栏 + 任务卡片 */}
        <div className="tasks-content-area">
          <div className="tasks-toolbar-v2">
            <Segmented
              value={statusTab}
              onChange={(val) => setStatusTab(val as string)}
              options={[
                { label: `全部 (${items.length})`, value: "all" },
                { label: `已启用 (${activeCount})`, value: "active" },
                { label: `已暂停 (${pausedCount})`, value: "paused" },
                { label: `需关注 (${attentionCount})`, value: "attention" },
              ]}
            />
            <Input.Search
              aria-label="搜索定时任务"
              placeholder="搜索任务名称或表达式..."
              allowClear
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              style={{ maxWidth: 260 }}
            />
          </div>

          {!data && !failed ? <Skeleton active paragraph={{ rows: 6 }} />
            : reachable && visible.length === 0 ? <Empty description={filter || statusTab !== "all" ? "没有匹配的任务" : "尚无定时任务"} />
            : reachable && <div className="tasks-grid-list">
              {visible.map((task, idx) => {
                const cardStatus = !task.enabled
                  ? "paused"
                  : task.lastStatus === "failed"
                  ? "failed"
                  : task.lastStatus === "delivery_failed"
                  ? "delivery_failed"
                  : "active";
                return (
                  <article
                    className="task-row task-rich-card ab-card-hover ab-stagger"
                    key={task.id}
                    data-status={cardStatus}
                    style={{ "--ab-stagger-i": Math.min(idx, 12) } as React.CSSProperties}
                  >
                    <div className="task-card-header">
                      <div className="task-card-title-col">
                        <h2 className="task-card-name" title={task.name}>{task.name}</h2>
                        <div className="task-card-badges">
                          <Tag color={task.scheduleLabel.toLowerCase().includes("cron") ? "geekblue" : "purple"}>
                            {task.scheduleLabel.toLowerCase().includes("cron") ? "Cron 表达式" : "排程计划"}
                          </Tag>
                          {task.deliveryEnabled ? (
                            <Tag color="cyan">已配通知</Tag>
                          ) : (
                            <Tag color="default">免打扰</Tag>
                          )}
                        </div>
                      </div>
                      <div className="task-switch-container">
                        <span className="switch-label">{task.enabled ? "运行中" : "已暂停"}</span>
                        <Switch
                          aria-label={`${task.name}启用`}
                          checked={task.enabled}
                          disabled={!writable || busy !== null}
                          loading={busy === `${task.id}:pause` || busy === `${task.id}:resume`}
                          onChange={(enabled) => toggle(task, enabled)}
                        />
                      </div>
                    </div>

                    <div className="task-schedule-panel">
                      <div className="task-schedule-expr">
                        <ClockCircleOutlined className="task-schedule-icon" />
                        <span className="task-schedule-label" title={task.scheduleLabel}>
                          {task.scheduleLabel}
                        </span>
                      </div>
                      <div className="task-next-run-box">
                        <span className="task-next-label">下次执行</span>
                        {task.enabled ? (
                          <div className="task-next-time-row">
                            <span className="task-next-time">{taskTime(task.nextRunAt, timezone)}</span>
                            <span className="task-countdown-pill">{formatRelativeNext(task.nextRunAt)}</span>
                          </div>
                        ) : (
                          <span className="task-paused-text">已暂停调度</span>
                        )}
                      </div>
                    </div>

                    <div className="task-status-row">
                      <div className="task-result-status">
                        <Tag color={task.lastStatus === "failed" ? "error" : task.lastStatus === "delivery_failed" ? "warning" : task.lastStatus === "success" ? "success" : "default"}>
                          {taskStatusLabel(task.lastStatus)}
                        </Tag>
                        <span className="last-run-time">
                          {task.lastRunAt ? `最近: ${taskTime(task.lastRunAt, timezone)}` : "尚未触发执行"}
                        </span>
                      </div>
                      {failureFor(task) && (
                        <div className="task-failure-banner" role="alert">
                          <WarningOutlined />
                          <span title={failureFor(task)!}>{failureFor(task)}</span>
                        </div>
                      )}
                    </div>

                    <div className="task-card-footer">
                      <Space size={6} wrap className="task-actions">
                        <Tooltip title="查看历史记录与日志">
                          <Button
                            aria-label={`查看${task.name}执行历史`}
                            icon={<HistoryOutlined />}
                            onClick={() => setHistory(task)}
                          >
                            历史
                          </Button>
                        </Tooltip>
                        <Tooltip title={task.editable === false ? "此类任务请在 Hermes 编辑" : "修改任务配置"}>
                          <Button
                            aria-label={`编辑${task.name}`}
                            icon={<EditOutlined />}
                            disabled={!writable || task.editable === false || busy !== null}
                            onClick={() => void edit(task)}
                          >
                            编辑
                          </Button>
                        </Tooltip>
                        <Tooltip title={status?.runSupported ? "立即手动单次测试运行" : "当前 Hermes 状态暂不支持测试运行"}>
                          <Button
                            aria-label={`测试运行${task.name}`}
                            icon={<PlayCircleOutlined />}
                            disabled={!writable || !status?.runSupported || busy !== null}
                            onClick={() => setTestRunningTask(task)}
                          >
                            测试运行
                          </Button>
                        </Tooltip>
                        <Tooltip title="删除任务">
                          <Button
                            danger
                            aria-label={`删除${task.name}`}
                            icon={<DeleteOutlined />}
                            disabled={!writable || busy !== null}
                            onClick={() => { setDeleting(task); setConfirmName(""); }}
                          />
                        </Tooltip>
                      </Space>
                    </div>
                  </article>
                );
              })}
            </div>}
        </div>

        {/* 右栏：未来24小时排程 + 快捷模版 + 运行基线 */}
        <aside className="tasks-sidebar">
          {/* 未来 24 小时排程流水线 */}
          <div className="sidebar-widget-card">
            <div className="sidebar-widget-title">
              <ClockCircleOutlined style={{ color: "var(--ab-primary)" }} />
              <span>未来 24 小时排程流水线</span>
            </div>
            {upcomingTimeline.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未来 24 小时内暂无待触发排程" />
            ) : (
              <div className="timeline-stream">
                {upcomingTimeline.map((item) => {
                  const date = new Date(item.nextRunAt!);
                  const timeStr = isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <div className="timeline-item" key={item.id}>
                      <div className="timeline-time-col">
                        <span className="timeline-time-badge">{timeStr}</span>
                      </div>
                      <div className="timeline-info-col">
                        <span className="timeline-task-name" title={item.name}>{item.name}</span>
                        <span className="timeline-countdown">{formatRelativeNext(item.nextRunAt)} · {item.scheduleLabel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 常用场景模版选用 */}
          <div className="sidebar-widget-card">
            <div className="sidebar-widget-title">
              <ThunderboltOutlined style={{ color: "var(--ab-warning)" }} />
              <span>常用场景模版选用</span>
            </div>
            <div className="quick-scenarios-grid">
              {TASK_TEMPLATES.slice(0, 4).map((tpl) => (
                <div className="quick-scenario-item" key={tpl.key}>
                  <div className="scenario-meta">
                    <span className="scenario-title-line">{tpl.title}</span>
                    <span className="scenario-desc" title={tpl.name}>{tpl.name}</span>
                  </div>
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    disabled={!writable}
                    onClick={() => {
                      setEditor({
                        key: crypto.randomUUID(),
                        initialDraft: {
                          name: tpl.name,
                          prompt: tpl.prompt,
                          schedule: tpl.schedule(timezone || "Asia/Shanghai"),
                          delivery: { enabled: true },
                        },
                      });
                    }}
                  >
                    选用
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* 调度器运行基线 */}
          <div className="sidebar-widget-card">
            <div className="sidebar-widget-title">
              <DashboardOutlined style={{ color: "var(--ab-text-2)" }} />
              <span>调度器运行基线</span>
            </div>
            <div className="daemon-info-list">
              <div className="daemon-info-item">
                <span>调度引擎</span>
                <strong>Hermes Cron Daemon</strong>
              </div>
              <div className="daemon-info-item">
                <span>基准时区</span>
                <strong>{timezone || "系统时区"}</strong>
              </div>
              <div className="daemon-info-item">
                <span>状态同步</span>
                <strong>{status?.heartbeatAgeSeconds != null ? `${status.heartbeatAgeSeconds} 秒前` : "实时"}</strong>
              </div>
              <div className="daemon-info-item">
                <span>动态重载</span>
                <Tag color="success" style={{ margin: 0 }}>支持热生效</Tag>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>}
    {editor && <TaskEditorDrawer key={editor.key} open taskId={editor.taskId} initialDraft={editor.initialDraft}
      timezone={timezone} onClose={() => setEditor(null)}
      onSaved={() => { setEditor(null); void refresh(); }} />}
    <TaskRunHistory task={history} onClose={() => setHistory(null)} timezone={timezone} />
    <TaskTestRunModal open={testRunningTask !== null} task={testRunningTask} onClose={() => { setTestRunningTask(null); void refresh(); }} />
    <Modal open={deleting !== null} title="删除定时任务" okText="删除任务" cancelText="取消"
      okButtonProps={{ danger: true, disabled: confirmName !== deleting?.name }}
      confirmLoading={busy === `${deleting?.id}:delete`}
      onCancel={() => { if (busy === null) setDeleting(null); }}
      onOk={() => { if (deleting) void mutate(deleting, "delete"); }}>
      {actionError && <Alert type="error" showIcon title={actionError} />}
      <p>删除后不再按计划执行。请输入任务名称确认：</p>
      <p><strong>{deleting?.name}</strong></p>
      <Input aria-label="确认删除任务名称" value={confirmName} disabled={busy !== null}
        onChange={(event) => setConfirmName(event.target.value)} />
    </Modal>
  </div>;
}
