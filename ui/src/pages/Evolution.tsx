import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Steps, Tag } from "antd";
import { fetchJson, postJson } from "../lib/api.js";

type CheckStatus = "pass" | "fail" | "skipped";

interface EvolutionCheck {
  id: "dependencies" | "endpoint" | "dataset" | "snapshot";
  label: string;
  status: CheckStatus;
  detail: string;
  action?: string;
}

interface LedgerEntry {
  runId: string;
  updatedAt: string;
  instanceId: string | null;
  status: string;
  holdoutCount: number;
  baselineMetric?: number;
  candidateMetric?: number;
  delta?: number;
  conclusion: string;
  disposition: string;
}

interface EvolutionPayload {
  watchReachable: boolean;
  minHoldoutCount: number;
  defaultDependencies: string[];
  defaultEndpoint: string;
  ledger: LedgerEntry[];
}

interface PreflightOutcome {
  runId: string;
  status: "rejected-preflight" | "ready";
  allowRun: boolean;
  instanceId: string | null;
  checks: EvolutionCheck[];
  snapshotId?: string;
  ledgerPath: string;
  nextAction?: { kind: "expand-dataset"; targetCount: number; endpoint: string };
}

interface ExpandOutcome {
  status: "ready" | "error";
  error?: string;
  beforeCount: number;
  afterCount: number;
  syntheticCount: number;
  datasetPath: string;
  recheck: PreflightOutcome;
}

interface GateOutcome {
  status: string;
  error?: string;
  allowWrite: boolean;
  baselinePreserved: boolean;
  delta: number | null;
  ledgerPath: string | null;
}

interface EvaluationOutcome extends GateOutcome {
  status: "accepted" | "kept-baseline" | "rejected-regression";
  sampleCount: number;
  confidence: number | null;
  baselineMetric: number;
  candidateMetric: number;
  canPromote: boolean;
  report: Record<string, unknown>;
}

