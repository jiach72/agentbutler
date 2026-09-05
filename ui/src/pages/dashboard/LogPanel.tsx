/**
 * 系统日志面板：只读查看日志文件、错误聚合与处理建议。
 * 面板自身的加载/分析/修复确认状态全部内聚在本组件内。
 *
 * 展示层采用全站「市场风」：页面工具带（搜索 + 级别筛选 + 日志源 + 刷新）
 * 与三分区卡（日志流 / 智能分析 / 修复会话）。级别与关键词筛选只作用于
 * 已取回日志行的**展示**，不改变任何数据读取逻辑。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Flex,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import {
  AlertOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { fetchJson, loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatBytes, formatNumber } from "../../lib/format.js";
import type { LogAnalyzeView, LogIssueView, LogSourceView, LogTailView, RepairSessionView } from "./types.js";

const { Text } = Typography;

const LEVEL_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "信息", value: "info" },
  { label: "警告", value: "warn" },
  { label: "错误", value: "error" },
] as const;

type LevelFilter = (typeof LEVEL_OPTIONS)[number]["value"];

/** 展示层启发式：把一行原始日志粗判为信息/警告/错误，仅用于工具带筛选。 */
function lineLevel(line: string): Exclude<LevelFilter, "all"> {
  if (
    /\b(error|fatal|critical|exception|panic|traceback|failed|failure|fail)\b|错误|失败|异常/i.test(line)
  ) {
    return "error";
  }
  if (/\b(warn|warning|retry|timeout|slow|degraded)\b|警告|重试|超时|缓慢/i.test(line)) {
    return "warn";
  }
  return "info";
}

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
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");

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
        const nextSources = payload.sources ?? [];
        setSources(nextSources);
        if (nextSources.length === 0) {
          setError("暂未发现日志文件。");
        } else {
          // 自动加载第一个日志源，避免首屏出现空的日志流卡片。
          void loadLogTail(nextSources[0].id);
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadLogAnalyze, loadLogTail]);

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

  const sourceLabel = (sourceId: string) =>
    sourceId.startsWith("butler:") ? `管家·${sourceId.split(":").pop()}` : (sourceId.split(":").pop() ?? sourceId);

  const filteredLines = useMemo(() => {
    if (activeLog === null) return [];
    const kw = keyword.trim().toLowerCase();
    return activeLog.lines.filter((line) => {
      if (level !== "all" && lineLevel(line) !== level) return false;
      return kw === "" || line.toLowerCase().includes(kw);
    });
  }, [activeLog, keyword, level]);

  const streamExtra =
    activeLog === null ? undefined : (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {filteredLines.length} / {activeLog.lines.length} 行
      </Text>
    );

  const repairSessionCard = repairSession !== null && (
    <Card size="small">
      <Flex vertical gap={12}>
        <SectionHeader
          kicker="修复会话"
          title="后台修复会话"
          extra={
            <Badge
              status={repairSession.status === "done" ? "success" : repairSession.status === "failed" || repairSession.status === "blocked" ? "error" : "processing"}
              text={repairSession.status === "done" ? "已完成" : repairSession.status === "blocked" ? "已阻断" : repairSession.status === "failed" ? "执行失败" : repairSession.status === "awaiting-approval" ? "等待确认" : "处理中"}
            />
          }
        />
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
  );

  const body = (
    <Flex vertical gap={16} className="logs-layout">
      <StatStrip
        items={[
          { key: "sources", label: "日志源", value: sources.length, unit: "个", icon: FolderOpenOutlined },
          {
            key: "issues",
            label: "分析问题",
            value: issues.length,
            unit: "类",
            icon: AlertOutlined,
            tone: issues.length > 0 ? "warn" : "ok",
          },
          {
            key: "lines",
            label: "当前日志行",
            value: activeLog === null ? "—" : formatNumber(activeLog.totalLines),
            unit: "行",
            icon: FileTextOutlined,
          },
        ]}
      />

      <Flex wrap justify="space-between" align="center" gap={12} className="logs-toolbar">
        <Flex wrap gap={8} align="center">
          <Input
            allowClear
            prefix={<SearchOutlined aria-hidden="true" />}
            placeholder="搜索日志内容…"
            aria-label="搜索日志内容"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 240 }}
          />
          <Segmented
            aria-label="日志级别筛选"
            value={level}
            onChange={(value) => setLevel(value as LevelFilter)}
            options={LEVEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
          />
        </Flex>
        <Flex wrap gap={8} align="center">
          <Select
            aria-label="选择日志源"
            style={{ minWidth: 220 }}
            placeholder="日志源"
            value={activeLog === null ? undefined : activeLog.sourceId}
            onChange={(sourceId) => void loadLogTail(sourceId)}
            disabled={sources.length === 0}
            options={sources.map((source) => ({
              value: source.id,
              label: `${sourceLabel(source.id)} · ${source.format === "journald" ? "服务日志" : formatBytes(source.sizeBytes)}`,
            }))}
          />
          <Button
            icon={<ReloadOutlined aria-hidden="true" />}
            disabled={activeLog === null}
            onClick={() => activeLog !== null && void loadLogTail(activeLog.sourceId)}
          >
            手动刷新
          </Button>
        </Flex>
      </Flex>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Flex vertical gap={16}>
            <Card size="small">
              <Flex vertical gap={12}>
                <SectionHeader kicker="日志流" title={activeLog === null ? "原始日志" : sourceLabel(activeLog.sourceId)} extra={streamExtra} />
                {error !== null && <Alert type="error" showIcon title={error} />}
                {loading && (
                  <Flex align="center" gap={8}>
                    <Spin size="small" />
                    <Text type="secondary">正在读取日志…</Text>
                  </Flex>
                )}
                {!loading && sources.length === 0 && error === null && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可用的日志文件" />
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
                            size="small"
                            disabled={loading}
                            onClick={() => void loadLogTail(activeLog.sourceId, activeLog.pageStart)}
                          >
                            更早的日志
                          </Button>
                        )}
                        {activeLog.hasNewer && (
                          <Button
                            size="small"
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
                    ) : filteredLines.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件下没有匹配的日志行" />
                    ) : (
                      <pre className="logs-stream-pre">
                        {filteredLines.map((line, index) => (
                          <code key={index}>{line}</code>
                        ))}
                      </pre>
                    )}
                  </>
                )}
              </Flex>
            </Card>
            {repairSessionCard}
          </Flex>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small">
            <Flex vertical gap={12}>
              <SectionHeader
                kicker="智能分析"
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
              />
              {issues.length === 0 && !analyzeLoading ? (
                <Text type="secondary">
                  最近一段日志没有匹配到常见错误；你仍然可以在左侧直接查看原始日志。
                </Text>
              ) : (
                <Flex vertical gap={8}>
                  {issues.map((issue) => (
                    <div key={issue.id} className="logs-issue">
                      <Flex justify="space-between" align="flex-start" gap={8}>
                        <Flex vertical gap={2} style={{ minWidth: 0 }}>
                          <Text strong>{issue.title}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>{issue.detail}</Text>
                        </Flex>
                        <StatusBadge tone={issue.severity === "error" ? "error" : "warn"} label={`×${issue.count}`} />
                      </Flex>
                      {issue.examples.length > 0 && (
                        <Text code style={{ fontSize: 12 }}>{issue.examples[0]}</Text>
                      )}
                      {issue.suggestedAction !== null && (
                        <Button
                          className="logs-issue-action"
                          type="primary"
                          size="small"
                          block
                          onClick={() => setConfirmFix(issue)}
                        >
                          一键修复
                        </Button>
                      )}
                    </div>
                  ))}
                </Flex>
              )}
            </Flex>
          </Card>
        </Col>
      </Row>
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
