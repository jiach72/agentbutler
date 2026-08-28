/**
 * Hermes 自我进化工作区：从日志诊断开始，候选全程隔离，只有受信评估和人工确认
 * 都完成后才允许发布。页面不保存 API Key 或一次性发布令牌。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CloseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { App, Alert, Button, Collapse, Descriptions, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useNavigate } from "react-router-dom";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { StatusBadge, type SemanticTone } from "../../components/StatusBadge.js";
import { loadJson, postJson, type FetchState } from "../../lib/api.js";
import { formatTime, isRecord } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { MetricProgressChart } from "./MetricProgressChart.js";

type ConnectionStatus =
  | "ready"
  | "watch-unreachable"
  | "watch-route-missing"
  | "watch-schema-mismatch"
  | "watch-version-mismatch";

type RunStatus =
  | "diagnosing"
  | "rejected-preflight"
  | "preflight-failed"
  | "ready"
  | "running"
  | "evaluating"
  | "accepted"
  | "kept-baseline"
  | "rejected-regression"
  | "promoted"
  | "cancelled"
  | "failed";

interface EvolutionMetrics {
  baselineQuality?: number;
  candidateQuality?: number;
  qualityDelta?: number;
  holdoutCount?: number;
  elapsedSeconds?: number;
  successRate?: number;
  failureRate?: number;
  confidence?: number | null;
  constraintsPassed?: boolean;
  structureGate?: "pass" | "fail" | "unknown";
  safetyGate?: "pass" | "fail" | "unknown";
  tokenCount?: number;
  cost?: number;
}

interface EvolutionCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
  action?: string;
}

interface EvolutionRun {
  runId: string;
  targetType: "skill" | "prompt" | "config";
  targetRef: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  commandSummary?: string;
  stdoutPath?: string;
  stderrPath?: string;
  artifacts?: {
    baselinePath?: string;
    candidatePath?: string;
    metricsPath?: string;
    diff?: string;
  };
  metrics?: EvolutionMetrics;
  checks: EvolutionCheck[];
  blocked: boolean;
  detail: string;
  logTail: { stdout: string[]; stderr: string[] };
}

interface EvolutionRecommendation {
  id: string;
  targetType: "skill" | "prompt" | "config" | "version-upgrade" | "diagnostic";
  targetRef: string;
  confidence: number;
  window: { sources: number; lines: number; occurrences: number };
  sources: string[];
  examples: string[];
  blocked: boolean;
  nextAction: "create-run" | "open-prompt-optimization" | "open-version-upgrade" | "fix-config" | "inspect";
  title: string;
  detail: string;
}

interface EvolutionDiagnosis {
  analyzedAt: string;
  issues: Array<{ id: string; title: string; detail: string; count: number }>;
  recommendations: EvolutionRecommendation[];
}

interface EvolutionPayload {
  watchReachable: boolean;
  connectionStatus: ConnectionStatus;
  detail: string | null;
  schemaVersion: string | null;
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: unknown[];
  hermes: { status: "ready" | "unavailable" | "unknown"; root: string | null; detail: string };
  endpointHealth: {
    status: "pass" | "fail" | "unknown";
    category: string;
    detail: string;
    checkedAt: string | null;
  };
  blocked: Array<{ category: string; detail: string; affectedRuns: string[] }>;
  tasks: EvolutionRun[];
  history: EvolutionMetrics[];
}

type BusyAction = "diagnose" | "create" | "start" | "evaluate" | "promote" | "cancel" | null;

function isEvolutionPayload(value: unknown): value is EvolutionPayload {
  return (
    isRecord(value) &&
    typeof value["watchReachable"] === "boolean" &&
    typeof value["connectionStatus"] === "string" &&
    isRecord(value["hermes"]) &&
    isRecord(value["endpointHealth"]) &&
    Array.isArray(value["tasks"]) &&
    Array.isArray(value["history"]) &&
    Array.isArray(value["blocked"])
  );
}

function runTone(status: RunStatus): SemanticTone {
  if (status === "accepted" || status === "promoted" || status === "ready") return "ok";
  if (status === "running" || status === "evaluating" || status === "diagnosing") return "info";
  if (status === "failed" || status === "rejected-regression" || status === "preflight-failed") return "error";
  if (status === "rejected-preflight" || status === "kept-baseline" || status === "cancelled") return "warn";
  return "muted";
}

function runLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    diagnosing: "正在诊断",
    "rejected-preflight": "预检未通过",
    "preflight-failed": "预检失败",
    ready: "可启动",
    running: "运行中",
    evaluating: "等待评估",
    accepted: "等待确认采用",
    "kept-baseline": "保留 baseline",
    "rejected-regression": "回归已拦截",
    promoted: "已采用",
    cancelled: "已取消",
    failed: "任务失败",
  };
  return labels[status];
}

function connectionDetail(status: ConnectionStatus, detail: string | null): string {
  if (detail !== null && detail !== "") return detail;
  const labels: Record<ConnectionStatus, string> = {
    ready: "Watch 已同步到当前进化 API schema。",
    "watch-unreachable": "Watch 控制通道不可达，请检查 Watch 服务。",
    "watch-route-missing": "当前 Watch 没有进化接口，需要同步部署。",
    "watch-schema-mismatch": "Watch 返回了不兼容的数据结构，需要同步部署。",
    "watch-version-mismatch": "Web 与 Watch 的 API schema 版本不一致，需要同步部署。",
  };
  return labels[status];
}

function recommendationActionLabel(item: EvolutionRecommendation): string | null {
  if (item.targetType === "skill" && item.nextAction === "create-run" && item.targetRef !== "待从日志定位") return "创建 dry-run";
  if (item.targetType === "prompt") return "打开提示词优化";
  if (item.targetType === "version-upgrade") return "打开版本升级";
  return null;
}

function metricSummary(metrics: EvolutionMetrics | undefined): string {
  if (metrics === undefined) return "尚无指标";
  const items: string[] = [];
  if (metrics.baselineQuality !== undefined && metrics.candidateQuality !== undefined) {
    items.push(`质量 ${metrics.baselineQuality.toFixed(3)} → ${metrics.candidateQuality.toFixed(3)}`);
  }
  if (metrics.successRate !== undefined) items.push(`成功率 ${Math.round(metrics.successRate * 100)}%`);
  if (metrics.elapsedSeconds !== undefined) items.push(`耗时 ${metrics.elapsedSeconds.toFixed(1)} 秒`);
  return items.length > 0 ? items.join(" · ") : "尚无指标";
}

export function EvolutionPage() {
  const { message } = App.useApp();
  const { mode } = useTheme();
  const navigate = useNavigate();
  const [state, setState] = useState<FetchState<EvolutionPayload>>({ status: "loading" });
  const [diagnosis, setDiagnosis] = useState<FetchState<EvolutionDiagnosis> | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<EvolutionRun | null>(null);
  const [promotionTokens, setPromotionTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<BusyAction>(null);
  const [startConfirmRunId, setStartConfirmRunId] = useState<string | null>(null);
  const [promoteConfirmRunId, setPromoteConfirmRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await loadJson<unknown>("/api/evolution", 8_000);
    if (!result.ok) {
      setState({ status: "failed", reason: result.reason });
      return;
    }
    if (!isEvolutionPayload(result.data)) {
      setState({ status: "failed", reason: "进化状态响应格式无效，请同步 Web 与 Watch 服务" });
      return;
    }
    setState({ status: "ready", data: result.data });
  }, []);

  const refreshSelectedRun = useCallback(async (runId: string) => {
    const result = await loadJson<EvolutionRun>(`/api/evolution/runs/${encodeURIComponent(runId)}`, 12_000);
    if (result.ok) setSelectedRun(result.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedRunId !== null) void refreshSelectedRun(selectedRunId);
  }, [refreshSelectedRun, selectedRunId]);

  useEffect(() => {
    if (state.status !== "ready") return;
    if (selectedRunId === null && state.data.tasks.length > 0) setSelectedRunId(state.data.tasks[0]!.runId);
    if (selectedRunId !== null && !state.data.tasks.some((run) => run.runId === selectedRunId)) {
      setSelectedRunId(state.data.tasks[0]?.runId ?? null);
    }
  }, [selectedRunId, state]);

  const poll = useCallback(async () => {
    await refresh();
    if (selectedRunId !== null) await refreshSelectedRun(selectedRunId);
  }, [refresh, refreshSelectedRun, selectedRunId]);
  usePolling(poll, 10_000);

  const data = state.status === "ready" ? state.data : null;
  const activeRun = selectedRun ?? data?.tasks.find((run) => run.runId === selectedRunId) ?? null;

  const runDiagnose = async () => {
    setBusy("diagnose");
    const result = await postJson("/api/evolution/diagnose", {}, 30_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data["recommendations"])) {
      message.error(`日志诊断失败：${result.status === 0 ? "Watch 服务不可达" : "服务返回无效结果"}`);
      return;
    }
    setDiagnosis({ status: "ready", data: result.data as unknown as EvolutionDiagnosis });
  };

  const createRun = async (item: EvolutionRecommendation) => {
    setBusy("create");
    const result = await postJson(
      "/api/evolution/runs",
      { targetType: "skill", targetRef: item.targetRef, dryRun: true },
      70_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data) || typeof result.data["runId"] !== "string") {
      message.error(`创建任务失败：${result.status === 0 ? "Watch 服务不可达" : "请查看预检详情"}`);
      return;
    }
    const run = result.data as unknown as EvolutionRun;
    setSelectedRunId(run.runId);
    setSelectedRun(run);
    message.success(run.status === "ready" ? "预检通过，任务已准备为 Hermes dry-run。" : "任务已创建，但预检阻断了启动。");
    await refresh();
  };

  const startRun = async () => {
    if (startConfirmRunId === null) return;
    setBusy("start");
    const result = await postJson(`/api/evolution/runs/${encodeURIComponent(startConfirmRunId)}/start`, {}, 30_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error("启动 Hermes dry-run 失败，请查看任务日志。");
      return;
    }
    setSelectedRun(result.data as unknown as EvolutionRun);
    setSelectedRunId(startConfirmRunId);
    setStartConfirmRunId(null);
    message.success("Hermes dry-run 已启动；baseline 保持只读。");
    await refresh();
  };

  const cancelRun = async (runId: string) => {
    setBusy("cancel");
    const result = await postJson(`/api/evolution/runs/${encodeURIComponent(runId)}/cancel`, {}, 30_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error("取消任务失败，请刷新后确认运行状态。");
      return;
    }
    setSelectedRun(result.data as unknown as EvolutionRun);
    message.success("任务已取消，baseline 未修改。");
    await refresh();
  };

  const evaluateRun = async (runId: string) => {
    setBusy("evaluate");
    const result = await postJson(`/api/evolution/runs/${encodeURIComponent(runId)}/evaluate`, {}, 70_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error("候选评估失败，请检查 metrics.json 和运行日志。");
      return;
    }
    const authority = result.data["writeAuthority"];
    if (isRecord(authority) && typeof authority["token"] === "string") {
      setPromotionTokens((tokens) => ({ ...tokens, [runId]: authority["token"] as string }));
    }
    await refreshSelectedRun(runId);
    await refresh();
    message.success(
      result.data["status"] === "accepted" ? "候选通过评估，等待你的确认采用。" : "评估完成，baseline 已保留。",
    );
  };

  const promoteRun = async () => {
    if (promoteConfirmRunId === null) return;
    const token = promotionTokens[promoteConfirmRunId];
    if (token === undefined) {
      message.error("本页没有有效的发布令牌，请重新进行该候选的受信评估。");
      return;
    }
    setBusy("promote");
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(promoteConfirmRunId)}/promote`,
      { token },
      30_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data) || result.data["status"] !== "promoted") {
      message.error("采用失败：候选或 baseline 可能已发生变化，未进行任何写入。");
      return;
    }
    setPromotionTokens((tokens) => {
      const next = { ...tokens };
      delete next[promoteConfirmRunId];
      return next;
    });
    setPromoteConfirmRunId(null);
    message.success("候选已原子替换 baseline，并已写入审计记录。");
    await refreshSelectedRun(promoteConfirmRunId);
    await refresh();
  };

  const taskColumns = useMemo<TableColumnsType<EvolutionRun>>(
    () => [
      {
        title: "目标",
        render: (_, run) => (
          <div className="evolution-task-target">
            <strong>{run.targetRef}</strong>
            <span>{run.targetType} · {run.runId.slice(0, 8)}</span>
          </div>
        ),
      },
      {
        title: "状态",
        width: 136,
        render: (_, run) => <StatusBadge tone={runTone(run.status)} label={runLabel(run.status)} />,
      },
      {
        title: "指标",
        render: (_, run) => <span className="evolution-metric-summary">{metricSummary(run.metrics)}</span>,
      },
      {
        title: "更新",
        width: 122,
        render: (_, run) => <span className="evolution-time">{formatTime(run.updatedAt)}</span>,
      },
    ],
    [],
  );

  const recommendationColumns = useMemo<TableColumnsType<EvolutionRecommendation>>(
    () => [
      {
        title: "方向",
        render: (_, item) => (
          <div className="evolution-recommendation-title">
            <strong>{item.title}</strong>
            <span>{item.targetType} · {item.targetRef}</span>
          </div>
        ),
      },
      {
        title: "证据",
        render: (_, item) => (
          <div className="evolution-recommendation-detail">
            <span>{item.detail}</span>
            <small>{item.window.occurrences} 次 · {item.window.sources} 个来源 · 置信度 {Math.round(item.confidence * 100)}%</small>
          </div>
        ),
      },
      {
        title: "下一步",
        width: 160,
        render: (_, item) => {
          const label = recommendationActionLabel(item);
          if (label === null) return <span className="evolution-muted-action">仅诊断</span>;
          if (item.targetType === "skill") {
            return (
              <Tooltip title="创建隔离的 Hermes dry-run；不会写入 SKILL.md">
                <Button size="small" icon={<PlayCircleOutlined />} loading={busy === "create"} onClick={() => void createRun(item)}>
                  {label}
                </Button>
              </Tooltip>
            );
          }
          const path = item.targetType === "version-upgrade" ? "/versions" : "/gateway";
          return <Button size="small" onClick={() => navigate(path)}>{label}</Button>;
        },
      },
    ],
    [busy, navigate],
  );

  const runDetails = activeRun === null ? [] : [
    {
      key: "checks",
      label: "预检与门禁",
      children: (
        <ul className="evolution-check-list">
          {activeRun.checks.map((check) => (
            <li key={check.id} className={`is-${check.status}`}>
              <StatusBadge
                tone={check.status === "pass" ? "ok" : check.status === "fail" ? "error" : "muted"}
                label={check.status === "pass" ? "通过" : check.status === "fail" ? "阻断" : "跳过"}
              />
              <div><strong>{check.label}</strong><span>{check.detail}</span></div>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "diff",
      label: "候选差异",
      children: activeRun.artifacts?.diff ? <pre className="evolution-code">{activeRun.artifacts.diff}</pre> : <div className="evolution-empty">该任务尚未生成可比较的隔离候选。</div>,
    },
    {
      key: "logs",
      label: "运行日志尾部",
      children: (
        <div className="evolution-log-grid">
          <div><strong>stdout</strong><pre className="evolution-code">{activeRun.logTail.stdout.join("\n") || "暂无输出"}</pre></div>
          <div><strong>stderr</strong><pre className="evolution-code">{activeRun.logTail.stderr.join("\n") || "暂无错误输出"}</pre></div>
        </div>
      ),
    },
  ];

  return (
    <section className="page evolution-page">
      <header className="evolution-header">
        <div>
          <span className="evolution-eyebrow">Hermes WSL</span>
          <h1>进化与优化</h1>
          <p>从日志证据生成隔离候选，评估通过后由你确认采用。</p>
        </div>
        <ConnectionChip
          reachable={data?.connectionStatus === "ready" ? data.watchReachable : false}
          connectingText="正在读取进化控制通道"
          offlineText="进化控制通道不可用"
        />
      </header>

      {state.status === "failed" ? (
        <Alert
          type="error"
          showIcon
          message="无法读取进化工作区"
          description={state.reason}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>重试</Button>}
        />
      ) : data !== null && data.connectionStatus !== "ready" ? (
        <Alert
          type="error"
          showIcon
          message="Web 与 Watch 未同步"
          description={connectionDetail(data.connectionStatus, data.detail)}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>重试</Button>}
        />
      ) : null}

      {data !== null && (
        <section className="evolution-health" aria-label="Hermes 与模型健康状态">
          <div className="evolution-section-head">
            <div><span className="evolution-kicker">健康与阻断</span><h2>运行前状态</h2></div>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>
          </div>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
            <Descriptions.Item label="Hermes WSL">
              <StatusBadge tone={data.hermes.status === "ready" ? "ok" : data.hermes.status === "unknown" ? "warn" : "error"} label={data.hermes.status === "ready" ? "已就绪" : data.hermes.status === "unknown" ? "未知" : "不可用"} />
            </Descriptions.Item>
            <Descriptions.Item label="LLM 探针">
              <StatusBadge tone={data.endpointHealth.status === "pass" ? "ok" : data.endpointHealth.status === "fail" ? "error" : "warn"} label={data.endpointHealth.status === "pass" ? "通过" : data.endpointHealth.status === "fail" ? "已阻断" : "未检查"} />
            </Descriptions.Item>
            <Descriptions.Item label="探针分类">{data.endpointHealth.category}</Descriptions.Item>
            <Descriptions.Item label="检查时间">{formatTime(data.endpointHealth.checkedAt)}</Descriptions.Item>
          </Descriptions>
          <p className="evolution-health-detail">{data.hermes.detail} · {data.endpointHealth.detail}</p>
          {data.blocked.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`当前有 ${data.blocked.length} 项阻断`}
              description={data.blocked.map((item) => item.detail).join("；")}
            />
          )}
        </section>
      )}

      <section className="evolution-diagnosis">
        <div className="evolution-section-head">
          <div><span className="evolution-kicker">日志诊断</span><h2>证据与进化方向</h2></div>
          <Tooltip title="读取已接入的 Watch 日志并生成脱敏建议">
            <Button type="primary" icon={<SearchOutlined />} loading={busy === "diagnose"} disabled={data?.connectionStatus !== "ready"} onClick={() => void runDiagnose()}>
              分析日志
            </Button>
          </Tooltip>
        </div>
        {diagnosis === null ? (
          <div className="evolution-empty">运行日志诊断后，会按配置、技能、提示词和依赖问题给出可追溯的下一步。</div>
        ) : diagnosis.status === "failed" ? (
          <Alert type="error" showIcon message="日志诊断失败" description={diagnosis.reason} />
        ) : diagnosis.status !== "ready" ? (
          <div className="evolution-empty">正在读取诊断结果…</div>
        ) : diagnosis.data.recommendations.length === 0 ? (
          <div className="evolution-empty">本次没有发现足以自动生成候选的模式；原始问题仍可在运行日志中查看。</div>
        ) : (
          <Table<EvolutionRecommendation>
            className="evolution-recommendations"
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={diagnosis.data.recommendations}
            columns={recommendationColumns}
            expandable={{
              rowExpandable: (item) => item.examples.length > 0 || item.sources.length > 0,
              expandedRowRender: (item) => (
                <div className="evolution-evidence">
                  <strong>脱敏日志示例</strong>
                  <pre className="evolution-code">{item.examples.join("\n") || "无可显示样例"}</pre>
                  <span>来源：{item.sources.join("、") || "未标注"}</span>
                </div>
              ),
            }}
          />
        )}
      </section>

      <div className="evolution-workspace">
        <section className="evolution-tasks">
          <div className="evolution-section-head">
            <div><span className="evolution-kicker">候选任务</span><h2>隔离运行</h2></div>
            <span className="evolution-task-count">{data?.tasks.length ?? 0} 项</span>
          </div>
          <Table<EvolutionRun>
            size="small"
            rowKey="runId"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={data?.tasks ?? []}
            columns={taskColumns}
            onRow={(run) => ({ onClick: () => { setSelectedRunId(run.runId); setSelectedRun(run); }, className: run.runId === selectedRunId ? "is-selected" : "" })}
            locale={{ emptyText: "还没有候选任务。先从上方日志诊断生成技能 dry-run。" }}
          />
        </section>

        <section className="evolution-inspector">
          <div className="evolution-section-head">
            <div><span className="evolution-kicker">候选详情</span><h2>{activeRun?.targetRef ?? "选择一个任务"}</h2></div>
            {activeRun !== null && <StatusBadge tone={runTone(activeRun.status)} label={runLabel(activeRun.status)} />}
          </div>
          {activeRun === null ? (
            <div className="evolution-empty">选中任务后可查看预检、差异、评估指标和运行日志。</div>
          ) : (
            <>
              <p className="evolution-run-detail">{activeRun.detail}</p>
              <div className="evolution-run-actions">
                {activeRun.status === "ready" && (
                  <Tooltip title="启动 Hermes WSL dry-run；不会修改 baseline"><Button type="primary" icon={<PlayCircleOutlined />} loading={busy === "start"} onClick={() => setStartConfirmRunId(activeRun.runId)}>启动 dry-run</Button></Tooltip>
                )}
                {activeRun.status === "running" && (
                  <Tooltip title="终止当前 WSL 进程，baseline 保持不变"><Button danger icon={<CloseCircleOutlined />} loading={busy === "cancel"} onClick={() => void cancelRun(activeRun.runId)}>取消任务</Button></Tooltip>
                )}
                {activeRun.status === "evaluating" && (
                  <Tooltip title="读取隔离候选与 metrics.json，执行结构和安全门禁"><Button type="primary" icon={<SearchOutlined />} loading={busy === "evaluate"} onClick={() => void evaluateRun(activeRun.runId)}>评估候选</Button></Tooltip>
                )}
                {activeRun.status === "accepted" && promotionTokens[activeRun.runId] !== undefined && (
                  <Tooltip title="需要二次确认；仅原样采用已评估的隔离候选"><Button danger icon={<RocketOutlined />} loading={busy === "promote"} onClick={() => setPromoteConfirmRunId(activeRun.runId)}>确认采用</Button></Tooltip>
                )}
                {activeRun.status === "accepted" && promotionTokens[activeRun.runId] === undefined && (
                  <span className="evolution-muted-action">发布令牌仅保留在本次评估的当前页面内存中。</span>
                )}
              </div>
              <Descriptions size="small" column={1} className="evolution-run-facts">
                <Descriptions.Item label="任务 ID">{activeRun.runId}</Descriptions.Item>
                <Descriptions.Item label="命令摘要">{activeRun.commandSummary ?? "尚未启动"}</Descriptions.Item>
                <Descriptions.Item label="指标">{metricSummary(activeRun.metrics)}</Descriptions.Item>
                <Descriptions.Item label="评估集">{activeRun.metrics?.holdoutCount ?? "—"} 条</Descriptions.Item>
                <Descriptions.Item label="置信度">{activeRun.metrics?.confidence === undefined || activeRun.metrics.confidence === null ? "—" : `${Math.round(activeRun.metrics.confidence * 100)}%`}</Descriptions.Item>
                <Descriptions.Item label="门禁">结构 {activeRun.metrics?.structureGate ?? "未知"} · 安全 {activeRun.metrics?.safetyGate ?? "未知"}</Descriptions.Item>
                {activeRun.metrics?.tokenCount !== undefined && <Descriptions.Item label="Token">{activeRun.metrics.tokenCount}</Descriptions.Item>}
                {activeRun.metrics?.cost !== undefined && <Descriptions.Item label="成本">{activeRun.metrics.cost}</Descriptions.Item>}
              </Descriptions>
              <Collapse size="small" items={runDetails} />
            </>
          )}
        </section>
      </div>

      <section className="evolution-metrics-section">
        <div className="evolution-section-head">
          <div><span className="evolution-kicker">真实指标</span><h2>历史对比</h2></div>
        </div>
        <MetricProgressChart history={data?.history ?? []} mode={mode} />
      </section>

      <DangerConfirmModal
        open={startConfirmRunId !== null}
        title="启动 Hermes dry-run？"
        confirmLabel="启动 dry-run"
        busy={busy === "start"}
        onCancel={() => { if (busy === null) setStartConfirmRunId(null); }}
        onConfirm={() => void startRun()}
        impact={<p>本次仅验证 Hermes 配置和技能路径，不会生成高成本真实进化，也不会修改 baseline。</p>}
        steps={["创建隔离运行目录", "启动 WSL Hermes 进程", "采集脱敏日志和产物状态"]}
      >
        <p>Watch 会为该技能创建独立运行目录。原始 `SKILL.md` 在评估和确认采用前始终保持只读。</p>
      </DangerConfirmModal>

      <DangerConfirmModal
        open={promoteConfirmRunId !== null}
        title="确认采用这个候选？"
        confirmLabel="确认采用"
        busy={busy === "promote"}
        onCancel={() => { if (busy === null) setPromoteConfirmRunId(null); }}
        onConfirm={() => void promoteRun()}
        impact={<p>Watch 会校验候选和 baseline 的 hash，然后以原子替换方式写入。文件一旦在评估后变化，采用将被拒绝。</p>}
        steps={["校验一次性发布令牌", "校验候选与 baseline hash", "原子替换并写入审计记录"]}
      >
        <p>只会采用这一运行已评估的隔离候选；不会写入配置、依赖或 Hermes 运行时。</p>
      </DangerConfirmModal>
    </section>
  );
}