const PENDING_CHECKS: EvolutionCheck[] = [
  { id: "dependencies", label: "运行依赖", status: "skipped", detail: "等待检查当前运行依赖" },
  { id: "endpoint", label: "模型连接", status: "skipped", detail: "等待模型连接检查" },
  { id: "dataset", label: "测试样本", status: "skipped", detail: "等待校验测试样本数量" },
  { id: "snapshot", label: "运行前备份", status: "skipped", detail: "前三项通过后才创建" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSeedExamples(raw: string): unknown[] {
  const text = raw.trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("种子样本 JSON 必须是数组或 JSONL");
    return parsed;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function responseError(data: unknown): string {
  if (!isRecord(data)) return "未知错误";
  const detail = typeof data["detail"] === "string" ? data["detail"] : "";
  const error = typeof data["error"] === "string" ? data["error"] : "请求失败";
  return detail === "" ? error : `${error}：${detail}`;
}

function checkTone(status: CheckStatus): string {
  if (status === "pass") return "is-pass";
  if (status === "fail") return "is-fail";
  return "is-pending";
}

const DISPOSITION_LABELS: Record<string, string> = {
  accepted: "已采用",
  "kept-baseline": "保留当前版本",
  "rejected-regression": "已拦截",
  "rejected-preflight": "检查未通过",
  pending: "等待确认",
};

function dispositionLabel(value: string): string {
  return DISPOSITION_LABELS[value] ?? "其他结论";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    "rejected-preflight": "检查未通过",
    ready: "可以运行",
    accepted: "明显更好",
    "kept-baseline": "没有明显提升",
    "rejected-regression": "结果变差，已拦截",
  };
  return labels[status] ?? "其他状态";
}

function formatMetric(entry: LedgerEntry): string {
  if (entry.baselineMetric === undefined || entry.candidateMetric === undefined) {
    return `${entry.holdoutCount} 条`;
  }
  return `${entry.baselineMetric.toFixed(3)} → ${entry.candidateMetric.toFixed(3)}`;
}

function formatTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function EvolutionPage() {
  const [data, setData] = useState<EvolutionPayload | null>(null);
  const [dependencies, setDependencies] = useState("dspy, gepa, optuna");
  const [endpoint, setEndpoint] = useState("");
  const [holdoutCount, setHoldoutCount] = useState("2");
  const [datasetPath, setDatasetPath] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [seedExamples, setSeedExamples] = useState("");
  const [preflight, setPreflight] = useState<PreflightOutcome | null>(null);
  const [baselineMetric, setBaselineMetric] = useState("");
  const [candidateMetric, setCandidateMetric] = useState("");
  const [significant, setSignificant] = useState(false);
  const [rootCause, setRootCause] = useState("");
  const [fixes, setFixes] = useState("");
  const [gate, setGate] = useState<GateOutcome | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationOutcome | null>(null);
  const [busy, setBusy] = useState<"preflight" | "expand" | "gate" | "evaluate" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    const payload = await fetchJson<EvolutionPayload>("/api/evolution");
    if (payload === null) return;
    setData(payload);
    setEndpoint((current) => current || payload.defaultEndpoint);
    setDependencies((current) => current || payload.defaultDependencies.join(", "));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const checks = preflight?.checks ?? PENDING_CHECKS;
  const failedChecks = checks.filter((check) => check.status === "fail");
  const minHoldout = data?.minHoldoutCount ?? 10;
  const parsedHoldout = Number(holdoutCount);
  const canExpand =
    preflight?.nextAction?.kind === "expand-dataset" &&
    (datasetPath.trim() !== "" || seedExamples.trim() !== "");
  const gateReady = preflight?.allowRun === true && gate === null;

  const preflightState = useMemo(() => {
    if (busy === "preflight" || busy === "expand") return "检查中";
    if (preflight === null) return "待运行";
    return preflight.allowRun ? "已通过" : "已拒绝";
  }, [busy, preflight]);

  const runPreflight = async () => {
    if (!Number.isInteger(parsedHoldout) || parsedHoldout < 0) {
      setNotice({ kind: "error", text: "测试样本数量必须是大于等于 0 的整数。" });
      return;
    }
    setBusy("preflight");
    setNotice(null);
    setGate(null);
    setEvaluation(null);
    const body: Record<string, unknown> = {
      holdoutCount: parsedHoldout,
      dependencies: dependencies
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      endpoint: endpoint.trim(),
      config: { source: "butler-ui", gateMode: "v1-external-engine" },
    };
    if (datasetPath.trim() !== "") body["datasetPath"] = datasetPath.trim();
    if (instanceId.trim() !== "") body["instanceId"] = instanceId.trim();
    const result = await postJson("/api/evolution/preflight", body, 20_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      setNotice({ kind: "error", text: `预检失败：${responseError(result.data)}` });
      return;
    }
    const outcome = result.data as unknown as PreflightOutcome;
    setPreflight(outcome);
    setNotice({
      kind: outcome.allowRun ? "ok" : "warn",
      text: outcome.allowRun
        ? "检查与运行前备份均通过。管家已允许外部改进引擎开始运行。"
        : "检查未通过；按提示处理好后可以重新检查。",
    });
    await refresh();
  };

  const expandDataset = async () => {
    if (preflight === null) return;
    let seeds: unknown[];
    try {
      seeds = parseSeedExamples(seedExamples);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (datasetPath.trim() === "" && seeds.length === 0) {
      setNotice({
        kind: "error",
        text: "请填写测试样本位置，或粘贴至少一条示例问题与期望答案。",
      });
      return;
    }
    setBusy("expand");
    setNotice(null);
    const body: Record<string, unknown> = {
      holdoutCount: parsedHoldout,
      targetCount: minHoldout,
    };
    if (datasetPath.trim() !== "") body["datasetPath"] = datasetPath.trim();
    if (seeds.length > 0) body["seedExamples"] = seeds;
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(preflight.runId)}/expand`,
      body,
      20_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      setNotice({ kind: "error", text: `补齐测试样本失败：${responseError(result.data)}` });
      return;
    }
    const outcome = result.data as unknown as ExpandOutcome;
    setPreflight(outcome.recheck);
    setHoldoutCount(String(outcome.afterCount));
    setDatasetPath(outcome.datasetPath);
    setNotice({
      kind: outcome.recheck.allowRun ? "ok" : "warn",
      text: `已生成 ${outcome.syntheticCount} 条最小合成样本并自动重检。合成样本仅用于打通门槛，正式运行前仍需人工审阅质量。`,
    });
    await refresh();
  };

  const submitGate = async () => {
    if (preflight === null) return;
    const baseline = Number(baselineMetric);
    const candidate = Number(candidateMetric);
    if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) {
      setNotice({ kind: "error", text: "当前版本与改进后的指标都必须是有效数值。" });
      return;
    }
    setBusy("gate");
    setNotice(null);
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(preflight.runId)}/result`,
      {
        baselineMetric: baseline,
        candidateMetric: candidate,
        significant,
        rootCause: rootCause.trim(),
        fixes: fixes
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      },
      20_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      setNotice({ kind: "error", text: `确认结果失败：${responseError(result.data)}` });
      return;
    }
    const outcome = result.data as unknown as GateOutcome;
    setGate(outcome);
    setNotice({
      kind: outcome.status === "rejected-regression" ? "error" : "warn",
      text:
        outcome.status === "accepted"
          ? "手填指标已记录，但不会授权写入；正式采用必须通过服务端受信评估入口。"
          : "改进结果未获采用资格，当前版本保持不变；结论已记录。",
    });
    await refresh();
  };

  const evaluateExternally = async () => {
    if (preflight === null || !preflight.allowRun) return;
    setBusy("evaluate");
    setNotice(null);
    const result = await postJson(`/api/evolution/runs/${encodeURIComponent(preflight.runId)}/evaluate`, {}, 70_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      setNotice({ kind: "error", text: `真实评估未完成：${responseError(result.data)}` });
      return;
    }
    const outcome = result.data as unknown as EvaluationOutcome;
    setEvaluation(outcome);
    setGate(outcome);
    setNotice({
      kind: outcome.status === "rejected-regression" ? "error" : outcome.status === "accepted" ? "ok" : "warn",
      text: outcome.status === "accepted" ? "真实评估显示候选版本有显著提升，但仍需通过受信提升入口才能正式采用。" : outcome.status === "rejected-regression" ? "真实评估发现质量下降，当前版本已保留。" : "真实评估完成，没有发现足够的显著提升。",
    });
    await refresh();
  };

  return (
    <section className="page evolution-page">
      <header className="evolution-header">
        <div>
          <span className="evolution-eyebrow">自我进化安全锁</span>
          <h1>给 AI 的自我改进装上安全锁</h1>
          <p>让 AI 自己变聪明之前，先检查、备份、记录结果；正式采用只接受服务端受信评估。</p>
        </div>
        <div
          className={`evolution-connection ${data?.watchReachable ? "is-online" : "is-offline"}`}
        >
          <span />
          {data === null
            ? "正在连接管家"
            : data.watchReachable
              ? "管家服务已连接"
              : "管家服务暂时连不上"}
        </div>
      </header>

      {notice !== null && (
        <div className={`evolution-notice is-${notice.kind}`} role="status">
          {notice.text}
        </div>
      )}

      <div className="evolution-workspace">
        <section className="evolution-column evolution-preflight">
          <div className="evolution-section-head">
            <div>
              <span className="evolution-kicker">开始之前</span>
              <h2>先检查，再运行</h2>
            </div>
            <span
              className={`evolution-state ${preflight?.allowRun ? "is-pass" : failedChecks.length > 0 ? "is-fail" : "is-pending"}`}
            >
              {preflightState}
            </span>
          </div>

          <details className="advanced-details evolution-run-settings">
            <summary>
              <span>
                <strong>高级运行设置</strong>
                <small>运行依赖、模型连接和测试样本位置；普通用户通常不需要填</small>
              </span>
              <span className="advanced-toggle">展开</span>
            </summary>
            <div className="advanced-details-body">
              <div className="evolution-form-grid">
                <label>
                  <span>运行依赖（高级）</span>
                  <input
                    value={dependencies}
                    onChange={(event) => setDependencies(event.target.value)}
                  />
                </label>
                <label>
                  <span>模型连接地址</span>
                  <input
                    type="url"
                    placeholder="例如：https://你的模型地址/v1"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </label>
                <label>
                  <span>测试样本数量</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={holdoutCount}
                    onChange={(event) => setHoldoutCount(event.target.value)}
                  />
                </label>
                <label>
                  <span>管家实例（可选）</span>
                  <input
                    placeholder="留空自动选择正在运行的实例"
                    value={instanceId}
                    onChange={(event) => setInstanceId(event.target.value)}
                  />
                </label>
                <label className="is-wide">
                  <span>测试样本位置（可选）</span>
                  <input
                    placeholder="例如：/home/你的账户/hermes/eval/test.jsonl"
                    value={datasetPath}
                    onChange={(event) => setDatasetPath(event.target.value)}
                  />
                </label>
              </div>
            </div>
          </details>

          <ol className="evolution-checks">
            {checks.map((check, index) => (
              <li
                className={checkTone(check.status)}
                key={check.id}
                style={{ animationDelay: `${index * 55}ms` }}
              >
                <span className="evolution-check-dot" aria-hidden="true" />
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                  {check.action !== undefined && <em>{check.action}</em>}
                </div>
                <span className="evolution-check-status">
                  {check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "待检"}
                </span>
              </li>
            ))}
          </ol>

          <div className="evolution-primary-action">
            <button
              type="button"
              onClick={() => void runPreflight()}
              disabled={busy !== null || data?.watchReachable === false}
            >
              {busy === "preflight" ? "正在检查…" : "开始检查"}
            </button>
            <span>全部通过后管家会先备份，再允许外部改进。</span>
          </div>

          {preflight !== null && !preflight.allowRun && (
            <div className="evolution-decision is-rejected">
              <div className="evolution-decision-label">拒绝运行</div>
              <h3>{failedChecks[0]?.detail ?? "检查未通过"}</h3>
              <p>{failedChecks[0]?.action ?? "按提示处理好后重新检查。"}</p>
              {preflight.nextAction?.kind === "expand-dataset" && (
                <div className="evolution-expander">
                  <label>
                    <span>没有数据集路径时，粘贴 JSON 数组或 JSONL 种子样本</span>
                    <textarea
                      rows={4}
                      placeholder={'{"prompt":"示例问题","expected":"期望答案"}'}
                      value={seedExamples}
                      onChange={(event) => setSeedExamples(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void expandDataset()}
                    disabled={busy !== null || !canExpand}
                  >
                    {busy === "expand"
                      ? "补齐并重新检查…"
                      : `补齐到 ${preflight.nextAction.targetCount} 条并重检`}
                  </button>
                </div>
              )}
            </div>
          )}

          {preflight?.allowRun === true && (
            <div className="evolution-decision is-ready">
              <div className="evolution-decision-label">检查通过，可以开始改进</div>
              <h3>已做好备份；改进结果确认后才会采用</h3>
              <p>管家已准备好运行环境。改进完成后，在右侧提交结果确认；确认更好才会写入。</p>
            </div>
          )}
        </section>

        <section className="evolution-column evolution-ledger">
          <div className="evolution-section-head">
            <div>
              <span className="evolution-kicker">运行后</span>
              <h2>改进记录</h2>
            </div>
            <button type="button" className="evolution-refresh" onClick={() => void refresh()}>
              刷新
            </button>
          </div>

          <Steps
            size="small"
            current={evaluation === null ? (preflight?.allowRun === true ? 2 : 1) : 4}
            items={[
              { title: "基线" },
              { title: "预检" },
              { title: "外部评估" },
              { title: "安全门禁" },
              { title: "结论" },
            ]}
          />

          {preflight?.allowRun === true && evaluation === null && (
            <Alert
              type="info"
              showIcon
              message="可以开始真实评估"
              description="管家会调用已配置的外部评估器，自动返回样本数、baseline/candidate 指标、置信度和是否允许提升。"
              action={<Button type="primary" loading={busy === "evaluate"} onClick={() => void evaluateExternally()}>开始真实评估</Button>}
            />
          )}

          {evaluation !== null && (
            <Alert
              type={evaluation.status === "accepted" ? "success" : evaluation.status === "rejected-regression" ? "error" : "warning"}
              showIcon
              message={statusLabel(evaluation.status)}
              description={`样本 ${evaluation.sampleCount} 条 · ${evaluation.baselineMetric.toFixed(3)} → ${evaluation.candidateMetric.toFixed(3)} · 变化 ${(evaluation.candidateMetric - evaluation.baselineMetric).toFixed(3)}${evaluation.confidence === null ? "" : ` · 置信度 ${(evaluation.confidence * 100).toFixed(1)}%`}`}
              action={<Tag color={evaluation.canPromote ? "green" : "default"}>{evaluation.canPromote ? "可申请提升" : "保留当前版本"}</Tag>}
            />
          )}

          {gateReady && (
            <details className="advanced-details evolution-gate-settings">
              <summary>
                <span>
                    <strong>兼容：手动提交外部评估结果</strong>
                    <small>优先使用上方“开始真实评估”；此处仅兼容尚未接入标准响应格式的旧评估器</small>
                </span>
                <span className="advanced-toggle">展开</span>
              </summary>
              <div className="advanced-details-body">
                <div className="evolution-gate-form">
                  <div className="evolution-gate-title">
                    <strong>填写评估结果</strong>
                    <span>管家会保存你提交的结论，不会擅自判断好坏。</span>
                  </div>
                  <div className="evolution-metric-grid">
                    <label>
                      <span>当前版本表现</span>
                      <input
                        type="number"
                        step="any"
                        value={baselineMetric}
                        onChange={(event) => setBaselineMetric(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>改进后表现</span>
                      <input
                        type="number"
                        step="any"
                        value={candidateMetric}
                        onChange={(event) => setCandidateMetric(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="evolution-checkbox">
                    <input
                      type="checkbox"
                      checked={significant}
                      onChange={(event) => setSignificant(event.target.checked)}
                    />
                    我确认改进后确实更好
                  </label>
                  <label>
                    <span>为什么有变化（可选）</span>
                    <textarea
                      rows={2}
                      value={rootCause}
                      onChange={(event) => setRootCause(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>做了哪些修复（可选）</span>
                    <textarea
                      rows={2}
                      value={fixes}
                      onChange={(event) => setFixes(event.target.value)}
                    />
                  </label>
                  <button type="button" onClick={() => void submitGate()} disabled={busy !== null}>
                    {busy === "gate" ? "正在确认…" : "确认结果"}
                  </button>
                </div>
              </div>
            </details>
          )}

          {gate !== null && (
            <div className="evolution-gate-result is-blocked">
              <span>{gate.status === "accepted" ? "仅记录通过" : "暂不采用"}</span>
              <strong>
                {statusLabel(gate.status)}
                {gate.delta !== null
                  ? ` · 变化 ${gate.delta >= 0 ? "+" : ""}${gate.delta.toFixed(6)}`
                  : ""}
              </strong>
              <p>
                当前版本已保留。手填指标不会授权写入，正式采用需通过服务端受信提升入口。
              </p>
            </div>
          )}

          <details className="advanced-details evolution-records-details">
            <summary>
              <span>
                <strong>查看历史记录</strong>
                <small>每次检查、评估和结果的完整记录</small>
              </span>
              <span className="advanced-toggle">展开</span>
            </summary>
            <div className="advanced-details-body">
              <div className="evolution-ledger-table">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>评估</th>
                      <th>结论</th>
                      <th>结果</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.ledger ?? []).map((entry) => (
                      <tr key={entry.runId}>
                        <td>
                          <strong>{entry.runId.slice(0, 8)}</strong>
                          <span>{formatTime(entry.updatedAt)}</span>
                        </td>
                        <td className="is-mono">{formatMetric(entry)}</td>
                        <td>
                          <span className={`evolution-ledger-status is-${entry.status}`}>
                            {statusLabel(entry.status)}
                          </span>
                        </td>
                        <td>{dispositionLabel(entry.disposition)}</td>
                        <td>
                          <a
                            href={`/api/evolution/ledger/${encodeURIComponent(entry.runId)}/export`}
                            download
                          >
                            导出
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(data?.ledger.length ?? 0) === 0 && (
                  <div className="evolution-empty">
                    还没有改进记录；完成一次检查和评估后，这里会生成可导出的记录。
                  </div>
                )}
              </div>

              <div className="evolution-scope-note">
                <span>目前能做到</span>
                <p>
                  当前会先检查运行依赖、模型连接和测试样本，再备份并确认改进结果。运行中挂死监测、
                  兼容性检查、模型档案和统计检验还没有完成，不会伪装成已支持。
                </p>
              </div>
            </div>
          </details>
        </section>
      </div>
    </section>
  );
}
