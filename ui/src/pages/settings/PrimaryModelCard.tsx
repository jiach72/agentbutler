/**
 * 系统主模型管理卡片 (PrimaryModelCard)：
 * 展示并控制 Hermes Agent 核心总控主模型。
 * 允许用户一键从本地 Ollama 模型（零成本）或已保存的商业 API Key 中直接选取切换。
 * 具备自动备份 ~/.hermes/config.yaml 与一键优雅重启生效的能力。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Flex,
  Modal,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  CloudOutlined,
  MessageOutlined,
  ReloadOutlined,
  SwapOutlined,
  ThunderboltFilled,
} from "@ant-design/icons";
import type { PrimaryModelConfig, UnifiedModelOption } from "@butler/contract";
import { loadJson, postJson } from "../../lib/api.js";
import { ModelSelector } from "../../components/ModelSelector.js";

const { Text, Paragraph } = Typography;

export function PrimaryModelCard() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [primary, setPrimary] = useState<PrimaryModelConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<UnifiedModelOption | null>(null);
  const [restartNow, setRestartNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    message: string;
    checkedAt: string;
  } | null>(null);

  const handleTestInIM = () => {
    const modelName = primary?.model || "主模型";
    const prompt = `你好！请做一下简短的自我介绍，并确认你当前正在使用 ${modelName} 模型工作。`;
    navigate(`/gateway?tab=im&prefill=${encodeURIComponent(prompt)}`);
  };

  const fetchPrimary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await loadJson<{ ok: boolean; primary: PrimaryModelConfig }>(
        "/api/models/primary",
        10_000,
      );
      if (res.ok && res.data.primary) {
        setPrimary(res.data.primary);
      }
    } catch {
      // 容错处理
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPrimary();
  }, [fetchPrimary]);

  const isLocal =
    primary?.source === "ollama" ||
    primary?.provider.toLowerCase() === "ollama" ||
    (primary?.endpoint && /11434/.test(primary.endpoint));

  const handleOpenSwitch = () => {
    setSelectedOption(null);
    setModalOpen(true);
  };

  const handleApplySwitch = async () => {
    if (!selectedOption) {
      message.warning("请先选择要切换的目标模型");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        provider: selectedOption.provider,
        model: selectedOption.model,
        endpoint: selectedOption.endpoint,
        source: selectedOption.source,
        envVar: selectedOption.envVar,
        restartNow,
      };

      const res = await postJson("/api/models/primary", payload, 30_000);
      if (res.ok) {
        // 后端如实返回 restarted 与 restartOutcome：
        // runbook 启动只是后台开始重载（started），不能虚假宣称「即刻生效」；
        // 遇到熔断/无实例等防御分支时细化提示原因。
        const data = res.data as { restarted?: boolean; restartOutcome?: string } | null;
        const restarted = data?.restarted === true;
        const outcome = data?.restartOutcome;

        let restartMsg = `主模型已切换为 ${selectedOption.model} (${selectedOption.provider})，已自动创建 config.yaml 备份，将在 Hermes 下次重载时生效。`;
        if (restarted) {
          restartMsg = `主模型已切换为 ${selectedOption.model} (${selectedOption.provider})，已触发 Hermes 优雅重启（后台重载中，预计数秒内完成生效）。`;
        } else if (outcome === "circuit-breaker-tripped") {
          restartMsg = `主模型已切换为 ${selectedOption.model} (${selectedOption.provider})，已创建备份；因重启过于频繁触发熔断保护，请稍后手动重启或等待下次重载生效。`;
        } else if (outcome === "no-servicing-instance") {
          restartMsg = `主模型已切换为 ${selectedOption.model} (${selectedOption.provider})，已创建备份；当前无在线的 Hermes 实例，将在服务启动后生效。`;
        } else if (restartNow) {
          restartMsg = `主模型已切换为 ${selectedOption.model} (${selectedOption.provider})，已创建备份；自动重启触发未成功，将在 Hermes 下次重载时生效。`;
        }

        message.success(restartMsg);
        setModalOpen(false);
        await fetchPrimary();
      } else if (res.status === 403) {
        message.error("写入已被安全门禁拦截：需在回环网络或设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true。");
      } else {
        message.error("主模型切换失败，请检查服务日志。");
      }
    } catch {
      message.error("请求失败，请确认管家服务正常。");
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!primary?.model) {
      message.warning("尚未获取到当前主模型信息");
      return;
    }
    setTestingConnection(true);
    const start = performance.now();
    try {
      if (isLocal) {
        // 本地 Ollama 引擎连通性测试
        const res = await loadJson<{ available: boolean; version?: string; error?: string }>(
          "/api/ollama/status",
          8_000,
        );
        const elapsed = Math.round(performance.now() - start);
        if (res.ok && res.data.available) {
          const detail = `Ollama 引擎在线 (v${res.data.version || "latest"})，响应耗时 ${elapsed}ms`;
          setTestResult({
            ok: true,
            latencyMs: elapsed,
            message: detail,
            checkedAt: new Date().toLocaleTimeString(),
          });
          message.success(`主模型 ${primary.model} 连通正常！${detail}`);
        } else {
          const detail = res.ok ? (res.data.error || "本地 Ollama 引擎未运行或端口未监听") : res.reason;
          setTestResult({
            ok: false,
            message: detail,
            checkedAt: new Date().toLocaleTimeString(),
          });
          message.error(`连通失败：${detail}`);
        }
      } else {
        // 商业 API / 自定义提供商连通性探测
        const res = await loadJson<{ ok: boolean; options: UnifiedModelOption[] }>(
          "/api/models/unified-options",
          12_000,
        );
        const elapsed = Math.round(performance.now() - start);
        if (res.ok && res.data.options) {
          const matched = res.data.options.find(
            (o) =>
              o.model.toLowerCase() === primary.model.toLowerCase() ||
              o.provider.toLowerCase() === primary.provider.toLowerCase(),
          );
          if (matched && matched.ready === false) {
            setTestResult({
              ok: false,
              message: `模型凭据未就绪或已被禁用 (${matched.provider})`,
              checkedAt: new Date().toLocaleTimeString(),
            });
            message.warning("模型凭据未完全就绪，请核对 API Key");
          } else {
            const detail = `服务接口正常响应，延迟 ${elapsed}ms，凭据配置完整`;
            setTestResult({
              ok: true,
              latencyMs: elapsed,
              message: detail,
              checkedAt: new Date().toLocaleTimeString(),
            });
            message.success(`主模型连通测试通过！${detail}`);
          }
        } else {
          setTestResult({
            ok: false,
            message: "无法从管家读取模型凭据列表",
            checkedAt: new Date().toLocaleTimeString(),
          });
          message.error("模型连通性检测未响应，请核对管家服务状态");
        }
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "请求超时或网络不可达",
        checkedAt: new Date().toLocaleTimeString(),
      });
      message.error("检测异常：网络或服务端点超时");
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          <ThunderboltFilled style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
          <Text strong style={{ fontSize: 15 }}>
            系统总控主模型 (Primary Model)
          </Text>
        </Flex>
      }
      extra={
        <Space size={8} wrap>
          <Button
            size="small"
            icon={<MessageOutlined />}
            onClick={handleTestInIM}
          >
            在即时通讯中测试
          </Button>
          <Button
            size="small"
            icon={<ApiOutlined />}
            loading={testingConnection}
            onClick={() => void handleTestConnection()}
          >
            测试连通性
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            onClick={() => void fetchPrimary()}
          >
            刷新
          </Button>
          <Button type="primary" size="small" icon={<SwapOutlined />} onClick={handleOpenSwitch}>
            切换主模型
          </Button>
        </Space>
      }
      style={{
        border: "1px solid var(--ab-border)",
        borderRadius: "var(--ab-r-card, 12px)",
        background: "var(--ab-surface)",
      }}
    >
      <Flex vertical gap={12}>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          Hermes Agent 默认对话、思考与总指挥调度所运行的核心模型。支持直接选取已下载的 Ollama 本地模型（零成本）或已保存的商业 API Key。
        </Paragraph>

        <Descriptions
          bordered
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            {
              label: "当前模型",
              children: (
                <Space size={6} wrap>
                  <Text
                    strong
                    style={{ fontSize: 14 }}
                    copyable={primary?.model ? { text: primary.model, tooltips: ["复制模型名称", "已复制"] } : undefined}
                  >
                    {primary?.model || "读取中..."}
                  </Text>
                  {isLocal ? (
                    <Tag icon={<CheckCircleFilled />} color="success">
                      本地免成本
                    </Tag>
                  ) : (
                    <Tag icon={<CloudOutlined />} color="blue">
                      商业按量计费
                    </Tag>
                  )}
                  {testResult?.ok && testResult.latencyMs !== undefined && (
                    <Tag color="green" style={{ margin: 0 }}>
                      ⚡ {testResult.latencyMs}ms
                    </Tag>
                  )}
                </Space>
              ),
            },
            {
              label: "驱动提供商",
              children: (
                <Text
                  code
                  copyable={primary?.provider ? { text: primary.provider, tooltips: ["复制提供商", "已复制"] } : undefined}
                >
                  {primary?.provider || "—"}
                </Text>
              ),
            },
            {
              label: "服务端点 (Base URL)",
              children: (
                <Text
                  type="secondary"
                  ellipsis
                  style={{ maxWidth: 220 }}
                  copyable={primary?.endpoint ? { text: primary.endpoint, tooltips: ["复制服务端点", "已复制"] } : undefined}
                >
                  {primary?.endpoint || "官方默认端点"}
                </Text>
              ),
            },
          ]}
        />

        {testResult && (
          <Alert
            type={testResult.ok ? "success" : "error"}
            showIcon
            closable
            onClose={() => setTestResult(null)}
            title={
              <Flex align="center" justify="space-between" wrap="wrap" gap={8} style={{ width: "100%" }}>
                <span>
                  <strong>{testResult.ok ? "模型连通检测通过" : "模型连通检测异常"}</strong>：
                  {testResult.message}
                </span>
                <span style={{ fontSize: 12, opacity: 0.75 }}>检测于 {testResult.checkedAt}</span>
              </Flex>
            }
            action={
              testResult.ok ? (
                <Button size="small" type="primary" ghost icon={<MessageOutlined />} onClick={handleTestInIM}>
                  发指令测试
                </Button>
              ) : (
                <Button size="small" danger ghost icon={<ApiOutlined />} loading={testingConnection} onClick={() => void handleTestConnection()}>
                  重新检测
                </Button>
              )
            }
          />
        )}

        {isLocal ? (
          <Alert
            type="success"
            showIcon
            title="当前主模型运行于本地 Ollama 引擎"
            description="日常 Agent 交互 100% 离线私密运行，无任何第三方 API 账单费用支出。"
          />
        ) : (
          <Alert
            type="info"
            showIcon
            title="当前主模型采用云端商业 API"
            description="由您在 API 密钥管理中配置的凭据驱动。若希望降低日常开销，可随时在上方切换为已安装的轻量本地模型。"
          />
        )}
      </Flex>

      {/* 切换主模型 Modal */}
      <Modal
        title="切换系统主模型"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        width={560}
        confirmLoading={saving}
        onOk={() => void handleApplySwitch()}
        okText="确认并原子应用变更"
        cancelText="取消"
      >
        <Flex vertical gap={16} style={{ marginTop: 12 }}>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            从您之前配置好的 API 密钥或本地已安装的模型中直接点选，无需重新输入 Key 或复杂配置：
          </Paragraph>

          <div>
            <Text strong style={{ display: "block", marginBottom: 6 }}>
              选择目标主模型：
            </Text>
            <ModelSelector
              value={selectedOption?.id}
              onChange={(_, opt) => setSelectedOption(opt ?? null)}
              style={{ width: "100%" }}
            />
          </div>

          {selectedOption && (
            <Card size="small" style={{ background: "var(--ab-surface-2)", borderRadius: 8 }}>
              <Flex vertical gap={6}>
                <Flex justify="space-between" align="center">
                  <Text strong>{selectedOption.name}</Text>
                  {selectedOption.costCategory === "free" ? (
                    <Tag color="success">本地零成本</Tag>
                  ) : (
                    <Tag color="blue">商业 API</Tag>
                  )}
                </Flex>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  提供商：{selectedOption.provider} · 模型：{selectedOption.model}
                </Text>
                {selectedOption.endpoint && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    端点：{selectedOption.endpoint}
                  </Text>
                )}
              </Flex>
            </Card>
          )}

          <Flex align="center" justify="space-between">
            <div>
              <Text strong>保存后自动优雅重启 Hermes</Text>
              <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                保存后经由宿主控制桥触发重载 Hermes 进程，新模型将在后台重启完成后生效（通常数秒内）。
              </Text>
            </div>
            <Checkbox checked={restartNow} onChange={(e) => setRestartNow(e.target.checked)} />
          </Flex>

          <div style={{ marginTop: -4 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              <kbd className="im-kbd-hint">Esc</kbd> 取消 · 变更主模型将自动备份旧版 <Text code>config.yaml</Text>
            </Text>
          </div>
        </Flex>
      </Modal>
    </Card>
  );
}
