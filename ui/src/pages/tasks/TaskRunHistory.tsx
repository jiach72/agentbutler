import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Skeleton, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { loadJson } from "../../lib/api.js";
import { taskStatusLabel, taskTime } from "./taskCopy.js";

interface RunView {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason?: string | null;
}
const getRunTagColor = (status: string) => {
  if (status === "success" || status === "completed" || status === "succeeded") return "success";
  if (status === "failed" || status === "delivery_failed" || status === "timeout") return "error";
  if (status === "running" || status === "claimed") return "processing";
  return "default";
};

export function TaskRunHistory({ task, onClose, timezone }: {
  task: { id: string; name: string } | null; onClose: () => void; timezone?: string | null;
}) {
  const [items, setItems] = useState<RunView[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!task) return;
    let current = true;
    setItems(null);
    setError(false);
    void loadJson<{ reachable: boolean; items: RunView[] }>(
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}/runs?limit=20`, 15_000,
    ).then((result) => {
      if (!current) return;
      if (result.ok && result.data.reachable !== false && Array.isArray(result.data.items)) setItems(result.data.items);
      else setError(true);
    });
    return () => { current = false; };
  }, [task?.id, retry]);
  return <Drawer open={task !== null} title={`${task?.name ?? "任务"} · 执行历史`} onClose={onClose}
    styles={{ wrapper: { width: 560, maxWidth: "100%" } }} className="task-history">
    {error ? <Alert type="warning" showIcon title="暂时无法读取执行历史"
      action={<Button icon={<ReloadOutlined />} onClick={() => setRetry((value) => value + 1)}>重试</Button>} />
      : items === null ? <Skeleton active />
      : items.length === 0 ? <Empty description="尚无执行记录" />
      : <ol className="task-run-list">{items.map((run) => <li key={run.id}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Tag color={getRunTagColor(run.status)} style={{ margin: 0 }}>
              {taskStatusLabel(run.status)}
            </Tag>
            <span style={{ fontSize: 13, color: "var(--ab-text-2)" }}>{taskTime(run.startedAt, timezone)}</span>
          </div>
          {run.startedAt && run.finishedAt && Number.isFinite(Date.parse(run.startedAt)) && Number.isFinite(Date.parse(run.finishedAt)) && (
            <span style={{ fontSize: 12, color: "var(--ab-text-3)", fontFamily: "var(--font-mono, monospace)" }}>
              耗时: {Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))}s
            </span>
          )}
        </div>
        {run.finishedAt && !run.startedAt && <p style={{ fontSize: 12, color: "var(--ab-text-2)", margin: "4px 0 0" }}>结束：{taskTime(run.finishedAt, timezone)}</p>}
        {run.failureReason && (
          <div style={{ marginTop: 8, padding: "6px 10px", background: "color-mix(in srgb, var(--ab-error) 8%, var(--ab-surface-2))", border: "1px solid color-mix(in srgb, var(--ab-error) 20%, transparent)", borderRadius: 6, fontSize: 12, color: "var(--ab-error)" }}>
            {run.failureReason}
          </div>
        )}
      </li>)}</ol>}
  </Drawer>;
}
