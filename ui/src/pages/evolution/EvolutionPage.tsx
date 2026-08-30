import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Divider,
  Empty,
  List,
  Progress,
  Select,
  Space,
  Steps,
  Table,
  Typography,
} from "antd";
import { ReloadOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime, isRecord } from "../../lib/format.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Link } from "react-router-dom";

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
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ range });
    if (instanceId) query.set("instanceId", instanceId);
    const [insightResult, instanceResult, proposalResult] = await Promise.all([
      loadJson<Insights>(`/api/evolution/insights?${query.toString()}`, 30_000),
      loadJson<{ instances: Array<{ instanceId: string; version?: string; state?: string }> }>(
        "/api/instances",
        10_000,
      ),
      loadJson<{ proposals: Proposal[] }>("/api/evolution/proposals", 10_000),
    ]);
    if (!insightResult.ok) {
      setError(insightResult.reason);
      return;
    }
    setError(null);
    setData(insightResult.data);
    setProposals(proposalResult.ok ? (proposalResult.data.proposals ?? []) : []);
    if (instanceResult.ok) {
      const next = instanceResult.data.instances ?? [];
      setInstances(next);
      if (!instanceId && next[0]) setInstanceId(next[0].instanceId);
    }
    if (selectedId === null && insightResult.data.directions[0])
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
  const columns = useMemo(
    () => [
      {
        title: "改进方向",
        render: (_: unknown, item: Direction) => (
          <div>
            <strong>{item.title}</strong>
            <div className="evolution-muted-action">
              {item.targetRef ?? "未能定位技能"} · {item.occurrences} 次
            </div>
          </div>
        ),
      },
      {
        title: "影响",
        width: 90,
        render: (_: unknown, item: Direction) => (
          <StatusBadge tone={impactTone[item.impact]} label={impactLabel[item.impact]} />
        ),
      },
      {
        title: "把握程度",
        width: 100,
        render: (_: unknown, item: Direction) => `${Math.round(item.confidence * 100)}%`,
      },
      {
        title: "最近出现",
        width: 150,
        render: (_: unknown, item: Direction) =>
          item.lastSeenAt ? formatTime(item.lastSeenAt) : "未知",
      },
      {
        title: "状态",
        width: 120,
        render: (_: unknown, item: Direction) =>
          item.execution ? (
            <StatusBadge tone="ok" label="已启动" />
          ) : item.blocked ? (
            <StatusBadge tone="warn" label="需处理" />
          ) : item.confirmedAt ? (
            <StatusBadge tone="info" label="已确认" />
          ) : (
            <StatusBadge tone="muted" label="待确认" />
          ),
      },
    ],
    [],
  );
  return (
    <section className="page evolution-page">
      <header className="evolution-header">
        <div>
          <span className="evolution-eyebrow">日志分析与变更评估</span>
          <h1>改进与优化</h1>
          <p>根据运行日志整理重复问题，确认后生成变更建议。</p>
        </div>
        <ConnectionChip
          reachable={error === null}
          connectingText="正在读取运行日志"
          offlineText="分析服务暂时不可用"
        />
      </header>
      {error && (
        <Alert
          type="error"
          showIcon
          message="无法读取 Hermes 日志洞察"
          description={error}
          action={
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      )}
      <section className="evolution-health">
        <div className="evolution-section-head">
          <div>
            <span className="evolution-kicker">分析范围</span>
            <h2>日志中的改进方向</h2>
          </div>
          <Space>
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
            <Select
              value={range}
              options={[
                { value: "24h", label: "最近 24 小时" },
                { value: "7d", label: "最近 7 天" },
                { value: "30d", label: "最近 30 天" },
              ]}
              onChange={setRange}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>
              重新分析
            </Button>
          </Space>
        </div>
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
      </section>
      <div className="evolution-workspace">
        <section className="evolution-tasks">
          <div className="evolution-section-head">
            <div>
              <span className="evolution-kicker">改进方向</span>
              <h2>{data?.directions.length ?? 0} 项</h2>
            </div>
          </div>
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={data?.directions ?? []}
            columns={columns}
            onRow={(item) => ({
              onClick: () => {
                setSelectedId(item.id);
                setSelectedSkill(item.targetRef ?? "");
              },
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedId(item.id);
                  setSelectedSkill(item.targetRef ?? "");
                }
              },
              tabIndex: 0,
              role: "button",
              "aria-label": `查看改进方向：${item.title}`,
              "aria-pressed": item.id === selectedId,
              className: item.id === selectedId ? "is-selected" : "",
            })}
            locale={{ emptyText: <Empty description="当前窗口没有可归纳的问题" /> }}
          />
        </section>
        <section className="evolution-diagnosis">
          <div className="evolution-section-head">
            <div>
              <span className="evolution-kicker">方向详情</span>
              <h2>{selected?.title ?? "选择一个方向"}</h2>
            </div>
            {selected && (
              <StatusBadge tone={impactTone[selected.impact]} label={`${impactLabel[selected.impact]}影响`} />
            )}
          </div>
          {!selected ? (
            <div className="evolution-empty">选择左侧方向查看问题总结、日志依据和处理方式。</div>
          ) : (
            <>
              <Typography.Title level={5}>问题总结</Typography.Title>
              <Typography.Paragraph>{selected.summary}</Typography.Paragraph>
              <section className="evolution-optimization">
                <Typography.Title level={5}>优化说明</Typography.Title>
                {selected.optimization ? (
                  <>
                    <Typography.Paragraph>{selected.optimization.goal}</Typography.Paragraph>
                    <List
                      size="small"
                      dataSource={selected.optimization.changes}
                      renderItem={(item) => <List.Item>{item}</List.Item>}
                    />
                    <Typography.Paragraph type="secondary">
                      预期结果：{selected.optimization.expectedResult}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary">
                      说明来源：
                      {selected.optimization.generatedBy === "model" ? "已配置模型" : "本地规则"} ·{" "}
                      {formatTime(selected.optimization.generatedAt)}
                    </Typography.Text>
                  </>
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    message="尚未生成优化说明"
                    description="点击“生成优化说明”查看建议改动和预期结果。"
                  />
                )}
              </section>
              <Descriptions size="small" column={1} className="evolution-run-facts">
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
                    <Link className="evolution-log-link" to="/logs">
                      打开日志并执行处理
                    </Link>
                  )}
                </Descriptions.Item>
              </Descriptions>
              {selected.examples.length > 0 && (
                <>
                  <Typography.Text strong>日志示例（已脱敏）</Typography.Text>
                  <pre className="evolution-code">{selected.examples.join("\n")}</pre>
                </>
              )}
              {selected.blockReason && (
                <Alert
                  type={selected.targetType === "config" ? "info" : "warning"}
                  showIcon
                  message={
                    selected.targetType === "config" ? "需要先处理系统问题" : "需要选择关联技能"
                  }
                  description={selected.blockReason}
                />
              )}
              {selected.targetRef === null && selected.candidateSkills.length > 0 && (
                <Select
                  showSearch
                  style={{ width: "100%", marginTop: 12 }}
                  placeholder="选择关联技能"
                  value={selectedSkill || undefined}
                  options={selected.candidateSkills.map((name) => ({ value: name, label: name }))}
                  onChange={setSelectedSkill}
                />
              )}
              <Space wrap className="evolution-run-actions">
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
              {selectedProposal && (
                <section className="evolution-inspector">
                  <Typography.Title level={5}>候选差异与应用</Typography.Title>
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="当前版本标识">
                      <code>{selectedProposal.baselineHash}</code>
                    </Descriptions.Item>
                    <Descriptions.Item label="改进方案标识">
                      <code>{selectedProposal.candidateHash}</code>
                    </Descriptions.Item>
                    <Descriptions.Item label="验证">
                      {selectedProposal.validation.reason}
                    </Descriptions.Item>
                  </Descriptions>
                  <pre className="evolution-code">{selectedProposal.diff}</pre>
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
                </section>
              )}
              {selected.execution?.kind === "run" && (
                <section className="evolution-inspector">
                  <Typography.Title level={5}>Hermes 执行状态</Typography.Title>
                  {run ? (
                    <>
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
                      <Divider />
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="运行编号">
                          <code>{run.runId}</code>
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
                        <>
                          <Typography.Text strong>候选差异</Typography.Text>
                          <pre className="evolution-code">{run.artifacts.diff}</pre>
                        </>
                      )}
                      {run.status === "evaluating" && (
                        <>
                          <Alert
                            type="info"
                            showIcon
                            message="候选已生成，下一步是隔离验证"
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
                            message="候选通过评估，等待确认应用"
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
                          message="Hermes 执行失败"
                          description={run.detail}
                        />
                      )}
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={() => void loadRun(run.runId)}
                      >
                        刷新执行状态
                      </Button>
                    </>
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message="正在读取执行状态"
                      description={`运行编号：${selected.execution.id}`}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </div>
      <section className="evolution-health">
        <div className="evolution-section-head">
          <div>
            <span className="evolution-kicker">历史记录</span>
            <h2>已处理方向</h2>
          </div>
        </div>
        {(data?.directions.filter((item) => item.execution).length ?? 0) === 0 ? (
          <Empty description="暂无处理记录；历史运行仍保留在记录中" />
        ) : (
          <ul>
            {data?.directions
              .filter((item) => item.execution)
              .map((item) => (
                <li key={item.id}>
                  {item.title} · {item.execution?.kind === "proposal" ? "变更建议" : "Hermes 流程"}{" "}
                  · {item.execution?.status ?? "已提交"}
                </li>
              ))}
          </ul>
        )}
      </section>
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
