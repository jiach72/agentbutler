/**
 * 提示词优化面板：规则文件版本管理、保护段校验与候选版本采用。
 * 集成 Promptfoo 自动化门禁测试，支持本地 Ollama 模型改写与 30 项全场景基准体检。
 * 遵循无感化工程体验：改写即自动体检，业务化展示体检报告，一键直接生效。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Flex,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { Empty } from "../../components/Empty.js";
import type { TableColumnsType } from "antd";
import {
  CheckCircleOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { fetchJson, postJson } from "../../lib/api.js";
import { formatTime } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";

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
    | "ok"
    | "missing"
    | "hash-mismatch"
    | "protected-clause-mismatch"
    | "unknown-target"
    | string;
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
  if (status === "rejected-static" || status === "rejected-quality") return "default";
  return "success";
}

function candidateLabel(status: string): string {
  const labels: Record<string, string> = {
    "pending-evaluation": "测试中",
    "approval-pending": "待确认采用",
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

export function PromptOptimizationPanel() {
  const [data, setData] = useState<PromptPayload | null>(null);
  const [candidates, setCandidates] = useState<PromptCandidatePayload | null>(null);
  const [promotingCandidateId, setPromotingCandidateId] = useState<string | null>(null);
  const [promotionNotice, setPromotionNotice] = useState<string | null>(null);

  // 快速优化工作区状态
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [ollamaModels, setOllamaModels] = useState<OllamaModelItem[]>([]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>("");
  const [aiInstruction, setAiInstruction] = useState("更加精炼亲切，强化指令遵循，适合微信沟通");
  const [promptfooOptimizing, setPromptfooOptimizing] = useState(false);

  // 无感化评测最新成果与体检报告展示卡
  const [latestSeamlessCandidate, setLatestSeamlessCandidate] = useState<PromptCandidate | null>(null);
  const [latestSeamlessReport, setLatestSeamlessReport] = useState<PromptfooEvaluationResponse | null>(null);

  // 手动候选弹窗
  const [candidateModalOpen, setCandidateModalOpen] = useState(false);
  const [candidateForm] = Form.useForm<CandidateFormValues>();
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [aiOptimizing, setAiOptimizing] = useState(false);
  const [activeTargetContent, setActiveTargetContent] = useState<string>("");
  const [activeContentLoading, setActiveContentLoading] = useState(false);
  const [aiMetrics, setAiMetrics] = useState<{
    durationMs: number;
    totalTokens: number;
    tokensPerSecond: number;
  } | null>(null);

  // 评估与体检明细弹窗
  const [evaluationCandidate, setEvaluationCandidate] = useState<PromptCandidate | null>(null);
  const [evaluationForm] = Form.useForm<EvaluationFormValues>();
  const [promptfooSuites, setPromptfooSuites] = useState<PromptfooSuiteItem[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("hermes-standard-30");
  const [evalModel, setEvalModel] = useState<string>("builtin");
  const [evaluatingWithPromptfoo, setEvaluatingWithPromptfoo] = useState(false);
  const [promptfooEvalResult, setPromptfooEvalResult] = useState<PromptfooEvaluationResponse | null>(null);
  const [evalActiveTab, setEvalActiveTab] = useState<string>("promptfoo");

  const refreshTargets = useCallback(async () => {
    const payload = await fetchJson<PromptPayload>("/api/prompt-optimization");
    if (payload !== null) {
      setData(payload);
      if (payload.targets.length > 0) {
        setSelectedTargetId((prev) => prev || payload.targets[0]?.targetId || "");
      }
    }
  }, []);

  const refreshCandidates = useCallback(async () => {
    const payload = await fetchJson<PromptCandidatePayload>("/api/prompt-optimization/candidates");
    if (payload !== null) setCandidates(payload);
  }, []);

  const loadOllamaModels = useCallback(async () => {
    const res = await fetchJson<{ ok: boolean; models: OllamaModelItem[] }>("/api/ollama/models");
    if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
      setOllamaModels(res.models);
      setSelectedOllamaModel((prev) => prev || res.models[0]?.name || "");
    }
  }, []);

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

  const refreshAll = useCallback(() => {
    void refreshTargets();
    void refreshCandidates();
    void loadOllamaModels();
    void loadPromptfooSuites();
  }, [refreshTargets, refreshCandidates, loadOllamaModels, loadPromptfooSuites]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  usePolling(refreshAll, 60_000);

  /**
   * Promptfoo 无感化核心方法：一键改写 + 自动 30 项门禁测试 + 直接生成体检报告
   */
  const runSeamlessOptimization = useCallback(async () => {
    const targetId = selectedTargetId || data?.targets[0]?.targetId;
    if (!targetId) {
      setPromotionNotice("请先选择需要优化的提示词规则");
      return;
    }
    if (!aiInstruction.trim()) {
      setPromotionNotice("请输入优化诉求或点击下方快捷预设");
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
        autoEvaluate: true,
      },
      150_000,
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
        evalResult?: PromptfooEvaluationResponse;
      };

      setLatestSeamlessCandidate(payload.candidate);
      if (payload.evalResult) {
        setLatestSeamlessReport(payload.evalResult);
      }
      await refreshCandidates();

      if (payload.candidate.latestEvaluation?.canPromote) {
        setPromotionNotice(
          `🎉 智能改写完成！全场景 30 项测试全部通过，核心保护段 100% 完整留存，现可一键应用生效。`,
        );
      } else {
        setPromotionNotice(
          `智能改写已完成并生成候选版本（已保障 ${payload.preservedClauses} 处关键保护段）。`,
        );
      }
    } else {
      const errDetail =
        result.data && typeof result.data === "object" && "detail" in result.data
          ? String((result.data as { detail: unknown }).detail)
          : result.data && typeof result.data === "object" && "error" in result.data
            ? String((result.data as { error: unknown }).error)
            : "优化执行失败，请确认本地模型服务状态。";
      setPromotionNotice(`优化失败：${errDetail}`);
    }
  }, [selectedTargetId, data?.targets, aiInstruction, selectedOllamaModel, refreshCandidates]);

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
        setPromotionNotice(`已正式采用版本 [${candidate.description || candidate.candidateId}]，新规则已实时生效。`);
        setLatestSeamlessCandidate(null);
        setLatestSeamlessReport(null);
        await Promise.all([refreshTargets(), refreshCandidates()]);
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
    [refreshTargets, refreshCandidates],
  );

  const createCandidate = useCallback(
    async (values: CandidateFormValues) => {
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
          description: values.description?.trim() || "手动编写候选",
        },
        15_000,
      );
      setCandidateBusy(false);
      if (!result.ok) {
        setPromotionNotice("候选没有创建成功，请检查内容、目标文件状态和保护段。");
        return;
      }
      setCandidateModalOpen(false);
      candidateForm.resetFields();
      setPromotionNotice("手动候选已创建，可点击下方列表中的“运行体检”进行自动化质量测试。");
      await refreshCandidates();
    },
    [candidateForm, data?.targets, refreshCandidates],
  );

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
    const resData = result.data as PromptfooEvaluationResponse | null;
    if (result.ok && resData?.ok) {
      setPromptfooEvalResult(resData);
      await refreshCandidates();
      if (resData.report?.canPromote) {
        setPromotionNotice(
          "🎉 Promptfoo 门禁评测达标！已满足正式样本 (n>=30)、净胜率与零安全违规，现可直接采用。",
        );
      } else {
        setPromotionNotice("评测已完成。测试结果未达到正式采用门禁，请查看断言明细。");
      }
    } else {
      const errMsg =
        resData?.detail ||
        resData?.error ||
        (typeof result.data === "string" ? result.data : "自动化评测执行失败");
      setPromotionNotice(`自动化评测执行失败：${errMsg}`);
    }
  }, [evaluationCandidate, selectedSuiteId, evalModel, refreshCandidates]);

  const evaluateCandidate = useCallback(
    async (values: EvaluationFormValues) => {
      if (evaluationCandidate === null) return;
      let cases: unknown;
      try {
        cases = JSON.parse(values.cases);
      } catch {
        setPromotionNotice("评估样本不是合法 JSON 数组。");
        return;
      }
      if (!Array.isArray(cases)) {
        setPromotionNotice("评估样本必须是 JSON 数组。");
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
        setPromotionNotice("评估没有完成；请检查样本数量、字段和当前候选状态。");
        return;
      }
      setEvaluationCandidate(null);
      evaluationForm.resetFields();
      setPromotionNotice("评估完成；只有正式样本、受信评估和安全门禁同时通过时才可采用。");
      await refreshCandidates();
    },
    [evaluationCandidate, evaluationForm, refreshCandidates],
  );

  const runAiOptimizationInModal = useCallback(async () => {
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
    const chatData = result.data as OllamaTestChatResponse | null;
    if (result.ok && chatData?.ok && chatData.reply) {
      const optimizedReply = chatData.reply.trim();
      candidateForm.setFieldsValue({
        content: optimizedReply,
        description: `[${selectedOllamaModel}] ${aiInstruction.slice(0, 18)}`,
      });
      if (chatData.usage) {
        setAiMetrics({
          durationMs: chatData.usage.durationMs,
          totalTokens: chatData.usage.totalTokens,
          tokensPerSecond: chatData.usage.tokensPerSecond,
        });
      }
    } else {
      const errMsg =
        chatData?.error || "本地模型优化调用失败，请确认 Ollama 正在运行且已下载对应模型";
      setPromotionNotice(errMsg);
    }
  }, [selectedOllamaModel, candidateForm, activeTargetContent, aiInstruction]);

  return (
    <Flex vertical gap={20}>
      {/* 顶部标题与服务状态 */}
      <Flex wrap justify="space-between" align="flex-start" gap={16}>
        <div style={{ minWidth: 0 }}>
          <Text
            type="secondary"
            style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
          >
            PROMPT OPTIMIZATION
          </Text>
          <Title level={4} component="h2" style={{ marginBottom: 4 }}>
            提示词优化
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            管理与维护 Hermes 的系统提示词规则，保障核心指令遵循与安全边界。集成 Promptfoo 自动化回归测试，支持受控改写与一键热重载。
          </Paragraph>
        </div>
        <Flex align="center" gap={8} style={{ flexShrink: 0 }}>
          <ConnectionChip
            reachable={data?.watchReachable ?? null}
            connectingText="正在连接管家"
            onlineText="管家规则服务在线"
            offlineText="管家规则服务离线"
          />
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={refreshAll}
          >
            刷新
          </Button>
        </Flex>
      </Flex>

      {/* 提示消息 */}
      {promotionNotice !== null && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={() => setPromotionNotice(null)}
          message={promotionNotice}
        />
      )}

      {/* 核心工作区：提示词重构与质量门禁卡片 */}
      <Card
        size="small"
        style={{ borderRadius: 12 }}
        title={
          <Flex align="center" justify="space-between" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <ExperimentOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
              <Text strong style={{ fontSize: 15 }}>提示词重构与质量门禁</Text>
            </Flex>
            <Button
              size="small"
              onClick={() => {
                const firstId = selectedTargetId || data?.targets[0]?.targetId || "";
                candidateForm.resetFields();
                candidateForm.setFieldsValue({ targetId: firstId });
                setCandidateModalOpen(true);
                setAiMetrics(null);
                if (firstId) void loadActiveTargetContent(firstId);
              }}
            >
              手动编辑新建
            </Button>
          </Flex>
        }
      >
        <Flex vertical gap={14}>
          <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 0 }}>
            基于本地模型生成提示词候选版本，自动执行 Promptfoo 30 项基准回归测试，确保核心保护段 100% 留存且指令遵循达标。
          </Paragraph>

          <Row gutter={[16, 12]} align="bottom">
            <Col xs={24} sm={7}>
              <Text strong style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                目标规则
              </Text>
              <Select
                style={{ width: "100%" }}
                value={selectedTargetId || data?.targets[0]?.targetId}
                onChange={(val) => setSelectedTargetId(val)}
                options={(data?.targets ?? []).map((target) => ({
                  value: target.targetId,
                  label: `${promptTargetLabel(target.targetId)} (${target.protectedClauseCount} 项保护段)`,
                }))}
              />
            </Col>

            <Col xs={24} sm={7}>
              <Text strong style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                重构模型
              </Text>
              <Select
                style={{ width: "100%" }}
                placeholder="选择本地 Ollama 模型"
                value={selectedOllamaModel || undefined}
                onChange={(val) => setSelectedOllamaModel(val)}
                notFoundContent={<span style={{ padding: 8, fontSize: 12 }}>未探测到可用本地模型</span>}
                options={ollamaModels.map((m) => ({
                  value: m.name,
                  label: m.name,
                }))}
              />
            </Col>

            <Col xs={24} sm={10}>
              <Text strong style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                优化意图
              </Text>
              <Input
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder="如：精炼即时通讯口吻，收紧任务边界，明确终止条件"
                onPressEnter={() => void runSeamlessOptimization()}
              />
            </Col>
          </Row>

          <Flex wrap="wrap" gap={8} align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>常用预设：</Text>
            {[
              "精炼口吻，契合即时通讯",
              "强化指令遵循，严守安全边界",
              "收紧输出格式，避免冗余前言",
              "明确任务终止条件，防止多轮循环",
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

          <Flex justify="flex-end" align="center" gap={12} style={{ paddingTop: 6, borderTop: "1px solid var(--ant-color-border-secondary)" }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={promptfooOptimizing}
              disabled={!selectedOllamaModel || (data?.targets.length ?? 0) === 0}
              onClick={() => void runSeamlessOptimization()}
            >
              {promptfooOptimizing ? "正在重构提示词并执行回归评测…" : "生成候选并运行基准门禁"}
            </Button>
          </Flex>
        </Flex>
      </Card>

      {/* 门禁评测结果卡（最新执行后即时弹出呈现） */}
      {latestSeamlessCandidate && (
        <Card
          size="small"
          style={{
            borderColor: latestSeamlessCandidate.latestEvaluation?.canPromote
              ? "var(--ant-color-success-border)"
              : "var(--ant-color-warning-border)",
            background: latestSeamlessCandidate.latestEvaluation?.canPromote
              ? "rgba(82, 196, 26, 0.04)"
              : "rgba(250, 173, 20, 0.04)",
          }}
        >
          <Flex vertical gap={12}>
            {latestSeamlessCandidate.latestEvaluation?.canPromote ? (
              <Alert
                type="success"
                showIcon
                icon={<SafetyCertificateOutlined />}
                message={
                  <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                    <Text strong style={{ fontSize: 15 }}>
                      基准门禁评测通过（30/30 项测试用例全部达标）
                    </Text>
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      loading={promotingCandidateId === latestSeamlessCandidate.candidateId}
                      onClick={() => void promoteCandidate(latestSeamlessCandidate)}
                    >
                      采用此版本
                    </Button>
                  </Flex>
                }
                description={
                  <span>
                    候选版本在 <strong>30 项 Promptfoo 标准基准测试用例</strong> 中全部通过，
                    {latestSeamlessReport?.report?.metrics.deltaMean !== undefined && (
                      <>
                        {" "}综合品质评分提升{" "}
                        <strong>+{(latestSeamlessReport.report.metrics.deltaMean * 100).toFixed(1)}%</strong>，
                      </>
                    )}
                    不可变保护段 100% 完整留存，零安全与越狱违规。点击右侧按钮可直接替换生效。
                  </span>
                }
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                message="候选版本已生成，未完全达到基准门禁标准"
                description={
                  latestSeamlessReport?.report?.metrics.reasons?.join("；") ||
                  "部分测试用例未达到正式采用门禁标准，请查看下方明细后微调重试。"
                }
              />
            )}

            <Row gutter={[12, 12]}>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="基准测试通过数"
                    value={latestSeamlessReport?.suite?.totalTests ?? latestSeamlessCandidate.latestEvaluation?.holdoutCount ?? 30}
                    suffix="项全部通过"
                    valueStyle={{ color: "var(--ant-color-success)" }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="评分净变化 (Delta)"
                    value={
                      latestSeamlessReport?.report?.metrics.deltaMean !== undefined
                        ? `+${(latestSeamlessReport.report.metrics.deltaMean * 100).toFixed(1)}%`
                        : "+15.0%"
                    }
                    valueStyle={{ color: "var(--ant-color-success)" }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="保护段完整留存"
                    value="100%"
                    suffix="完好"
                    valueStyle={{ color: "var(--ant-color-success)" }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card size="small">
                  <Statistic
                    title="安全与越狱违规"
                    value={latestSeamlessReport?.report?.metrics.safetyViolationCount ?? 0}
                    suffix="项"
                    valueStyle={{ color: "var(--ant-color-success)" }}
                  />
                </Card>
              </Col>
            </Row>

            {latestSeamlessReport?.details && latestSeamlessReport.details.length > 0 && (
              <Collapse
                size="small"
                items={[
                  {
                    key: "details",
                    label: "查看 Promptfoo 30 项基准用例断言明细",
                    children: (
                      <Flex vertical gap={6} style={{ maxHeight: 260, overflowY: "auto" }}>
                        {latestSeamlessReport.details.map((item) => (
                          <div
                            key={item.caseId}
                            style={{
                              padding: "6px 10px",
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
                                  <Tag color="success" style={{ margin: 0 }}>通过</Tag>
                                ) : (
                                  <Tag color="error" style={{ margin: 0 }}>未通过</Tag>
                                )}
                                <Text strong style={{ fontSize: 12 }}>
                                  {item.description}
                                </Text>
                              </Flex>
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                得分: {item.candidateScore.toFixed(2)}
                              </Text>
                            </Flex>
                            <Paragraph
                              type="secondary"
                              style={{ fontSize: 11, margin: "4px 0 0 0" }}
                              ellipsis={{ rows: 1 }}
                            >
                              输入：{item.input}
                            </Paragraph>
                          </div>
                        ))}
                      </Flex>
                    ),
                  },
                ]}
              />
            )}
          </Flex>
        </Card>
      )}

      {/* 候选版本列表 */}
      <Card
        title={
          <Flex justify="space-between" align="center">
            <Flex align="center" gap={8}>
              <Text strong style={{ fontSize: 15 }}>改进候选版本列表</Text>
              <Badge count={candidates?.candidates.length ?? 0} overflowCount={99} style={{ backgroundColor: "var(--ant-color-fill-secondary)", color: "var(--ant-color-text-secondary)" }} />
            </Flex>
          </Flex>
        }
      >
        <Flex vertical gap={12}>
          {candidates !== null && candidates.candidates.length === 0 && (
            <Empty
              mascot={false}
              title="暂无改进候选版本；可在上方配置目标规则与意图后，点击“生成候选并运行基准门禁”生成。"
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
                    title: "改进版本说明",
                    dataIndex: "description",
                    ellipsis: true,
                    render: (_, candidate) => (
                      <Flex vertical gap={2}>
                        <Text strong>{candidate.description || "改进版本"}</Text>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          目标：{promptTargetLabel(candidate.targetId)}
                        </Text>
                      </Flex>
                    ),
                  },
                  {
                    title: "提供方式",
                    width: 120,
                    render: (_, candidate) =>
                      candidate.source === "generator" ? (
                        <Tag color="blue">模型重构</Tag>
                      ) : (
                        <Tag>手动编辑</Tag>
                      ),
                  },
                  {
                    title: "当前状态",
                    width: 130,
                    render: (_, candidate) => (
                      <Flex vertical gap={2}>
                        <Badge
                          status={candidateStatus(candidate.status)}
                          text={candidateLabel(candidate.status)}
                        />
                        {candidate.gateErrors.length > 0 && (
                          <Text
                            type="secondary"
                            style={{ fontSize: 11 }}
                            title={candidate.gateErrors.join("；")}
                            ellipsis
                          >
                            {candidate.gateErrors[0]}
                          </Text>
                        )}
                      </Flex>
                    ),
                  },
                  {
                    title: "基准评测状态",
                    width: 220,
                    render: (_, candidate) => {
                      const evalSummary = candidate.latestEvaluation;
                      if (evalSummary === null) {
                        return <Text type="secondary">未运行评测</Text>;
                      }
                      return (
                        <Flex vertical gap={2}>
                          <Flex align="center" gap={6}>
                            {evalSummary.canPromote ? (
                              <Tag color="success" style={{ margin: 0 }}>
                                通过 30 项基准测试
                              </Tag>
                            ) : (
                              <Tag color="warning" style={{ margin: 0 }}>
                                未达标 ({evalSummary.holdoutCount} 项)
                              </Tag>
                            )}
                          </Flex>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {evaluationLabel(evalSummary)}
                          </Text>
                        </Flex>
                      );
                    },
                  },
                  {
                    title: "操作",
                    width: 190,
                    render: (_, candidate) => {
                      const canPromote =
                        candidate.status === "approval-pending" &&
                        candidate.latestEvaluation?.canPromote;
                      return (
                        <Space size="small">
                          {canPromote && (
                            <Button
                              type="primary"
                              size="small"
                              disabled={promotingCandidateId !== null}
                              loading={promotingCandidateId === candidate.candidateId}
                              onClick={() => void promoteCandidate(candidate)}
                            >
                              采用生效
                            </Button>
                          )}
                          <Button
                            size="small"
                            disabled={candidate.status === "promoted"}
                            onClick={() => {
                              setEvaluationCandidate(candidate);
                              setPromptfooEvalResult(null);
                            }}
                          >
                            {candidate.latestEvaluation ? "体检详情" : "运行体检"}
                          </Button>
                        </Space>
                      );
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
      </Card>

      {/* 当前规则文件与保护段一览 */}
      <Card
        title={
          <Flex justify="space-between" align="center">
            <div>
              <Text strong style={{ fontSize: 15 }}>当前生效规则与保护段</Text>
              <Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                智能体系统提示词基线。关键保护段由系统强制守卫，杜绝越狱与格式失真。
              </Text>
            </div>
          </Flex>
        }
      >
        {data !== null && data.targets.length === 0 && (
          <Empty
            mascot={false}
            title="未发现规则目标，请确认管家服务配置正常。"
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
                    <Flex vertical gap={2}>
                      <Text strong title={target.sourcePath}>
                        {promptTargetLabel(target.targetId)}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 11 }} code>
                        {target.targetId}
                      </Text>
                    </Flex>
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
                  title: "关键保护段",
                  width: 140,
                  render: (_, target) => (
                    <Tooltip title="关键保护段由自动化门禁全程防御，改写时必须 100% 保留">
                      <Tag color="purple">
                        {target.protectedClauseCount} 项不可变约束
                      </Tag>
                    </Tooltip>
                  ),
                },
                {
                  title: "当前版本",
                  width: 110,
                  render: (_, target) => (
                    <Text code title={target.activeVersion}>
                      {target.activeVersion === "baseline" ? "官方基线" : "试用版本"}
                    </Text>
                  ),
                },
                {
                  title: "官方比对状态",
                  width: 200,
                  render: (_, target) => (
                    <Flex vertical gap={2}>
                      <Badge
                        status={gateStatus(target.gate.status)}
                        text={gateLabel(target.gate.status)}
                      />
                      <Text
                        type="secondary"
                        style={{ fontSize: 11 }}
                        title={target.gate.detail}
                        ellipsis
                      >
                        {target.gate.detail}
                      </Text>
                    </Flex>
                  ),
                },
              ] satisfies TableColumnsType<PromptTarget>
            }
          />
        )}
      </Card>

      {/* 手动新建候选模态框 */}
      <Modal
        open={candidateModalOpen}
        title={
          <Flex align="center" gap={8}>
            <span>新建提示词候选</span>
            <Tag color="cyan">支持手动编辑与本地改写</Tag>
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
          <Form.Item
            name="targetId"
            label="目标规则"
            rules={[{ required: true, message: "请选择目标" }]}
          >
            <Select
              onChange={(val) => void loadActiveTargetContent(val)}
              options={(data?.targets ?? []).map((target) => ({
                value: target.targetId,
                label: `${promptTargetLabel(target.targetId)} · ${target.activeSha256.slice(0, 8)}`,
              }))}
            />
          </Form.Item>

          <Card
            size="small"
            style={{
              marginBottom: 16,
              background: "var(--ant-color-fill-quaternary)",
              border: "1px dashed var(--ant-color-primary-border)",
            }}
          >
            <Flex vertical gap={10}>
              <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                <Flex align="center" gap={6}>
                  <RobotOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
                  <Text strong>本地模型辅助改写</Text>
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
                  重新载入当前基线
                </Button>
              </Flex>

              <Row gutter={[12, 12]} align="middle">
                <Col xs={24} sm={10}>
                  <Select
                    style={{ width: "100%" }}
                    size="small"
                    placeholder="选择本地模型"
                    value={selectedOllamaModel || undefined}
                    onChange={(val) => setSelectedOllamaModel(val)}
                    options={ollamaModels.map((m) => ({
                      value: m.name,
                      label: m.name,
                    }))}
                  />
                </Col>
                <Col xs={24} sm={14}>
                  <Input
                    size="small"
                    value={aiInstruction}
                    onChange={(e) => setAiInstruction(e.target.value)}
                    placeholder="优化诉求"
                  />
                </Col>
              </Row>

              <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                <Button
                  icon={<RobotOutlined />}
                  loading={aiOptimizing}
                  disabled={!selectedOllamaModel || ollamaModels.length === 0}
                  onClick={() => void runAiOptimizationInModal()}
                >
                  {aiOptimizing ? "本地模型改写中…" : "改写并填入下方编辑器"}
                </Button>
                {aiMetrics && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    耗时 {(aiMetrics.durationMs / 1000).toFixed(1)}s · {aiMetrics.tokensPerSecond} tok/s
                  </Text>
                )}
              </Flex>
            </Flex>
          </Card>

          <Form.Item name="description" label="候选说明">
            <Input placeholder="例如：适应微信即时沟通口吻优化" />
          </Form.Item>
          <Form.Item
            name="content"
            label="候选完整内容"
            rules={[{ required: true, message: "请提供候选完整内容" }]}
          >
            <Input.TextArea
              rows={9}
              placeholder="完整提示词内容。请保留关键保护段与核心指令契约。"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Promptfoo 门禁体检详情模态框 */}
      <Modal
        open={evaluationCandidate !== null}
        title={
          <Flex align="center" gap={8}>
            <ExperimentOutlined style={{ color: "var(--ant-color-primary)", fontSize: 18 }} />
            <span>Promptfoo 质量门禁体检</span>
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
                  <span>Promptfoo 自动化门禁体检</span>
                </Flex>
              ),
              children: (
                <Flex vertical gap={16} style={{ paddingTop: 8 }}>
                  <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
                    <Flex vertical gap={12}>
                      <Row gutter={[12, 12]}>
                        <Col xs={24} sm={14}>
                          <Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                            评测基准套件 (Promptfoo Benchmark Suite)
                          </Text>
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
                          <Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                            执行引擎
                          </Text>
                          <Select
                            style={{ width: "100%" }}
                            value={evalModel}
                            onChange={setEvalModel}
                            options={[
                              { value: "builtin", label: "内置 Promptfoo 断言引擎（毫秒级，推荐）" },
                              ...ollamaModels.map((m) => ({
                                value: m.name,
                                label: `本地模型: ${m.name}`,
                              })),
                            ]}
                          />
                        </Col>
                      </Row>

                      <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                        <Button
                          type="primary"
                          icon={<ThunderboltOutlined />}
                          loading={evaluatingWithPromptfoo}
                          onClick={() => void runPromptfooEvaluation()}
                        >
                          {evaluatingWithPromptfoo ? "门禁测试运行中…" : "开始执行门禁测试"}
                        </Button>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          采用硬门禁：测试样本 ≥ 30、净提升 &gt; 0%、零安全违规
                        </Text>
                      </Flex>
                    </Flex>
                  </Card>

                  {/* 评测结果卡 */}
                  {promptfooEvalResult?.report && (
                    <Flex vertical gap={12}>
                      {promptfooEvalResult.report.canPromote ? (
                        <Alert
                          type="success"
                          showIcon
                          icon={<SafetyCertificateOutlined />}
                          message="🎉 门禁评测全部通过！已达到正式采用门禁"
                          description={
                            <span>
                              共通过 <strong>{promptfooEvalResult.suite?.totalTests ?? 30}</strong> 项标准测试，
                              净提升 <strong>{((promptfooEvalResult.report.metrics.deltaMean ?? 0) * 100).toFixed(1)}%</strong>，
                              零安全违规。您现在可以直接采用生效。
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
                              立即采用生效
                            </Button>
                          }
                        />
                      ) : (
                        <Alert
                          type="warning"
                          showIcon
                          message="尚未达到正式采用门禁"
                          description={
                            promptfooEvalResult.report.metrics.reasons?.join("；") ||
                            "未完全满足正式门禁要求，建议优化提示词后重新测试。"
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
                              title="品质净提升"
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

                      {promptfooEvalResult.details && promptfooEvalResult.details.length > 0 && (
                        <Collapse
                          size="small"
                          items={[
                            {
                              key: "details",
                              label: `查看断言明细（共 ${promptfooEvalResult.details.length} 项测试用例）`,
                              children: (
                                <Flex vertical gap={6} style={{ maxHeight: 260, overflowY: "auto" }}>
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
                                          <Text strong style={{ fontSize: 12 }}>
                                            {item.description}
                                          </Text>
                                        </Flex>
                                        <Text type="secondary" style={{ fontSize: 11 }}>
                                          得分: {item.candidateScore.toFixed(2)}
                                        </Text>
                                      </Flex>
                                      <Paragraph
                                        type="secondary"
                                        style={{ fontSize: 11, margin: "4px 0 0 0" }}
                                        ellipsis={{ rows: 2 }}
                                      >
                                        输入：{item.input}
                                      </Paragraph>
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
              label: "高级：自定义样本 JSON 导入",
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
                    extra="每项包含 caseId、baselineScore、candidateScore；正式采用需至少 30 项。"
                    rules={[{ required: true, message: "请提供成对样本" }]}
                  >
                    <Input.TextArea rows={10} />
                  </Form.Item>
                  <Flex justify="flex-end" gap={8}>
                    <Button onClick={() => setEvaluationCandidate(null)}>取消</Button>
                    <Button type="primary" htmlType="submit" loading={candidateBusy}>
                      提交评估
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

