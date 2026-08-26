/**
 * 消息优化面板：口语消息改写对照历史、规则文件改进记录与候选版本采用。
 * 从 components/ 迁入 gateway 子目录；轮询改走 usePolling（后台自动暂停）。
 */
import { useCallback, useEffect, useState } from "react";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { fetchJson, postJson } from "../../lib/api.js";
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

export function PromptOptimizationPanel() {
  const [data, setData] = useState<PromptPayload | null>(null);
  const [candidates, setCandidates] = useState<PromptCandidatePayload | null>(null);
  const [history, setHistory] = useState<OptimizationHistoryPayload | null>(null);
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
    const payload = await fetchJson<OptimizationHistoryPayload>(
      "/api/messages/optimization-history?limit=50",
    );
    if (payload !== null) setHistory(payload);
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
  const todayItems = (history?.items ?? []).filter((item) => isSameDay(item.inbound.receivedAt, now));
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
            reachable={history === null ? null : history.reachable}
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

      {history === null && (
        <div className="prompt-empty">正在读取优化记录…</div>
      )}

      {history !== null && !history.reachable && (
        <div className="prompt-empty">
          暂时连不上消息服务，等管家恢复后这里会自动显示对照记录。
        </div>
      )}

      {history !== null && history.reachable && history.items.length === 0 && (
        <div className="prompt-empty">
          还没有消息记录。现在去给 AI 发一条消息，这里就会显示“你发的原文”和“优化后的指令”对照。
        </div>
      )}

      {history !== null && history.reachable && history.items.length > 0 && (
        <div className="po-history">
          {history.items.map((item) => {
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
            <table className="prompt-table">
              <thead>
                <tr>
                  <th>规则内容</th>
                  <th>用于哪个 AI</th>
                  <th>保存格式</th>
                  <th>不能改动的部分</th>
                  <th>当前状态</th>
                  <th>检查结果</th>
                </tr>
              </thead>
              <tbody>
                {data.targets.map((target) => (
                  <tr key={target.targetId}>
                    <td>
                      <strong title={target.sourcePath}>{promptTargetLabel(target.targetId)}</strong>
                    </td>
                    <td>
                      {target.instanceId === "hermes-main"
                        ? "Hermes 主实例"
                        : target.instanceId || "—"}
                    </td>
                    <td>{promptFormatLabel(target.format)}</td>
                    <td>{target.protectedClauseCount} 项</td>
                    <td>
                      <code title={target.activeVersion}>
                        {target.activeVersion === "baseline" ? "当前版本" : "试用版本"}
                      </code>
                    </td>
                    <td>
                      <span className={`prompt-gate ${gateTone(target.gate.status)}`}>
                        {gateLabel(target.gate.status)}
                      </span>
                      <small title={target.gate.detail}>{target.gate.detail}</small>
                      <em>{formatTime(target.gate.checkedAt)}</em>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <table className="prompt-table">
              <thead>
                <tr>
                  <th>改进版本</th>
                  <th>谁提供的</th>
                  <th>当前状态</th>
                  <th>测试结果</th>
                  <th>采用</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {candidates.candidates.map((candidate) => (
                  <tr key={candidate.candidateId}>
                    <td>
                      <strong>{candidate.description || "改进版本"}</strong>
                    </td>
                    <td>{candidate.source === "generator" ? "自动改进" : "我提供的"}</td>
                    <td>
                      <span className={"prompt-gate " + candidateTone(candidate.status)}>
                        {candidateLabel(candidate.status)}
                      </span>
                      {candidate.gateErrors.length > 0 && (
                        <small title={candidate.gateErrors.join("；")}>
                          {candidate.gateErrors[0]}
                        </small>
                      )}
                    </td>
                    <td>
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
                    </td>
                    <td>
                      {candidate.status === "approval-pending" &&
                      candidate.latestEvaluation?.canPromote ? (
                        <button
                          className="prompt-promote-button"
                          type="button"
                          disabled={promotingCandidateId !== null}
                          onClick={() => void promoteCandidate(candidate)}
                        >
                          {promotingCandidateId === candidate.candidateId
                            ? "正在采用"
                            : "采用此版本"}
                        </button>
                      ) : candidate.status === "promoted" ? (
                        "当前使用"
                      ) : (
                        "不可采用"
                      )}
                    </td>
                    <td>{formatTime(candidate.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdvancedDetails>
    </section>
  );
}
