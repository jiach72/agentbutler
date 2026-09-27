/**
 * 记忆探针模型与频率设置卡片（成本治理）：
 * 完整写入探针会触发记忆服务的 LLM 事实抽取。
 * 此卡片让用户直观选择探针使用的模型（首选推荐本地免成本模型，0 API 费用），
 * 并灵活调节巡检频率，消除用户的费用焦虑。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Divider, Flex, Row, Select, Space, Tag, Typography } from "antd";
import { CheckCircleFilled, ExperimentOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { MemoryProbeConfig, UnifiedModelOption } from "@butler/contract";
import { loadJson, postJson } from "../../lib/api.js";
import { ModelSelector } from "../../components/ModelSelector.js";

const { Text, Paragraph } = Typography;

const INTERVAL_OPTIONS = [
  { value: 5, label: "5 分钟（高频，写入验证最灵敏）" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟（推荐平衡）" },
  { value: 60, label: "1 小时" },
  { value: 120, label: "2 小时（最省，验证延迟较大）" },
];

export function MemoryProbeConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<MemoryProbeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<MemoryProbeConfig>("/api/memory-probe/config", 6_000).then((result) => {
      if (result.ok && result.data) {
        setConfig(result.data);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveConfig = useCallback(
    async (patch: Partial<MemoryProbeConfig>) => {
      setSaving(true);
      const newConfig: MemoryProbeConfig = {
        intervalMin: config?.intervalMin ?? 30,
        modelId: config?.modelId,
        modelName: config?.modelName,
        endpoint: config?.endpoint,
        isLocal: config?.isLocal,
        ...patch,
      };

      const result = await postJson("/api/memory-probe/config", newConfig, 15_000);
      setSaving(false);
      if (result.ok) {
        setConfig(result.data as MemoryProbeConfig);
        message.success("记忆探针设置已更新");
      } else {
        message.error("保存失败，请确认管家服务在线");
      }
    },
    [config, message],
  );

  const runSelfCheck = useCallback(async () => {
    setTesting(true);
    const result = await postJson("/api/memory/self-check", {}, 30_000);
    setTesting(false);
    if (result.ok) {
      const outcome = result.data as { result?: { status?: string; detail?: string } } | null;
      const detail = outcome?.result?.detail || "写入并召回测试记忆成功，全链路通畅。";
      message.success(`记忆探针自检通过：${detail}`);
    } else {
      message.error("记忆探针自检失败，请检查 Watch 服务状态。");
    }
  }, [message]);

  const handleSelectModel = (_: string, opt?: UnifiedModelOption) => {
    if (!opt) return;
    const isLocal = opt.category === "local" || opt.costCategory === "free";
    void saveConfig({
      modelId: opt.id,
      modelName: opt.model,
      endpoint: opt.endpoint,
      isLocal,
    });
  };

  const isLocalModel = config?.isLocal || (config?.modelId && config.modelId.startsWith("ollama:"));

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          <ExperimentOutlined style={{ color: "var(--ant-color-primary)" }} />
          <span>记忆探针模型与频率设置（成本治理）</span>
        </Flex>
      }
      extra={
        <Flex align="center" gap={8} wrap="wrap">
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={testing}
            onClick={() => void runSelfCheck()}
          >
            立即自检
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={refresh}
          >
            刷新
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          完整写入探针每轮会触发记忆服务的 LLM 事实抽取，用于验证写入与召回全链路。
          您可以自由选择使用<b>本地免成本模型（Ollama）</b>或指定的商业 API，彻底避免意外扣费。
        </Paragraph>

        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Flex vertical gap={6}>
              <Text strong style={{ fontSize: 13 }}>
                探针事实抽取模型：
              </Text>
              <ModelSelector
                value={config?.modelId}
                onChange={handleSelectModel}
                placeholder="选取探针使用的模型 (推荐本地免成本模型)..."
                disabled={saving}
                style={{ width: "100%" }}
              />
            </Flex>
          </Col>

          <Col xs={24} md={12}>
            <Flex vertical gap={6}>
              <Text strong style={{ fontSize: 13 }}>
                探针写入验证频率：
              </Text>
              <Select
                value={config?.intervalMin ?? 30}
                onChange={(val) => void saveConfig({ intervalMin: val })}
                loading={saving}
                style={{ width: "100%" }}
                options={INTERVAL_OPTIONS}
              />
            </Flex>
          </Col>
        </Row>

        <Divider style={{ margin: "4px 0" }} />

        {/* 费用与健康状态提示条 */}
        {isLocalModel ? (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled style={{ color: "var(--ab-ok)" }} />}
            message={
              <Space>
                <span>已选用本地免成本模型执行探针</span>
                <Tag color="success">0 API 支出</Tag>
              </Space>
            }
            description={
              <div>
                当前探针采用本地模型（
                {config?.modelName ? (
                  <Typography.Text
                    copyable={{ text: config.modelName, tooltips: ["复制模型名", "已复制"] }}
                    code
                  >
                    {config.modelName}
                  </Typography.Text>
                ) : (
                  "Ollama"
                )}
                ），即使设置 5 分钟高频巡检也不会产生任何第三方 API 账单费用，兼顾高灵敏度与零成本。
              </div>
            }
          />
        ) : config?.modelName ? (
          <Alert
            type="info"
            showIcon
            message={
              <Space>
                <span>当前采用商业 API 执行探针</span>
                <Tag color="blue">按量计费 ({config.modelName})</Tag>
              </Space>
            }
            description={
              <div>
                <span>模型：</span>
                <Typography.Text
                  copyable={{ text: config.modelName, tooltips: ["复制模型名", "已复制"] }}
                  code
                >
                  {config.modelName}
                </Typography.Text>
                {config.endpoint && (
                  <>
                    <span style={{ marginLeft: 8 }}>端点：</span>
                    <Typography.Text
                      copyable={{ text: config.endpoint, tooltips: ["复制端点", "已复制"] }}
                      code
                    >
                      {config.endpoint}
                    </Typography.Text>
                  </>
                )}
                <div style={{ marginTop: 4 }}>
                  建议设置 30 分钟或更长间隔以降低 API 消耗；若需彻底免除费用，可在上方切换为本地已安装的 Ollama 模型。
                </div>
              </div>
            }
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="未显式指定探针模型"
            description="系统将回退到默认后端内置逻辑。建议在上方选择一个本地轻量模型（如 qwen2.5:0.5b）以确保探针完全零成本运行。"
          />
        )}
      </Flex>
    </Card>
  );
}
