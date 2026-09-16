import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Collapse, Drawer, Input, Select, Space, Switch, Typography } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import type { ScheduledTaskDraft } from "@butler/contract";
import { mutateJson, postJson } from "../../lib/api.js";
import { SchedulePicker } from "./SchedulePicker.js";
import { scheduleConfirmation, taskMutationError } from "./taskCopy.js";
import { readScheduledTaskDefaults } from "../settings/taskDefaults.js";

export interface TaskPreview { scheduleLabel: string; nextRunAt: string | null; timezone: string }

interface TaskTemplate {
  key: string;
  title: string;
  name: string;
  prompt: string;
  schedule: (tz: string) => ScheduledTaskDraft["schedule"];
}

const TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "morning-report",
    title: "📋 每日早报",
    name: "每日早报与日程待办概览",
    prompt: "总结今日重要日程、未读邮件概要与重点待办事项，形成结构化晨报，并在 100 字内给出今日最优先关注的 3 件事。",
    schedule: (tz) => ({ kind: "daily", time: "08:30", timezone: tz }),
  },
  {
    key: "github-monitor",
    title: "🐙 GitHub 监控",
    name: "GitHub 关注仓库动态巡检",
    prompt: "检查关注的核心代码仓库是否有新提交的 Issue、PR 或未解决的安全提醒，汇总关键变更并标注需人工介入的事项。",
    schedule: (tz) => ({ kind: "daily", time: "10:00", timezone: tz }),
  },
  {
    key: "sys-health",
    title: "🖥️ 系统巡检",
    name: "主机服务与容器运行健康巡检",
    prompt: "巡检主机内存占用、磁盘剩余空间及关键后台服务状态，记录最近错误日志，并在资源超阈值或服务异常时输出预警。",
    schedule: () => ({ kind: "interval", everyMinutes: 120 }),
  },
  {
    key: "ai-radar",
    title: "📡 资讯雷达",
    name: "AI 领域开源进展与技术雷达",
    prompt: "检索过去 24 小时内 AI/LLM 领域的最新前沿开源项目、技术解读与产品动态，提炼 3 条深度摘要与落地价值建议。",
    schedule: (tz) => ({ kind: "daily", time: "18:00", timezone: tz }),
  },
  {
    key: "daily-retro",
    title: "📝 工作复盘",
    name: "工作日结项复盘与明日备忘",
    prompt: "回顾今日各项开发与跟进任务的完成进度，盘点卡点阻塞及明日优先级，生成简洁的工作复盘笔记。",
    schedule: (tz) => ({ kind: "weekdays", time: "18:30", timezone: tz }),
  },
];

export function emptyTaskDraft(timezone: string): ScheduledTaskDraft {
  return { name: "", prompt: "", schedule: { kind: "daily", time: "09:00", timezone },
    delivery: { enabled: readScheduledTaskDefaults().deliveryEnabled } };
}

