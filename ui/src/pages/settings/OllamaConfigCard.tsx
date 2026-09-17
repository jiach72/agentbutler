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
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  BarChartOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";

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
  const [loadingModels, setLoadingModels] = useState(false);

  const [downloadInput, setDownloadInput] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullStatusPayload["pull"]>(null);

  const [usageSummary, setUsageSummary] = useState<OllamaUsageSummary | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const [testModel, setTestModel] = useState<string>("");
  const [testPrompt, setTestPrompt] = useState<string>("你好，请做个简短的自我介绍。");
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<ChatTestResult | null>(null);

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

  // 初始化加载
  useEffect(() => {
    void checkStatus();
    void loadHardwareProfile();
    void loadModels();
    void loadUsageSummary();
  }, [checkStatus, loadHardwareProfile, loadModels, loadUsageSummary]);

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

  // 一键录入到 Butler 模型凭据库（设为探针模型）
  const handleQuickBind = async (modelName: string) => {
    const endpoint = status?.endpoint ? `${status.endpoint}/v1` : "http://ollama:11434/v1";
    const profileId = `ollama-${modelName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const payload = {
      profileId,
      provider: "Ollama (本地)",
      protocol: "openai-compatible",
      endpoint,
      model: modelName,
      apiKey: "ollama",
    };
    const res = await postJson("/api/llm/profiles", payload, 10_000);
    if (res.ok) {
      message.success(`已成功将 ${modelName} 接入 Butler 模型列表（端点：${endpoint}）`);
    } else {
      message.error("录入失败，请确认管家服务在线");
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
                  icon={<CheckCircleFilled style={{ color: "#52c41a" }} />}
                  style={{
                    backgroundColor: "#f6ffed",
                    borderColor: "#b7eb8f",
                    color: "#389e0d",
                    fontWeight: 500,
                    padding: "2px 8px",
                  }}
                >
                  可用
                </Tag>
              ) : (
                <Tag
                  icon={<CloseCircleFilled style={{ color: "#ff4d4f" }} />}
                  style={{
                    backgroundColor: "#fff2f0",
                    borderColor: "#ffccc7",
                    color: "#cf1322",
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
              message="未检测到运行中的 Ollama 服务"
              description={`请确保在 docker-compose.yml 中已启动 ollama 容器，或宿主机已开启 Ollama 引擎（默认地址：${status.endpoint}）。`}
            />
          )}
        </div>

        <div style={{ height: 1, backgroundColor: "#f0f0f0" }} />

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
              backgroundColor: "#f5f5f5",
              color: "#333",
              cursor: "default",
            }}
          />
        </div>

        <div style={{ height: 1, backgroundColor: "#f0f0f0" }} />

        {/* 3. 动态硬件自适应推荐（核心动态引擎） */}
        {hwProfile && (
          <div
            style={{
              backgroundColor: "#fafafa",
              border: "1px solid #f0f0f0",
              borderRadius: 8,
              padding: 16,
            }}
          >
            <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 8 }}>
              <Space>
                <ThunderboltOutlined style={{ color: "#fa8c16", fontSize: 16 }} />
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
              <Text style={{ fontSize: 12, color: "#8c8c8c", display: "block", marginBottom: 6 }}>
                💡 根据当前机器客观硬件，推荐适用的轻量记忆与探针模型（点击标签可直接填入下载）：
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
                        <span style={{ color: "#8c8c8c", fontSize: 11 }}>({rec.sizeDisplay})</span>
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

        <div style={{ height: 1, backgroundColor: "#f0f0f0" }} />

        {/* 5. 已下载的模型区块 */}
        <div>
          <Flex justify="space-between" align="center" wrap="wrap" gap={8} style={{ marginBottom: 6 }}>
            <Text strong style={{ fontSize: 15 }}>
              已下载的模型
            </Text>
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
          <Text type="secondary" style={{ display: "block", marginBottom: 14 }}>
            已安装在 Ollama 中的模型列表
          </Text>

          {models.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={status?.available ? "暂无已下载模型，请在上方输入模型名称下载" : "Ollama 服务未连接"}
            />
          ) : (
            <Flex wrap="wrap" gap={12}>
              {models.map((item) => (
                <div
                  key={item.name}
                  style={{
                    minWidth: 260,
                    maxWidth: 320,
                    padding: "14px 16px",
                    backgroundColor: "#f0f5ff",
                    border: "1px solid #d6e4ff",
                    borderRadius: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <Flex justify="space-between" align="center">
                    <Text strong style={{ fontSize: 14, wordBreak: "break-all" }}>
                      {item.name}
                    </Text>
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
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.sizeFormatted}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.modifiedAt}
                    </Text>
                  </Flex>
                    <Button
                      size="small"
                      style={{ marginTop: 2 }}
                      icon={<CloudDownloadOutlined />}
                      onClick={() => handleQuickBind(item.name)}
                    >
                      设为 Butler 模型
                    </Button>
                  </div>
                ))}
              </Flex>
            )}
          </div>

          <Divider style={{ margin: "18px 0" }} />

          {/* 6. 每日调用量与 Token 消耗大盘 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Flex align="center" gap={8}>
                <BarChartOutlined style={{ fontSize: 16, color: "#1677ff" }} />
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
                  background: "#fafafa",
                  borderRadius: 8,
                  border: "1px solid #f0f0f0",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  今日调用量
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#1677ff", marginTop: 4 }}>
                  {usageSummary?.todayCalls ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "#8c8c8c" }}>次</span>
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
                  background: "#fafafa",
                  borderRadius: 8,
                  border: "1px solid #f0f0f0",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  今日 Token 消耗
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#52c41a", marginTop: 4 }}>
                  {(usageSummary?.todayTokens ?? 0).toLocaleString()}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "#8c8c8c" }}>Tokens</span>
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
                  background: "#fafafa",
                  borderRadius: 8,
                  border: "1px solid #f0f0f0",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  累计调用总数
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                  {usageSummary?.totalCalls ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "#8c8c8c" }}>次</span>
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
                  background: "#fafafa",
                  borderRadius: 8,
                  border: "1px solid #f0f0f0",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  累计总 Token 消耗
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                  {(usageSummary?.totalTokens ?? 0).toLocaleString()}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "#8c8c8c" }}>Tokens</span>
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
                  background: "#fafafa",
                  borderRadius: 8,
                  border: "1px solid #f0f0f0",
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  平均生成速率
                </Text>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#fa8c16", marginTop: 4 }}>
                  {usageSummary?.avgTokensPerSecond ?? 0}{" "}
                  <span style={{ fontSize: 13, fontWeight: "normal", color: "#8c8c8c" }}>tokens/s</span>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  本地模型生成吞吐
                </Text>
              </div>
            </Flex>

            {/* 每日明细表格 */}
            <div style={{ marginTop: 4 }}>
              <Text strong style={{ fontSize: 13, marginBottom: 8, display: "block" }}>
                📅 最近 14 天每日调用明细
              </Text>
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
            </div>
          </div>

          <Divider style={{ margin: "18px 0" }} />

          {/* 7. 本地模型在线测试与 Token 探测 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Flex align="center" gap={8}>
                <ThunderboltOutlined style={{ fontSize: 16, color: "#fa8c16" }} />
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
                message="暂无可用模型"
                description="请先在上方模型推荐列表中下载任意模型（例如 qwen2.5:0.5b），下载完成后即可在此处发起对话测试与 Token 探测。"
              />
            ) : (
              <div
                style={{
                  padding: "16px",
                  background: "#fafafa",
                  border: "1px solid #f0f0f0",
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
                      background: "#fff",
                      border: "1px solid #d9d9d9",
                      borderRadius: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                      <Text strong style={{ color: chatResult.ok ? "#52c41a" : "#f5222d" }}>
                        {chatResult.ok ? "✓ 模型回复成功" : "✕ 调用出错"}
                      </Text>
                      {chatResult.usage && (
                        <Flex gap={8} wrap="wrap">
                          <Tag color="blue">⚡ 输入: {chatResult.usage.promptTokens} tokens</Tag>
                          <Tag color="green">💬 输出: {chatResult.usage.completionTokens} tokens</Tag>
                          <Tag color="purple">📊 总计: {chatResult.usage.totalTokens} tokens</Tag>
                          <Tag color="cyan">⏱️ 耗时: {chatResult.usage.durationMs} ms</Tag>
                          <Tag color="orange">🚀 吞吐: {chatResult.usage.tokensPerSecond} tokens/s</Tag>
                        </Flex>
                      )}
                    </Flex>

                    <div
                      style={{
                        padding: "10px 12px",
                        background: "#f9f9f9",
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
