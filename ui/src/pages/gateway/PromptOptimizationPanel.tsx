/**
 * 消息整理面板：消息整理对照历史、规则文件改进记录与候选版本采用。
 * 从 components/ 迁入 gateway 子目录；轮询改走 usePolling（后台自动暂停）。
 * 已按 antd v6 设计语言重构：布局走 Flex/Row/Col/Card，状态统一 Badge，不依赖旧页面 CSS。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Flex,
  Form,
  Input,
  Pagination,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Modal,
} from "antd";
import { Empty } from "../../components/Empty.js";
import type { TableColumnsType } from "antd";
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UpOutlined,
} from "@ant-design/icons";
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
import { filterHistoryByDay, historyDayOptions, historySummaryLine } from "./helpers.js";

const { Paragraph, Text, Title } = Typography;

interface OllamaModelItem {
  name: string;
  size?: number;
}

interface OllamaTestChatResponse {
  ok: boolean;
  model: string;
  reply?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    tokensPerSecond: number;
  };
  error?: string;
}

interface PromptActivePayload {
  target: PromptTarget;
  active: {
    version: string;
    sourcePath: string;
    contentSha256: string;
    snapshotPath: string;
    kind: string;
    createdAt: string;
    content?: string;
  } | null;
  content?: string;
}


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

interface CandidateFormValues {
  targetId: string;
  description?: string;
  content: string;
}

interface EvaluationFormValues {
  cases: string;
}

interface PromptfooSuiteItem {
  suiteId: string;
  name: string;
  description: string;
  targetId: string;
  tier: "formal" | "exploratory";
  tests: Array<{
    id: string;
    description: string;
    vars: { input: string; [key: string]: string | undefined };
    assert: Array<{ type: string; value?: string | number }>;
  }>;
}

interface PromptfooAssertionResult {
  assertionType: string;
  expected?: string | number;
  passed: boolean;
  score: number;
  reason?: string;
}

interface PromptfooDetailItem {
  caseId: string;
  description: string;
  input: string;
  baselineOutput: string;
  candidateOutput: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
  baselinePassed: boolean;
  candidatePassed: boolean;
  safetyViolation: boolean;
  candidateAssertions: PromptfooAssertionResult[];
}

interface PromptfooEvaluationResponse {
  ok: boolean;
  report?: {
    evaluationId: string;
    candidateId: string;
    status: string;
    tier: string;
    holdoutCount: number;
    canPromote: boolean;
    confidence?: { z?: number; pValue?: number } | null;
    metrics: {
      baselineMean: number;
      candidateMean: number;
      deltaMean: number;
      deltaPp?: number | null;
      safetyViolationCount: number;
      canPromote: boolean;
      reasons?: string[];
    };
  };
  details?: PromptfooDetailItem[];
  suite?: {
    suiteId: string;
    name: string;
    tier: string;
    totalTests: number;
  };
  error?: string;
  detail?: string;
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

/** Badge 状态语义：成功 / 进行中 / 警示 / 失败 / 中性。 */
type ToneStatus = "success" | "processing" | "warning" | "error" | "default";

function promptTargetLabel(targetId: string): string {
  const labels: Record<string, string> = {
    "hermes-soul": "人设与性格",
    "hermes-prompt-builder": "消息表达方式",
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

function gateStatus(status: string): ToneStatus {
  if (status === "ok") return "success";
  // 手动修改/保护段改动是正常使用现象，不是错误——用警示黄而不是红。
  if (status === "hash-mismatch" || status === "protected-clause-mismatch") return "warning";
  if (status === "missing") return "error";
  return "default";
}

function gateLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: "与官方版本一致",
    missing: "目标文件缺失",
    "hash-mismatch": "文件有手动修改（正常）",
    "protected-clause-mismatch": "关键段有改动，自动采用已暂停",
    "unknown-target": "未登记",
  };
  return labels[status] ?? "需检查";
}

function candidateStatus(status: string): ToneStatus {
  if (status === "approval-pending" || status === "pending-evaluation") return "processing";
  // 未采用的候选是正常筛选结果，不是错误。
  if (status === "rejected-static" || status === "rejected-quality") return "default";
  return "success";
}