export function TaskEditorDrawer({ open, taskId, initialDraft, timezone, onClose, onSaved }: {
  open: boolean; taskId?: string; initialDraft?: ScheduledTaskDraft; timezone: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { modal, message } = App.useApp();
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => initialDraft ?? emptyTaskDraft(timezone));
  const [preview, setPreview] = useState<TaskPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const scheduleKey = JSON.stringify(draft.schedule);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void postJson("/api/scheduled-tasks/preview", { schedule: JSON.parse(scheduleKey) }, 15_000).then((result) => {
        if (!current) return;
        const data = result.data as TaskPreview | null;
        if (result.ok && data && typeof data.scheduleLabel === "string"
          && typeof data.timezone === "string" && typeof data.nextRunAt === "string"
          && Number.isFinite(Date.parse(data.nextRunAt))) {
          setPreview(data);
        } else {
          setPreviewError("Hermes 尚未确认此执行时间，请检查时间设置与连接。");
        }
      });
    }, 400);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, scheduleKey]);

  const save = async () => {
    if (busy || !preview) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setError("请填写任务名称和任务内容。");
      return;
    }
    const fingerprint = JSON.stringify(draft);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    const result = await mutateJson(taskId ? "PATCH" : "POST",
      taskId ? `/api/scheduled-tasks/${encodeURIComponent(taskId)}` : "/api/scheduled-tasks",
      { requestId: request.current.id, draft });
    setBusy(false);
    if (!result.ok || (result.data as { outcome?: string } | null)?.outcome !== "succeeded") {
      setUncertain(result.status === 0 || result.status === 409 || result.status >= 500);
      setError(taskMutationError(result.status, result.data));
      return;
    }
    message.success(taskId ? "任务已更新" : "任务已创建");
    onSaved();
  };
  const close = () => {
    if (busy) return;
    if (JSON.stringify(draft) === JSON.stringify(initialDraft ?? emptyTaskDraft(timezone))) return onClose();
    modal.confirm({
      title: uncertain ? "操作结果还未确认" : "放弃未保存的修改？",
      content: uncertain ? "请先刷新列表核对任务，避免重新创建同一任务。" : "关闭后将丢弃当前草稿。",
      okText: "关闭", cancelText: "继续编辑", onOk: onClose,
    });
  };
  const frozen = busy || uncertain;
  const advanced = draft.advanced ?? {};
  return (
    <Drawer title={taskId ? "编辑定时任务" : "新建定时任务"} open={open} onClose={close}
      size={560} className="task-editor" maskClosable={!busy}
      footer={<Space wrap><Button onClick={close} disabled={busy}>取消</Button>
        <Button type="primary" icon={<SaveOutlined />} loading={busy} disabled={!preview}
          onClick={() => void save()}>{uncertain ? "核对并重试保存" : "保存任务"}</Button></Space>}>
      <div className="task-editor-fields">
        {error && <Alert type="error" showIcon title={error} />}
        {!taskId && (
          <div className="task-templates-section" style={{ marginBottom: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              ✨ 常用任务模板（点击快速填入）：
            </Typography.Text>
            <Space wrap size={[8, 8]}>
              {TASK_TEMPLATES.map((tmpl) => (
                <Button
                  key={tmpl.key}
                  size="small"
                  disabled={frozen}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      name: tmpl.name,
                      prompt: tmpl.prompt,
                      schedule: tmpl.schedule(timezone),
                    });
                    setError(null);
                  }}
                  style={{ borderRadius: 16 }}
                >
                  {tmpl.title}
                </Button>
              ))}
            </Space>
          </div>
        )}
        <label htmlFor="task-name">任务名称</label>
        <Input id="task-name" autoFocus value={draft.name} maxLength={120} disabled={frozen}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <label htmlFor="task-prompt">任务内容</label>
        <Input.TextArea id="task-prompt" value={draft.prompt} rows={5} maxLength={16000} disabled={frozen}
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
        <SchedulePicker value={draft.schedule} timezone={timezone} disabled={frozen}
          onChange={(schedule) => setDraft({ ...draft, schedule })} />
        <div className="task-delivery-control">
          <label htmlFor="task-delivery">完成后通知</label>
          <Switch id="task-delivery" checked={draft.delivery.enabled} disabled={frozen}
            onChange={(enabled) => setDraft({ ...draft, delivery: { enabled } })} />
        </div>
        <Collapse items={[{ key: "advanced", label: "高级设置", children: <div className="task-editor-fields">
          <label htmlFor="task-model">模型</label>
          <Input id="task-model" value={advanced.model ?? ""} maxLength={160} disabled={frozen}
            onChange={(event) => setDraft({ ...draft, advanced: { ...advanced, model: event.target.value } })} />
          <label htmlFor="task-skills">技能</label>
          <Select id="task-skills" mode="tags" value={advanced.skills ?? []} disabled={frozen}
            onChange={(skills: string[]) => setDraft({ ...draft, advanced: { ...advanced, skills } })} />
          <label htmlFor="task-workdir">工作目录</label>
          <Input id="task-workdir" value={advanced.workdir ?? ""} maxLength={512} disabled={frozen}
            onChange={(event) => setDraft({ ...draft, advanced: { ...advanced, workdir: event.target.value } })} />
        </div> }]} />
        <div className="task-preview" aria-live="polite">
          <Typography.Text strong>执行时间确认</Typography.Text>
          <p>{preview ? scheduleConfirmation(preview.scheduleLabel, preview.nextRunAt, preview.timezone)
            : previewError ?? "正在向 Hermes 确认执行时间…"}</p>
        </div>
      </div>
    </Drawer>
  );
}
