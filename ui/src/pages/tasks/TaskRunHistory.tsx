import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Drawer, Flex, Segmented, Skeleton, Tag, Tooltip, Typography } from "antd";
import { CheckCircleOutlined, CopyOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { loadJson } from "../../lib/api.js";
import { taskStatusLabel, taskTime } from "./taskCopy.js";
import { Empty as ButlerEmpty } from "../../components/Empty.js";

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

export const isFailedRunStatus = (status: string) => {
  return status === "failed" || status === "delivery_failed" || status === "timeout";
};

export function TaskRunHistory({ task, onClose, timezone }: {
  task: { id: string; name: string } | null; onClose: () => void; timezone?: string | null;
}) {
  const { message } = App.useApp();
  const [items, setItems] = useState<RunView[] | null>(null);
  const [filterStatus, setFilterStatus] = useState<"all" | "failed">("all");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);

  const copyError = async (err: string) => {
    try {
      await navigator.clipboard.writeText(err);
      message.success("错误原因已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  const copyRunDebugInfo = async (run: RunView) => {
    const debugText = [
      `[Agent Butler 任务执行报告]`,
      `任务: ${task?.name ?? "未知"} (${task?.id ?? "无 ID"})`,
      `运行编号: ${run.id}`,
      `状态: ${taskStatusLabel(run.status)} (${run.status})`,
      `开始时间: ${run.startedAt ? taskTime(run.startedAt, timezone) : "未知"}`,
      `结束时间: ${run.finishedAt ? taskTime(run.finishedAt, timezone) : "未记录"}`,
      run.failureReason ? `失败原因: ${run.failureReason}` : null,
    ].filter(Boolean).join("\n");

    try {
      await navigator.clipboard.writeText(debugText);
      message.success("已复制执行调试信息");
    } catch {
      message.error("复制失败");
    }
  };

  useEffect(() => {
    if (!task) return;
    let current = true;
    setItems(null);
    setError(false);
    setLoading(true);
    setFilterStatus("all");
    void loadJson<{ reachable: boolean; items: RunView[] }>(
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}/runs?limit=20`, 15_000,
    ).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.ok && result.data.reachable !== false && Array.isArray(result.data.items)) setItems(result.data.items);
      else setError(true);
    });
    return () => { current = false; };
  }, [task?.id, retry]);

  const failedCount = useMemo(() => {
    if (!items) return 0;
    return items.filter((r) => isFailedRunStatus(r.status)).length;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!items) return null;
    if (filterStatus === "failed") {
      return items.filter((r) => isFailedRunStatus(r.status));
    }
    return items;
  }, [items, filterStatus]);

  return <Drawer
    open={task !== null}
    title={
      <Flex align="center" gap={8} wrap="wrap">
        <span>{task?.name ? `任务执行历史：${task.name}` : "任务执行历史"}</span>
        {task?.id && (
          <Typography.Text
            copyable={{ text: task.id, tooltips: ["复制任务 ID", "已复制"] }}
            type="secondary"
            code
            style={{ fontSize: 11 }}
          >
            {task.id}
          </Typography.Text>
        )}
      </Flex>
    }
    onClose={onClose}
    extra={
      <Button
        size="small"
        icon={<ReloadOutlined spin={loading} />}
        onClick={() => setRetry((value) => value + 1)}
      >
        刷新
      </Button>
    }
    styles={{ wrapper: { width: 560, maxWidth: "100%" } }}
    className="task-history"
  >
    {error ? (
      <Alert
        type="warning"
        showIcon
        title="暂时无法读取执行历史"
        action={<Button icon={<ReloadOutlined />} onClick={() => setRetry((value) => value + 1)}>重试</Button>}
      />
    ) : items === null ? (
      <Skeleton active />
    ) : items.length === 0 ? (
      <ButlerEmpty
        mascot={false}
        title="尚无执行记录"
        hint="该任务尚未触发执行。您可以等待到达预定时间，或在任务列表点击「测试运行」立即验证。"
      />
    ) : (
      <>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <Segmented
            value={filterStatus}
            onChange={(val) => setFilterStatus(val as "all" | "failed")}
            options={[
              { label: `全部 (${items.length})`, value: "all" },
              {
                label: (
                  <span style={{ color: failedCount > 0 ? "var(--ab-error, #cf1322)" : undefined, fontWeight: failedCount > 0 ? 600 : undefined }}>
                    仅看异常 ({failedCount})
                  </span>
                ),
                value: "failed",
              },
            ]}
            size="small"
          />
          <div style={{ fontSize: 12, color: "var(--ab-text-3)", display: "flex", alignItems: "center", gap: 6 }}>
            {failedCount === 0 ? (
              <span style={{ color: "var(--ab-success, #389e0d)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <CheckCircleOutlined /> 近期运行 100% 成功
              </span>
            ) : (
              <span style={{ color: "var(--ab-error, #cf1322)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <WarningOutlined /> 近期存在 {failedCount} 次异常
              </span>
            )}
          </div>
        </div>

        {filteredItems && filteredItems.length === 0 ? (
          <ButlerEmpty
            mascot={false}
            title="近期无异常记录"
            hint="太棒了！该任务近期的执行均顺利完成，没有发生超时或报错。"
            action={<Button size="small" onClick={() => setFilterStatus("all")}>查看全部记录</Button>}
          />
        ) : (
          <ol className="task-run-list">
            {filteredItems?.map((run) => (
              <li key={run.id}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag color={getRunTagColor(run.status)} style={{ margin: 0 }}>
                      {taskStatusLabel(run.status)}
                    </Tag>
                    <Typography.Text
                      copyable={{ text: run.id, tooltips: ["复制运行编号", "已复制"] }}
                      type="secondary"
                      code
                      style={{ fontSize: 11 }}
                    >
                      {run.id.length > 8 ? run.id.slice(0, 8) : run.id}
                    </Typography.Text>
                    <span style={{ fontSize: 13, color: "var(--ab-text-2)" }}>{taskTime(run.startedAt, timezone)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {run.startedAt && run.finishedAt && Number.isFinite(Date.parse(run.startedAt)) && Number.isFinite(Date.parse(run.finishedAt)) && (
                      <span style={{ fontSize: 12, color: "var(--ab-text-3)", fontFamily: "var(--font-mono, monospace)" }}>
                        耗时: {Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))}s
                      </span>
                    )}
                    <Tooltip title="复制该次运行调试信息">
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        style={{ color: "var(--ab-text-3)" }}
                        onClick={() => void copyRunDebugInfo(run)}
                      />
                    </Tooltip>
                  </div>
                </div>
                {run.finishedAt && !run.startedAt && <p style={{ fontSize: 12, color: "var(--ab-text-2)", margin: "4px 0 0" }}>结束：{taskTime(run.finishedAt, timezone)}</p>}
                {run.failureReason && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "color-mix(in srgb, var(--ab-error) 8%, var(--ab-surface-2))", border: "1px solid color-mix(in srgb, var(--ab-error) 20%, transparent)", borderRadius: 6, fontSize: 12, color: "var(--ab-error)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ wordBreak: "break-all" }}>{run.failureReason}</span>
                    <Tooltip title="仅复制错误原因">
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        style={{ color: "var(--ab-error)", flexShrink: 0 }}
                        onClick={() => void copyError(run.failureReason!)}
                      />
                    </Tooltip>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </>
    )}
  </Drawer>;
}
