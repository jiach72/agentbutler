/**
 * 消息优化面板：口语消息改写对照历史、规则文件改进记录与候选版本采用。
 * 从 components/ 迁入 gateway 子目录；轮询改走 usePolling（后台自动暂停）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Table } from "antd";
import type { TableColumnsType } from "antd";
import { TrendCard, ChartEmpty, TrendColumn } from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { fetchJson, loadJson, postJson, type FetchState } from "../../lib/api.js";
import { formatTime } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";

interface PromptGate {
  status:
    "ok" | "missing" | "hash-mismatch" | "protected-clause-mismatch" | "unknown-target" | string;
  detail: string;
  checkedAt: string;
}

interface PromptTarget {
  targetId: string;
  instanceId: string;
  frameworkId: string;
  sourcePath: string;
  format: string;
  editableSections: string[];
  protectedClauseCount: number;
  protectedSha256: string;
  reloadMode: string;
  activeVersion: string;
  activeSha256: string;
  createdAt: string;
  updatedAt: string;
  gate: PromptGate;
}

interface PromptPayload {
  watchReachable: boolean;
  targets: PromptTarget[];
}

interface PromptEvaluationSummary {
  evaluationId: string;
  status: string;
  tier: string;
  holdoutCount: number;
  canPromote: boolean;
  confidence: unknown;
  createdAt: string;
}

interface PromptCandidate {
  candidateId: string;
  targetId: string;
  contentSha256: string;
  baseSha256: string;
  snapshotPath: string;
  source: "manual" | "generator" | string;
  description: string;
  status: string;
  gateErrors: string[];
  createdAt: string;
  updatedAt: string;
  latestEvaluation: PromptEvaluationSummary | null;
}

interface PromptCandidatePayload {
  watchReachable: boolean;
  candidates: PromptCandidate[];
}

type OptimizeMode = "pass-through" | "quick" | "rule" | "llm";

interface InboundDecisionView {
  inboundMessageId: string;
  action: string;
  optimizedText: string;
  transformTrace: string[];
  mode?: OptimizeMode;
  changes?: string[];
}

interface InboundHistoryEntry {
  inboundMessageId: string;
  inbound: {
    inboundMessageId: string;
    instanceId: string;
    adapterId: string;
    channel: string;
    chatId: string;
    threadId?: string | null;
    userId?: string | null;
    sessionId?: string | null;
    runId?: string | null;
    content: string;
    receivedAt: string;
  };
  decision: InboundDecisionView | null;
  decidedAt: string | null;
}

interface OptimizationHistoryPayload {
  reachable: boolean;
  items: InboundHistoryEntry[];
}

function promptTargetLabel(targetId: string): string {
  const labels: Record<string, string> = {
    "hermes-soul": "人设与性格",
    "hermes-prompt-builder": "AI 的说话方式",
    "hermes-system-prompt": "系统提示",
    "hermes-tool-guardrails": "使用工具的安全规则",
  };
  return labels[targetId] ?? targetId;
}

function promptFormatLabel(format: string): string {
  if (format === "markdown") return "Markdown";
  if (format === "plain") return "纯文本";
  return format || "—";
}

function gateTone(status: string): string {
  if (status === "ok") return "is-ok";
  if (
    status === "missing" ||
    status === "hash-mismatch" ||
    status === "protected-clause-mismatch"
  ) {
    return "is-fail";
  }
  return "is-pending";
}

function gateLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: "通过",
    missing: "规则文件缺失",
    "hash-mismatch": "文件被改过",
    "protected-clause-mismatch": "必须保留的内容被改过",
    "unknown-target": "未登记",
  };
  return labels[status] ?? "需检查";
}

function candidateTone(status: string): string {
  if (status === "approval-pending" || status === "pending-evaluation") return "is-pending";
  if (status === "rejected-static" || status === "rejected-quality") return "is-fail";
  return "is-ok";
}

function candidateLabel(status: string): string {
  const labels: Record<string, string> = {
    "pending-evaluation": "等待测试",
    "approval-pending": "等待确认",
    "rejected-static": "检查未通过",
    "rejected-quality": "测试未通过",
    "kept-baseline": "保留当前版本",
    promoted: "已正式采用",
  };
  return labels[status] ?? "待确认";
}

function evaluationLabel(latest: PromptEvaluationSummary | null): string {
  if (latest === null) return "还没测试";
  const tier: Record<string, string> = {
    insufficient: "测试样本不足",
    exploratory: "初步测试",
    formal: "正式测试",
  };
  return (tier[latest.tier] ?? latest.tier) + " · " + latest.holdoutCount + " 条";
}

function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    weixin: "微信",
    "api-server": "接口",
    a2a: "智能体对接",
  };
  return labels[channel] ?? channel;
}

function missingDecisionLabel(item: InboundHistoryEntry, now: Date): string {
  if (item.inbound.channel === "api-server") return "接口消息，不优化";
  const received = new Date(item.inbound.receivedAt);
  if (Number.isNaN(received.getTime()) || now.getTime() - received.getTime() > 5 * 60_000) {
    return "没有优化记录";
  }
  return "正在处理";
}

function modeLabel(
  mode: OptimizeMode | undefined,
  hasDecision: boolean,
  pendingText: string,
): string {
  if (!hasDecision) return pendingText;
  if (mode === "quick") return "快捷指令";
  if (mode === "rule") return "已改写";
  if (mode === "llm") return "AI 改写";
  return "原样发送";
}

function modeTone(
  mode: OptimizeMode | undefined,
  hasDecision: boolean,
  pendingText: string,
): string {
  if (!hasDecision) return pendingText === "正在处理" ? "is-pending" : "is-muted";
  if (mode === "quick" || mode === "rule" || mode === "llm") return "is-ok";
  return "is-muted";
}

function isSameDay(value: string | null, now: Date): boolean {
  if (value === null) return false;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return false;
  return (
    time.getFullYear() === now.getFullYear() &&
    time.getMonth() === now.getMonth() &&
    time.getDate() === now.getDate()
  );
}

/* ---- 30 天趋势聚合 ---- */

