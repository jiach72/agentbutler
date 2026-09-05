import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Empty,
  Flex,
  Progress,
  Row,
  Select,
  Space,
  Steps,
  Typography,
} from "antd";
import {
  BulbOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime, isRecord } from "../../lib/format.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { StatStrip } from "../../components/StatStrip.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Link } from "react-router-dom";
import { EvolutionOverview } from "./EvolutionOverview.js";
import type { EvolutionOverviewPayload } from "./types.js";

const { Paragraph, Text } = Typography;

/** 日志示例 / 差异预览的共享代码块样式（走 antd Token 变量）。 */
const CODE_STYLE: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--ant-color-fill-tertiary)",
  borderRadius: 8,
  overflow: "auto",
  fontSize: 12,
  lineHeight: 1.6,
};
/** 说明类清单的共享列表样式。 */
const LIST_STYLE: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

type Direction = {
  id: string;
  targetType: "skill" | "prompt" | "config" | "diagnostic";
  targetRef: string | null;
  title: string;
  summary: string;
  optimization?: {
    goal: string;
    changes: string[];
    expectedResult: string;
    generatedAt: string;
    generatedBy: "rules" | "model";
  };
  impact: "high" | "medium" | "low";
  confidence: number;
  occurrences: number;
  lastSeenAt: string | null;
  sources: string[];
  examples: string[];
  blocked: boolean;
  blockReason: string | null;
  recommendedAction: string;
  candidateSkills: string[];
  confirmedAt: string | null;
  executionMode: "hermes" | "manual" | null;
  execution?: {
    kind: "run" | "proposal";
    id: string;
    status?: string;
    updatedAt?: string;
    detail?: string;
  };
};
type Run = {
  runId: string;
  status: string;
  detail: string;
  updatedAt: string;
  artifacts?: { baselinePath?: string; candidatePath?: string; diff?: string };
  checks?: Array<{ label: string; status: string; detail: string }>;
  metrics?: { baselineQuality?: number; candidateQuality?: number; qualityDelta?: number };
  logTail?: { stdout: string[]; stderr: string[] };
  writeAuthority?: { token: string };
};
type Insights = {
  instanceId: string | null;
  range: "24h" | "7d" | "30d";
  coverage?: {
    from: string | null;
    to: string | null;
    sources: number;
    lines: number;
    rotatedLogs: boolean;
  };
  directions: Direction[];
  analyzedAt: string;
};
type Proposal = {
  id: string;
  status: string;
  targetRef: string;
  problem: string;
  diff: string;
  baselineHash: string;
  candidateHash: string;
  validation: { status: string; reason: string; fix: string };
  target: { name: string; canApply: boolean };
};
const impactLabel = { high: "高", medium: "中", low: "低" } as const;
const impactTone = { high: "error", medium: "warn", low: "info" } as const;

