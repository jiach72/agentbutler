import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Skeleton, Space, Switch, Tag, Tooltip } from "antd";
import { DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ScheduledTaskDraft, ScheduledTaskSummary, ScheduledTaskStatus, ScheduledTaskIncidents } from "@butler/contract";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, mutateJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { TaskEditorDrawer } from "./TaskEditorDrawer.js";
import { TaskRunHistory } from "./TaskRunHistory.js";
import { compareTasks, taskFailureLabel, taskMutationError, taskStatusLabel, taskTime } from "./taskCopy.js";
import "./tasks.css";

interface TasksPayload { supported: boolean; reachable: boolean; reason?: string; items: ScheduledTaskSummary[] }
type StatusView = ScheduledTaskStatus & { reachable: boolean; writesSupported?: boolean; timezone?: string | null };
type TaskView = ScheduledTaskSummary & { editable?: boolean; failureReason?: string | null };
type Editor = { key: string; taskId?: string; initialDraft?: ScheduledTaskDraft };
type Action = "pause" | "resume" | "run" | "delete";

export function TasksPage() {
  const { message, modal } = App.useApp();
  const [data, setData] = useState<TasksPayload | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [incidents, setIncidents] = useState<ScheduledTaskIncidents | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [history, setHistory] = useState<TaskView | null>(null);
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
  const visible = items.filter((task) => task.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const failureFor = (task: TaskView) => {
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
  const run = (task: TaskView) => modal.confirm({
    title: `立即运行“${task.name}”？`,
    content: "Hermes 将在下一轮调度执行任务。任务可能调用模型、修改文件或发送通知。",
    okText: "确认运行", cancelText: "取消", onOk: () => mutate(task, "run"),
  });
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
        <div><span>调度状态</span><strong>{status.schedulerRunning ? "正在运行" : "未确认运行"}</strong></div>
        <div><span>已启用</span><strong>{status.activeCount}</strong></div>
        <div><span>需要关注</span><strong>{items.filter((task) => ["failed", "unknown"].includes(task.lastStatus)).length}</strong></div>
        <div><span>下一次执行</span><strong>{taskTime(status.nextRunAt, timezone)}</strong></div>
      </section>}
    {supported && reachable && !writable && <Alert type="info" showIcon title="当前为只读模式"
      description="宿主控制服务尚未确认写入能力或执行时区，现有任务可以继续查看。" />}
    {actionError && <Alert type="error" showIcon title={actionError} closable onClose={() => setActionError(null)} />}
    {supported && <section className="tasks-list-section">
      <div className="tasks-toolbar">
        <Input.Search aria-label="搜索定时任务" placeholder="搜索任务名称" allowClear value={filter}
          onChange={(event) => setFilter(event.target.value)} />
        {timezone && <span className="task-timezone">{timezone}</span>}
      </div>
      {!data && !failed ? <Skeleton active paragraph={{ rows: 6 }} />
        : reachable && visible.length === 0 ? <Empty description={filter ? "没有匹配的任务" : "尚无定时任务"} />
        : reachable && <div className="tasks-list">
          <div className="task-row task-row-heading" aria-hidden="true">
            <span>任务</span><span>下一次执行</span><span>最近结果</span><span>启用</span><span>操作</span>
          </div>
          {visible.map((task) => <article className="task-row" key={task.id}>
            <div className="task-name-cell"><h2>{task.name}</h2><p>{task.scheduleLabel}</p>
              {!task.deliveryEnabled && <span className="task-muted">不发送完成通知</span>}</div>
            <div className="task-next-cell"><span className="task-mobile-label">下一次执行</span>
              {task.enabled ? taskTime(task.nextRunAt, timezone) : "已暂停"}</div>
            <div><Tag color={task.lastStatus === "failed" ? "error" : task.lastStatus === "success" ? "success" : "default"}>
              {taskStatusLabel(task.lastStatus)}</Tag>
              <p className="task-muted">{task.lastRunAt ? taskTime(task.lastRunAt, timezone) : ""}</p>
              {failureFor(task) && <p className="task-failure">{failureFor(task)}</p>}
            </div>
            <div className="task-enabled-cell"><span className="task-mobile-label">启用</span>
              <Switch aria-label={`${task.name}启用`} checked={task.enabled} disabled={!writable || busy !== null}
                loading={busy === `${task.id}:pause` || busy === `${task.id}:resume`}
                onChange={(enabled) => toggle(task, enabled)} /></div>
            <Space size={4} wrap className="task-actions">
              <Tooltip title="执行历史"><Button aria-label={`查看${task.name}执行历史`} icon={<HistoryOutlined />}
                onClick={() => setHistory(task)} /></Tooltip>
              <Tooltip title={task.editable === false ? "此类任务请在 Hermes 编辑" : "编辑"}>
                <Button aria-label={`编辑${task.name}`} icon={<EditOutlined />}
                  disabled={!writable || task.editable === false || busy !== null} onClick={() => void edit(task)} /></Tooltip>
              <Tooltip title={status?.runSupported ? "立即运行" : "当前 Hermes 版本暂不支持安全的立即运行"}>
                <Button aria-label={`立即运行${task.name}`} icon={<PlayCircleOutlined />}
                  disabled={!writable || !status?.runSupported || busy !== null} onClick={() => run(task)} /></Tooltip>
              <Tooltip title="删除"><Button danger aria-label={`删除${task.name}`} icon={<DeleteOutlined />}
                disabled={!writable || busy !== null} onClick={() => { setDeleting(task); setConfirmName(""); }} /></Tooltip>
            </Space>
          </article>)}
        </div>}
    </section>}
    {editor && <TaskEditorDrawer key={editor.key} open taskId={editor.taskId} initialDraft={editor.initialDraft}
      timezone={timezone} onClose={() => setEditor(null)}
      onSaved={() => { setEditor(null); void refresh(); }} />}
    <TaskRunHistory task={history} onClose={() => setHistory(null)} timezone={timezone} />
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