const OPT_BUCKETS = ["AI 改写", "快捷指令", "原样发送"] as const;

const DAY_MS = 86_400_000;
function dayLabel(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function optimizationBucket(mode: OptimizeMode | undefined): (typeof OPT_BUCKETS)[number] {
  if (mode === "quick") return "快捷指令";
  if (mode === undefined || mode === "pass-through") return "原样发送";
  return "AI 改写";
}

interface TrendRow {
  date: string;
  bucket: string;
  count: number;
}

function buildOptimizationTrend(items: InboundHistoryEntry[], days = 30) {
  const counts = new Map<string, Map<string, number>>();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    counts.set(dayLabel(new Date(now.getTime() - i * DAY_MS)), new Map());
  }
  let total = 0;
  for (const item of items) {
    if (item.decision === null) continue;
    const at = new Date(item.inbound.receivedAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayLabel(at);
    const perDay = counts.get(key);
    if (perDay === undefined) continue;
    const bucket = optimizationBucket(item.decision.mode);
    perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1);
    total += 1;
  }
  const rows: TrendRow[] = [];
  for (const [date, perDay] of counts) {
    for (const bucket of OPT_BUCKETS) {
      rows.push({ date, bucket, count: perDay.get(bucket) ?? 0 });
    }
  }
  const rewritten = items.filter(
    (item) => item.decision !== null && item.decision.mode !== "pass-through",
  ).length;
  const rewrittenShare = total === 0 ? 0 : Math.round((rewritten / total) * 100);
  return {
    rows,
    hasData: total > 0,
    summary: `近 ${days} 天处理 ${total} 条 · 改写占比 ${rewrittenShare}%`,
  };
}

