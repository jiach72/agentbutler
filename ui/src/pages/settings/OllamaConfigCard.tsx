/**
 * Ollama 本地模型管理与硬件自适应配置卡片。
 *
 * 严格对齐界面交互规范：
 * 1. 服务状态自动检测（可用/不可用标签 + 重新检测按钮）；
 * 2. 服务地址只读展示（默认 http://ollama:11434）；
 * 3. 动态硬件体检与自适应推荐标签（点击自动填充下载框）；
 * 4. 模型下载器（流式进度条 + 官方模型库链接）；
 * 5. 已安装模型列表（卡片展示、体积与日期、一键绑定探针、删除）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Dropdown,
  Empty,
  Flex,
  Input,
  type MenuProps,
  Popconfirm,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApiOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  LineChartOutlined,
  LinkOutlined,
  LoadingOutlined,
  MessageOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  TableOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { MemoryProbeConfig, PrimaryModelConfig } from "@butler/contract";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import {
  ChartEmpty,
  ChartSkeleton,
  TrendCard,
  TrendColumn,
} from "../../components/charts/index.js";
import {
  chartThemeFor,
  quietAxes,
  semanticSeries,
  topLegend,
} from "../../components/charts/chartTheme.js";
import { useTheme } from "../../theme/ThemeProvider.js";

const { Text, Title, Link } = Typography;

interface OllamaStatus {
  available: boolean;
  version?: string;
  endpoint: string;
  error?: string;
}

interface RecommendedModel {
  name: string;
  tag: string;
  fullName: string;
  category: "embedding" | "probe" | "extraction" | "chat" | "reasoning";
  categoryLabel: string;
  sizeDisplay: string;
  reason: string;
  highlight?: boolean;
}

interface HardwareProfilePayload {
  hardware: {
    cpu: { model: string; cores: number; logicalCores: number };
    memory: { totalBytes: number; totalGb: number; freeGb: number };
    gpu: { detected: boolean; name: string; vramGb?: number; isUnified?: boolean } | null;
    platform: string;
    arch: string;
    host?: {
      cpu?: { model?: string; cores?: number; logicalCores?: number };
      memory?: { totalGb?: number };
      isContainerized: boolean;
    };
    container?: {
      cpu: { model: string; cores: number; logicalCores: number };
      memory: { totalBytes: number; totalGb: number; freeGb: number };
    };
  };
  evaluation: {
    tier: 1 | 2 | 3 | 4;
    tierLabel: string;
    hardwareSummary: string;
    description: string;
    recommendations: RecommendedModel[];
  };
}

interface OllamaModelItem {
  name: string;
  model: string;
  size: number;
  sizeFormatted: string;
  modifiedAt: string;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface PullStatusPayload {
  pull: {
    name: string;
    status: string;
    completed: number;
    total: number;
    percentage: number;
    error?: string;
    updatedAt: number;
  } | null;
}

interface DailyUsageMetric {
  date: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgTokensPerSecond: number;
}

interface OllamaUsageSummary {
  todayCalls: number;
  todayPromptTokens: number;
  todayCompletionTokens: number;
  todayTokens: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgTokensPerSecond: number;
  dailyHistory: DailyUsageMetric[];
}

interface ChatTestResult {
  ok: boolean;
  model: string;
  reply?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    tokensPerSecond: number;
  };
}

export function OllamaConfigCard() {
  const { message } = App.useApp();

  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const [hwProfile, setHwProfile] = useState<HardwareProfilePayload | null>(null);

  const [models, setModels] = useState<OllamaModelItem[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);

  const searchedModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.details?.family && m.details.family.toLowerCase().includes(q)) ||
        (m.details?.parameter_size && m.details.parameter_size.toLowerCase().includes(q)),
    );
  }, [models, modelSearch]);

  const [downloadInput, setDownloadInput] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullStatusPayload["pull"]>(null);

  const [usageSummary, setUsageSummary] = useState<OllamaUsageSummary | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const [testModel, setTestModel] = useState<string>("");
  const [testPrompt, setTestPrompt] = useState<string>("你好，请做个简短的自我介绍。");
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<ChatTestResult | null>(null);

  const [primaryModel, setPrimaryModel] = useState<PrimaryModelConfig | null>(null);
  const [probeConfig, setProbeConfig] = useState<MemoryProbeConfig | null>(null);
  const [instanceBindingModel, setInstanceBindingModel] = useState<string | null>(null);
  const [assigningModel, setAssigningModel] = useState<string | null>(null);

  const { mode } = useTheme();
  const [usageViewMode, setUsageViewMode] = useState<"tokens" | "calls" | "table">("tokens");

  const chartTheme = useMemo(() => chartThemeFor(mode), [mode]);
  const tokenSeries = useMemo(
    () =>
      semanticSeries(mode, [
        ["输入 (Prompt)", "输入 (Prompt)", "accent"],
        ["输出 (Completion)", "输出 (Completion)", "brand"],
      ]),
    [mode],
  );

  const tokenRows = useMemo(() => {
    return (usageSummary?.dailyHistory ?? []).flatMap((item) => {
      const shortDate = item.date.length >= 10 ? item.date.slice(5) : item.date;
      return [
        { date: shortDate, fullDate: item.date, type: "输入 (Prompt)", tokens: item.promptTokens },
        { date: shortDate, fullDate: item.date, type: "输出 (Completion)", tokens: item.completionTokens },
      ];
    });
  }, [usageSummary]);

  const callRows = useMemo(() => {
    return (usageSummary?.dailyHistory ?? []).map((item) => {
      const shortDate = item.date.length >= 10 ? item.date.slice(5) : item.date;
      return {
        date: shortDate,
        fullDate: item.date,
        count: item.callCount,
        type: "调用次数",
      };
    });
  }, [usageSummary]);

  // 1. 检查服务健康状态
  const checkStatus = useCallback(async () => {
    setCheckingStatus(true);
    const res = await loadJson<OllamaStatus>("/api/ollama/status", 5000);
    setCheckingStatus(false);
    if (res.ok) {
      setStatus(res.data);
    } else {
      setStatus({
        available: false,
        endpoint: "http://ollama:11434",
        error: res.reason,
      });
    }
  }, []);

  // 2. 加载当前机器客观硬件信息与自适应推荐
  const loadHardwareProfile = useCallback(async () => {
    const res = await loadJson<HardwareProfilePayload>("/api/ollama/hardware-profile", 5000);
    if (res.ok) {
      setHwProfile(res.data);
    }
  }, []);

  // 3. 加载已下载模型列表
  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    const res = await loadJson<{ ok: boolean; models: OllamaModelItem[]; error?: string }>(
      "/api/ollama/models",
      6000,
    );
    setLoadingModels(false);
    if (res.ok && res.data.ok) {
      setModels(res.data.models);
    }
  }, []);

  // 4. 轮询下载进度
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (pulling) {
      timer = setInterval(async () => {
        const res = await loadJson<PullStatusPayload>("/api/ollama/pull-status", 4000);
        if (res.ok && res.data.pull) {
          const p = res.data.pull;
          setPullProgress(p);
          if (p.status === "success") {
            setPulling(false);
            message.success(`模型 ${p.name} 下载完成！`);
            void loadModels();
          } else if (p.status === "failed") {
            setPulling(false);
            message.error(`模型下载失败: ${p.error || "未知错误"}`);
          }
        }
      }, 1500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [pulling, loadModels, message]);

  // 5. 加载每日调用量与 Token 汇总统计
  const loadUsageSummary = useCallback(async () => {
    setLoadingUsage(true);
    const res = await loadJson<{ ok: boolean; summary: OllamaUsageSummary }>(
      "/api/ollama/usage/summary?days=14",
      5000,
    );
    setLoadingUsage(false);
    if (res.ok && res.data.ok) {
      setUsageSummary(res.data.summary);
    }
  }, []);

  // 6. 发起测试对话
  const handleTestChat = async () => {
    const targetModel = testModel || models[0]?.name;
    if (!targetModel) {
      message.warning("请先选择或下载要测试的模型");
      return;
    }
    if (!testPrompt.trim()) {
      message.warning("请输入测试提示词");
      return;
    }
    setTestingChat(true);
    setChatResult(null);
    const res = await postJson(
      "/api/ollama/test-chat",
      { model: targetModel, prompt: testPrompt },
      60_000,
    );
    setTestingChat(false);
    if (res.ok && res.data) {
      const resultData = res.data as ChatTestResult;
      setChatResult(resultData);
      if (resultData.ok) {
        message.success("模型响应成功，Token 统计已实时更新！");
        void loadUsageSummary();
      } else {
        message.error(`模型响应失败: ${resultData.error || "未知错误"}`);
      }
    } else {
      message.error(`调用接口失败 (HTTP ${res.status})`);
    }
  };

  useEffect(() => {
    if (models.length > 0 && !testModel) {
      setTestModel(models[0]?.name || "");
    }
  }, [models, testModel]);

  // 7. 加载各模型角色的实时生效分配情况（主对话、记忆探针、实例默认）
  const loadRoles = useCallback(async () => {
    try {
      const [pRes, probeRes, bRes, profRes] = await Promise.all([
        loadJson<{ ok: boolean; primary: PrimaryModelConfig }>("/api/models/primary", 5000),
        loadJson<{ ok?: boolean; config?: MemoryProbeConfig } & Partial<MemoryProbeConfig>>("/api/memory-probe/config", 5000),
        loadJson<{ bindings: Array<{ scope: string; profileId: string }> }>("/api/llm/bindings", 5000),
        loadJson<{ profiles: Array<{ profileId: string; model: string }> }>("/api/llm/profiles", 5000),
      ]);

      if (pRes.ok && pRes.data?.primary) {
        setPrimaryModel(pRes.data.primary);
      }
      if (probeRes.ok && probeRes.data) {
        const raw = probeRes.data;
        const cfg = raw.config ?? (raw.intervalMin !== undefined ? (raw as unknown as MemoryProbeConfig) : null);
        if (cfg) {
          setProbeConfig(cfg);
        }
      }
      if (bRes.ok && profRes.ok && Array.isArray(bRes.data?.bindings)) {
        const instBinding = bRes.data.bindings.find((b) => b.scope === "instance");
        if (instBinding) {
          const prof = profRes.data?.profiles?.find((p) => p.profileId === instBinding.profileId);
          setInstanceBindingModel(prof?.model ?? null);
        } else {
          setInstanceBindingModel(null);
        }
      }
    } catch {
      // 容错降级
    }
  }, []);

  // 快捷分配模型角色（主对话模型、记忆探针、实例默认）
  const handleAssignRole = async (modelName: string, roleKey: "primary" | "probe" | "instance") => {
    setAssigningModel(modelName);
    try {
      const endpoint = status?.endpoint ? `${status.endpoint}/v1` : "http://ollama:11434/v1";

      if (roleKey === "primary") {
        const res = await postJson(
          "/api/models/primary",
          {
            provider: "ollama",
            model: modelName,
            endpoint,
            source: "ollama",
          },
          30_000,
        );
        if (res.ok) {
          message.success(`已成功将 ${modelName} 设为 Hermes 主对话模型并备份重载！`);
          await loadRoles();
        } else {
          message.error("设为主对话模型失败，请检查管家服务连接");
        }
      } else if (roleKey === "probe") {
        const res = await postJson(
          "/api/memory-probe/config",
          {
            modelId: `ollama:${modelName}`,
            modelName,
            endpoint,
            isLocal: true,
          },
          15_000,
        );
        if (res.ok) {
          message.success(`已成功将 ${modelName} 设为记忆探针模型（全天候 0 成本事实抽取）！`);
          await loadRoles();
        } else {
          message.error("设为记忆探针模型失败，请检查管家服务连接");
        }
      } else if (roleKey === "instance") {
        const profileId = `ollama-${modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        await postJson(
          "/api/llm/profiles",
          {
            profileId,
            provider: "Ollama (本地)",
            protocol: "openai-compatible",
            endpoint,
            model: modelName,
            apiKey: "ollama",
          },
          10_000,
        );
        const bindRes = await postJson(
          "/api/llm/bindings",
          {
            profileId,
            scope: "instance",
            instanceId: "hermes-main",
            frameworkId: "hermes",
          },
          15_000,
        );
        if (bindRes.ok) {
          message.success(`已成功将 ${modelName} 设为 Butler 实例默认调度模型！`);
          await loadRoles();
        } else {
          message.error("设为实例默认模型失败，请检查管家服务连接");
        }
      }
    } finally {
      setAssigningModel(null);
    }
  };

  // 初始化加载
  useEffect(() => {
    void checkStatus();
    void loadHardwareProfile();
    void loadModels();
    void loadUsageSummary();
    void loadRoles();
  }, [checkStatus, loadHardwareProfile, loadModels, loadUsageSummary, loadRoles]);

  // 发起下载模型
  const handleStartPull = async (modelToPull?: string) => {
    const target = (modelToPull || downloadInput).trim();
    if (!target) {
      message.warning("请输入要下载的模型名称");
      return;
    }
    setPulling(true);
    setPullProgress({
      name: target,
      status: "starting",
      completed: 0,
      total: 0,
      percentage: 0,
      updatedAt: Date.now(),
    });

    const res = await postJson("/api/ollama/pull", { name: target }, 10_000);
    if (res.ok) {
      message.info(`已开始在后台拉取模型: ${target}`);
    } else {
      setPulling(false);
      message.error("发起下载失败，请确认 Ollama 容器运行中");
    }
  };

  // 删除模型
  const handleDeleteModel = async (name: string) => {
    const res = await deleteJson(`/api/ollama/models/${encodeURIComponent(name)}`, 10_000);
    if (res.ok) {
      message.success(`已删除模型 ${name}`);
      void loadModels();
    } else {
      message.error("删除模型失败");
    }
  };

  return (
    <Card className="ollama-config-card" style={{ marginBottom: 24 }}>
      <Flex vertical gap={24}>
        {/* 标题 */}
        <div>
          <Title level={4} style={{ marginBottom: 4 }}>
            Ollama 配置
          </Title>
          <Text type="secondary">管理本地 Ollama 服务，查看和下载模型</Text>
        </div>

        {/* 1. 服务状态区块 */}
        <div>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 8 }}>
            <Text strong style={{ fontSize: 15 }}>
              Ollama 服务状态
            </Text>
            <Space>
              {checkingStatus ? (
                <Tag icon={<LoadingOutlined />} color="processing">
                  检测中...
                </Tag>
              ) : status?.available ? (
                <Tag
                  icon={<CheckCircleFilled style={{ color: "var(--ab-ok)" }} />}
                  style={{
                    backgroundColor: "var(--ab-ok-soft)",
                    borderColor: "var(--ab-ok)",
                    color: "var(--ab-ok)",
                    fontWeight: 500,
                    padding: "2px 8px",
                  }}
                >
                  可用
                </Tag>
              ) : (
                <Tag
                  icon={<CloseCircleFilled style={{ color: "var(--ab-error)" }} />}
                  style={{
                    backgroundColor: "var(--ab-error-soft)",
                    borderColor: "var(--ab-error)",
                    color: "var(--ab-error)",
                    fontWeight: 500,
                    padding: "2px 8px",
                  }}
                >
                  不可用
                </Tag>
              )}
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={checkingStatus}
                onClick={checkStatus}
              >
                重新检测
              </Button>
            </Space>
          </Flex>
          <Text type="secondary">
            自动检测本地 Ollama 服务是否可用。如果服务未运行或地址配置错误，将显示“不可用”状态
          </Text>
          {status && !status.available && (
            <Alert
              style={{ marginTop: 8 }}
              type="warning"
              showIcon
              title="未检测到运行中的 Ollama 服务"
              description={`请确保在 docker-compose.yml 中已启动 ollama 容器，或宿主机已开启 Ollama 引擎（默认地址：${status.endpoint}）。`}
            />
          )}
        </div>

        <div style={{ height: 1, backgroundColor: "var(--ab-border)" }} />

        {/* 2. 服务地址区块 */}
        <div>
          <div style={{ marginBottom: 6 }}>
            <Text strong style={{ fontSize: 15 }}>
              服务地址
            </Text>
          </div>
          <Text type="secondary" style={{ display: "block", marginBottom: 10 }}>
            本地 Ollama 服务的 API 地址，由系统自动检测。如需修改，请在 .env 配置文件中设置
          </Text>
          <Input
            disabled
            value={status?.endpoint || "http://ollama:11434"}
            style={{
              maxWidth: 460,
              backgroundColor: "var(--ab-surface-2)",
              color: "var(--ab-text-1)",
              borderColor: "var(--ab-border)",
              cursor: "default",
            }}
          />
        </div>

        <div style={{ height: 1, backgroundColor: "var(--ab-border)" }} />

        {/* 3. 动态硬件自适应推荐（核心动态引擎） */}
        {hwProfile && (
          <div
            style={{
              backgroundColor: "var(--ab-surface-2)",
              border: "1px solid var(--ab-border)",
              borderRadius: 8,
              padding: 16,
            }}
          >
            <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 8 }}>
              <Space>
                <ThunderboltOutlined style={{ color: "var(--ab-warn)", fontSize: 16 }} />
                <Text strong style={{ fontSize: 14 }}>
                  当前设备算力体检：{hwProfile.evaluation.tierLabel}
                </Text>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {hwProfile.evaluation.hardwareSummary}
              </Text>
            </Flex>
            <Text type="secondary" style={{ fontSize: 13, display: "block", marginBottom: 12 }}>
              {hwProfile.evaluation.description}
            </Text>

            <div>
              <Text style={{ fontSize: 12, color: "var(--ab-text-3)", display: "block", marginBottom: 6 }}>
                根据当前机器客观硬件，推荐适用的轻量记忆与探针模型（点击标签可直接填入下载）：
              </Text>
              <Flex wrap="wrap" gap={8}>
                {hwProfile.evaluation.recommendations.map((rec) => (
                  <Tooltip key={rec.fullName} title={`${rec.reason} · 体积: ${rec.sizeDisplay}`}>
                    <Tag
                      color={rec.highlight ? "blue" : "default"}
                      style={{
                        cursor: "pointer",
                        padding: "3px 10px",
                        fontSize: 13,
                        borderRadius: 4,
                      }}
                      onClick={() => {
                        setDownloadInput(rec.fullName);
                        message.info(`已填入模型: ${rec.fullName}`);
                      }}
                    >
                      <Space size={4}>
                        <Tag
                          bordered={false}
                          color={rec.category === "embedding" ? "purple" : rec.category === "probe" ? "green" : "cyan"}
                          style={{ marginInlineEnd: 0, paddingInline: 4, fontSize: 11 }}
                        >
                          {rec.categoryLabel}
                        </Tag>
                        <span>{rec.fullName}</span>
                        <span style={{ color: "var(--ab-text-3)", fontSize: 11 }}>({rec.sizeDisplay})</span>
                      </Space>
                    </Tag>
                  </Tooltip>
                ))}
              </Flex>
            </div>
          </div>
        )}

        {/* 4. 下载新模型区块 */}
        <div>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 6 }}>
            <Text strong style={{ fontSize: 15 }}>
              下载新模型
            </Text>
          </Flex>
          <Flex align="center" gap={8} style={{ marginBottom: 10 }}>
            <Text type="secondary">输入模型名称下载，</Text>
            <Link href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">
              浏览 Ollama 模型库 <LinkOutlined />
            </Link>
          </Flex>

          <Flex gap={12} align="center" style={{ maxWidth: 650 }}>
            <Input
              placeholder="如: qwen2.5:0.5b"
              value={downloadInput}
              onChange={(e) => setDownloadInput(e.target.value)}
              onPressEnter={() => handleStartPull()}
              disabled={pulling}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              icon={pulling ? <LoadingOutlined /> : <DownloadOutlined />}
              loading={pulling}
              onClick={() => handleStartPull()}
            >
              {pulling ? "下载中" : "下载"}
            </Button>
          </Flex>

          {/* 下载进度条 */}
          {pullProgress && pullProgress.status !== "idle" && (
            <div
              style={{
                marginTop: 12,
                maxWidth: 650,
                backgroundColor: "#f9f9f9",
                border: "1px solid #e8e8e8",
                borderRadius: 6,
                padding: "10px 14px",
              }}
            >
              <Flex justify="space-between" align="center" style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 13 }}>
                  正在下载: {pullProgress.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {pullProgress.status}
                </Text>
              </Flex>
              <Progress
                percent={pullProgress.percentage}
                status={
                  pullProgress.status === "failed"
                    ? "exception"
                    : pullProgress.status === "success"
                      ? "success"
                      : "active"
                }
                size="small"
              />
              {pullProgress.total > 0 && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  进度: {Math.round((pullProgress.completed / (1024 * 1024)) * 10) / 10} MB /{" "}
                  {Math.round((pullProgress.total / (1024 * 1024)) * 10) / 10} MB
                </Text>
              )}
            </div>
          )}
        </div>

        <div style={{ height: 1, backgroundColor: "var(--ab-border)" }} />

        {/* 5. 已下载的模型区块 */}
        <div>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 6 }}>
            <Text strong style={{ fontSize: 15 }}>
              已下载的模型 ({models.length})
            </Text>
            <Flex align="center" gap={8}>
              {models.length > 0 && (
                <Input.Search
                  placeholder="搜索本地模型..."
                  allowClear
                  size="small"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  style={{ width: 170, maxWidth: "100%" }}
                />
              )}
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={loadingModels}
                onClick={loadModels}
              >
                刷新
              </Button>
            </Flex>
          </Flex>
          <Text type="secondary" style={{ display: "block", marginBottom: 14 }}>
            已安装在 Ollama 中的模型列表。点击卡片上的【快捷分配角色】可自由指派为 Hermes 主对话、记忆探针或实例默认调度模型。
          </Text>

          {searchedModels.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                modelSearch.trim()
                  ? `未找到与 “${modelSearch.trim()}” 相关的本地模型`
                  : status?.available
                    ? "暂无已下载模型，请在上方输入模型名称下载"
                    : "Ollama 服务未连接"
              }
            >
              {modelSearch.trim() !== "" && (
                <Button size="small" onClick={() => setModelSearch("")}>
                  清空筛选
                </Button>
              )}
            </Empty>
          ) : (
            <Flex wrap="wrap" gap={12}>
              {searchedModels.map((item) => {
                const isEmbed =
                  item.name.toLowerCase().includes("embed") ||
                  item.details?.family?.toLowerCase().includes("bert") === true;
                const isPrimary = Boolean(
                  primaryModel?.model &&
                    (primaryModel.model === item.name ||
                      primaryModel.model.toLowerCase() === item.name.toLowerCase()),
                );
                const isProbe = Boolean(
                  (probeConfig?.modelName &&
                    (probeConfig.modelName === item.name ||
                      probeConfig.modelName.toLowerCase() === item.name.toLowerCase())) ||
                    (probeConfig?.modelId &&
                      (probeConfig.modelId === `ollama:${item.name}` ||
                        probeConfig.modelId.toLowerCase() === `ollama:${item.name.toLowerCase()}`)),
                );
                const isInstance = Boolean(
                  instanceBindingModel &&
                    (instanceBindingModel === item.name ||
                      instanceBindingModel.toLowerCase() === item.name.toLowerCase()),
                );
                const hasAnyRole = isPrimary || isProbe || isInstance;

                const roleMenuItems: MenuProps["items"] = [
                  {
                    key: "primary",
                    label: (
                      <div style={{ padding: "4px 0" }}>
                        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                          <span>设为 Hermes 主对话模型</span>
                          {isPrimary && <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>当前生效</Tag>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--ab-text-3)", marginTop: 2 }}>
                          系统的核心日常对话大脑 (Core Chat)，修改后重载网关
                        </div>
                      </div>
                    ),
                    icon: <MessageOutlined style={{ color: "var(--ab-primary)", fontSize: 14 }} />,
                    disabled: isPrimary,
                  },
                  {
                    type: "divider",
                  },
                  {
                    key: "probe",
                    label: (
                      <div style={{ padding: "4px 0" }}>
                        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                          <span>设为记忆探针抽取模型</span>
                          {isProbe && <Tag color="green" style={{ fontSize: 10, margin: 0 }}>当前生效</Tag>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--ab-text-3)", marginTop: 2 }}>
                          用于后台记忆提炼与事实抽取 (Memory Probe)，0 成本运行
                        </div>
                      </div>
                    ),
                    icon: <ExperimentOutlined style={{ color: "var(--ab-ok)", fontSize: 14 }} />,
                    disabled: isProbe,
                  },
                  {
                    type: "divider",
                  },
                  {
                    key: "instance",
                    label: (
                      <div style={{ padding: "4px 0" }}>
                        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                          <span>设为 Butler 实例默认调度模型</span>
                          {isInstance && <Tag color="orange" style={{ fontSize: 10, margin: 0 }}>当前生效</Tag>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--ab-text-3)", marginTop: 2 }}>
                          Butler 任务调度、代码分析与技能执行的默认底层 LLM (Binding)
                        </div>
                      </div>
                    ),
                    icon: <ApiOutlined style={{ color: "var(--ab-warning)", fontSize: 14 }} />,
                    disabled: isInstance,
                  },
                ];

                return (
                  <div
                    key={item.name}
                    style={{
                      minWidth: 270,
                      maxWidth: 330,
                      padding: "14px 16px",
                      backgroundColor: "var(--ab-surface-2)",
                      border: isPrimary
                        ? "1px solid var(--ab-primary)"
                        : hasAnyRole
                          ? "1px solid var(--ab-ok)"
                          : "1px solid var(--ab-border)",
                      borderRadius: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      boxShadow: isPrimary ? "0 0 0 1px var(--ab-primary)" : "none",
                    }}
                  >
                    <Flex justify="space-between" align="flex-start" gap={8}>
                      <Flex vertical gap={4} style={{ overflow: "hidden" }}>
                        <Text
                          strong
                          copyable={{ text: item.name, tooltips: ["复制模型名称", "已复制"] }}
                          style={{
                            fontSize: 14,
                            wordBreak: "break-all",
                            color: "var(--ab-text-1)",
                          }}
                        >
                          {item.name}
                        </Text>
                        {isEmbed && (
                          <Tag color="purple" style={{ width: "fit-content", fontSize: 11 }}>
                            向量嵌入模型 (记忆检索)
                          </Tag>
                        )}
                      </Flex>
                      <Popconfirm
                        title="确认从本地删除该模型？"
                        description="删除后将释放磁盘空间，后续可重新下载。"
                        onConfirm={() => handleDeleteModel(item.name)}
                        okText="确认删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          title="删除模型"
                        />
                      </Popconfirm>
                    </Flex>

                    <Flex justify="space-between" align="center">
                      <Text type="secondary" style={{ fontSize: 12, color: "var(--ab-text-3)" }}>
                        {item.sizeFormatted}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12, color: "var(--ab-text-3)" }}>
                        {item.modifiedAt}
                      </Text>
                    </Flex>

                    {/* 当前已生效的角色徽章展示 */}
                    <Flex wrap="wrap" gap={6} align="center" style={{ minHeight: 24 }}>
                      {isPrimary && (
                        <Tag
                          color="blue"
                          icon={<MessageOutlined />}
                          style={{ margin: 0, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3 }}
                        >
                          主对话模型
                        </Tag>
                      )}
                      {isProbe && (
                        <Tag
                          color="green"
                          icon={<ExperimentOutlined />}
                          style={{ margin: 0, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3 }}
                        >
                          记忆探针
                        </Tag>
                      )}
                      {isInstance && (
                        <Tag
                          color="orange"
                          icon={<ApiOutlined />}
                          style={{ margin: 0, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3 }}
                        >
                          实例默认
                        </Tag>
                      )}
                      {!hasAnyRole && !isEmbed && (
                        <Text type="secondary" style={{ fontSize: 11, color: "var(--ab-text-3)" }}>
                          未分配角色
                        </Text>
                      )}
                    </Flex>

                    {/* 操作区域 */}
                    {isEmbed ? (
                      <div style={{ marginTop: 2 }}>
                        <Text type="secondary" style={{ fontSize: 12, color: "var(--ab-text-3)" }}>
                          专用向量模型（不可设为对话角色）
                        </Text>
                      </div>
                    ) : (
                      <div style={{ marginTop: 2 }}>
                        <Dropdown
                          menu={{
                            items: roleMenuItems,
                            onClick: ({ key }) =>
                              void handleAssignRole(item.name, key as "primary" | "probe" | "instance"),
                          }}
                          trigger={["click"]}
                        >
                          <Button
                            size="small"
                            type={hasAnyRole ? "default" : "primary"}
                            ghost={!hasAnyRole}
                            loading={assigningModel === item.name}
                            icon={<SettingOutlined />}
                            style={{ width: "fit-content" }}
                          >
                            快捷分配角色 <DownOutlined style={{ fontSize: 10, marginLeft: 2 }} />
                          </Button>
                        </Dropdown>
                      </div>
                    )}
                  </div>
                );
              })}
            </Flex>
          )}
          </div>

          <Divider style={{ margin: "18px 0" }} />

          {/* 6. 每日调用量与 Token 消耗大盘 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Flex align="center" gap={8}>
                <BarChartOutlined style={{ fontSize: 16, color: "var(--ab-primary)" }} />
                <Text strong style={{ fontSize: 15 }}>
                  调用量与 Token 消耗监控
                </Text>
                <Tag color="blue">每日统计</Tag>
              </Flex>
              <Button
                size="small"
                icon={<ReloadOutlined spin={loadingUsage} />}
                onClick={() => void loadUsageSummary()}
              >
                刷新统计
              </Button>
            </Flex>

            {/* 汇总统计指标卡片 */}
            <Flex wrap="wrap" gap={12}>
              <div
                style={{
                  flex: "1 1 180px",
                  minWidth: 160,
                  padding: "12px 14px",
                  background: "var(--ab-surface-2)",
                  borderRadius: 8,
                  border: "1px solid var(--ab-border)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  今日调用量
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ab-primary)", marginTop: 4 }}>
                  {usageSummary?.todayCalls ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--ab-text-3)" }}>次</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  今日发起的本地推理请求
                </Text>
              </div>

              <div
                style={{
                  flex: "1 1 180px",
                  minWidth: 160,
                  padding: "12px 14px",
                  background: "var(--ab-surface-2)",
                  borderRadius: 8,
                  border: "1px solid var(--ab-border)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  今日 Token 消耗
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ab-ok)", marginTop: 4 }}>
                  {(usageSummary?.todayTokens ?? 0).toLocaleString()}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--ab-text-3)" }}>Tokens</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  输入 {(usageSummary?.todayPromptTokens ?? 0).toLocaleString()} · 输出{" "}
                  {(usageSummary?.todayCompletionTokens ?? 0).toLocaleString()}
                </Text>
              </div>

              <div
                style={{
                  flex: "1 1 180px",
                  minWidth: 160,
                  padding: "12px 14px",
                  background: "var(--ab-surface-2)",
                  borderRadius: 8,
                  border: "1px solid var(--ab-border)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  累计调用总数
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ab-text)", marginTop: 4 }}>
                  {usageSummary?.totalCalls ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--ab-text-3)" }}>次</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  历史调用次数总计
                </Text>
              </div>

              <div
                style={{
                  flex: "1 1 180px",
                  minWidth: 160,
                  padding: "12px 14px",
                  background: "var(--ab-surface-2)",
                  borderRadius: 8,
                  border: "1px solid var(--ab-border)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  累计总 Token 消耗
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ab-text)", marginTop: 4 }}>
                  {(usageSummary?.totalTokens ?? 0).toLocaleString()}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--ab-text-3)" }}>Tokens</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  输入 {(usageSummary?.totalPromptTokens ?? 0).toLocaleString()} · 输出{" "}
                  {(usageSummary?.totalCompletionTokens ?? 0).toLocaleString()}
                </Text>
              </div>

              <div
                style={{
                  flex: "1 1 180px",
                  minWidth: 160,
                  padding: "12px 14px",
                  background: "var(--ab-surface-2)",
                  borderRadius: 8,
                  border: "1px solid var(--ab-border)",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  平均生成速率
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ab-warn)", marginTop: 4 }}>
                  {usageSummary?.avgTokensPerSecond ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "var(--ab-text-3)" }}>tokens/s</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  本地模型生成吞吐
                </Text>
              </div>
            </Flex>

            {/* 6.2 14 天每日调用趋势与 Token 消耗图表 */}
            <div style={{ marginTop: 6 }}>
              <TrendCard
                title="最近 14 天每日调用趋势与 Token 消耗"
                summary={
                  usageSummary
                    ? `近 14 天累计调用 ${usageSummary.totalCalls} 次 · 消耗 ${usageSummary.totalTokens.toLocaleString()} Tokens · 平均生成速率 ${usageSummary.avgTokensPerSecond} tokens/s`
                    : "正在读取本地调用统计…"
                }
                extra={
                  <Segmented
                    size="small"
                    value={usageViewMode}
                    onChange={(val) => setUsageViewMode(val as "tokens" | "calls" | "table")}
                    options={[
                      { label: "Token 消耗趋势", value: "tokens", icon: <BarChartOutlined /> },
                      { label: "调用频次趋势", value: "calls", icon: <LineChartOutlined /> },
                      { label: "每日数据表格", value: "table", icon: <TableOutlined /> },
                    ]}
                  />
                }
              >
                {loadingUsage ? (
                  <ChartSkeleton height={220} />
                ) : usageViewMode === "tokens" ? (
                  !usageSummary || usageSummary.totalTokens === 0 ? (
                    <ChartEmpty hint="近 14 天尚未产生本地模型调用；可在下方发起在线测试体验 Token 吞吐。" />
                  ) : (
                    <TrendColumn
                      data={tokenRows}
                      xField="date"
                      yField="tokens"
                      colorField="type"
                      transform={[{ type: "stackY" }]}
                      theme={chartTheme.g2Theme}
                      autoFit
                      height={220}
                      scale={{ color: { range: tokenSeries.map((s) => s.color) } }}
                      axis={quietAxes(chartTheme, { integerY: true })}
                      legend={topLegend(chartTheme)}
                      style={{ maxWidth: 28, radiusTopLeft: 3, radiusTopRight: 3 }}
                      tooltip={{
                        items: [
                          {
                            field: "tokens",
                            name: "Token",
                            valueFormatter: (val: number) => Number(val).toLocaleString(),
                          },
                        ],
                      }}
                    />
                  )
                ) : usageViewMode === "calls" ? (
                  !usageSummary || usageSummary.totalCalls === 0 ? (
                    <ChartEmpty hint="近 14 天尚未产生本地模型调用记录。" />
                  ) : (
                    <TrendColumn
                      data={callRows}
                      xField="date"
                      yField="count"
                      colorField="type"
                      theme={chartTheme.g2Theme}
                      autoFit
                      height={220}
                      scale={{ color: { range: [chartTheme.seriesColors[0] || "var(--ab-primary)"] } }}
                      axis={quietAxes(chartTheme, { integerY: true })}
                      style={{ maxWidth: 24, radiusTopLeft: 3, radiusTopRight: 3 }}
                      tooltip={{
                        items: [
                          {
                            field: "count",
                            name: "调用次数",
                            valueFormatter: (val: number) => `${val} 次`,
                          },
                        ],
                      }}
                    />
                  )
                ) : (
                  <Table
                    size="small"
                    dataSource={usageSummary?.dailyHistory || []}
                    rowKey="date"
                    pagination={{ pageSize: 7, size: "small" }}
                    columns={[
                      { title: "日期", dataIndex: "date", key: "date", width: 120 },
                      {
                        title: "调用次数",
                        dataIndex: "callCount",
                        key: "callCount",
                        width: 100,
                        render: (val: number) => (
                          <Tag color={val > 0 ? "blue" : "default"}>{val} 次</Tag>
                        ),
                      },
                      {
                        title: "输入 (Prompt)",
                        dataIndex: "promptTokens",
                        key: "promptTokens",
                        render: (val: number) => val.toLocaleString(),
                      },
                      {
                        title: "输出 (Completion)",
                        dataIndex: "completionTokens",
                        key: "completionTokens",
                        render: (val: number) => val.toLocaleString(),
                      },
                      {
                        title: "总消耗 Token",
                        dataIndex: "totalTokens",
                        key: "totalTokens",
                        render: (val: number) => <Text strong>{val.toLocaleString()}</Text>,
                      },
                      {
                        title: "平均速率",
                        dataIndex: "avgTokensPerSecond",
                        key: "avgTokensPerSecond",
                        render: (val: number) => (val > 0 ? `${val} tokens/s` : "-"),
                      },
                    ]}
                  />
                )}
              </TrendCard>
            </div>
          </div>

          <Divider style={{ margin: "18px 0" }} />

          {/* 7. 本地模型在线测试与 Token 探测 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Flex align="center" gap={8}>
                <ThunderboltOutlined style={{ fontSize: 16, color: "var(--ab-warn)" }} />
                <Text strong style={{ fontSize: 15 }}>
                  本地模型在线测试与 Token 探测
                </Text>
                <Tag color="orange">冒烟测试</Tag>
              </Flex>
            </Flex>

            <Text type="secondary" style={{ fontSize: 13 }}>
              向本地模型发起对话测试，实时探测返回的 Token 数量、推理耗时与生成吞吐速度（调用记录将自动计入上方每日统计大盘）。
            </Text>

            {models.length === 0 ? (
              <Alert
                type="info"
                showIcon
                title="暂无可用模型"
                description="请先在上方模型推荐列表中下载任意模型（例如 qwen2.5:0.5b），下载完成后即可在此处发起对话测试与 Token 探测。"
              />
            ) : (
              <div
                style={{
                  padding: "16px",
                  background: "var(--ab-surface-2)",
                  border: "1px solid var(--ab-border)",
                  borderRadius: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <Flex gap={12} align="center" wrap="wrap">
                  <Text style={{ minWidth: 64 }}>选择模型:</Text>
                  <Select
                    style={{ minWidth: 200 }}
                    value={testModel || models[0]?.name}
                    onChange={(val) => setTestModel(val)}
                    options={models.map((m) => ({
                      label: `${m.name} (${m.sizeFormatted})`,
                      value: m.name,
                    }))}
                  />
                  <Space wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      快捷提示词:
                    </Text>
                    <Tag
                      style={{ cursor: "pointer" }}
                      onClick={() => setTestPrompt("你好，请做个简短的自我介绍。")}
                    >
                      自我介绍
                    </Tag>
                    <Tag
                      style={{ cursor: "pointer" }}
                      onClick={() => setTestPrompt("请用一句话总结什么是 Agent Butler。")}
                    >
                      一句话总结
                    </Tag>
                    <Tag
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setTestPrompt(
                          "提取以下文本的 3 个关键词：本地轻量模型提供全天候记忆管理与状态探针服务。",
                        )
                      }
                    >
                      实体抽取
                    </Tag>
                  </Space>
                </Flex>

                <Input.TextArea
                  rows={3}
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  placeholder="输入测试提示词..."
                />

                <Flex justify="flex-end">
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    loading={testingChat}
                    onClick={handleTestChat}
                  >
                    发送测试并探测 Token
                  </Button>
                </Flex>

                {/* 测试结果展示区 */}
                {chatResult && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "14px 16px",
                      background: "var(--ab-surface)",
                      border: "1px solid var(--ab-border-control)",
                      borderRadius: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                      <Text strong style={{ color: chatResult.ok ? "var(--ab-ok)" : "var(--ab-error)" }}>
                        {chatResult.ok ? "✓ 模型回复成功" : "✕ 调用出错"}
                      </Text>
                      {chatResult.usage && (
                        <Flex gap={8} wrap="wrap">
                          <Tag color="blue">输入: {chatResult.usage.promptTokens} tokens</Tag>
                          <Tag color="green">输出: {chatResult.usage.completionTokens} tokens</Tag>
                          <Tag color="purple">总计: {chatResult.usage.totalTokens} tokens</Tag>
                          <Tag color="cyan">耗时: {chatResult.usage.durationMs} ms</Tag>
                          <Tag color="orange">吞吐: {chatResult.usage.tokensPerSecond} tokens/s</Tag>
                        </Flex>
                      )}
                    </Flex>

                    <div
                      style={{
                        padding: "10px 12px",
                        background: "var(--ab-sunken)",
                        borderRadius: 4,
                        fontSize: 13,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {chatResult.reply || chatResult.error}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
      </Flex>
    </Card>
  );
}
