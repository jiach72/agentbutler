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
    width={560} className="task-history">
    {error ? <Alert type="warning" showIcon title="暂时无法读取执行历史"
      action={<Button icon={<ReloadOutlined />} onClick={() => setRetry((value) => value + 1)}>重试</Button>} />
      : items === null ? <Skeleton active />
      : items.length === 0 ? <Empty description="尚无执行记录" />
      : <ol className="task-run-list">{items.map((run) => <li key={run.id}>
        <div><Tag color={run.status === "failed" ? "error" : run.status === "success" ? "success" : "default"}>
          {taskStatusLabel(run.status)}</Tag><span>{taskTime(run.startedAt, timezone)}</span></div>
        {run.finishedAt && <p>结束：{taskTime(run.finishedAt, timezone)}</p>}
        {run.failureReason && <p>{run.failureReason}</p>}
      </li>)}</ol>}
  </Drawer>;
}