export function PromptOptimizationPanel() {
  const [data, setData] = useState<PromptPayload | null>(null);
  const [candidates, setCandidates] = useState<PromptCandidatePayload | null>(null);
  const [history, setHistory] = useState<FetchState<OptimizationHistoryPayload>>({ status: "loading" });
  const [promotingCandidateId, setPromotingCandidateId] = useState<string | null>(null);
  const [promotionNotice, setPromotionNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const payload = await fetchJson<PromptPayload>("/api/prompt-optimization");
    if (payload !== null) setData(payload);
  }, []);

  const refreshCandidates = useCallback(async () => {
    const payload = await fetchJson<PromptCandidatePayload>("/api/prompt-optimization/candidates");
    if (payload !== null) setCandidates(payload);
  }, []);

  const refreshHistory = useCallback(async () => {
    const payload = await loadJson<OptimizationHistoryPayload>(
      "/api/messages/optimization-history?limit=300",
    );
    setHistory(payload.ok ? { status: "ready", data: payload.data } : { status: "failed", reason: payload.reason });
  }, []);

  const promoteCandidate = useCallback(
    async (candidate: PromptCandidate) => {
      const evaluationId = candidate.latestEvaluation?.evaluationId;
      if (evaluationId === undefined || !candidate.latestEvaluation?.canPromote) return;
      setPromotingCandidateId(candidate.candidateId);
      setPromotionNotice(null);
      const result = await postJson(
        `/api/prompt-optimization/candidates/${encodeURIComponent(candidate.candidateId)}/promote`,
        { evaluationId, confirmed: true },
        15_000,
      );
      if (result.ok) {
        setPromotionNotice("已采用该版本，新的规则会按目标的重载方式生效。");
        await Promise.all([refresh(), refreshCandidates()]);
      } else {
        const detail =
          result.data !== null &&
          typeof result.data === "object" &&
          "detail" in result.data &&
          typeof result.data.detail === "string"
            ? result.data.detail
            : "采用失败，请刷新后检查最新评估与源文件状态。";
        setPromotionNotice(detail);
      }
      setPromotingCandidateId(null);
    },
    [refresh, refreshCandidates],
  );

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshCandidates();
    void refreshHistory();
  }, [refresh, refreshCandidates, refreshHistory]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  usePolling(refreshAll, 10_000);

  const now = new Date();
  const { mode } = useTheme();
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const historyData = history.status === "ready" ? history.data : null;
  const trend = useMemo(() => buildOptimizationTrend(historyData?.items ?? []), [historyData]);
  const trendSeries = useMemo(
    () =>
      semanticSeries(mode, [
        ["AI 改写", "AI 改写", "accent"],
        ["快捷指令", "快捷指令", "teal"],
        ["原样发送", "原样发送", "ok"],
      ]),
    [mode],
  );
  const trendColors = useMemo(() => trendSeries.map((s) => s.color), [trendSeries]);
  const todayItems = (historyData?.items ?? []).filter((item) =>
    isSameDay(item.inbound.receivedAt, now),
  );
  const todayRewritten = todayItems.filter(
    (item) => item.decision !== null && item.decision.mode !== "pass-through",
  ).length;
  const todayQuick = todayItems.filter((item) => item.decision?.mode === "quick").length;
  const todayPassed = todayItems.filter(
    (item) => item.decision !== null && item.decision.mode === "pass-through",
  ).length;
  const pendingCount = todayItems.filter(
    (item) => item.decision === null && missingDecisionLabel(item, now) === "正在处理",
  ).length;

  return (
    <section className="prompt-panel">
      <div className="prompt-panel-head">
        <div>
          <span className="evolution-kicker">消息优化</span>
          <h2>消息优化</h2>
          <p>
            你发来的口语消息，管家会先整理成更明确的指令再交给 AI；每条消息都会留下对照记录，方便你看到改了什么。
          </p>
        </div>
        <span className="evolution-connection">
          <ConnectionChip
            reachable={history.status === "loading" ? null : history.status === "ready" ? history.data.reachable : false}
            connectingText="正在连接管家"
            onlineText="管家服务已连接"
            offlineText="管家服务暂时连不上"
          />
        </span>
      </div>

      <div className="po-stats" aria-label="今日消息优化统计">
        <div className="po-stat">
          <strong>{todayRewritten}</strong>
          <span>今天改写</span>
        </div>
        <div className="po-stat">
          <strong>{todayQuick}</strong>
          <span>快捷指令</span>
        </div>
        <div className="po-stat">
          <strong>{todayPassed}</strong>
          <span>原样发送</span>
        </div>
        <div className="po-stat">
          <strong>{pendingCount}</strong>
          <span>处理中</span>
        </div>
      </div>

      {history.status === "failed" ? (
        <ChartEmpty hint={`消息优化趋势接口不可用：${history.reason}`} />
      ) : trend.hasData ? (
        <TrendCard title="消息优化趋势" summary={trend.summary}>
          <TrendColumn
            data={trend.rows}
            xField="date"
            yField="count"
            colorField="bucket"
            transform={[{ type: "stackY" }]}
            theme={chartTheme.g2Theme}
            autoFit
            height={220}
            scale={{ color: { range: trendColors } }}
            axis={quietAxes(chartTheme)}
            legend={topLegend(chartTheme)}
            style={{ maxWidth: 22, radiusTopLeft: 3, radiusTopRight: 3 }}
          />
        </TrendCard>
      ) : (
        <ChartEmpty hint="还没有优化记录；管家处理消息后，这里会出现近 30 天的处理趋势。" />
      )}

      <div className="po-note">
        管家会先按规则整理口语消息；规则拿不准时会请 AI 帮忙改写，失败或结果不可用时仍会原样发送，不会卡住或漏掉你的消息。
      </div>

      <div className="prompt-subhead">
        <div>
          <span className="evolution-kicker">对照历史</span>
          <h3>你发的消息和优化后的指令</h3>
        </div>
        <span className="po-retention">保留最近 30 天</span>
      </div>

      {history.status === "loading" && (
        <div className="prompt-empty">正在读取优化记录…</div>
      )}

      {history.status === "failed" && (
        <div className="prompt-empty">优化记录读取失败：{history.reason}</div>
      )}

      {history.status === "ready" && !history.data.reachable && (
        <div className="prompt-empty">
          暂时连不上消息服务，等管家恢复后这里会自动显示对照记录。
        </div>
      )}

      {history.status === "ready" && history.data.reachable && history.data.items.length === 0 && (
        <div className="prompt-empty">
          还没有消息记录。现在去给 AI 发一条消息，这里就会显示“你发的原文”和“优化后的指令”对照。
        </div>
      )}

      {history.status === "ready" && history.data.reachable && history.data.items.length > 0 && (
        <div className="po-history">
          {history.data.items.map((item) => {
            const hasDecision = item.decision !== null;
            const mode = item.decision?.mode;
            const pendingText = missingDecisionLabel(item, now);
            const original = item.inbound.content;
            const optimized = item.decision?.optimizedText ?? original;
            const changed = hasDecision && optimized !== original;
            return (
              <article className="po-card" key={item.inboundMessageId}>
                <div className="po-meta">
                  <span className="po-channel">{channelLabel(item.inbound.channel)}</span>
                  <span className="po-time">{formatTime(item.inbound.receivedAt)}</span>
                  <span className={"po-badge " + modeTone(mode, hasDecision, pendingText)}>
                    {modeLabel(mode, hasDecision, pendingText)}
                  </span>
                  {!hasDecision && pendingText === "正在处理" && (
                    <span className="po-pending-hint">对照结果稍后自动出现</span>
                  )}
                </div>
                <div className="po-compare">
                  <div className="po-col po-original">
                    <span className="po-col-label">你发的原文</span>
                    <p>{original || "（图片或语音消息，没有文字）"}</p>
                  </div>
                  <div className="po-arrow" aria-hidden="true">
                    →
                  </div>
                  <div className={"po-col po-optimized" + (changed ? " is-changed" : "")}>
                    <span className="po-col-label">优化后的指令</span>
                    <p>{optimized || "（无文字内容）"}</p>
                    {!changed && hasDecision && (
                      <span className="po-unchanged">没有改动，原样发送</span>
                    )}
                  </div>
                </div>
                {hasDecision && (item.decision?.changes?.length ?? 0) > 0 && (
                  <div className="po-changes">
                    <span className="po-changes-label">改动要点</span>
                    {(item.decision?.changes ?? []).map((change) => (
                      <span className="po-chip" key={change}>
                        {change}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <AdvancedDetails
        summary={
          <>
            <strong>高级：规则文件改进记录</strong>
            <small>管家提示词文件的当前版本、检查结果和经过正式评估的改进</small>
          </>
        }
      >
        {data !== null && data.targets.length === 0 && (
          <div className="prompt-empty">
            还没有找到可查看的规则；等 AI 配置好规则后，这里会显示真实内容。
          </div>
        )}

        {data !== null && data.targets.length > 0 && (
          <div className="prompt-table-wrap">
            <Table<PromptTarget>
              size="small"
              rowKey="targetId"
              dataSource={data.targets}
              pagination={false}
              columns={
                [
                  {
                    title: "规则内容",
                    ellipsis: true,
                    render: (_, target) => (
                      <strong title={target.sourcePath}>
                        {promptTargetLabel(target.targetId)}
                      </strong>
                    ),
                  },
                  {
                    title: "用于哪个 AI",
                    width: 130,
                    render: (_, target) =>
                      target.instanceId === "hermes-main"
                        ? "Hermes 主实例"
                        : target.instanceId || "—",
                  },
                  {
                    title: "保存格式",
                    width: 90,
                    render: (_, target) => promptFormatLabel(target.format),
                  },
                  {
                    title: "不能改动的部分",
                    width: 120,
                    render: (_, target) => `${target.protectedClauseCount} 项`,
                  },
                  {
                    title: "当前状态",
                    width: 100,
                    render: (_, target) => (
                      <code title={target.activeVersion}>
                        {target.activeVersion === "baseline" ? "当前版本" : "试用版本"}
                      </code>
                    ),
                  },
                  {
                    title: "检查结果",
                    width: 220,
                    render: (_, target) => (
                      <div className="po-eval-cell">
                        <span className={`prompt-gate ${gateTone(target.gate.status)}`}>
                          {gateLabel(target.gate.status)}
                        </span>
                        <small title={target.gate.detail}>{target.gate.detail}</small>
                        <em>{formatTime(target.gate.checkedAt)}</em>
                      </div>
                    ),
                  },
                ] satisfies TableColumnsType<PromptTarget>
              }
            />
          </div>
        )}

        {data !== null && data.targets.length > 0 && (
          <div className="prompt-panel-note">
            <span>现在能做什么</span>
            <p>
              只有通过正式样本、受信评估和保护段复验的版本才会显示采用按钮；采用动作会再次核对源文件并留下审计记录。
            </p>
          </div>
        )}

        {promotionNotice !== null && (
          <div className="prompt-promotion-notice" role="status" aria-live="polite">
            {promotionNotice}
          </div>
        )}

        {candidates !== null && candidates.candidates.length === 0 && (
          <div className="prompt-empty">
            还没有试过新的规则版本；现在只能查看，不能创建或替换。
          </div>
        )}

        {candidates !== null && candidates.candidates.length > 0 && (
          <div className="prompt-table-wrap prompt-table-spaced">
            <Table<PromptCandidate>
              size="small"
              rowKey="candidateId"
              dataSource={candidates.candidates}
              pagination={false}
              columns={
                [
                  {
                    title: "改进版本",
                    dataIndex: "description",
                    ellipsis: true,
                    render: (_, candidate) => (
                      <strong>{candidate.description || "改进版本"}</strong>
                    ),
                  },
                  {
                    title: "谁提供的",
                    width: 110,
                    render: (_, candidate) =>
                      candidate.source === "generator" ? "自动改进" : "我提供的",
                  },
                  {
                    title: "当前状态",
                    width: 150,
                    render: (_, candidate) => (
                      <>
                        <span className={"prompt-gate " + candidateTone(candidate.status)}>
                          {candidateLabel(candidate.status)}
                        </span>
                        {candidate.gateErrors.length > 0 && (
                          <small title={candidate.gateErrors.join("；")}>
                            {candidate.gateErrors[0]}
                          </small>
                        )}
                      </>
                    ),
                  },
                  {
                    title: "测试结果",
                    width: 200,
                    render: (_, candidate) => (
                      <div className="po-eval-cell">
                        <strong>{evaluationLabel(candidate.latestEvaluation)}</strong>
                        <span>
                          {candidate.latestEvaluation === null
                            ? "等待测试"
                            : candidate.latestEvaluation.canPromote
                              ? "可以正式采用"
                              : candidate.latestEvaluation.tier === "exploratory"
                                ? "还在初步测试，不能当最终结论"
                                : "暂不建议采用"}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: "采用",
                    width: 120,
                    render: (_, candidate) => {
                      if (candidate.status === "approval-pending" && candidate.latestEvaluation?.canPromote) {
                        return (
                          <Button
                            type="primary"
                            size="small"
                            disabled={promotingCandidateId !== null}
                            loading={promotingCandidateId === candidate.candidateId}
                            onClick={() => void promoteCandidate(candidate)}
                          >
                            采用此版本
                          </Button>
                        );
                      }
                      return candidate.status === "promoted" ? "当前使用" : "不可采用";
                    },
                  },
                  {
                    title: "更新时间",
                    width: 130,
                    render: (_, candidate) => formatTime(candidate.updatedAt),
                  },
                ] satisfies TableColumnsType<PromptCandidate>
              }
            />
          </div>
        )}
      </AdvancedDetails>
    </section>
  );
}