export function EvolutionPage() {
  const { message } = App.useApp();
  const [instanceId, setInstanceId] = useState("");
  const [instances, setInstances] = useState<
    Array<{ instanceId: string; version?: string; state?: string }>
  >([]);
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const [data, setData] = useState<Insights | null>(null);
  const [overview, setOverview] = useState<EvolutionOverviewPayload | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ range });
    if (instanceId) query.set("instanceId", instanceId);
    const [insightResult, overviewResult, instanceResult, proposalResult] = await Promise.all([
      loadJson<Insights>(`/api/evolution/insights?${query.toString()}`, 30_000),
      loadJson<EvolutionOverviewPayload>(`/api/evolution/overview?${query.toString()}`, 30_000),
      loadJson<{ instances: Array<{ instanceId: string; version?: string; state?: string }> }>(
        "/api/instances",
        10_000,
      ),
      loadJson<{ proposals: Proposal[] }>("/api/evolution/proposals", 10_000),
    ]);
    if (!insightResult.ok && !overviewResult.ok) setError(insightResult.reason);
    else setError(null);
    if (insightResult.ok) setData(insightResult.data);
    if (overviewResult.ok) setOverview(overviewResult.data);
    setProposals(proposalResult.ok ? (proposalResult.data.proposals ?? []) : []);
    if (instanceResult.ok) {
      const next = instanceResult.data.instances ?? [];
      setInstances(next);
      if (!instanceId && next[0]) setInstanceId(next[0].instanceId);
    }
    if (selectedId === null && insightResult.ok && insightResult.data.directions[0])
      setSelectedId(insightResult.data.directions[0].id);
  }, [instanceId, range, selectedId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = data?.directions.find((item) => item.id === selectedId) ?? null;
  const selectedProposal =
    selected?.execution?.kind === "proposal"
      ? (proposals.find((item) => item.id === selected.execution?.id) ?? null)
      : null;
  const analyze = async () => {
    setBusy("analyze");
    const result = await postJson("/api/evolution/analyze", { instanceId: instanceId || undefined, range }, 30_000);
    setBusy(null);
    if (!result.ok) {
      message.error(detailOf(result.data, "重新分析失败"));
      return;
    }
    setOverview(result.data as EvolutionOverviewPayload);
    message.success("分析完成，指标和行动事项已更新");
  };
  const recheckAction = async (actionId: string) => {
    setBusy(actionId);
    const result = await postJson(`/api/evolution/action-items/${encodeURIComponent(actionId)}/recheck`, {}, 30_000);
    setBusy(null);
    if (!result.ok) {
      message.error(detailOf(result.data, "复核失败"));
      return;
    }
    await refresh();
  };
  const loadRun = useCallback(async (runId: string) => {
    const result = await loadJson<Run>(`/api/evolution/runs/${encodeURIComponent(runId)}`, 15_000);
    if (result.ok) setRun(result.data);
  }, []);
  useEffect(() => {
    if (selected?.execution?.kind !== "run") {
      setRun(null);
      return;
    }
    void loadRun(selected.execution.id);
    const timer = window.setInterval(() => void loadRun(selected.execution!.id), 5000);
    return () => window.clearInterval(timer);
  }, [selected?.execution?.id, selected?.execution?.kind, loadRun]);
  const confirm = async () => {
    if (!selected) return;
    setBusy("confirm");
    const result = await postJson(
      `/api/evolution/directions/${encodeURIComponent(selected.id)}/confirm`,
      selected.targetRef ? {} : { targetRef: selectedSkill },
      10_000,
    );
    setBusy(null);
    if (!result.ok) {
      message.error(detailOf(result.data, "无法确认该方向"));
      return;
    }
    await refresh();
    message.success("已记录确认，可以选择执行方式");
  };
  const summarize = async () => {
    if (!selected) return;
    setBusy("summarize");
    const result = await postJson(
      `/api/evolution/directions/${encodeURIComponent(selected.id)}/summarize`,
      {},
      30_000,
    );
    setBusy(null);
    if (!result.ok) message.error(detailOf(result.data, "生成优化说明失败"));
    else {
      const next = result.data as Direction;
      setData((current) =>
        current
          ? {
              ...current,
              directions: current.directions.map((item) => (item.id === next.id ? next : item)),
            }
          : current,
      );
      message.success("优化说明已生成");
    }
  };
  const start = async (mode: "hermes" | "manual") => {
    if (!selected) return;
    setBusy(`start:${mode}`);
    const result = await postJson(
      `/api/evolution/directions/${encodeURIComponent(selected.id)}/start`,
      { mode, ...(instanceId ? { instanceId } : {}) },
      70_000,
    );
    setBusy(null);
    if (!result.ok) {
      message.error(detailOf(result.data, "启动处理失败"));
      return;
    }
    const returned = result.data as Direction | Run | Proposal;
    if (mode === "hermes" && "runId" in returned) setRun(returned as Run);
    if (mode === "manual" && "id" in returned)
      setProposals((items) => [
        returned as Proposal,
        ...items.filter((item) => item.id !== (returned as Proposal).id),
      ]);
    await refresh();
    message.success(
      mode === "manual"
        ? "可编辑方案已生成，请先隔离验证"
        : "Hermes 已启动，页面会自动更新执行状态",
    );
  };
  const validate = async (id: string) => {
    setBusy("validate");
    const result = await postJson(
      `/api/evolution/proposals/${encodeURIComponent(id)}/validate`,
      {},
      30_000,
    );
    setBusy(null);
    if (!result.ok) message.error(detailOf(result.data, "隔离验证失败"));
    else {
      await refresh();
      message.success("隔离验证完成");
    }
  };
  const evaluateRun = async (runId: string) => {
    setBusy("evaluate");
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(runId)}/evaluate`,
      {},
      70_000,
    );
    setBusy(null);
    if (!result.ok) message.error(detailOf(result.data, "候选评估失败"));
    else {
      await loadRun(runId);
      message.success("候选评估完成");
    }
  };
  const promoteRun = async (current: Run) => {
    const authority = (current as Run & { writeAuthority?: { token: string } }).writeAuthority;
    if (!authority) {
      message.error("尚未获得应用授权，请先完成候选评估");
      return;
    }
    setBusy("promote");
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(current.runId)}/promote`,
      { token: authority.token },
      30_000,
    );
    setBusy(null);
    if (!result.ok) message.error(detailOf(result.data, "应用失败"));
    else {
      await loadRun(current.runId);
      message.success("候选已应用到 Hermes");
    }
  };
  const apply = async (id: string) => {
    setBusy("apply");
    const result = await postJson(
      `/api/evolution/proposals/${encodeURIComponent(id)}/apply`,
      { confirmed: true },
      30_000,
    );
    setBusy(null);
    if (!result.ok) message.error(detailOf(result.data, "应用失败"));
    else {
      await refresh();
      message.success("变更已应用");
    }
  };
  /** 方向状态徽标：已启动 > 需处理 > 已确认 > 待确认（与旧表格列同一判定）。 */
  const statusBadgeOf = (item: Direction) =>
    item.execution ? (
      <StatusBadge tone="ok" label="已启动" />
    ) : item.blocked ? (
      <StatusBadge tone="warn" label="需处理" />
    ) : item.confirmedAt ? (
      <StatusBadge tone="info" label="已确认" />
    ) : (
      <StatusBadge tone="muted" label="待确认" />
    );
  const startedCount = (data?.directions ?? []).filter((item) => item.execution).length;
  const pendingCount = (data?.directions ?? []).filter(
    (item) => !item.execution && !item.blocked && !item.confirmedAt,
  ).length;
  return (
    <section className="evolution-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="维护与升级"
          title="自进化"
          description="定期分析运行日志，归纳重复问题并生成可审计的优化方向；先试运行，再由你确认应用。"
          extra={
            <ConnectionChip
              reachable={error === null}
              connectingText="正在读取运行日志"
              offlineText="分析服务暂时不可用"
            />
          }
        />
        {/* 概览统计条：全部来自页面已有真实数据。 */}
        <StatStrip
          items={[
            {
              key: "coverage",
              icon: FileSearchOutlined,
              label: "日志覆盖",
              value: data?.coverage ? data.coverage.lines.toLocaleString() : "—",
              unit: "行",
              sub: data?.coverage ? `${data.coverage.sources} 个来源文件` : "暂无分析数据",
            },
            {
              key: "directions",
              icon: BulbOutlined,
              label: "改进方向",
              value: data?.directions.length ?? 0,
              unit: "项",
            },
            {
              key: "pending",
              icon: ExclamationCircleOutlined,
              label: "待确认",
              value: pendingCount,
              unit: "项",
              tone: pendingCount > 0 ? "warn" : "ok",
            },
            {
              key: "started",
              icon: ThunderboltOutlined,
              label: "已启动执行",
              value: startedCount,
              unit: "项",
              tone: startedCount > 0 ? "info" : undefined,
            },
          ]}
        />
        {error && (
          <Alert
            type="error"
            showIcon
            title="无法读取 Hermes 日志洞察"
            description={error}
            action={
              <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
                重试
              </Button>
            }
          />
        )}
        <EvolutionOverview
          overview={overview}
          range={range}
          onRangeChange={setRange}
          onRefresh={() => void refresh()}
          onAnalyze={() => void analyze()}
          busy={busy}
          onRecheck={(id) => void recheckAction(id)}
        />
        <Card
          title={<SectionHeader kicker="分析范围" title="日志中的改进方向" />}
          extra={
            <Space wrap>
              <Select
                value={instanceId || undefined}
                placeholder="选择实例"
                style={{ minWidth: 190 }}
                options={instances.map((item) => ({
                  value: item.instanceId,
                  label: `${item.instanceId}${item.version ? ` · ${item.version}` : ""}`,
                }))}
                onChange={setInstanceId}
              />
              <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
                重新分析
              </Button>
            </Space>
          }
        >
          <Descriptions size="small" column={{ xs: 1, sm: 4 }}>
            <Descriptions.Item label="日志覆盖">
              {data?.coverage?.from
                ? `${formatTime(data.coverage.from)} 至 ${formatTime(data.coverage.to ?? "")}`
                : "暂无数据"}
            </Descriptions.Item>
            <Descriptions.Item label="扫描文件 / 行数">
              {data?.coverage ? `${data.coverage.sources} / ${data.coverage.lines}` : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="包含轮转日志">
              {data?.coverage?.rotatedLogs ? "是" : "否"}
            </Descriptions.Item>
            <Descriptions.Item label="最近分析">
              {data?.analyzedAt ? formatTime(data.analyzedAt) : "-"}
            </Descriptions.Item>
          </Descriptions>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <Card
              title={<SectionHeader kicker="改进方向" title={`${data?.directions.length ?? 0} 项`} />}
              styles={{ body: { padding: 12, maxHeight: 640, overflow: "auto" } }}
            >
              {(data?.directions ?? []).length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前窗口没有可归纳的问题" />
              ) : (
                <Flex vertical gap={8}>
                  {data?.directions.map((item) => (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看改进方向：${item.title}`}
                      aria-pressed={item.id === selectedId}
                      onClick={() => {
                        setSelectedId(item.id);
                        setSelectedSkill(item.targetRef ?? "");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(item.id);
                          setSelectedSkill(item.targetRef ?? "");
                        }
                      }}
                      style={{
                        border: `1px solid ${item.id === selectedId ? "var(--ant-color-primary)" : "var(--ant-color-border-secondary)"}`,
                        borderRadius: 10,
                        padding: 12,
                        cursor: "pointer",
                        background: item.id === selectedId ? "var(--ant-color-primary-bg)" : "var(--ant-color-bg-container)",
                      }}
                    >
                      <Flex vertical gap={4}>
                        <Flex align="center" justify="space-between" gap={8}>
                          <Text strong ellipsis style={{ minWidth: 0 }}>
                            {item.title}
                          </Text>
                          {statusBadgeOf(item)}
                        </Flex>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.targetRef ?? "未能定位技能"} · {item.occurrences} 次 · 把握{" "}
                          {Math.round(item.confidence * 100)}%
                        </Text>
                        <Flex align="center" gap={8} wrap="wrap">
                          <StatusBadge tone={impactTone[item.impact]} label={`${impactLabel[item.impact]}影响`} />
                          {item.lastSeenAt && (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              最近 {formatTime(item.lastSeenAt)}
                            </Text>
                          )}
                        </Flex>
                      </Flex>
                    </div>
                  ))}
                </Flex>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            {!selected ? (
              <Card title={<SectionHeader kicker="方向详情" title="选择一个方向" />}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="选择左侧方向查看问题总结、日志依据和处理方式。"
                />
              </Card>
            ) : (
              <Flex vertical gap={16}>
                <Card
                  title={<SectionHeader kicker="方向概览" title={selected.title} />}
                  extra={
                    <StatusBadge tone={impactTone[selected.impact]} label={`${impactLabel[selected.impact]}影响`} />
                  }
                >
                  <Flex vertical gap={12}>
                    <Paragraph style={{ marginBottom: 0 }}>{selected.summary}</Paragraph>
                    <Descriptions size="small" column={1}>
                      <Descriptions.Item label="关联技能">
                        {selected.targetRef ?? "未能定位"}
                      </Descriptions.Item>
                      <Descriptions.Item label="证据">
                        {selected.occurrences} 次 · {selected.sources.join("、") || "未知来源"}
                      </Descriptions.Item>
                      <Descriptions.Item label="把握程度">
                        {Math.round(selected.confidence * 100)}%
                      </Descriptions.Item>
                      <Descriptions.Item label="推荐动作">
                        {selected.recommendedAction}
                        {(selected.targetType === "config" || selected.targetType === "diagnostic") && (
                          <Link to="/logs" style={{ color: "var(--ant-color-primary)" }}>
                            打开日志并执行处理
                          </Link>
                        )}
                      </Descriptions.Item>
                    </Descriptions>
                    {selected.examples.length > 0 && (
                      <Flex vertical gap={8}>
                        <Text strong>日志示例（已脱敏）</Text>
                        <pre style={CODE_STYLE}>{selected.examples.join("\n")}</pre>
                      </Flex>
                    )}
                    {selected.blockReason && (
                      <Alert
                        type={selected.targetType === "config" ? "info" : "warning"}
                        showIcon
                        title={
                          selected.targetType === "config" ? "需要先处理系统问题" : "需要选择关联技能"
                        }
                        description={selected.blockReason}
                      />
                    )}
                    {selected.targetRef === null && selected.candidateSkills.length > 0 && (
                      <Select
                        showSearch
                        style={{ width: "100%" }}
                        placeholder="选择关联技能"
                        value={selectedSkill || undefined}
                        options={selected.candidateSkills.map((name) => ({ value: name, label: name }))}
                        onChange={setSelectedSkill}
                      />
                    )}
                    <Space wrap>
                      <Button onClick={() => void summarize()} loading={busy === "summarize"}>
                        {selected.optimization ? "重新生成优化说明" : "生成优化说明"}
                      </Button>
                      {(selected.targetType === "skill" || selected.targetType === "prompt") && (
                        <Button
                          type="primary"
                          onClick={() => void confirm()}
                          loading={busy === "confirm"}
                          disabled={
                            Boolean(selected.confirmedAt) ||
                            (selected.targetRef === null && !selectedSkill)
                          }
                        >
                          {selected.confirmedAt ? "方向已确认" : "确认这个方向"}
                        </Button>
                      )}
                      {selected.confirmedAt && (
                        <>
                          <Button
                            icon={<ThunderboltOutlined />}
                            onClick={() => void start("hermes")}
                            loading={busy === "start:hermes"}
                          >
                            按 Hermes 流程执行
                          </Button>
                          <Button onClick={() => void start("manual")} loading={busy === "start:manual"}>
                            生成可编辑方案
                          </Button>
                        </>
                      )}
                    </Space>
                  </Flex>
                </Card>
                <Card title={<SectionHeader kicker="优化方案" title="优化说明" compact />}>
                  {selected.optimization ? (
                    <Flex vertical gap={8}>
                      <Paragraph style={{ marginBottom: 0 }}>{selected.optimization.goal}</Paragraph>
                      <ul style={LIST_STYLE}>
                        {selected.optimization.changes.map((item, index) => (
                          <li key={index}>
                            <Typography.Text>{item}</Typography.Text>
                          </li>
                        ))}
                      </ul>
                      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                        预期结果：{selected.optimization.expectedResult}
                      </Paragraph>
                      <Text type="secondary">
                        说明来源：
                        {selected.optimization.generatedBy === "model" ? "已配置模型" : "本地规则"} ·{" "}
                        {formatTime(selected.optimization.generatedAt)}
                      </Text>
                    </Flex>
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      title="尚未生成优化说明"
                      description="点击“生成优化说明”查看建议改动和预期结果。"
                    />
                  )}
                </Card>
                {selectedProposal && (
                  <Card title={<SectionHeader kicker="候选差异" title="候选差异与应用" compact />}>
                    <Flex vertical gap={12}>
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="当前版本标识">
                          <Typography.Text code>{selectedProposal.baselineHash}</Typography.Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="改进方案标识">
                          <Typography.Text code>{selectedProposal.candidateHash}</Typography.Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="验证">
                          {selectedProposal.validation.reason}
                        </Descriptions.Item>
                      </Descriptions>
                      <pre style={CODE_STYLE}>{selectedProposal.diff}</pre>
                      <Space>
                        <Button
                          icon={<SafetyCertificateOutlined />}
                          loading={busy === "validate"}
                          onClick={() => void validate(selectedProposal.id)}
                          disabled={selectedProposal.status === "applied"}
                        >
                          隔离验证
                        </Button>
                        <Button
                          type="primary"
                          danger
                          loading={busy === "apply"}
                          onClick={() => void apply(selectedProposal.id)}
                          disabled={
                            selectedProposal.status !== "ready-to-apply" ||
                            !selectedProposal.target.canApply
                          }
                        >
                          应用到 Hermes
                        </Button>
                      </Space>
                    </Flex>
                  </Card>
                )}
                {selected.execution?.kind === "run" && (
                  <Card title={<SectionHeader kicker="执行状态" title="Hermes 执行状态" compact />}>
                    {run ? (
                      <Flex vertical gap={12}>
                        <Steps
                          size="small"
                          current={runStepIndex(run.status)}
                          items={[
                            { title: "准备" },
                            { title: "执行中" },
                            { title: "生成候选" },
                            { title: "等待验证" },
                            { title: "完成" },
                          ]}
                        />
                        <Divider style={{ margin: 0 }} />
                        <Descriptions size="small" column={1}>
                          <Descriptions.Item label="运行编号">
                            <Typography.Text code>{run.runId}</Typography.Text>
                          </Descriptions.Item>
                          <Descriptions.Item label="当前状态">
                            {runStatusLabel(run.status)}
                          </Descriptions.Item>
                          <Descriptions.Item label="更新时间">
                            {formatTime(run.updatedAt)}
                          </Descriptions.Item>
                          <Descriptions.Item label="说明">{run.detail}</Descriptions.Item>
                          {run.artifacts?.candidatePath && (
                            <Descriptions.Item label="候选文件">
                              {run.artifacts.candidatePath}
                            </Descriptions.Item>
                          )}
                        </Descriptions>
                        {run.status === "running" && (
                          <Progress percent={60} status="active" showInfo={false} />
                        )}
                        {run.artifacts?.diff && (
                          <Flex vertical gap={8}>
                            <Text strong>候选差异</Text>
                            <pre style={CODE_STYLE}>{run.artifacts.diff}</pre>
                          </Flex>
                        )}
                        {run.status === "evaluating" && (
                          <>
                            <Alert
                              type="info"
                              showIcon
                              title="候选已生成，下一步是隔离验证"
                              description="完成评估后，验证通过才能应用到 Hermes。"
                            />
                            <Button
                              icon={<SafetyCertificateOutlined />}
                              loading={busy === "evaluate"}
                              onClick={() => void evaluateRun(run.runId)}
                            >
                              隔离验证并评估
                            </Button>
                          </>
                        )}
                        {run.status === "accepted" && (
                          <>
                            <Alert
                              type="success"
                              showIcon
                              title="候选通过评估，等待确认应用"
                              description="请核对候选差异后，再确认应用。"
                            />
                            <Button
                              type="primary"
                              danger
                              loading={busy === "promote"}
                              onClick={() => void promoteRun(run)}
                            >
                              应用到 Hermes
                            </Button>
                          </>
                        )}
                        {run.status === "failed" && (
                          <Alert
                            type="error"
                            showIcon
                            title="Hermes 执行失败"
                            description={run.detail}
                          />
                        )}
                        <div>
                          <Button
                            icon={<ReloadOutlined />}
                            onClick={() => void loadRun(run.runId)}
                          >
                            刷新执行状态
                          </Button>
                        </div>
                      </Flex>
                    ) : (
                      <Alert
                        type="info"
                        showIcon
                        title="正在读取执行状态"
                        description={`运行编号：${selected.execution.id}`}
                      />
                    )}
                  </Card>
                )}
              </Flex>
            )}
          </Col>
        </Row>
        <Collapse
          className="advanced-details"
          size="small"
          items={[
            {
              key: "history",
              label: (
                <span className="advanced-details-summary">
                  <span>已处理方向</span>
                  <span className="advanced-details-extra">历史执行记录</span>
                </span>
              ),
              children:
                (data?.directions.filter((item) => item.execution).length ?? 0) === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无处理记录；历史运行仍保留在记录中"
                  />
                ) : (
                  <ul style={LIST_STYLE}>
                    {data?.directions
                      .filter((item) => item.execution)
                      .map((item) => (
                        <li key={item.id}>
                          <Typography.Text>
                            {item.title} · {item.execution?.kind === "proposal" ? "变更建议" : "Hermes 流程"}{" "}
                            · {item.execution?.status ?? "已提交"}
                          </Typography.Text>
                        </li>
                      ))}
                  </ul>
                ),
            },
          ]}
        />
      </Flex>
    </section>
  );
}
function detailOf(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  return (
    [
      value["detail"],
      value["fix"],
      Array.isArray(value["actions"]) ? value["actions"].join("、") : "",
    ]
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .join("；") || fallback
  );
}
function runStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    ready: "待执行",
    running: "执行中",
    evaluating: "等待评估",
    accepted: "评估通过",
    "kept-baseline": "保留当前版本",
    "rejected-regression": "验证未通过",
    promoted: "已应用",
    failed: "执行失败",
    cancelled: "已取消",
    "preflight-failed": "准备失败",
  };
  return labels[status ?? ""] ?? status ?? "未知";
}
function runStepIndex(status: string): number {
  if (status === "ready") return 0;
  if (status === "running") return 1;
  if (status === "evaluating") return 3;
  return 4;
}
