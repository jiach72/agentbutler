/**
 * 统一 API 密钥管理中心：
 * 全局统一管理 Vision、Web Search、大语言模型 (LLM)、长期记忆与外部工具的所有 API Key。
 * 支持主流服务模板预设、即时连通性测试（探针）、脱敏展示与 ~/.hermes/.env 自动安全同步。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  EyeInvisibleOutlined,
  GlobalOutlined,
  LinkOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { SectionHeader } from "../../components/SectionHeader.js";

const { Text, Paragraph } = Typography;

export type ApiKeyCategory = "all" | "search" | "vision" | "llm" | "memory" | "tool" | "custom";

export interface ApiCredentialView {
  id: string;
  name: string;
  category: "search" | "vision" | "llm" | "memory" | "tool" | "custom";
  envVar: string;
  provider: string;
  endpoint: string | null;
  maskedKey: string;
  status: "active" | "disabled";
  probeStatus: "pass" | "fail" | "unknown";
  probeCategory: string | null;
  probeDetail: string | null;
  probedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isPreset: boolean;
  docsUrl?: string;
  description?: string;
}

export interface ApiCredentialPreset {
  id: string;
  name: string;
  category: "search" | "vision" | "llm" | "memory" | "tool" | "custom";
  envVar: string;
  provider: string;
  docsUrl: string;
  description: string;
  defaultEndpoint?: string;
  probeType: "http-get" | "http-post" | "none";
}

const CATEGORY_META: Record<
  ApiKeyCategory,
  { label: string; color: string; countSuffix?: string }
> = {
  all: { label: "全部服务", color: "default" },
  search: { label: "网络搜索 (Web Search)", color: "green" },
  vision: { label: "视觉能力 (Vision)", color: "purple" },
  llm: { label: "大语言模型 (LLM)", color: "blue" },
  memory: { label: "记忆服务", color: "orange" },
  tool: { label: "工具与扩展", color: "cyan" },
  custom: { label: "自定义 Key", color: "geekblue" },
};

export function UnifiedApiKeyManager() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [credentials, setCredentials] = useState<ApiCredentialView[]>([]);
  const [presets, setPresets] = useState<ApiCredentialPreset[]>([]);
  const [filterCategory, setFilterCategory] = useState<ApiKeyCategory>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ApiCredentialView | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [testProbing, setTestProbing] = useState(false);
  const [testProbeResult, setTestProbeResult] = useState<{
    status: "pass" | "fail";
    detail: string;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadJson<{
        credentials: ApiCredentialView[];
        presets: ApiCredentialPreset[];
      }>("/api/credentials", 10_000);
      if (result.ok) {
        setCredentials(result.data.credentials ?? []);
        setPresets(result.data.presets ?? []);
      } else {
        message.error("无法加载 API 密钥列表，请确认 Watch 服务正常运行。");
      }
    } catch {
      message.error("加载 API 密钥失败。");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 过滤后的列表
  const filteredList = useMemo(() => {
    if (filterCategory === "all") return credentials;
    return credentials.filter((c) => c.category === filterCategory);
  }, [credentials, filterCategory]);

  // 统计概览
  const stats = useMemo(() => {
    const total = credentials.length;
    const searchCount = credentials.filter((c) => c.category === "search").length;
    const visionCount = credentials.filter((c) => c.category === "vision").length;
    const llmCount = credentials.filter((c) => c.category === "llm").length;
    const passCount = credentials.filter((c) => c.probeStatus === "pass").length;
    return { total, searchCount, visionCount, llmCount, passCount };
  }, [credentials]);

  // 打开新增弹窗
  const handleOpenAdd = () => {
    setEditingItem(null);
    setTestProbeResult(null);
    form.resetFields();
    form.setFieldsValue({
      category: "search",
      provider: "tavily",
      name: "Tavily Search",
      envVar: "TAVILY_API_KEY",
    });
    setModalOpen(true);
  };

  // 打开编辑弹窗
  const handleOpenEdit = (item: ApiCredentialView) => {
    setEditingItem(item);
    setTestProbeResult(null);
    form.resetFields();
    form.setFieldsValue({
      name: item.name,
      category: item.category,
      envVar: item.envVar,
      provider: item.provider,
      endpoint: item.endpoint ?? "",
      apiKey: "", // 编辑时不回显原密钥明文
    });
    setModalOpen(true);
  };

  // 点击选择预设模板
  const handleSelectPreset = (preset: ApiCredentialPreset) => {
    setTestProbeResult(null);
    form.setFieldsValue({
      name: preset.name,
      category: preset.category,
      envVar: preset.envVar,
      provider: preset.provider,
      endpoint: preset.defaultEndpoint ?? "",
    });
  };

  // 连通性测试 (针对正在编辑/新增的表单数据)
  const handleTestProbe = async () => {
    try {
      const values = await form.validateFields(["provider", "apiKey"]);
      const endpoint = form.getFieldValue("endpoint");
      setTestProbing(true);
      setTestProbeResult(null);

      const res = await postJson("/api/credentials/test", {
        provider: values.provider,
        apiKey: values.apiKey,
        endpoint: endpoint ? endpoint.trim() : null,
      });

      const data = res.data as {
        probe?: { status: "pass" | "fail"; category: string; detail: string };
      } | null;

      if (res.ok && data?.probe) {
        setTestProbeResult({
          status: data.probe.status,
          detail: data.probe.detail,
        });
      } else {
        setTestProbeResult({
          status: "fail",
          detail: "测试请求无法送达，请检查网络设置或端点配置。",
        });
      }
    } catch {
      message.warning("请先填写有效的服务标识与 API 密钥再执行测试。");
    } finally {
      setTestProbing(false);
    }
  };

  // 表格中针对指定已有记录测试连通性
  const handleProbeExisting = async (item: ApiCredentialView) => {
    setProbingId(item.id);
    try {
      const res = await postJson(`/api/credentials/${encodeURIComponent(item.id)}/probe`, {});
      const data = res.data as {
        probe?: { status: "pass" | "fail"; category: string; detail: string };
      } | null;

      if (res.ok && data?.probe) {
        if (data.probe.status === "pass") {
          message.success(`${item.name} 连通性验证成功！`);
        } else {
          message.warning(`${item.name} 验证失败：${data.probe.detail}`);
        }
        await loadData();
      } else {
        message.error("探测请求失败，请稍后重试。");
      }
    } catch {
      message.error("连通性测试失败。");
    } finally {
      setProbingId(null);
    }
  };

  // 手动同步到 ~/.hermes/.env
  const handleSyncToHermes = async () => {
    setSyncing(true);
    try {
      const res = await postJson("/api/credentials/sync", {});
      const data = res.data as { ok?: boolean; updated?: number; path?: string } | null;
      if (res.ok) {
        message.success(`已成功同步 ${data?.updated ?? 0} 项受管密钥至 ~/.hermes/.env！`);
      } else if (res.status === 403) {
        message.error("写入已被安全门禁拦截：需在回环网络或设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true。");
      } else {
        message.error("同步至 ~/.hermes/.env 失败。");
      }
    } catch {
      message.error("同步请求异常。");
    } finally {
      setSyncing(false);
    }
  };

  // 删除凭据
  const handleDelete = async (item: ApiCredentialView) => {
    try {
      const res = await deleteJson(`/api/credentials/${encodeURIComponent(item.id)}`);
      if (res.ok) {
        message.success(`已删除 ${item.name}，并从 ~/.hermes/.env 中清理配置。`);
        await loadData();
      } else if (res.status === 403) {
        message.error("删除已被安全门禁拦截：需在回环网络或设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true。");
      } else {
        message.error("删除密钥失败。");
      }
    } catch {
      message.error("删除请求失败。");
    }
  };

  // 保存凭据
  const handleSaveSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (!editingItem && (!values.apiKey || values.apiKey.trim() === "")) {
        message.warning("新增密钥时 API Key 不能为空。");
        return;
      }

      const payload = {
        id: editingItem ? editingItem.id : undefined,
        name: values.name.trim(),
        category: values.category,
        envVar: values.envVar.trim().toUpperCase(),
        provider: values.provider.trim(),
        endpoint: values.endpoint ? values.endpoint.trim() : null,
        apiKey: values.apiKey ? values.apiKey.trim() : undefined,
      };

      const res = await postJson("/api/credentials", payload);
      if (res.ok) {
        message.success(
          editingItem
            ? "API 密钥已更新并同步到 ~/.hermes/.env"
            : "API 密钥已加密保存并同步到 ~/.hermes/.env",
        );
        setModalOpen(false);
        await loadData();
      } else if (res.status === 403) {
        message.error("写入已被安全门禁拦截：需在回环网络或设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true。");
      } else {
        message.error("保存失败，请检查输入或服务日志。");
      }
    } catch {
      // Form validation error
    }
  };

  const columns = [
    {
      title: "服务名称",
      key: "name",
      width: 220,
      render: (_: unknown, record: ApiCredentialView) => (
        <Flex vertical gap={2}>
          <Space orientation="horizontal" size={6}>
            <Text strong>{record.name}</Text>
            {record.docsUrl && (
              <Tooltip title="查看官方文档/控制台">
                <a href={record.docsUrl} target="_blank" rel="noreferrer">
                  <LinkOutlined style={{ color: "#1677ff", fontSize: 12 }} />
                </a>
              </Tooltip>
            )}
          </Space>
          {record.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.description}
            </Text>
          )}
        </Flex>
      ),
    },
    {
      title: "功能分类",
      dataIndex: "category",
      key: "category",
      width: 140,
      render: (category: ApiKeyCategory) => {
        const meta = CATEGORY_META[category] ?? CATEGORY_META.custom;
        return <Tag color={meta.color}>{meta.label.split(" ")[0]}</Tag>;
      },
    },
    {
      title: "环境变量名",
      dataIndex: "envVar",
      key: "envVar",
      width: 190,
      render: (envVar: string) => (
        <Space orientation="horizontal" size={4}>
          <Text code copyable={{ text: envVar, tooltips: ["复制变量名", "已复制"] }}>
            {envVar}
          </Text>
        </Space>
      ),
    },
    {
      title: "密钥 (掩码脱敏)",
      dataIndex: "maskedKey",
      key: "maskedKey",
      width: 170,
      render: (maskedKey: string) => (
        <Space orientation="horizontal" size={4}>
          <Text style={{ fontFamily: "monospace", letterSpacing: "1px" }}>{maskedKey}</Text>
          <Tooltip title="密钥受 AES-256-GCM 安全加密保护，明文仅在后端执行与安全同步时使用">
            <SafetyCertificateOutlined style={{ color: "#52c41a", fontSize: 13 }} />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "连通性状态",
      key: "probe",
      width: 160,
      render: (_: unknown, record: ApiCredentialView) => {
        if (record.probeStatus === "pass") {
          return (
            <Tooltip title={record.probeDetail || "连通正常"}>
              <Tag icon={<CheckCircleOutlined />} color="success">
                连接正常
              </Tag>
            </Tooltip>
          );
        }
        if (record.probeStatus === "fail") {
          return (
            <Tooltip title={record.probeDetail || "连接失败"}>
              <Tag icon={<CloseCircleOutlined />} color="error">
                连接失败
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Tooltip title="尚未执行连通性探测">
            <Tag icon={<QuestionCircleOutlined />} color="default">
              未检测
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "生效状态",
      key: "status",
      width: 120,
      render: (_: unknown, record: ApiCredentialView) => (
        <Tag color="cyan">已生效 (~/.hermes)</Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 220,
      render: (_: unknown, record: ApiCredentialView) => (
        <Space orientation="horizontal" size={8}>
          <Button
            size="small"
            icon={<ExperimentOutlined />}
            loading={probingId === record.id}
            onClick={() => handleProbeExisting(record)}
          >
            测试
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleOpenEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该 API Key？"
            description="删除后将同步从 ~/.hermes/.env 中清除该环境变量，依赖此 Key 的功能可能无法运行。"
            okText="确定删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <SectionHeader
          kicker="API 凭据"
          title="API 密钥与服务中心"
        />
      }
      extra={
        <Space orientation="horizontal" size={10}>
          <Button icon={<SyncOutlined />} loading={syncing} onClick={handleSyncToHermes}>
            同步至 Hermes
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenAdd}>
            添加 API Key
          </Button>
        </Space>
      }
      className="unified-api-key-card"
    >
      <Flex vertical gap={16}>
        {/* 顶部统计摘要 */}
        <Row gutter={16}>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: "rgba(22, 119, 255, 0.04)" }}>
              <Descriptions
                column={1}
                size="small"
                items={[{ label: "受管服务总数", children: <Text strong>{stats.total}</Text> }]}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: "rgba(82, 196, 26, 0.04)" }}>
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    label: "网络搜索服务",
                    children: <Text strong style={{ color: "#52c41a" }}>{stats.searchCount}</Text>,
                  },
                ]}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: "rgba(114, 46, 209, 0.04)" }}>
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    label: "视觉多模态能力",
                    children: <Text strong style={{ color: "#722ed1" }}>{stats.visionCount}</Text>,
                  },
                ]}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: "rgba(250, 140, 22, 0.04)" }}>
              <Descriptions
                column={1}
                size="small"
                items={[
                  {
                    label: "探针正常率",
                    children: (
                      <Text strong style={{ color: "#fa8c16" }}>
                        {stats.total > 0 ? `${Math.round((stats.passCount / stats.total) * 100)}%` : "100%"}
                      </Text>
                    ),
                  },
                ]}
              />
            </Card>
          </Col>
        </Row>

        {/* 分类切换 Radio.Group */}
        <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
          <Radio.Group
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="all">全部 ({credentials.length})</Radio.Button>
            <Radio.Button value="search">
              网络搜索 ({credentials.filter((c) => c.category === "search").length})
            </Radio.Button>
            <Radio.Button value="vision">
              视觉多模态 ({credentials.filter((c) => c.category === "vision").length})
            </Radio.Button>
            <Radio.Button value="llm">
              大语言模型 ({credentials.filter((c) => c.category === "llm").length})
            </Radio.Button>
            <Radio.Button value="memory">
              记忆服务 ({credentials.filter((c) => c.category === "memory").length})
            </Radio.Button>
            <Radio.Button value="tool">
              其它工具 ({credentials.filter((c) => c.category === "tool").length})
            </Radio.Button>
            <Radio.Button value="custom">
              自定义 ({credentials.filter((c) => c.category === "custom").length})
            </Radio.Button>
          </Radio.Group>
        </Flex>

        {/* 统一表格 */}
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredList}
          loading={loading}
          pagination={filteredList.length > 10 ? { pageSize: 10 } : false}
          locale={{ emptyText: "当前分类下暂无已配置的 API 密钥，点击右上角「添加 API Key」开始配置。" }}
        />
      </Flex>

      {/* 新增 / 编辑 密钥 Modal */}
      <Modal
        title={editingItem ? `编辑 API 密钥：${editingItem.name}` : "添加 API 密钥"}
        open={modalOpen}
        width={680}
        onCancel={() => setModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setModalOpen(false)}>
            取消
          </Button>,
          <Button
            key="test"
            icon={<ExperimentOutlined />}
            loading={testProbing}
            onClick={handleTestProbe}
          >
            测试连通性
          </Button>,
          <Button key="submit" type="primary" onClick={handleSaveSubmit}>
            保存并生效
          </Button>,
        ]}
      >
        <Flex vertical gap={16} style={{ marginTop: 8 }}>
          {/* 新增时展示常用预设快速选择卡片 */}
          {!editingItem && (
            <Card size="small" title="快捷选择官方推荐预设服务" style={{ background: "#fafafa" }}>
              <Row gutter={[8, 8]}>
                {presets.slice(0, 8).map((preset) => (
                  <Col span={6} key={preset.id}>
                    <Card
                      hoverable
                      size="small"
                      style={{ textAlign: "center", cursor: "pointer" }}
                      onClick={() => handleSelectPreset(preset)}
                    >
                      <Text strong style={{ fontSize: 13 }}>
                        {preset.name}
                      </Text>
                      <div style={{ fontSize: 11, color: "#8c8c8c", marginTop: 2 }}>
                        {preset.category === "search"
                          ? "搜索引擎"
                          : preset.category === "vision"
                            ? "视觉模型"
                            : "大模型"}
                      </div>
                    </Card>
                  </Col>
                ))}
              </Row>
            </Card>
          )}

          <Form form={form} layout="vertical" initialValues={{ category: "search" }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="name"
                  label="服务名称"
                  rules={[{ required: true, message: "请输入服务名称" }]}
                >
                  <Input placeholder="如：Tavily Search、Google Gemini Vision" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="category"
                  label="功能类别"
                  rules={[{ required: true, message: "请选择功能类别" }]}
                >
                  <Select
                    options={[
                      { value: "search", label: "网络搜索 (Web Search)" },
                      { value: "vision", label: "视觉多模态能力 (Vision)" },
                      { value: "llm", label: "大语言模型 (LLM)" },
                      { value: "memory", label: "记忆服务 (Mem0)" },
                      { value: "tool", label: "工具与扩展 (GitHub 等)" },
                      { value: "custom", label: "自定义服务" },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  name="envVar"
                  label="环境变量名 (写入 ~/.hermes/.env)"
                  rules={[
                    { required: true, message: "请输入环境变量名" },
                    {
                      pattern: /^[A-Z][A-Z0-9_]*$/,
                      message: "必须为大写字母、数字或下划线组成的合法环境变量名",
                    },
                  ]}
                  tooltip="Hermes Agent 及底层工具读取该变量。如 TAVILY_API_KEY、GOOGLE_API_KEY、BRAVE_API_KEY 等。"
                >
                  <Input placeholder="如：TAVILY_API_KEY" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="provider"
                  label="提供商 / 驱动标识"
                  rules={[{ required: true, message: "请输入驱动标识" }]}
                  tooltip="连通性探测器通过此标识匹配专用探测协议（如 tavily、brave、google、openai、custom 等）。"
                >
                  <Input placeholder="如：tavily、brave、google、openai" />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="apiKey"
              label="API Key (密钥明文)"
              rules={editingItem ? [] : [{ required: true, message: "请输入 API Key" }]}
              extra={editingItem ? "留空则保留原有加密密钥不更改；若填写则覆盖更新。" : undefined}
            >
              <Input.Password placeholder="输入 API Key，保存后经 AES-256-GCM 强加密脱敏保存" />
            </Form.Item>

            <Form.Item
              name="endpoint"
              label="自定义端点 Base URL (可选)"
              tooltip="针对私有化部署、反向代理或自定义端点填入，留空使用服务商默认官方接口。"
            >
              <Input placeholder="如：https://api.openai.com/v1（可选）" />
            </Form.Item>
          </Form>

          {/* 探测结果即时反馈条 */}
          {testProbeResult && (
            <Alert
              type={testProbeResult.status === "pass" ? "success" : "warning"}
              showIcon
              message={
                testProbeResult.status === "pass"
                  ? "连通性测试通过"
                  : "连通性测试未通过（可强制保存）"
              }
              description={
                <Flex vertical gap={4}>
                  <div>{testProbeResult.detail}</div>
                  {testProbeResult.status === "fail" && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      提示：由于网络波动或部分服务商不提供轻量鉴权探测，测试失败不影响继续点击「保存并生效」。
                    </Text>
                  )}
                </Flex>
              }
            />
          )}
        </Flex>
      </Modal>
    </Card>
  );
}
