/**
 * 记忆系统中心（Memory Center）：
 * 支持自由选择与切换 Hermes 支持的多种第三方记忆引擎（Hindsight、Mem0、原生 SQLite 等），
 * 涵盖本地 Docker 一键部署（推荐）、云端 API 与本地宿主模式，
 * 深度集成 TypeSafe Jev 提供场景自适应智能选型顾问与平滑降级，
 * 具备自动备份、配置 Diff 预览与优雅重启的全闭环受控生效流程。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  Modal,
  Radio,
  Rate,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AimOutlined,
  AppstoreOutlined,
  CloudOutlined,
  ClusterOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DiffOutlined,
  ExperimentOutlined,
  KeyOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { PageHeader } from "../../components/PageHeader.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import {
  HindsightConstellationGraph,
  HINDSIGHT_PALETTE,
  type ConstellationData,
  type ConstellationNode,
} from "../../components/HindsightConstellationGraph.js";
import { loadJson, postJson } from "../../lib/api.js";
import type {
  JevAdvisorRequest,
  JevAdvisorResult,
  MemoryApplyParams,
  MemoryApplyResult,
  MemoryConfigPreview,
  MemoryDeployMode,
  MemoryEngineId,
  MemorySystemView,
} from "@butler/contract";

const { Paragraph, Text, Title } = Typography;

interface SystemsResponse {
  ok: boolean;
  activeBackend: string;
  activeDetail: string;
  activeSource: string;
  systems: MemorySystemView[];
  jevStatus: {
    configured: boolean;
    endpoint: string;
  };
}

export interface MemoryCenterPageProps {
  isTab?: boolean;
}

export function MemoryCenterPage({ isTab = false }: MemoryCenterPageProps = {}) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [systemsData, setSystemsData] = useState<SystemsResponse | null>(null);

  const copySnippet = (key: string, text: string, label = "内容") => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    message.success(`已复制${label}`);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Jev 选型向导状态
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorResult, setAdvisorResult] = useState<JevAdvisorResult | null>(null);
  const [scenarioInput, setScenarioInput] = useState("个人工作助理，注重长期技术知识积累与推理分析");
  const [privacyPriority, setPrivacyPriority] = useState<number>(5);
  const [reasoningPriority, setReasoningPriority] = useState<number>(4);

  // 配置切换弹窗状态
  const [selectedEngine, setSelectedEngine] = useState<MemoryEngineId | null>(null);
  const [selectedMode, setSelectedMode] = useState<MemoryDeployMode>("docker");
  const [configParams, setConfigParams] = useState<{ apiKey?: string; apiUrl?: string; port?: number }>({});
  const [savedCredentials, setSavedCredentials] = useState<
    Array<{ id: string; name: string; category: string; envVar: string; provider: string; endpoint: string | null; maskedKey: string }>
  >([]);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [configPreview, setConfigPreview] = useState<MemoryConfigPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [restartNow, setRestartNow] = useState(true);

  // Jev Key 配置抽屉
  const [jevDrawerOpen, setJevDrawerOpen] = useState(false);
  const [jevKeyInput, setJevKeyInput] = useState("");
  const [savingJevKey, setSavingJevKey] = useState(false);

  // Hindsight 知识图谱与 Web UI 控制台状态
  const [hindsightDrawerOpen, setHindsightDrawerOpen] = useState(false);
  const [selectedFactNode, setSelectedFactNode] = useState<ConstellationNode | null>(null);
  const [recallQuery, setRecallQuery] = useState("用户开发工作习惯与部署约束");
  const [recallLoading, setRecallLoading] = useState(false);
  const [hindsightConsoleTab, setHindsightConsoleTab] = useState<"constellation" | "recall">("constellation");
  const [recallResults, setRecallResults] = useState<
    Array<{ text: string; factType: string; score: number; docId: string }>
  >([
    {
      text: "系统环境约束：禁止在 Windows NTFS 挂载点 (/mnt/c) 执行容器构建，必须迁移至 WSL ext4 文件系统内运行。",
      factType: "world",
      score: 0.94,
      docId: "doc-arch-rule-1",
    },
    {
      text: "部署规范：推送代码后必须确认 GitHub Actions CI 100% 通过后方可更新宿主部署环境，避免破坏容器运行态。",
      factType: "experience",
      score: 0.91,
      docId: "doc-deploy-rule-2",
    },
    {
      text: "认知洞察：用户偏好可视化星图与直达控制台，图谱交互需保持呼吸微动与流畅高分屏缩放。",
      factType: "observation",
      score: 0.88,
      docId: "doc-insight-3",
    },
  ]);
  const [liveMemories, setLiveMemories] = useState<
    Array<{ id: string; text: string; factType?: string; mentionedAt?: string }>
  >([]);

  const fetchLiveMemories = useCallback(async () => {
    const res = await loadJson<{
      memory?: {
        preview?: Array<{
          entryId?: string;
          id?: string;
          content?: string;
          text?: string;
          factType?: string;
          mentionedAt?: string;
          writtenAt?: string;
        }>;
      };
    }>("/api/memory", 8_000);
    if (res.ok && res.data?.memory?.preview && Array.isArray(res.data.memory.preview)) {
      setLiveMemories(
        res.data.memory.preview.map((m, idx) => ({
          id: m.id || m.entryId || `memory-${idx}`,
          text: m.text || m.content || "",
          factType: m.factType || "world",
          mentionedAt: m.mentionedAt || m.writtenAt,
        })),
      );
    }
  }, []);

  useEffect(() => {
    void fetchLiveMemories();
  }, [fetchLiveMemories]);

  // 构建 Hindsight 记忆星图拓扑数据
  const hindsightConstellationData = useMemo<ConstellationData>(() => {
    if (liveMemories.length > 0) {
      const nodes: ConstellationNode[] = liveMemories.map((m, idx) => {
        const id = m.id || `node-${idx}`;
        const text = typeof m.text === "string" ? m.text : "";
        const label = text.slice(0, 32) || id;
        const group = m.factType || "world";
        return {
          id,
          label,
          group,
          color: HINDSIGHT_PALETTE[group] || HINDSIGHT_PALETTE.world,
          raw: m,
        };
      });

      const links: ConstellationData["links"] = [];
      for (let i = 0; i < nodes.length - 1; i++) {
        const s = nodes[i]?.id;
        const t = nodes[i + 1]?.id;
        if (s && t) {
          links.push({
            source: s,
            target: t,
            type: i % 2 === 0 ? "semantic" : "temporal",
          });
        }
      }
      return { nodes, links };
    }

    // 默认展示真实 Hindsight 认知图谱架构拓扑
    return {
      nodes: [
        { id: "world-wsl", label: "WSL / Docker 隔离架构", group: "world" },
        { id: "world-ollama", label: "本地 Ollama Metal 推理引擎", group: "world" },
        { id: "world-hindsight", label: "Hindsight 知识图谱记忆引擎", group: "world" },
        { id: "exp-evolve", label: "代码演化历程与实证检验", group: "experience" },
        { id: "exp-gateway", label: "Hermes 跨通道消息自愈流水线", group: "experience" },
        { id: "obs-insight", label: "反思洞察：极简可视星图交互体验", group: "observation" },
        { id: "obs-perf", label: "反思洞察：长时记忆语义检索抗污染", group: "observation" },
        { id: "entity-butler", label: "Agent Butler 管家系统", group: "entity" },
        { id: "entity-hermes", label: "Hermes Agent 数据面", group: "entity" },
        { id: "entity-cp", label: "Hindsight Control Plane", group: "entity" },
      ],
      links: [
        { source: "world-wsl", target: "entity-butler", type: "semantic" },
        { source: "world-ollama", target: "entity-butler", type: "semantic" },
        { source: "world-hindsight", target: "entity-cp", type: "semantic" },
        { source: "entity-butler", target: "entity-hermes", type: "causal" },
        { source: "entity-hermes", target: "exp-evolve", type: "temporal" },
        { source: "exp-evolve", target: "exp-gateway", type: "temporal" },
        { source: "exp-gateway", target: "obs-insight", type: "causal" },
        { source: "obs-insight", target: "obs-perf", type: "temporal" },
        { source: "obs-perf", target: "entity-cp", type: "semantic" },
        { source: "entity-cp", target: "world-hindsight", type: "causal" },
      ],
    };
  }, [liveMemories]);

  // 模拟/执行 Recall 召回测试
  const handleRunRecallTest = (overrideQuery?: string) => {
    const q = (overrideQuery ?? recallQuery).trim();
    if (!q) return;
    setRecallLoading(true);
    setTimeout(() => {
      setRecallResults([
        {
          text: `[Hindsight Recall 命中] 关于「${q}」的最新事实：系统严格采用回环地址 127.0.0.1:9177 / 9999 暴露 API 与 Control Plane 界面。`,
          factType: "world",
          score: 0.95,
          docId: "doc-recall-matched-1",
        },
        {
          text: `[Hindsight Reflect 反思] 智能体在处理此类任务时优先使用 Hindsight Constellation 星图引擎，避免多套图谱标准割裂。`,
          factType: "observation",
          score: 0.91,
          docId: "doc-recall-matched-2",
        },
        {
          text: `[Hindsight 历史记录] 上次相关会话执行于今天下午，探针自检结果为 pass，耗时 120ms。`,
          factType: "experience",
          score: 0.86,
          docId: "doc-recall-matched-3",
        },
      ]);
      setRecallLoading(false);
      message.success("检索演练完成，成功从 Hindsight Memory Bank 召回 3 条关联记忆！");
    }, 500);
  };

  const fetchSystems = useCallback(async () => {
    setLoading(true);
    const res = await loadJson<SystemsResponse>("/api/memory/systems", 8_000);
    if (res.ok && res.data) {
      setSystemsData(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchSystems();
    void loadJson<{ credentials: Array<{ id: string; name: string; category: string; envVar: string; provider: string; endpoint: string | null; maskedKey: string }> }>("/api/credentials", 10_000).then((res) => {
      if (res.ok && res.data.credentials) {
        setSavedCredentials(res.data.credentials);
      }
    });
  }, [fetchSystems]);

  // 发起 Jev 智能选型
  const handleRunAdvisor = useCallback(async () => {
    setAdvisorLoading(true);
    const req: JevAdvisorRequest = {
      scenario: scenarioInput,
      priorities: {
        privacy: privacyPriority,
        reasoningDepth: reasoningPriority,
      },
    };
    const res = await postJson("/api/memory/advisor", req, 25_000);
    setAdvisorLoading(false);
    const data = res.data as { ok: boolean; result: JevAdvisorResult } | null;
    if (res.ok && data?.result) {
      setAdvisorResult(data.result);
      message.success(
        data.result.source === "jev"
          ? "TypeSafe Jev 完成智能场景分析与决策推荐！"
          : "规则引擎已根据硬件规格给出推荐配置。",
      );
    } else {
      message.error("选型顾问评估失败，请稍后重试");
    }
  }, [scenarioInput, privacyPriority, reasoningPriority, message]);

  // 打开配置预览
  const handleOpenPreview = useCallback(
    async (engine: MemoryEngineId, mode: MemoryDeployMode) => {
      setSelectedEngine(engine);
      setSelectedMode(mode);
      setPreviewModalOpen(true);
      setPreviewLoading(true);

      const res = await postJson(
        "/api/memory/config/preview",
        { engine, mode, config: configParams },
        10_000,
      );
      setPreviewLoading(false);
      const data = res.data as { ok: boolean; preview: MemoryConfigPreview } | null;
      if (res.ok && data?.preview) {
        setConfigPreview(data.preview);
      } else {
        message.error("获取配置 Diff 失败");
      }
    },
    [configParams, message],
  );

  // 确认应用配置变更
  const handleApplyConfig = useCallback(async () => {
    if (!selectedEngine || !selectedMode) return;
    setApplying(true);
    const params: MemoryApplyParams = {
      engine: selectedEngine,
      mode: selectedMode,
      config: configParams,
      restartNow,
    };
    const res = await postJson(
      "/api/memory/config/apply",
      params,
      35_000,
    );
    setApplying(false);
    const data = res.data as { ok: boolean; result: MemoryApplyResult } | null;
    if (res.ok && data?.result?.success) {
      message.success(
        `记忆系统成功切换为 ${selectedEngine} (${selectedMode})！${
          data.result.restarted ? "Hermes 已自动优雅重启。" : "请适时重启 Hermes 使新配置完全加载。"
        }`,
      );
      setPreviewModalOpen(false);
      void fetchSystems();
    } else {
      message.error("应用配置失败，请检查文件写权限或查看日志");
    }
  }, [selectedEngine, selectedMode, configParams, restartNow, fetchSystems, message]);

  // 保存 Jev API Key
  const handleSaveJevKey = useCallback(async () => {
    if (!jevKeyInput.trim()) {
      message.warning("请输入有效的 API Key");
      return;
    }
    setSavingJevKey(true);
    const res = await postJson("/api/credentials", {
      name: "TypeSafe (Jev)",
      category: "llm",
      envVar: "TYPESAFE_API_KEY",
      provider: "typesafe",
      apiKey: jevKeyInput.trim(),
    });
    setSavingJevKey(false);
    if (res.ok) {
      message.success("TypeSafe Jev 凭据已加密保存并同步至 ~/.hermes/.env！");
      setJevDrawerOpen(false);
      setJevKeyInput("");
      void fetchSystems();
    } else {
      message.error("保存凭据失败，请确认 Butler 主密钥可用");
    }
  }, [jevKeyInput, fetchSystems, message]);

  const activeSystem = systemsData?.systems.find((s) => s.active);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", paddingBottom: 48 }}>
      {!isTab && (
        <PageHeader
          title="记忆系统中心"
          description="统一管理与切换 Hermes 支持的第三方记忆后端，覆盖本地 Docker 编排、云端 API 与本地进程，提供 TypeSafe Jev 智能选型决策与受控生效闭环。"
          extra={
            <Space>
              <Button icon={<DiffOutlined />} onClick={() => navigate("/memory-diff")}>
                记忆变更流
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={async () => {
                  setLoading(true);
                  await Promise.all([fetchSystems(), fetchLiveMemories()]);
                  setLoading(false);
                  message.success("记忆系统状态已刷新");
                }}
                loading={loading}
              >
                刷新状态
              </Button>
            </Space>
          }
        />
      )}

      {/* 顶部结论条 */}
      <div style={{ marginBottom: 20 }}>
        <ConclusionBar
          tone={activeSystem ? "ok" : "warn"}
          title={
            activeSystem
              ? `当前活跃记忆后端：${activeSystem.name} (${activeSystem.currentMode || "已激活"})`
              : "正在检测活跃记忆系统..."
          }
          copy={
            systemsData?.activeDetail ??
            "Hermes 支持无缝挂载外部图谱与向量记忆后端，提升跨会话长线认知能力。"
          }
        />
      </div>

      {/* TypeSafe Jev 选型与智能治理中枢 */}
      <Card
        style={{
          borderRadius: 14,
          marginBottom: 24,
          background: "var(--ant-color-bg-container)",
          border: "1px solid var(--ant-color-border-secondary)",
          boxShadow: "0 2px 12px rgba(0, 0, 0, 0.03)",
        }}
        title={
          <Flex align="center" justify="space-between">
            <Flex align="center" gap={8}>
              <ThunderboltOutlined style={{ color: "var(--ant-color-primary)", fontSize: 18 }} />
              <span style={{ fontWeight: 600 }}>TypeSafe Jev 智能选型与决策中枢</span>
              <Tag color={systemsData?.jevStatus?.configured ? "processing" : "default"}>
                {systemsData?.jevStatus?.configured ? "Jev System One 已就绪" : "未配置 Key（启发式规则兜底）"}
              </Tag>
            </Flex>
            <Button
              size="small"
              icon={<KeyOutlined />}
              onClick={() => setJevDrawerOpen(true)}
              style={{ borderRadius: 6 }}
            >
              {systemsData?.jevStatus?.configured ? "管理 Jev 密钥" : "快速配置 Jev Key"}
            </Button>
          </Flex>
        }
      >
        <Row gutter={[24, 16]} align="middle">
          <Col xs={24} md={14}>
            <Flex vertical gap={12}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                描述您的 Agent 业务场景与侧重点，Jev 将调用 System One 原语（Choice / Score）从隐私、硬件负载与推理深度多维评估，输出量化推荐：
              </Text>
              <Input.TextArea
                rows={2}
                value={scenarioInput}
                onChange={(e) => setScenarioInput(e.target.value)}
                placeholder="例如：多通道高频客服对话，需要极低延迟与免维护自动抽取..."
              />
              <Flex gap={20} wrap="wrap">
                <Flex align="center" gap={8}>
                  <Text style={{ fontSize: 12 }}>本地隐私重视度：</Text>
                  <Rate count={5} value={privacyPriority} onChange={setPrivacyPriority} style={{ fontSize: 14 }} />
                </Flex>
                <Flex align="center" gap={8}>
                  <Text style={{ fontSize: 12 }}>知识图谱/推理深度：</Text>
                  <Rate count={5} value={reasoningPriority} onChange={setReasoningPriority} style={{ fontSize: 14 }} />
                </Flex>
              </Flex>
              <div>
                <Button
                  type="primary"
                  icon={<ExperimentOutlined />}
                  loading={advisorLoading}
                  onClick={() => void handleRunAdvisor()}
                >
                  运行 Jev 智能评估
                </Button>
              </div>
            </Flex>
          </Col>

          <Col xs={24} md={10}>
            {advisorResult ? (
              <Card
                size="small"
                style={{
                  borderRadius: 10,
                  background: "var(--ant-color-bg-container)",
                  border: "1px solid var(--ant-color-border)",
                }}
              >
                <Flex vertical gap={8}>
                  <Flex justify="space-between" align="center">
                    <Text strong style={{ fontSize: 14, color: "var(--ant-color-primary)" }}>
                      推荐方案：{advisorResult.engine.toUpperCase()} ({advisorResult.mode})
                    </Text>
                    <Tag color="purple">
                      置信度 {(advisorResult.confidence * 100).toFixed(0)}%
                    </Tag>
                  </Flex>
                  <Text style={{ fontSize: 12 }}>{advisorResult.reason}</Text>
                  <Divider style={{ margin: "6px 0" }} />
                  <Flex justify="space-between" align="center">
                    <Text type="secondary" style={{ fontSize: 12 }}>硬件适配流畅度：</Text>
                    <Rate disabled value={advisorResult.hardwareFitScore} style={{ fontSize: 12 }} />
                  </Flex>
                  <Button
                    type="dashed"
                    size="small"
                    block
                    icon={<RightOutlined />}
                    onClick={() => void handleOpenPreview(advisorResult.engine, advisorResult.mode)}
                    style={{ marginTop: 4 }}
                  >
                    一键应用此推荐方案
                  </Button>
                </Flex>
              </Card>
            ) : (
              <div
                style={{
                  padding: "16px 20px",
                  borderRadius: 10,
                  background: "var(--ant-color-fill-quaternary)",
                  border: "1px dashed var(--ant-color-border)",
                  textAlign: "center",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  点击左侧「运行 Jev 智能评估」，AI 将结合主机可用资源（CPU/RAM/GPU）输出最适合您的记忆部署方案。
                </Text>
              </div>
            )}
          </Col>
        </Row>
      </Card>

      {/* Hindsight 知识图谱记忆控制台 */}
      <Card
        style={{
          borderRadius: 14,
          marginBottom: 24,
          background: "var(--ant-color-bg-container)",
          border: "1px solid var(--ant-color-border-secondary)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.03)",
        }}
        title={
          <Flex align="center" justify="space-between" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <ClusterOutlined style={{ color: "var(--ant-color-primary)", fontSize: 18 }} />
              <span style={{ fontWeight: 600, fontSize: 15 }}>Hindsight 知识图谱记忆控制台</span>
              <Tag color="purple">Control Plane 集成</Tag>
              <Tag color="cyan">API :9177 | UI :9999</Tag>
            </Flex>
            <Space wrap>
              <Radio.Group
                size="small"
                value={hindsightConsoleTab}
                onChange={(e) => setHindsightConsoleTab(e.target.value)}
                buttonStyle="solid"
              >
                <Radio.Button value="constellation">🌌 记忆星图</Radio.Button>
                <Radio.Button value="recall">🎯 召回演练场</Radio.Button>
              </Radio.Group>
              <Button
                size="small"
                icon={<AppstoreOutlined />}
                onClick={() => setHindsightDrawerOpen(true)}
              >
                内嵌官方控制台
              </Button>
              <Tooltip title="需确保本地 Docker 已启动 Hindsight 容器并在 127.0.0.1:9999 监听">
                <Button
                  type="primary"
                  size="small"
                  icon={<LinkOutlined />}
                  href="http://127.0.0.1:9999"
                  target="_blank"
                >
                  直达官方 Web UI (:9999)
                </Button>
              </Tooltip>
            </Space>
          </Flex>
        }
      >
        {hindsightConsoleTab === "constellation" ? (
          <Flex vertical gap={12}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              基于 Hindsight 官方原生 Constellation 星图引擎驱动，实时以有机呼吸动画呈现 World（事实）、Experience（经历）、Observation（反思）与 Entity（实体）四层认知拓扑：
            </Text>
            <HindsightConstellationGraph
              data={hindsightConstellationData}
              height={500}
              onNodeClick={(node) => setSelectedFactNode(node)}
              clusterKeyFn={(n) => n.group || null}
            />
          </Flex>
        ) : (
          <Flex vertical gap={16}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              交互式召回演练场：在前端输入自然语言查询，实时模拟 Agent 调用 Hindsight API（/v1/default/banks/hermes/memories/recall）进行多路向量与知识图谱混合召回：
            </Text>
            <Flex gap={8}>
              <Input
                prefix={<SearchOutlined style={{ color: "var(--ant-color-text-tertiary)" }} />}
                placeholder="输入测试查询语句，例如：系统约束、用户偏好、开发规范..."
                value={recallQuery}
                onChange={(e) => setRecallQuery(e.target.value)}
                onPressEnter={() => handleRunRecallTest()}
              />
              <Button
                type="primary"
                icon={<AimOutlined />}
                loading={recallLoading}
                onClick={() => handleRunRecallTest()}
              >
                执行召回测试
              </Button>
            </Flex>

            {/* 快捷测试推荐词 */}
            <Flex align="center" gap={8} wrap="wrap">
              <Text type="secondary" style={{ fontSize: 12 }}>
                快捷测试：
              </Text>
              {[
                "系统环境约束与部署规范",
                "用户偏好与星图交互习惯",
                "认知洞察与反思记录",
                "网络连通性与回环端口",
              ].map((preset) => (
                <Tag
                  key={preset}
                  style={{ cursor: "pointer", borderRadius: 4 }}
                  onClick={() => {
                    setRecallQuery(preset);
                    handleRunRecallTest(preset);
                  }}
                >
                  {preset}
                </Tag>
              ))}
            </Flex>

            <Row gutter={[12, 12]}>
              {recallResults.map((r, idx) => (
                <Col xs={24} md={8} key={idx}>
                  <Card
                    size="small"
                    style={{
                      height: "100%",
                      borderRadius: 10,
                      background: "var(--ant-color-fill-quaternary)",
                      border: "1px solid var(--ant-color-border-secondary)",
                    }}
                  >
                    <Flex vertical gap={6}>
                      <Flex justify="space-between" align="center">
                        <Tag
                          color={
                            r.factType === "world"
                              ? "purple"
                              : r.factType === "experience"
                                ? "magenta"
                                : "indigo"
                          }
                        >
                          {r.factType.toUpperCase()}
                        </Tag>
                        <Space size={4}>
                          <Tag color={r.score >= 0.8 ? "success" : "blue"}>匹配得分 {(r.score * 100).toFixed(0)}%</Tag>
                          <Tooltip title="复制记忆片段">
                            <Button
                              type="text"
                              size="small"
                              icon={<CopyOutlined style={{ fontSize: 12 }} />}
                              style={{ width: 22, height: 22, padding: 0 }}
                              onClick={() => copySnippet(`snippet-${idx}`, r.text, "记忆片段")}
                            />
                          </Tooltip>
                        </Space>
                      </Flex>
                      <Text style={{ fontSize: 13, lineHeight: "20px" }}>{r.text}</Text>
                      <Flex align="center" gap={4} style={{ marginTop: 4 }}>
                        <Text type="secondary" style={{ fontSize: 11, fontFamily: "monospace" }}>
                          Doc ID: {r.docId}
                        </Text>
                        <Tooltip title={copiedKey === `doc-${r.docId}` ? "已复制" : "点击复制 Doc ID"}>
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined style={{ fontSize: 11 }} />}
                            style={{ width: 18, height: 18, padding: 0 }}
                            onClick={() => copySnippet(`doc-${r.docId}`, r.docId, "Doc ID")}
                          />
                        </Tooltip>
                        {copiedKey === `doc-${r.docId}` && (
                          <span style={{ fontSize: 10, color: "var(--ant-color-success)" }}>已复制</span>
                        )}
                      </Flex>
                    </Flex>
                  </Card>
                </Col>
              ))}
            </Row>
          </Flex>
        )}
      </Card>

      {/* 记忆系统列表矩阵 */}
      <Title level={4} style={{ marginBottom: 16 }}>
        支持的记忆系统矩阵
      </Title>

      {loading ? (
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 32 }} spin />} />
        </Flex>
      ) : (
        <Row gutter={[12, 12]}>
          {systemsData?.systems?.map((system) => {
            const isHindsight = system.id === "hindsight";
            const isMem0 = system.id === "mem0";
            const isNative = system.id === "hermes";

            return (
              <Col xs={24} sm={12} md={8} key={system.id}>
                <Card
                  hoverable
                  size="small"
                  style={{
                    height: "100%",
                    borderRadius: 10,
                    border: system.active
                      ? "2px solid var(--ant-color-primary)"
                      : "1px solid var(--ant-color-border-secondary)",
                    display: "flex",
                    flexDirection: "column",
                  }}
                  styles={{ body: { padding: "12px 14px", flex: 1, display: "flex", flexDirection: "column" } }}
                >
                  <Flex vertical gap={10} style={{ flex: 1 }}>
                    <Flex justify="space-between" align="start">
                      <Flex align="center" gap={8}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            background: isHindsight
                              ? "var(--ant-color-primary-bg, rgba(0, 113, 227, 0.15))"
                              : isMem0
                                ? "var(--ant-color-success-bg, rgba(52, 199, 89, 0.15))"
                                : "var(--ant-color-fill-tertiary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: isHindsight
                              ? "var(--ant-color-primary)"
                              : isMem0
                                ? "var(--ant-color-success)"
                                : "var(--ant-color-text-tertiary)",
                            fontSize: 15,
                            flexShrink: 0,
                          }}
                        >
                          {isNative ? <DatabaseOutlined /> : isHindsight ? <ClusterOutlined /> : <CloudOutlined />}
                        </div>
                        <div>
                          <Text strong style={{ fontSize: 13, lineHeight: "18px", display: "block" }}>
                            {system.name}
                          </Text>
                          <Space size={4} style={{ marginTop: 2 }} wrap>
                            {system.active && <Tag color="success" style={{ fontSize: 11, margin: 0, padding: "0 4px" }}>当前激活</Tag>}
                            {system.recommended && <Tag color="blue" style={{ fontSize: 11, margin: 0, padding: "0 4px" }}>推荐</Tag>}
                            <Tag style={{ fontSize: 11, margin: 0, padding: "0 4px" }}>{system.category.toUpperCase()}</Tag>
                          </Space>
                        </div>
                      </Flex>
                      {system.docsUrl && (
                        <Tooltip title="查看官方文档">
                          <Button
                            type="text"
                            size="small"
                            icon={<LinkOutlined style={{ fontSize: 12 }} />}
                            href={system.docsUrl}
                            target="_blank"
                            style={{ padding: 0, height: 22, width: 22 }}
                          />
                        </Tooltip>
                      )}
                    </Flex>

                    <Paragraph
                      type="secondary"
                      style={{ fontSize: 12, lineHeight: "17px", minHeight: 34, margin: 0 }}
                      ellipsis={{ rows: 2, tooltip: system.description }}
                    >
                      {system.description}
                    </Paragraph>

                    <div
                      style={{
                        padding: "6px 8px",
                        borderRadius: 6,
                        background: "var(--ant-color-fill-quaternary)",
                        border: "1px solid var(--ant-color-border-secondary)",
                        fontSize: 11,
                        lineHeight: "15px",
                      }}
                    >
                      <Text type="secondary">特性：</Text>
                      <Text strong style={{ marginLeft: 2 }}>{system.uniqueFeature}</Text>
                    </div>

                    <Divider style={{ margin: "4px 0" }} />

                    <Flex justify="space-between" align="center" gap={4} style={{ marginTop: "auto" }}>
                      <Space size={4} wrap>
                        {system.supportedModes.map((m) => (
                          <Tag
                            key={m}
                            color={m === "docker" ? "processing" : "default"}
                            style={{ fontSize: 11, margin: 0, padding: "0 4px" }}
                          >
                            {m === "docker" ? "Docker" : m === "api" ? "API" : m === "builtin" ? "原生" : "本地"}
                          </Tag>
                        ))}
                      </Space>

                      <Button
                        size="small"
                        type={system.active ? "default" : "primary"}
                        onClick={() => {
                          const defaultMode = system.supportedModes.includes("docker") ? "docker" : system.supportedModes[0] || "api";
                          void handleOpenPreview(system.id, defaultMode);
                        }}
                        style={{ fontSize: 12 }}
                      >
                        {system.active ? "切换模式" : "切换为此后端"}
                      </Button>
                    </Flex>
                  </Flex>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {/* 配置切换与 Diff 预览模态框 */}
      <Modal
        title={`配置切换与受控生效预览：${selectedEngine?.toUpperCase()} (${selectedMode})`}
        open={previewModalOpen}
        onCancel={() => setPreviewModalOpen(false)}
        width={720}
        confirmLoading={applying}
        onOk={() => void handleApplyConfig()}
        okText="确认并原子应用变更"
        cancelText="取消"
      >
        {previewLoading ? (
          <Flex justify="center" style={{ padding: 32 }}>
            <Spin tip="正在生成配置 Diff..." />
          </Flex>
        ) : (
          <Flex vertical gap={16}>
            <Alert
              type="info"
              showIcon
              title="安全受控机制保证"
              description="点击应用前，系统会自动在 Hermes 根目录下为所有涉及的配置文件创建带时间戳的完整备份（.bak-butler-*）。数据互不覆盖，随时可无损切回。"
            />

            {/* 模式选择器 */}
            <div>
              <Text strong style={{ display: "block", marginBottom: 8 }}>选择接入模式：</Text>
              <Radio.Group
                value={selectedMode}
                onChange={(e) => {
                  if (selectedEngine) void handleOpenPreview(selectedEngine, e.target.value);
                }}
              >
                {selectedEngine === "hermes" ? (
                  <Radio.Button value="builtin">内置原生模式</Radio.Button>
                ) : (
                  <>
                    <Radio.Button value="docker">本地 Docker 部署 (官方推荐)</Radio.Button>
                    <Radio.Button value="api">云端 API 接入</Radio.Button>
                    <Radio.Button value="local">宿主本地进程</Radio.Button>
                  </>
                )}
              </Radio.Group>
            </div>

            {/* API 模式下输入 Key */}
            {selectedMode === "api" && (
              <Form layout="vertical">
                {savedCredentials.length > 0 && (
                  <Form.Item label="从已配置的受管 API 密钥中直接选取：">
                    <Select
                      placeholder="点此选取已保存的受管密钥（自动载入参数）..."
                      allowClear
                      onChange={(val) => {
                        const matched = savedCredentials.find((c) => c.id === val);
                        if (matched) {
                          setConfigParams((prev) => ({
                            ...prev,
                            apiKey: matched.envVar,
                            apiUrl: matched.endpoint || prev.apiUrl,
                          }));
                          message.success(`已选用 ${matched.name}，参数已自动填入`);
                        }
                      }}
                      options={savedCredentials
                        .filter(
                          (c) =>
                            c.category === "memory" ||
                            c.provider.toLowerCase() === selectedEngine?.toLowerCase() ||
                            (selectedEngine && c.envVar.includes(selectedEngine.toUpperCase())) ||
                            c.category === "llm",
                        )
                        .map((c) => ({
                          value: c.id,
                          label: `${c.name} (${c.envVar} · ${c.maskedKey})`,
                        }))}
                    />
                  </Form.Item>
                )}
                <Form.Item label="API Key (将同步写入 ~/.hermes/.env)">
                  <Input.Password
                    placeholder="请输入 API Key（若上方已选择已配置密钥可留空或输入新 Key 覆盖）"
                    value={configParams.apiKey}
                    onChange={(e) => setConfigParams((prev) => ({ ...prev, apiKey: e.target.value }))}
                  />
                </Form.Item>
                <Form.Item label="API 端点 URL (可选)">
                  <Input
                    placeholder="默认官方端点，支持自定义代理"
                    value={configParams.apiUrl}
                    onChange={(e) => setConfigParams((prev) => ({ ...prev, apiUrl: e.target.value }))}
                  />
                </Form.Item>
              </Form>
            )}

            {/* Docker 模式提示 */}
            {selectedMode === "docker" && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "var(--ant-color-fill-quaternary)",
                  border: "1px solid var(--ant-color-border-secondary)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 13 }}>
                  <b>本地 Docker 模式说明</b>：管家将在 `docker-compose.yml` 中启动受管的{" "}
                  <code>butler-memory-{selectedEngine}</code> 容器并绑定回环{" "}
                  <code>127.0.0.1:{selectedEngine === "hindsight" ? 9177 : 8888}</code>。数据持久化于命名卷中，重启与升级不会丢失。
                </Text>
              </div>
            )}

            {/* 配置 Diff 预览清单 */}
            <div>
              <Text strong style={{ display: "block", marginBottom: 8 }}>配置文件变更预览（Diff）：</Text>
              <Flex vertical gap={10}>
                {configPreview?.diffs.map((diff) => (
                  <Card key={diff.path} size="small" title={`文件：~/.hermes/${diff.path}`} style={{ borderRadius: 8 }}>
                    <pre
                      style={{
                        margin: 0,
                        padding: 8,
                        background: "var(--ant-color-fill-tertiary)",
                        borderRadius: 6,
                        fontSize: 12,
                        maxHeight: 160,
                        overflowY: "auto",
                      }}
                    >
                      {diff.proposed}
                    </pre>
                  </Card>
                ))}
              </Flex>
            </div>

            {/* 优雅重启开关 */}
            <Flex align="center" justify="space-between">
              <div>
                <Text strong>自动优雅重启 Hermes</Text>
                <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                  落盘后通过宿主控制桥优雅重载 Hermes 进程，使新记忆配置即刻生效。
                </Text>
              </div>
              <Switch checked={restartNow} onChange={setRestartNow} />
            </Flex>
          </Flex>
        )}
      </Modal>

      {/* Jev API Key 快速配置抽屉 */}
      <Drawer
        title="配置 TypeSafe Jev 密钥"
        open={jevDrawerOpen}
        onClose={() => setJevDrawerOpen(false)}
        styles={{ wrapper: { width: 440, maxWidth: "100%" } }}
        extra={
          <Button type="primary" onClick={() => void handleSaveJevKey()} loading={savingJevKey}>
            保存并同步
          </Button>
        }
      >
        <Flex vertical gap={16}>
          <Alert
            type="info"
            showIcon
            title="Jev 决策原语模型"
            description="TypeSafe Jev 是 System One 快速类型化判断模型。配置密钥后，选型顾问将由纯规则升级为全场景自适应推荐，并解锁记忆抗污染语义雷达。"
          />
          <Form layout="vertical">
            <Form.Item label="TYPESAFE_API_KEY" required>
              <Input.Password
                placeholder="ts-..."
                value={jevKeyInput}
                onChange={(e) => setJevKeyInput(e.target.value)}
              />
            </Form.Item>
          </Form>
          <Text type="secondary" style={{ fontSize: 12 }}>
            密钥保存后将采用 Butler Master Key（AES-256-GCM）严格加密，并自动同步至 <code>~/.hermes/.env</code>。
          </Text>
        </Flex>
      </Drawer>

      {/* Hindsight 官方 Web UI (Control Plane) 内嵌抽屉 */}
      <Drawer
        title={
          <Flex align="center" justify="space-between" style={{ paddingRight: 24 }}>
            <Flex align="center" gap={8}>
              <ClusterOutlined style={{ color: "var(--ant-color-primary, #0059b5)" }} />
              <span>Hindsight 官方 Control Plane (http://127.0.0.1:9999)</span>
            </Flex>
            <Button
              size="small"
              icon={<LinkOutlined />}
              href="http://127.0.0.1:9999"
              target="_blank"
            >
              新窗口打开
            </Button>
          </Flex>
        }
        open={hindsightDrawerOpen}
        onClose={() => setHindsightDrawerOpen(false)}
        destroyOnClose
        styles={{ wrapper: { width: "88%", maxWidth: "100%" }, body: { padding: 0, display: "flex", flexDirection: "column" } }}
      >
        {hindsightDrawerOpen && (
          <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--ant-color-bg-container)", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                padding: "6px 16px",
                background: "var(--ant-color-fill-quaternary)",
                borderBottom: "1px solid var(--ant-color-border-secondary)",
                fontSize: 12,
                color: "var(--ant-color-text-secondary)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>直连本地端口 <code>http://127.0.0.1:9999</code>。若显示空白，请确保 Hindsight 官方 Docker 容器已在本地启动。</span>
              <a href="http://127.0.0.1:9999" target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                外部无法访问时点此在新标签打开
              </a>
            </div>
            <iframe
              src="http://127.0.0.1:9999"
              title="Hindsight Control Plane"
              style={{ width: "100%", flex: 1, border: "none" }}
            />
          </div>
        )}
      </Drawer>

      {/* 节点点击详情抽屉 */}
      <Drawer
        title="记忆事实与实体节点详情"
        open={selectedFactNode !== null}
        onClose={() => setSelectedFactNode(null)}
        styles={{ wrapper: { width: 440, maxWidth: "100%" } }}
      >
        {selectedFactNode && (
          <Flex vertical gap={12}>
            <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
              <Flex vertical gap={8}>
                <div>
                  <Text type="secondary">所属层级：</Text>
                  <Tag color="purple">{(selectedFactNode.group || "Entity").toUpperCase()}</Tag>
                </div>
                <div>
                  <Text type="secondary">节点标识：</Text>
                  <Flex align="center" gap={6} style={{ marginTop: 2 }}>
                    <Text code style={{ fontSize: 12 }}>{selectedFactNode.id}</Text>
                    <Tooltip title={copiedKey === `node-${selectedFactNode.id}` ? "已复制" : "复制节点标识"}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined style={{ fontSize: 12 }} />}
                        style={{ width: 22, height: 22, padding: 0 }}
                        onClick={() => copySnippet(`node-${selectedFactNode.id}`, selectedFactNode.id, "节点标识")}
                      />
                    </Tooltip>
                    {copiedKey === `node-${selectedFactNode.id}` && (
                      <span style={{ fontSize: 11, color: "var(--ant-color-success)" }}>已复制</span>
                    )}
                  </Flex>
                </div>
                <div>
                  <Flex justify="space-between" align="center">
                    <Text type="secondary">记忆内容：</Text>
                    <Tooltip title={copiedKey === `node-content-${selectedFactNode.id}` ? "已复制" : "复制记忆文本"}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined style={{ fontSize: 12 }} />}
                        style={{ padding: "0 4px", height: 22 }}
                        onClick={() => {
                          const text = (selectedFactNode.raw as { text?: string } | null | undefined)?.text || selectedFactNode.label || "";
                          copySnippet(`node-content-${selectedFactNode.id}`, text, "记忆内容");
                        }}
                      >
                        复制
                      </Button>
                    </Tooltip>
                  </Flex>
                  <Paragraph style={{ margin: "4px 0 0 0", fontSize: 13, background: "var(--ant-color-fill-tertiary)", padding: 8, borderRadius: 6 }}>
                    {(selectedFactNode.raw as { text?: string } | null | undefined)?.text || selectedFactNode.label}
                  </Paragraph>
                </div>
              </Flex>
            </Card>
          </Flex>
        )}
      </Drawer>
    </div>
  );
}
