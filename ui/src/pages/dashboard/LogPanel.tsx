/**
 * 系统日志面板：只读查看日志文件、错误聚合与处理建议。
 * 面板自身的加载/分析/修复确认状态全部内聚在本组件内。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Menu,
  Progress,
  Space,
  Spin,
  Typography,
} from "antd";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { fetchJson, loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatBytes, formatNumber } from "../../lib/format.js";
import type { LogAnalyzeView, LogIssueView, LogSourceView, LogTailView, RepairSessionView } from "./types.js";

const { Text } = Typography;

interface LogPanelProps {
  open?: boolean;
  onClose?: () => void;
  embedded?: boolean;
}

export function LogPanel({ open = true, onClose = () => undefined, embedded = false }: LogPanelProps) {
  const { message } = App.useApp();
  const [sources, setSources] = useState<LogSourceView[]>([]);
  const [activeLog, setActiveLog] = useState<LogTailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<LogIssueView[]>([]);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [confirmFix, setConfirmFix] = useState<LogIssueView | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [repairSession, setRepairSession] = useState<RepairSessionView | null>(null);

  usePolling(async () => {
    if (repairSession === null || ["done", "blocked", "failed"].includes(repairSession.status)) return;
    const result = await loadJson<RepairSessionView>(`/api/recovery/sessions/${encodeURIComponent(repairSession.sessionId)}`, 8_000);
    if (result.ok) {
      setRepairSession(result.data);
      if (result.data.status === "done" && repairSession.status !== "done") message.success("修复会话已完成并通过复验");
      if (result.data.status === "failed" && repairSession.status !== "failed") message.error(`修复未完成：${result.data.detail}`);
    }
  }, repairSession !== null && !["done", "blocked", "failed"].includes(repairSession.status) ? 1000 : null);

  const loadLogTail = useCallback(async (sourceId: string, before?: number | null) => {
    setLoading(true);
    setError(null);
    setActiveLog((current) => (current !== null && current.sourceId !== sourceId ? null : current));
    const query = new URLSearchParams({ limit: "300" });
    if (before !== undefined && before !== null) query.set("before", String(before));
    const payload = await fetchJson<LogTailView>(
      `/api/logs/${encodeURIComponent(sourceId)}?${query.toString()}`,
      8_000,
    );
    if (payload === null) {
      setError("读取日志失败；管家服务可能暂时不可用。");
    } else {
      setActiveLog(payload);
    }
    setLoading(false);
  }, []);

  const loadLogAnalyze = useCallback(async () => {
    setAnalyzeLoading(true);
    const payload = await fetchJson<LogAnalyzeView>("/api/logs/analyze", 8_000);
    setIssues(payload?.issues ?? []);
    setAnalyzeLoading(false);
  }, []);

  // 打开时拉取来源与体检结果；关闭时清空阅读态并撤销未触发的复检。
  useEffect(() => {
    if (!open) {
      setActiveLog(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadLogAnalyze();
    void (async () => {
      const payload = await fetchJson<{ reachable: boolean; sources?: LogSourceView[] }>(
        "/api/logs",
        8_000,
      );
      if (cancelled) return;
      if (payload === null || payload.reachable !== true) {
        setSources([]);
        setError("管家服务暂时连不上，稍后再试。");
      } else {
        setSources(payload.sources ?? []);
        if ((payload.sources ?? []).length === 0) {
          setError("暂未发现日志文件。");
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadLogAnalyze]);

  const runLogFix = async () => {
    if (confirmFix === null || confirmFix.suggestedAction === null) return;
    setFixBusy(true);
    const result = await postJson("/api/recovery/sessions", {});
    setFixBusy(false);
    setConfirmFix(null);
    if (result.ok) {
      setRepairSession(result.data as RepairSessionView);
      message.success("已启动后台修复会话，正在定位根因并生成受限方案");
    } else {
      message.error("修复会话没有启动成功，请确认管家服务是否在线。");
    }
  };

  const approveRepair = async () => {
    if (repairSession === null || repairSession.status !== "awaiting-approval") return;
    setFixBusy(true);
    const result = await postJson(`/api/recovery/sessions/${encodeURIComponent(repairSession.sessionId)}/approve`, {});
    setFixBusy(false);
    if (result.ok) setRepairSession(result.data as RepairSessionView);
    else message.error("修复审批没有提交成功，请稍后重试。");
  };

  const body = (
    <Flex vertical gap={16}>
      {repairSession !== null && (
        <Card size="small">
          <Flex vertical gap={8}>
            <Flex justify="space-between" align="center" gap={8}>
              <Text strong>后台修复会话</Text>
              <Badge
                status={repairSession.status === "done" ? "success" : repairSession.status === "failed" || repairSession.status === "blocked" ? "error" : "processing"}
                text={repairSession.status === "done" ? "已完成" : repairSession.status === "blocked" ? "已阻断" : repairSession.status === "failed" ? "执行失败" : repairSession.status === "awaiting-approval" ? "等待确认" : "处理中"}
              />
            </Flex>
            <Progress
              percent={repairSession.progress}
              status={repairSession.status === "failed" || repairSession.status === "blocked" ? "exception" : repairSession.status === "done" ? "success" : "active"}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>{repairSession.detail}</Text>
            {repairSession.diagnosis !== null && (
              <Alert
                type={repairSession.diagnosis.severity === "error" ? "error" : repairSession.diagnosis.severity === "warn" ? "warning" : "success"}
                showIcon
                title={repairSession.diagnosis.rootCause ?? repairSession.diagnosis.summary}
                description={repairSession.diagnosis.primaryFinding === null ? undefined : `${repairSession.diagnosis.primaryFinding.detail} · ${repairSession.diagnosis.primaryFinding.evidence.lastSeenLabel ?? "时间不明"}`}
              />
            )}
            {repairSession.plan !== null && (
              <Flex vertical gap={2}>
                <Text strong>建议方案：{repairSession.plan.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{repairSession.plan.description} · {repairSession.plan.impact}</Text>
                {repairSession.plan.approvalRequired && repairSession.status === "awaiting-approval" && (
                  <Button type="primary" loading={fixBusy} onClick={() => void approveRepair()}>批准执行</Button>
                )}
              </Flex>
            )}
            {repairSession.changes.length > 0 && <Text>实际变更：{repairSession.changes.join("、")}</Text>}
            <Text type={repairSession.verification.status === "passed" ? "success" : repairSession.verification.status === "failed" ? "danger" : "secondary"} style={{ fontSize: 12 }}>
              复验：{repairSession.verification.summary}
            </Text>
          </Flex>
        </Card>
      )}
      <Card
        size="small"
        title="日志分析"
        extra={
          analyzeLoading ? (
            <Spin size="small" />
          ) : (
            <Badge
              status={issues.length === 0 ? "success" : "warning"}
              text={issues.length === 0 ? "未发现明显错误" : `发现 ${issues.length} 类问题`}
            />
          )
        }
      >
        {issues.length === 0 && !analyzeLoading ? (
          <Text type="secondary">
            最近一段日志没有匹配到常见错误；你仍然可以在下面直接查看原始日志。
          </Text>
        ) : (
          <Flex vertical gap={8}>
            {issues.map((issue) => (
              <Alert
                key={issue.id}
                type={issue.severity === "error" ? "error" : "warning"}
                showIcon
                title={
                  <>
                    {issue.title} <Text type="secondary">×{issue.count}</Text>
                  </>
                }
                description={
                  <Flex vertical gap={4}>
                    <span>{issue.detail}</span>
                    {issue.examples.length > 0 && (
                      <Text code style={{ fontSize: 12 }}>{issue.examples[0]}</Text>
                    )}
                  </Flex>
                }
                action={
                  issue.suggestedAction !== null ? (
                    <Button
                      type="primary"
                      onClick={() => setConfirmFix(issue)}
                    >
                      一键修复
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </Flex>
        )}
      </Card>
      <Flex gap={16} align="flex-start" wrap="wrap">
        <Flex vertical gap={8} style={{ width: 240, flexShrink: 0 }}>
          <Text strong>日志文件</Text>
          <Menu
            mode="inline"
            selectedKeys={activeLog === null ? [] : [activeLog.sourceId]}
            style={{ borderInlineEnd: 0 }}
            onClick={({ key }) => void loadLogTail(key)}
            items={sources.map((source) => ({
              key: source.id,
              label: (
                <Flex vertical gap={2}>
                  <span>{source.id.startsWith("butler:") ? "管家·" + source.id.split(":").pop() : source.id.split(":").pop()}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {source.format === "journald" ? "服务日志" : formatBytes(source.sizeBytes)}
                  </Text>
                </Flex>
              ),
            }))}
          />
          {!loading && sources.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可用的日志文件" />
          )}
        </Flex>
        <Flex vertical gap={8} style={{ flex: 1, minWidth: 0 }}>
          {error !== null && <Alert type="error" showIcon title={error} />}
          {loading && (
            <Flex align="center" gap={8}>
              <Spin size="small" />
              <Text type="secondary">正在读取日志…</Text>
            </Flex>
          )}
          {activeLog !== null && (
            <>
              <Flex wrap="wrap" align="center" justify="space-between" gap={8}>
                <Text code style={{ fontSize: 12 }} title={activeLog.path}>{activeLog.path}</Text>
                <Text type="secondary">
                  {activeLog.truncated
                    ? `只显示最后 ${activeLog.lines.length} 行（共 ${formatNumber(activeLog.totalLines)} 行）`
                    : `共 ${formatNumber(activeLog.totalLines)} 行`}
                </Text>
              </Flex>
              {(activeLog.hasOlder || activeLog.hasNewer) && (
                <Space wrap>
                  {activeLog.hasOlder && (
                    <Button
                      disabled={loading}
                      onClick={() => void loadLogTail(activeLog.sourceId, activeLog.pageStart)}
                    >
                      更早的日志
                    </Button>
                  )}
                  {activeLog.hasNewer && (
                    <Button
                      disabled={loading}
                      onClick={() => void loadLogTail(activeLog.sourceId, null)}
                    >
                      回到最新
                    </Button>
                  )}
                </Space>
              )}
              {activeLog.error !== undefined ? (
                <Alert type="error" showIcon title={`读取失败：${activeLog.error}`} />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: "var(--ant-color-fill-tertiary)",
                    borderRadius: 8,
                    fontFamily: "var(--ant-font-family-code)",
                    fontSize: 12,
                    maxHeight: 480,
                    overflow: "auto",
                  }}
                >
                  {activeLog.lines.map((line, index) => (
                    <code key={index} style={{ display: "block", whiteSpace: "pre-wrap" }}>{line}</code>
                  ))}
                </pre>
              )}
            </>
          )}
        </Flex>
      </Flex>
    </Flex>
  );

  return (
    <>
      {open && (
        embedded ? (
          <Flex vertical gap={16}>{body}</Flex>
        ) : (
          <Drawer width={920} title="系统日志" open onClose={onClose}>
            {body}
          </Drawer>
        )
      )}

      <DangerConfirmModal
        open={confirmFix !== null}
        title="确认一键修复"
        confirmLabel="确认修复"
        cancelLabel="先不修复"
        busy={fixBusy}
        onCancel={() => setConfirmFix(null)}
        onConfirm={() => void runLogFix()}
        impact="该操作会重启或重连相关服务。确认前不会执行任何修改。"
      >
        管家将执行修复方案「<strong>{confirmFix?.actionLabel ?? "重启服务"}</strong>」，
        期间 Hermes 可能短暂不可用，修复完成后会自动复检。
      </DangerConfirmModal>
    </>
  );
}