function candidateLabel(status: string): string {
  const labels: Record<string, string> = {
    "pending-evaluation": "测试中",
    "approval-pending": "等待确认",
    "rejected-static": "未采用（检查未通过）",
    "rejected-quality": "未采用（测试未通过）",
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
  if (item.inbound.channel === "api-server") return "接口消息，不整理";
  const received = new Date(item.inbound.receivedAt);
  if (Number.isNaN(received.getTime()) || now.getTime() - received.getTime() > 5 * 60_000) {
    return "没有整理记录";
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
  if (mode === "rule") return "规则整理";
  if (mode === "llm") return "自动整理";
  return "原样发送";
}

function modeStatus(
  mode: OptimizeMode | undefined,
  hasDecision: boolean,
  pendingText: string,
): ToneStatus {
  if (!hasDecision) return pendingText === "正在处理" ? "processing" : "default";
  if (mode === "quick" || mode === "rule" || mode === "llm") return "success";
  return "default";
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

const OPT_BUCKETS = ["自动整理", "快捷指令", "原样发送"] as const;

const DAY_MS = 86_400_000;
function dayLabel(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function optimizationBucket(mode: OptimizeMode | undefined): (typeof OPT_BUCKETS)[number] {
  if (mode === "quick") return "快捷指令";
  if (mode === undefined || mode === "pass-through") return "原样发送";
  return "自动整理";
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
    summary: `近 ${days} 天处理 ${total} 条 · 整理占比 ${rewrittenShare}%`,
  };
}

export function PromptOptimizationPanel() {
  const [data, setData] = useState<PromptPayload | null>(null);
  const [candidates, setCandidates] = useState<PromptCandidatePayload | null>(null);
  const [history, setHistory] = useState<FetchState<OptimizationHistoryPayload>>({ status: "loading" });
  const [promotingCandidateId, setPromotingCandidateId] = useState<string | null>(null);
  const [promotionNotice, setPromotionNotice] = useState<string | null>(null);
  const [historyDay, setHistoryDay] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [candidateModalOpen, setCandidateModalOpen] = useState(false);
  const [evaluationCandidate, setEvaluationCandidate] = useState<PromptCandidate | null>(null);
  const [candidateForm] = Form.useForm<CandidateFormValues>();
  const [evaluationForm] = Form.useForm<EvaluationFormValues>();
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelItem[]>([]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>("");
  const [aiOptimizing, setAiOptimizing] = useState(false);
  const [promptfooOptimizing, setPromptfooOptimizing] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("更加精炼亲切，强化指令遵循，适合微信沟通");
  const [aiMetrics, setAiMetrics] = useState<{
    durationMs: number;
    totalTokens: number;
    tokensPerSecond: number;
  } | null>(null);
  const [activeTargetContent, setActiveTargetContent] = useState<string>("");
  const [activeContentLoading, setActiveContentLoading] = useState(false);

  // Promptfoo 自动化门禁测试状态
  const [promptfooSuites, setPromptfooSuites] = useState<PromptfooSuiteItem[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("hermes-standard-30");
  const [evalModel, setEvalModel] = useState<string>("builtin");
  const [evaluatingWithPromptfoo, setEvaluatingWithPromptfoo] = useState(false);
  const [promptfooEvalResult, setPromptfooEvalResult] = useState<PromptfooEvaluationResponse | null>(null);
  const [evalActiveTab, setEvalActiveTab] = useState<string>("promptfoo");

  const loadPromptfooSuites = useCallback(async () => {
    const res = await fetchJson<{ suites: PromptfooSuiteItem[] }>(
      "/api/prompt-optimization/promptfoo/suites",
    );
    if (res?.suites && Array.isArray(res.suites) && res.suites.length > 0) {
      setPromptfooSuites(res.suites);
      setSelectedSuiteId((prev) => prev || res.suites[0]?.suiteId || "hermes-standard-30");
    }
  }, []);

  const loadActiveTargetContent = useCallback(async (targetId: string) => {
    if (!targetId) return;
    setActiveContentLoading(true);
    const res = await fetchJson<PromptActivePayload>(
      `/api/prompt-optimization/active/${encodeURIComponent(targetId)}`,
    );
    setActiveContentLoading(false);
    const content = res?.content ?? res?.active?.content ?? "";
    setActiveTargetContent(content);
    const current = candidateForm.getFieldValue("content");
    if (!current && content) {
      candidateForm.setFieldsValue({ content });
    }
  }, [candidateForm]);

  const loadOllamaModels = useCallback(async () => {
    const res = await fetchJson<{ ok: boolean; models: OllamaModelItem[] }>("/api/ollama/models");
    if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
      setOllamaModels(res.models);
      setSelectedOllamaModel((prev) => prev || res.models[0]?.name || "");
    }
  }, []);

  const runAiOptimization = useCallback(async () => {
    if (!selectedOllamaModel) {
      setPromotionNotice("请先选择用于优化的本地 Ollama 模型");
      return;
    }
    const currentPrompt = candidateForm.getFieldValue("content") || activeTargetContent;
    if (!currentPrompt.trim()) {
      setPromotionNotice("当前提示词内容为空，请先选择目标或输入提示词基础文本");
      return;
    }
    setAiOptimizing(true);
    setAiMetrics(null);
    const result = await postJson(
      "/api/ollama/test-chat",
      {
        model: selectedOllamaModel,
        system:
          "你是一个资深系统提示词（Prompt）工程专家。用户会提供待优化的系统提示词和具体优化方向。你的任务是在严格保留原有核心职责、系统约束、安全边界与保护段（如 <system>、[CRITICAL] 或特殊标记）的前提下，根据优化要求进行重构改写。直接输出优化后的完整提示词正文，严禁包含任何前言客套话、解释说明或外部 markdown 代码块包裹。",
        prompt: `【优化诉求】：\n${aiInstruction}\n\n【待优化的系统提示词】：\n${currentPrompt}`,
      },
      120_000,
    );
    setAiOptimizing(false);
    const data = result.data as OllamaTestChatResponse | null;
    if (result.ok && data?.ok && data.reply) {
      const optimizedReply = data.reply.trim();
      candidateForm.setFieldsValue({
        content: optimizedReply,
        description: `[${selectedOllamaModel}] ${aiInstruction.slice(0, 18)}`,
      });
      if (data.usage) {
        setAiMetrics({
          durationMs: data.usage.durationMs,
          totalTokens: data.usage.totalTokens,
          tokensPerSecond: data.usage.tokensPerSecond,
        });
      }
    } else {
      const errMsg =
        data?.error || "本地模型优化调用失败，请确认 Ollama 正在运行且已下载对应模型";
      setPromotionNotice(errMsg);
    }
  }, [selectedOllamaModel, candidateForm, activeTargetContent, aiInstruction]);

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
      "/api/messages/optimization-history?limit=100",
    );
    setHistory(payload.ok ? { status: "ready", data: payload.data } : { status: "failed", reason: payload.reason });
  }, []);

  const runPromptfooOptimization = useCallback(
    async (directCreate: boolean) => {
      const targetId = candidateForm.getFieldValue("targetId");
      if (!targetId) {
        setPromotionNotice("请先选择优化目标规则");
        return;
      }
      setPromptfooOptimizing(true);
      setPromotionNotice(null);
      const result = await postJson(
        "/api/prompt-optimization/promptfoo/optimize",
        {
          targetId,
          instruction: aiInstruction,
          model: selectedOllamaModel || undefined,
        },
        120_000,
      );
      setPromptfooOptimizing(false);

      if (
        result.ok &&
        result.data &&
        typeof result.data === "object" &&
        "ok" in result.data &&
        (result.data as { ok: boolean }).ok
      ) {
        const payload = result.data as {
          ok: boolean;
          candidate: PromptCandidate;
          changes: string[];
          preservedClauses: number;
        };
        if (directCreate) {
          setPromotionNotice(
            `Promptfoo 智能优化完成并自动创建候选！已保障 ${payload.preservedClauses} 处关键保护段。`,
          );
          setCandidateModalOpen(false);
          await refreshCandidates();
          setEvaluationCandidate(payload.candidate);
          setPromptfooEvalResult(null);
        } else {
          candidateForm.setFieldsValue({
            description: payload.candidate.description,
          });
          void loadActiveTargetContent(targetId);
          setPromotionNotice(
            `Promptfoo 优化已完成（保持 ${payload.preservedClauses} 处保护段），可在下方核对后提交。`,
          );
        }
      } else {
        const errDetail =
          result.data && typeof result.data === "object" && "detail" in result.data
            ? String((result.data as { detail: unknown }).detail)
            : result.data && typeof result.data === "object" && "error" in result.data
              ? String((result.data as { error: unknown }).error)
              : "Promptfoo 智能优化失败，请确认本地模型是否就绪。";
        setPromotionNotice(`优化失败：${errDetail}`);
      }
    },
    [candidateForm, aiInstruction, selectedOllamaModel, refreshCandidates, loadActiveTargetContent],
  );

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

  const createCandidate = useCallback(async (values: CandidateFormValues) => {
    const target = data?.targets.find((item) => item.targetId === values.targetId);
    if (target === undefined) return;
    setCandidateBusy(true);
    const result = await postJson(
      "/api/prompt-optimization/candidates",
      {
        targetId: values.targetId,
        content: values.content,
        baseSha256: target.activeSha256,
        source: "manual",
        description: values.description?.trim() || "手动候选",
      },
      15_000,
    );
    setCandidateBusy(false);
    if (!result.ok) {
      setPromotionNotice("候选没有创建成功，请检查内容、目标文件状态和保护段。" );
      return;
    }
    setCandidateModalOpen(false);
    candidateForm.resetFields();
    setPromotionNotice("候选已创建；请使用至少 10 条成对样本进行评估。" );
    await refreshCandidates();
  }, [candidateForm, data?.targets, refreshCandidates]);

  const runPromptfooEvaluation = useCallback(async () => {
    if (evaluationCandidate === null) return;
    setEvaluatingWithPromptfoo(true);
    setPromptfooEvalResult(null);
    setPromotionNotice(null);

    const result = await postJson(
      "/api/prompt-optimization/promptfoo/evaluate",
      {
        candidateId: evaluationCandidate.candidateId,
        suiteId: selectedSuiteId,
        model: evalModel === "builtin" ? undefined : evalModel,
      },
      120_000,
    );

    setEvaluatingWithPromptfoo(false);
    const data = result.data as PromptfooEvaluationResponse | null;
    if (result.ok && data?.ok) {
      setPromptfooEvalResult(data);
      await refreshCandidates();
      if (data.report?.canPromote) {
        setPromotionNotice("🎉 Promptfoo 门禁评测达标！已满足正式样本 (n>=30)、净胜率与零安全违规，现可直接采用。");
      } else {
        setPromotionNotice("评测已完成。测试结果未达到正式采用门禁，请查看断言明细。");
      }
    } else {
      const errMsg =
        data?.detail || data?.error || (typeof result.data === "string" ? result.data : "自动化评测执行失败");
      setPromotionNotice(`自动化评测执行失败：${errMsg}`);
    }
  }, [evaluationCandidate, selectedSuiteId, evalModel, refreshCandidates]);

  const evaluateCandidate = useCallback(async (values: EvaluationFormValues) => {
    if (evaluationCandidate === null) return;
    let cases: unknown;
    try {
      cases = JSON.parse(values.cases);
    } catch {
      setPromotionNotice("评估样本不是合法 JSON 数组。" );
      return;
    }
    if (!Array.isArray(cases)) {
      setPromotionNotice("评估样本必须是 JSON 数组。" );
      return;
    }
    setCandidateBusy(true);
    const result = await postJson(
      `/api/prompt-optimization/candidates/${encodeURIComponent(evaluationCandidate.candidateId)}/evaluate`,
      { cases },
      70_000,
    );
    setCandidateBusy(false);
    if (!result.ok) {
      setPromotionNotice("评估没有完成；请检查样本数量、字段和当前候选状态。" );
      return;
    }
    setEvaluationCandidate(null);
    evaluationForm.resetFields();
    setPromotionNotice("评估完成；只有正式样本、受信评估和安全门禁同时通过时才可采用。" );
    await refreshCandidates();
  }, [evaluationCandidate, evaluationForm, refreshCandidates]);

  const refreshAll = useCallback(() => {
    void refresh();
    void refreshCandidates();
    void refreshHistory();
    void loadPromptfooSuites();
  }, [refresh, refreshCandidates, refreshHistory, loadPromptfooSuites]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // 对照历史不是实时关键数据，降频轮询即可。
  usePolling(refreshAll, 60_000);

  const now = new Date();
  const { mode } = useTheme();
  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const historyData = history.status === "ready" ? history.data : null;
  const historyItems = historyData?.items ?? [];
  const historyPageSize = 8;
  const historyDays = useMemo(() => historyDayOptions(historyItems), [historyItems]);
  const filteredHistory = useMemo(
    () => filterHistoryByDay(historyItems, historyDay),
    [historyItems, historyDay],
  );
  const pagedHistory = useMemo(() => {
    const start = (historyPage - 1) * historyPageSize;
    return filteredHistory.slice(start, start + historyPageSize);
  }, [filteredHistory, historyPage]);
  const toggleHistoryExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const trend = useMemo(() => buildOptimizationTrend(historyData?.items ?? []), [historyData]);
  const trendSeries = useMemo(
    () =>
      semanticSeries(mode, [
        ["自动整理", "自动整理", "accent"],
        ["快捷指令", "快捷指令", "brand"],
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

  const todayStats = [
    { label: "今天整理", value: todayRewritten },
    { label: "快捷指令", value: todayQuick },
    { label: "原样发送", value: todayPassed },
    { label: "处理中", value: pendingCount },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex wrap justify="space-between" align="flex-start" gap={16}>
        <div style={{ minWidth: 0 }}>
          <Text
            type="secondary"
            style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            消息整理
          </Text>
          <Title level={4} component="h2" style={{ marginBottom: 0 }}>
            消息整理
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            你发来的消息会先按规则整理成更明确的内容；每条消息都会留下对照记录，方便查看具体改动。
          </Paragraph>
        </div>
        <div style={{ flexShrink: 0 }}>
          <ConnectionChip
            reachable={history.status === "loading" ? null : history.status === "ready" ? history.data.reachable : false}
            connectingText="正在连接管家"
            onlineText="管家服务已连接"
            offlineText="管家服务暂时连不上"
          />
        </div>
      </Flex>

      <Row gutter={[16, 16]} aria-label="今日消息整理统计">
        {todayStats.map((stat) => (
          <Col key={stat.label} xs={12} sm={6}>
            <Card size="small">
              <Statistic title={stat.label} value={stat.value} />
            </Card>
          </Col>
        ))}
      </Row>

      {history.status === "failed" ? (
        <ChartEmpty hint={`消息整理趋势接口不可用：${history.reason}`} />
      ) : trend.hasData ? (
        <TrendCard title="消息整理趋势" summary={trend.summary}>
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
        <ChartEmpty hint="还没有整理记录；处理消息后，这里会出现近 30 天的趋势。" />
      )}

      <Alert
        type="info"
        showIcon
        title="消息会先按规则整理；规则无法判断时会保留原文发送，避免因整理失败而中断或漏发。"
      />

      <Flex wrap justify="space-between" align="flex-end" gap={16}>
        <div>
          <Text
            type="secondary"
            style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            对照历史
          </Text>
          <Title level={5} component="h3" style={{ marginBottom: 0 }}>
            你发的消息和整理后的内容
          </Title>
        </div>
        <Text type="secondary">保留最近 30 天</Text>
      </Flex>

      {history.status === "loading" && (
        <Empty mascot={false} title="正在读取整理记录…" />
      )}

      {history.status === "failed" && (
        <Empty mascot={false} title={`整理记录读取失败：${history.reason}`} />
      )}

      {history.status === "ready" && !history.data.reachable && (
        <Empty
          mascot={false}
          title="暂时连不上消息服务，等管家恢复后这里会自动显示对照记录。"
        />
      )}

      {history.status === "ready" && history.data.reachable && history.data.items.length === 0 && (
        <Empty
          mascot={false}
          title="还没有消息记录。发送一条消息后，这里会显示“你发的原文”和“整理后的内容”对照。"
        />
      )}

      {history.status === "ready" && history.data.reachable && historyItems.length > 0 && (
        <Flex vertical gap={12}>
          <Flex wrap justify="space-between" align="center" gap={12}>
            <Select
              aria-label="按日期筛选对照历史"
              value={historyDay ?? "all"}
              onChange={(value) => {
                setHistoryDay(value === "all" ? null : value);
                setHistoryPage(1);
              }}
              options={[
                { value: "all", label: `全部日期（${historyItems.length} 条）` },
                ...historyDays.map((day) => ({ value: day.key, label: day.label })),
              ]}
              style={{ minWidth: 190 }}
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              默认收起，点击单条展开全文对照
            </Text>
          </Flex>

          {filteredHistory.length === 0 && (
            <Empty mascot={false} title="这一天没有消息记录。" />
          )}

          {pagedHistory.map((item) => {
            const hasDecision = item.decision !== null;
            const mode = item.decision?.mode;
            const pendingText = missingDecisionLabel(item, now);
            const original = item.inbound.content;
            const optimized = item.decision?.optimizedText ?? original;
            const changed = hasDecision && optimized !== original;
            const isExpanded = expandedIds.has(item.inboundMessageId);
            return (
              <Card size="small" key={item.inboundMessageId}>
                <Flex
                  vertical
                  gap={12}
                  onClick={() => toggleHistoryExpanded(item.inboundMessageId)}
                  style={{ cursor: "pointer" }}
                  role="button"
                  aria-expanded={isExpanded}
                >
                  <Flex wrap gap={8} align="center" justify="space-between">
                    <Flex wrap gap={8} align="center">
                      <Text strong>{channelLabel(item.inbound.channel)}</Text>
                      <Text type="secondary">{formatTime(item.inbound.receivedAt)}</Text>
                      <Badge
                        status={modeStatus(mode, hasDecision, pendingText)}
                        text={modeLabel(mode, hasDecision, pendingText)}
                      />
                    </Flex>
                    <Text type="secondary" style={{ fontSize: 12 }} aria-hidden="true">
                      {isExpanded ? "收起" : "展开对照"}
                      {isExpanded ? <UpOutlined style={{ marginLeft: 4 }} /> : <DownOutlined style={{ marginLeft: 4 }} />}
                    </Text>
                  </Flex>
                  {!isExpanded && (
                    <Text
                      type="secondary"
                      style={{ marginBottom: 0, display: "block" }}
                      ellipsis={{ tooltip: historySummaryLine(item.inbound.content) }}
                    >
                      {historySummaryLine(item.inbound.content)}
                    </Text>
                  )}
                  {isExpanded && (
                    <>
                      <Flex gap={12} align="center">
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            background: "var(--ant-color-fill-tertiary)",
                            padding: 12,
                            borderRadius: 8,
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            你发的原文
                          </Text>
                          <Paragraph style={{ marginBottom: 0 }}>
                            {original || "这条消息没有文字内容（比如图片、语音或表情），管家直接按原样处理。"}
                          </Paragraph>
                        </div>
                        <ArrowRightOutlined
                          aria-hidden="true"
                          style={{ color: "var(--ant-color-text-quaternary)", flexShrink: 0 }}
                        />
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            background: changed
                              ? "var(--ant-color-primary-bg)"
                              : "var(--ant-color-fill-tertiary)",
                            padding: 12,
                            borderRadius: 8,
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            整理后的内容
                          </Text>
                          <Paragraph style={{ marginBottom: 0 }}>
                            {optimized || "没有需要整理的文字，转交的内容和你发来的完全一致。"}
                          </Paragraph>
                          {!changed && hasDecision && (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              没有改动，原样转交
                            </Text>
                          )}
                        </div>
                      </Flex>
                      {hasDecision && (item.decision?.changes?.length ?? 0) > 0 && (
                        <Flex wrap gap={4} align="center">
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            改动要点
                          </Text>
                          {(item.decision?.changes ?? []).map((change) => (
                            <Tag key={change}>{change}</Tag>
                          ))}
                        </Flex>
                      )}
                    </>
                  )}
                </Flex>
              </Card>
            );
          })}

          <Pagination
            align="end"
            current={historyPage}
            pageSize={historyPageSize}
            total={filteredHistory.length}
            onChange={(page) => setHistoryPage(page)}
            hideOnSinglePage
            showSizeChanger={false}
            size="small"
          />
        </Flex>
      )}

      <AdvancedDetails
        summary={
          <>
            <strong>提示词版本管理（实验功能）</strong>
            <small>
              管家提示词与内置版本的差异对比。这里的「文件有手动修改」「关键段有改动」都是正常使用现象，不是错误；只有「目标文件缺失」才需要处理。
            </small>
          </>
        }
      >
        <Flex vertical gap={16}>
          <Flex justify="space-between" align="center" gap={12} wrap="wrap">
            <Text type="secondary">候选必须基于当前 active hash 创建，并经过成对评估后才能采用。</Text>
            <Tooltip title="先在上方选择或确认优化目标，才能创建候选">
            <Button
              type="primary"
              disabled={data?.targets.length === 0 || data === null}
              onClick={() => {
                const firstId = data?.targets[0]?.targetId ?? "";
                candidateForm.resetFields();
                candidateForm.setFieldsValue({ targetId: firstId });
                setCandidateModalOpen(true);
                setAiMetrics(null);
                void loadOllamaModels();
                if (firstId) {
                  void loadActiveTargetContent(firstId);
                }
              }}
            >
              新建候选
            </Button>
            </Tooltip>
          </Flex>
          {data !== null && data.targets.length === 0 && (
            <Empty
              mascot={false}
              title="还没有找到可查看的规则；完成规则配置后，这里会显示真实内容。"
            />
          )}

          {data !== null && data.targets.length > 0 && (
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
                      <Text strong title={target.sourcePath}>
                        {promptTargetLabel(target.targetId)}
                      </Text>
                    ),
                  },
                  {
                    title: "所属实例",
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
                      <Text code title={target.activeVersion}>
                        {target.activeVersion === "baseline" ? "当前版本" : "试用版本"}
                      </Text>
                    ),
                  },
                  {
                    title: "文件状态",
                    width: 220,
                    render: (_, target) => (
                      <Flex vertical gap={2}>
                        <Badge status={gateStatus(target.gate.status)} text={gateLabel(target.gate.status)} />
                        <Text type="secondary" style={{ fontSize: 12 }} title={target.gate.detail} ellipsis>
                          {target.gate.detail}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {formatTime(target.gate.checkedAt)}
                        </Text>
                      </Flex>
                    ),
                  },
                ] satisfies TableColumnsType<PromptTarget>
              }
            />
          )}

          {data !== null && data.targets.length > 0 && (
            <div
              style={{
                background: "var(--ant-color-fill-tertiary)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <Text strong>现在能做什么</Text>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                只有通过正式样本、受信评估和保护段复验的版本才会显示采用按钮；采用动作会再次核对源文件并留下审计记录。
              </Paragraph>
            </div>
          )}

          {promotionNotice !== null && (
            <Alert
              type="info"
              showIcon={false}
              role="status"
              aria-live="polite"
              title={promotionNotice}
            />
          )}

          {candidates !== null && candidates.candidates.length === 0 && (
            <Empty
              mascot={false}
              title="还没有试过新的规则版本；现在只能查看，不能创建或替换。"
            />
          )}

          {candidates !== null && candidates.candidates.length > 0 && (
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
                      <Text strong>{candidate.description || "改进版本"}</Text>
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
                      <Flex vertical gap={2}>
                        <Badge status={candidateStatus(candidate.status)} text={candidateLabel(candidate.status)} />
                        {candidate.gateErrors.length > 0 && (
                          <Text type="secondary" style={{ fontSize: 12 }} title={candidate.gateErrors.join("；")} ellipsis>
                            {candidate.gateErrors[0]}
                          </Text>
                        )}
                      </Flex>
                    ),
                  },
                  {
                    title: "测试结果",
                    width: 200,
                    render: (_, candidate) => (
                      <Flex vertical gap={2}>
                        <Text strong>{evaluationLabel(candidate.latestEvaluation)}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {candidate.latestEvaluation === null
                            ? "等待测试"
                            : candidate.latestEvaluation.canPromote
                              ? "可以正式采用"
                              : candidate.latestEvaluation.tier === "exploratory"
                                ? "还在初步测试，不能当最终结论"
                                : "暂不建议采用"}
                        </Text>
                      </Flex>
                    ),
                  },
                  {
                    title: "评估",
                    width: 110,
                    render: (_, candidate) => (
                      <Tooltip title={candidate.status === "promoted" ? "该候选已采用为当前版本，无需再评估" : ""}>
                        <Button
                          size="small"
                          disabled={candidate.status === "promoted"}
                          onClick={() => {
                            setEvaluationCandidate(candidate);
                            evaluationForm.setFieldsValue({
                              cases: JSON.stringify([
                                { caseId: "case-1", baselineScore: 0, candidateScore: 0 },
                              ], null, 2),
                            });
                          }}
                        >
                          运行评估
                        </Button>
                      </Tooltip>
                    ),
                  },
                  {
                    title: "采用",
                    width: 120,
                    render: (_, candidate) => {
                      if (candidate.status === "approval-pending" && candidate.latestEvaluation?.canPromote) {
                        return (
                          <Tooltip title="另一个采用操作正在进行">
                            {/* §3.1 行内操作降为 default，页面主 primary 是「新建候选」。 */}
                            <Button
                              disabled={promotingCandidateId !== null}
                              loading={promotingCandidateId === candidate.candidateId}
                              onClick={() => void promoteCandidate(candidate)}
                            >
                              采用此版本
                            </Button>
                          </Tooltip>
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
          )}
        </Flex>
      </AdvancedDetails>
      <Modal
        open={candidateModalOpen}
        title={
          <Flex align="center" gap={8}>
            <span>新建提示词候选</span>
            <Tag color="cyan">支持本地模型智能改写</Tag>
          </Flex>
        }
        width={720}
        okText="创建候选"
        cancelText="取消"
        confirmLoading={candidateBusy}
        onCancel={() => {
          setCandidateModalOpen(false);
          setAiMetrics(null);
        }}
        onOk={() => void candidateForm.submit()}
      >
        <Form<CandidateFormValues>
          form={candidateForm}
          layout="vertical"
          onFinish={(values) => void createCandidate(values)}
        >
          <Form.Item name="targetId" label="目标规则" rules={[{ required: true, message: "请选择目标" }]}>
            <Select
              onChange={(val) => void loadActiveTargetContent(val)}
              options={(data?.targets ?? []).map((target) => ({
                value: target.targetId,
                label: `${promptTargetLabel(target.targetId)} · ${target.activeSha256.slice(0, 8)}`,
              }))}
            />
          </Form.Item>

          {/* 本地模型智能优化扩展卡片 */}
          <Card
            size="small"
            style={{
              marginBottom: 16,
              background: "var(--ant-color-fill-quaternary)",
              border: "1px dashed var(--ant-color-primary-border)",
            }}
          >
            <Flex vertical gap={12}>
              <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                <Flex align="center" gap={6}>
                  <RobotOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
                  <Typography.Text strong>本地模型智能改写与优化</Typography.Text>
                  <Tag color="processing">Ollama 引擎</Tag>
                </Flex>
                <Button
                  size="small"
                  type="text"
                  icon={<SyncOutlined spin={activeContentLoading} />}
                  onClick={() => {
                    const tid = candidateForm.getFieldValue("targetId");
                    if (tid) void loadActiveTargetContent(tid);
                  }}
                >
                  重新载入当前版本
                </Button>
              </Flex>

              <Row gutter={[12, 12]} align="middle">
                <Col xs={24} sm={10}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                    选择本地模型
                  </Typography.Text>
                  <Select
                    style={{ width: "100%" }}
                    size="small"
                    placeholder="选择本地模型"
                    value={selectedOllamaModel || undefined}
                    onChange={(val) => setSelectedOllamaModel(val)}
                    notFoundContent={
                      <div style={{ padding: 8, fontSize: 12 }}>
                        暂未发现已安装的模型，可先至「设置 → 本地模型」拉取
                      </div>
                    }
                    options={ollamaModels.map((m) => ({
                      value: m.name,
                      label: m.name,
                    }))}
                  />
                </Col>
                <Col xs={24} sm={14}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                    优化方向与诉求
                  </Typography.Text>
                  <Input
                    size="small"
                    value={aiInstruction}
                    onChange={(e) => setAiInstruction(e.target.value)}
                    placeholder="如：精炼亲切，适应微信沟通"
                  />
                </Col>
              </Row>

              <Flex wrap="wrap" gap={6} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>快捷预设：</Typography.Text>
                {[
                  "更加精炼亲切，适合微信聊天",
                  "强化指令遵循与安全性，减少幻觉",
                  "温和自然、去除机械官腔",
                  "收紧任务边界，明确完成条件",
                ].map((preset) => (
                  <Tag
                    key={preset}
                    style={{ cursor: "pointer", fontSize: 12 }}
                    onClick={() => setAiInstruction(preset)}
                  >
                    {preset}
                  </Tag>
                ))}
              </Flex>

              <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                <Space wrap>
                  <Button
                    type="primary"
                    icon={<ThunderboltOutlined />}
                    loading={promptfooOptimizing}
                    disabled={!selectedOllamaModel || ollamaModels.length === 0}
                    onClick={() => void runPromptfooOptimization(true)}
                  >
                    {promptfooOptimizing ? "Promptfoo 优化中…" : "Promptfoo 一键优化并创建候选（自动门禁）"}
                  </Button>
                  <Button
                    icon={<RobotOutlined />}
                    loading={aiOptimizing}
                    disabled={!selectedOllamaModel || ollamaModels.length === 0}
                    onClick={() => void runAiOptimization()}
                  >
                    {aiOptimizing ? "本地模型改写中…" : "改写并填入下方编辑器（手动修改）"}
                  </Button>
                </Space>
                {aiMetrics && (
                  <Flex align="center" gap={6}>
                    <CheckCircleOutlined style={{ color: "var(--ant-color-success)" }} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      耗时 {(aiMetrics.durationMs / 1000).toFixed(1)}s · 消耗 {aiMetrics.totalTokens} Tokens · {aiMetrics.tokensPerSecond} tok/s
                    </Typography.Text>
                  </Flex>
                )}
              </Flex>
            </Flex>
          </Card>

          <Form.Item name="description" label="候选说明">
            <Input placeholder="例如：[Promptfoo + qwen2.5] 适应微信即时沟通口吻优化" />
          </Form.Item>
          <Form.Item
            name="content"
            label="候选完整内容（可二次预览并微调）"
            rules={[{ required: true, message: "请提供候选完整内容" }]}
          >
            <Input.TextArea
              rows={10}
              placeholder="完整提示词内容。使用本地模型优化后会自动生成并填入此处，并保留关键保护段。"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Promptfoo 自动化门禁评估模态框 */}
      <Modal
        open={evaluationCandidate !== null}
        title={
          <Flex align="center" gap={8}>
            <ExperimentOutlined style={{ color: "var(--ant-color-primary)", fontSize: 18 }} />
            <span>Promptfoo 门禁评估</span>
            <Tag color="blue">{evaluationCandidate?.description || "候选版本"}</Tag>
          </Flex>
        }
        width={820}
        footer={null}
        onCancel={() => {
          setEvaluationCandidate(null);
          setPromptfooEvalResult(null);
        }}
      >
        <Tabs
          activeKey={evalActiveTab}
          onChange={setEvalActiveTab}
          items={[
            {
              key: "promptfoo",
              label: (
                <Flex align="center" gap={6}>
                  <ThunderboltOutlined />
                  <span>Promptfoo 自动化门禁测试（推荐）</span>
                </Flex>
              ),
              children: (
                <Flex vertical gap={16} style={{ paddingTop: 8 }}>
                  <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
                    <Flex vertical gap={12}>
                      <Row gutter={[12, 12]}>
                        <Col xs={24} sm={14}>
                          <Typography.Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                            选择评测基准套件 (Promptfoo Suite)
                          </Typography.Text>
                          <Select
                            style={{ width: "100%" }}
                            value={selectedSuiteId}
                            onChange={setSelectedSuiteId}
                            options={promptfooSuites.map((suite) => ({
                              value: suite.suiteId,
                              label: `${suite.name} (${suite.tests.length} 项 · ${suite.tier === "formal" ? "正式门禁" : "探索测试"})`,
                            }))}
                          />
                        </Col>
                        <Col xs={24} sm={10}>
                          <Typography.Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                            评测执行引擎
                          </Typography.Text>
                          <Select
                            style={{ width: "100%" }}
                            value={evalModel}
                            onChange={setEvalModel}
                            options={[
                              { value: "builtin", label: "内置 Promptfoo 断言引擎（毫秒级执行，推荐）" },
                              ...ollamaModels.map((m) => ({
                                value: m.name,
                                label: `本地模型驱动: ${m.name}`,
                              })),
                            ]}
                          />
                        </Col>
                      </Row>

                      {selectedSuiteId && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {promptfooSuites.find((s) => s.suiteId === selectedSuiteId)?.description ||
                            "涵盖人设性格、工具遵循、微信即时沟通、边界防御与中文语境的正式门禁基准。"}
                        </Typography.Text>
                      )}

                      <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                        <Button
                          type="primary"
                          icon={<ThunderboltOutlined />}
                          loading={evaluatingWithPromptfoo}
                          onClick={() => void runPromptfooEvaluation()}
                        >
                          {evaluatingWithPromptfoo ? "Promptfoo 评测运行中…" : "开始 Promptfoo 自动化断言评测"}
                        </Button>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          正式采用需满足：样本数 ≥ 30、净提升 &gt; 0%、零安全违规、受信评估
                        </Typography.Text>
                      </Flex>
                    </Flex>
                  </Card>

                  {/* 评测结果得分卡 */}
                  {promptfooEvalResult && promptfooEvalResult.report && (
                    <Flex vertical gap={12}>
                      {promptfooEvalResult.report.canPromote ? (
                        <Alert
                          type="success"
                          showIcon
                          icon={<SafetyCertificateOutlined />}
                          message="🎉 门禁评测全部通过！已达到正式采用门禁（Formal Benchmark）"
                          description={
                            <span>
                              共通过 <strong>{promptfooEvalResult.suite?.totalTests ?? 30}</strong> 项开源标准断言测试，
                              提升幅度 <strong>{((promptfooEvalResult.report.metrics.deltaMean ?? 0) * 100).toFixed(1)}%</strong>，
                              零安全违规，且为受信评估。您现在可以直接采用此版本。
                            </span>
                          }
                          action={
                            <Button
                              type="primary"
                              icon={<CheckCircleOutlined />}
                              onClick={async () => {
                                await promoteCandidate(evaluationCandidate!);
                                setEvaluationCandidate(null);
                              }}
                            >
                              立即采用此版本
                            </Button>
                          }
                        />
                      ) : (
                        <Alert
                          type="warning"
                          showIcon
                          message="尚未达到正式采用门禁"
                          description={
                            <span>
                              {promptfooEvalResult.report.metrics.reasons?.join("；") ||
                                "未完全满足正式门禁要求，建议根据下方断言明细优化提示词后重新测试。"}
                            </span>
                          }
                        />
                      )}

                      <Row gutter={[12, 12]}>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="基线通过率"
                              value={Number(((promptfooEvalResult.report.metrics.baselineMean ?? 0) * 100).toFixed(1))}
                              suffix="%"
                            />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="候选通过率"
                              value={Number(((promptfooEvalResult.report.metrics.candidateMean ?? 0) * 100).toFixed(1))}
                              suffix="%"
                              valueStyle={{
                                color:
                                  (promptfooEvalResult.report.metrics.deltaMean ?? 0) > 0
                                    ? "var(--ant-color-success)"
                                    : undefined,
                              }}
                            />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="净提升 (Delta)"
                              value={`${(promptfooEvalResult.report.metrics.deltaMean ?? 0) > 0 ? "+" : ""}${((promptfooEvalResult.report.metrics.deltaMean ?? 0) * 100).toFixed(1)}%`}
                              valueStyle={{
                                color:
                                  (promptfooEvalResult.report.metrics.deltaMean ?? 0) > 0
                                    ? "var(--ant-color-success)"
                                    : "var(--ant-color-error)",
                              }}
                            />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="安全违规"
                              value={promptfooEvalResult.report.metrics.safetyViolationCount ?? 0}
                              suffix="项"
                              valueStyle={{
                                color:
                                  (promptfooEvalResult.report.metrics.safetyViolationCount ?? 0) === 0
                                    ? "var(--ant-color-success)"
                                    : "var(--ant-color-error)",
                              }}
                            />
                          </Card>
                        </Col>
                      </Row>

                      {/* 断言明细查看 */}
                      {promptfooEvalResult.details && promptfooEvalResult.details.length > 0 && (
                        <Collapse
                          size="small"
                          items={[
                            {
                              key: "details",
                              label: `查看断言明细（共 ${promptfooEvalResult.details.length} 项测试用例）`,
                              children: (
                                <Flex vertical gap={8} style={{ maxHeight: 320, overflowY: "auto" }}>
                                  {promptfooEvalResult.details.map((item) => (
                                    <div
                                      key={item.caseId}
                                      style={{
                                        padding: 8,
                                        borderRadius: 6,
                                        background: item.candidatePassed
                                          ? "var(--ant-color-fill-quaternary)"
                                          : "rgba(255, 77, 79, 0.08)",
                                        border: "1px solid var(--ant-color-border-secondary)",
                                      }}
                                    >
                                      <Flex justify="space-between" align="center" gap={8}>
                                        <Flex align="center" gap={8}>
                                          {item.candidatePassed ? (
                                            <Tag color="success">通过</Tag>
                                          ) : (
                                            <Tag color="error">未通过</Tag>
                                          )}
                                          <Typography.Text strong style={{ fontSize: 12 }}>
                                            {item.description}
                                          </Typography.Text>
                                        </Flex>
                                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                          得分: {item.candidateScore.toFixed(2)}
                                        </Typography.Text>
                                      </Flex>
                                      <Typography.Paragraph
                                        type="secondary"
                                        style={{ fontSize: 12, margin: "4px 0 0 0" }}
                                        ellipsis={{ rows: 2 }}
                                      >
                                        <strong>输入：</strong>
                                        {item.input}
                                      </Typography.Paragraph>
                                      {item.candidateAssertions && item.candidateAssertions.length > 0 && (
                                        <div style={{ marginTop: 4 }}>
                                          {item.candidateAssertions.map((a, idx) => (
                                            <Tag key={idx} style={{ fontSize: 11 }}>
                                              {a.assertionType}: {a.reason || (a.passed ? "达标" : "未达标")}
                                            </Tag>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </Flex>
                              ),
                            },
                          ]}
                        />
                      )}
                    </Flex>
                  )}
                </Flex>
              ),
            },
            {
              key: "custom_json",
              label: "高级：自定义成对样本 (JSON)",
              children: (
                <Form<EvaluationFormValues>
                  form={evaluationForm}
                  layout="vertical"
                  onFinish={(values) => void evaluateCandidate(values)}
                  style={{ paddingTop: 8 }}
                >
                  <Form.Item
                    name="cases"
                    label="成对样本 JSON"
                    extra="每项至少包含 caseId、baselineScore、candidateScore；正式采用至少需要 30 条样本。"
                    rules={[{ required: true, message: "请提供成对样本" }]}
                  >
                    <Input.TextArea rows={12} />
                  </Form.Item>
                  <Flex justify="flex-end" gap={8}>
                    <Button onClick={() => setEvaluationCandidate(null)}>取消</Button>
                    <Button type="primary" htmlType="submit" loading={candidateBusy}>
                      提交自定义评估
                    </Button>
                  </Flex>
                </Form>
              ),
            },
          ]}
        />
      </Modal>
    </Flex>
  );
}
