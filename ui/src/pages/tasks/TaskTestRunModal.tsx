import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Tag, Typography } from "antd";
import { PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { mutateJson } from "../../lib/api.js";

const { Text, Paragraph } = Typography;

export interface TestRunResult {
  outcome?: string;
  durationMs?: number;
  exitCode?: number;
  outputSnippet?: string;
  errorSnippet?: string;
  reason?: string;
}

export function TaskTestRunModal({
  task,
  open,
  onClose,
}: {
  task: { id: string; name: string } | null;
  open: boolean;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const startRun = async () => {
    if (!task || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setElapsedMs(0);
    const startTime = Date.now();

    timerRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startTime);
    }, 100);

    const requestId = crypto.randomUUID();
    const res = await mutateJson(
      "POST",
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`,
      { requestId },
      70_000,
    );

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedMs(Date.now() - startTime);
    setRunning(false);

    const data = (res.data && typeof res.data === "object" ? res.data : null) as TestRunResult | null;
    if (!res.ok) {
      setError(
        data?.reason === "timeout"
          ? "任务执行超时（超过 60 秒硬限制）"
          : "执行请求未能成功完成，请检查 Hermes 连接与服务状态。",
      );
      if (data) setResult(data);
    } else {
      setResult(data);
    }
  };

  useEffect(() => {
    if (open && task) {
      void startRun();
    } else {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setResult(null);
      setError(null);
      setRunning(false);
    }
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
    };
  }, [open, task?.id]);

  if (!task) return null;

  const seconds = (elapsedMs / 1000).toFixed(1);
  const isSuccess = result?.outcome === "succeeded";

  return (
    <Modal
      open={open}
      title={
        <Space>
          <PlayCircleOutlined style={{ color: "var(--ab-brand)" }} />
          <span>测试运行任务：“{task.name}”</span>
        </Space>
      }
      onCancel={() => {
        if (!running) onClose();
      }}
      width={680}
      footer={
        <Space>
          <Button onClick={onClose} disabled={running}>
            关闭
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={running}
            onClick={() => void startRun()}
          >
            再次测试
          </Button>
        </Space>
      }
      maskClosable={!running}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 12 }}>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          通过宿主桥立即调用 Hermes 单次执行此任务。测试运行不会重置或修改现有周期性调度计划。
        </Paragraph>

        {running && (
          <div
            style={{
              padding: "16px 20px",
              background: "var(--ab-surface)",
              borderRadius: 8,
              border: "1px solid var(--ab-border)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--ab-ok)",
                animation: "pulse 1.2s infinite ease-in-out",
              }}
            />
            <Text strong>Hermes 正在执行中...</Text>
            <Text type="secondary">（已耗时 {seconds}s，等待推理或工具返回）</Text>
          </div>
        )}

        {error && <Alert type="error" showIcon message={error} />}

        {result && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              background: isSuccess
                ? "color-mix(in srgb, var(--ab-ok) 10%, var(--ab-surface))"
                : "color-mix(in srgb, var(--ab-error) 10%, var(--ab-surface))",
              borderRadius: 8,
              border: `1px solid ${isSuccess ? "var(--ab-ok)" : "var(--ab-error)"}`,
            }}
          >
            <Space size={8}>
              <Tag color={isSuccess ? "success" : "error"}>
                {isSuccess ? "执行成功" : "执行失败"}
              </Tag>
              {typeof result.durationMs === "number" && (
                <Text type="secondary">耗时: {(result.durationMs / 1000).toFixed(2)}s</Text>
              )}
              {typeof result.exitCode === "number" && (
                <Text type="secondary">退出码: {result.exitCode}</Text>
              )}
            </Space>
          </div>
        )}

        {(result?.outputSnippet || result?.errorSnippet) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Text strong style={{ fontSize: 13 }}>
              执行控制台输出摘要：
            </Text>
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: "var(--ab-canvas, #1e1e1e)",
                color: "var(--ab-text, #f0f0f0)",
                borderRadius: 6,
                maxHeight: 280,
                overflowY: "auto",
                fontFamily: "var(--ab-font-mono, monospace)",
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {result.outputSnippet || result.errorSnippet}
            </pre>
          </div>
        )}

        {result && !result.outputSnippet && !result.errorSnippet && !error && (
          <Alert type="info" message="任务执行完成，未捕获到额外标准输出。" />
        )}
      </div>
    </Modal>
  );
}
