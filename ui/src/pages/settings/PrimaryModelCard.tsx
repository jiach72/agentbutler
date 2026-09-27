/**
 * 系统主模型管理卡片 (PrimaryModelCard)：
 * 展示并控制 Hermes Agent 核心总控主模型。
 * 允许用户一键从本地 Ollama 模型（零成本）或已保存的商业 API Key 中直接选取切换。
 * 具备自动备份 ~/.hermes/config.yaml 与一键优雅重启生效的能力。
 */
import { useCallback, useEffect, useState } from "react";
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
  CheckCircleFilled,
  CloudOutlined,
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
  const [primary, setPrimary] = useState<PrimaryModelConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<UnifiedModelOption | null>(null);
  const [restartNow, setRestartNow] = useState(true);
  const [saving, setSaving] = useState(false);

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
        message.success(
          `主模型已成功切换为 ${selectedOption.model} (${selectedOption.provider})！已自动创建 config.yaml 备份。`,
        );
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
        <Space size={8}>
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
                <Space size={6}>
                  <Text strong style={{ fontSize: 14 }}>
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
                </Space>
              ),
            },
            {
              label: "驱动提供商",
              children: <Text code>{primary?.provider || "—"}</Text>,
            },
            {
              label: "服务端点 (Base URL)",
              children: (
                <Text type="secondary" ellipsis style={{ maxWidth: 220 }}>
                  {primary?.endpoint || "官方默认端点"}
                </Text>
              ),
            },
          ]}
        />

        {isLocal ? (
          <Alert
            type="success"
            showIcon
            message="当前主模型运行于本地 Ollama 引擎"
            description="日常 Agent 交互 100% 离线私密运行，无任何第三方 API 账单费用支出。"
          />
        ) : (
          <Alert
            type="info"
            showIcon
            message="当前主模型采用云端商业 API"
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
              <Text strong>立即优雅重启 Hermes 生效</Text>
              <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                保存后经由宿主控制桥自动重载 Hermes 进程，使新主模型即刻生效。
              </Text>
            </div>
            <Checkbox checked={restartNow} onChange={(e) => setRestartNow(e.target.checked)} />
          </Flex>
        </Flex>
      </Modal>
    </Card>
  );
}
