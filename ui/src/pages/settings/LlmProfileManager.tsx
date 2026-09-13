/**
 * 设置页模型配置面板：加密凭据、探针、绑定与 Hermes 迁移助手。
 *
 * 重排（UX 验收）：先展示「已有模型配置及其使用情况」，再给显式「添加模型配置」按钮
 * （非常开表单）；添加模型与高级绑定是两步有意操作；绑定表用可读名而非裸 profileId；
 * 探针 / 状态 / 动作改用平实文案；请求失败或切标签时草稿不丢（模块级草稿持久）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from "antd";
import { ApiOutlined, CopyOutlined, DeleteOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { SectionHeader } from "../../components/SectionHeader.js";

const { Paragraph } = Typography;

interface Profile {
  profileId: string;
  instanceId: string | null;
  provider: string;
  protocol: "openai-compatible" | "anthropic" | "gemini";
  endpoint: string;
  model: string;
  status: "active" | "disabled" | "unsupported";
  maskedKey: string;
  bindingCount: number;
  probe: null | { status: "pass" | "fail"; category: string; detail: string; checkedAt: string };
}
interface Binding { bindingId: string; scope: string; instanceId: string | null; frameworkId: string | null; targetRef: string | null; profileId: string; }
interface Status {
  vault: { available: boolean };
  profiles: number;
  activeProfiles: number;
  bindings: number;
  activeBindings: number;
  ready: boolean;
  blocked: Array<{ profileId: string; status: string; detail: string }>;
}
interface DiscoveredConfig { id: string; source: string; provider: string; protocol: Profile["protocol"]; endpoint: string; model: string; maskedKey: string; importable: boolean; runtimeObserved: boolean; }

/** 模块级草稿：切到别的 tab 再回来、或保存失败，已填内容都不丢。 */
interface DraftState {
  open: boolean;
  values: Record<string, unknown>;
}
export const addDraftStore: DraftState = { open: false, values: {} };
export const bindingDraftStore: DraftState = { open: false, values: {} };

function credentialWriteError(result: { status: number; data: unknown }): string {
  if (result.status === 403 && result.data !== null && typeof result.data === "object") {
    const error = (result.data as Record<string, unknown>).error;
    if (error === "credential-writes-require-loopback") {
      return "凭据写入已被安全策略阻断：本机 WSL/Docker 部署可设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true 后重启服务。若 Web 发布到局域网或公网，必须先接入认证并保持该开关关闭。";
    }
  }
  return "保存或探针失败。请检查端点、模型名和 API Key。";
}

function probeStateLabel(probe: Profile["probe"]): string {
  if (!probe) return "未检查";
  return probe.status === "pass" ? "连接正常" : "连接失败";
}

function profileLabel(profile: Profile | undefined): string {
  if (!profile) return "未知配置";
  return `${profile.provider} · ${profile.model}`;
}

const providerOptions = ["OpenAI", "DeepSeek", "通义", "智谱", "Kimi", "豆包", "MiniMax", "百川", "自定义 OpenAI-compatible", "Claude", "Gemini"].map((value) => ({ label: value, value }));

const protocolOptions = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic 原生" },
  { value: "gemini", label: "Gemini 原生" },
];

const scopeOptions = [
  { value: "instance", label: "实例默认" },
  { value: "framework", label: "框架默认" },
  { value: "skill", label: "技能" },
  { value: "plugin", label: "插件" },
  { value: "evolution", label: "进化目标" },
];

interface LlmProfileManagerProps {
  /** 测试 / 预填充数据：提供后跳过自动拉取，直接渲染这些状态。 */
  seed?: { profiles: Profile[]; bindings: Binding[]; status: Status | null; discovered: DiscoveredConfig[] };
}

export function LlmProfileManager({ seed }: LlmProfileManagerProps = {}) {
  const { message } = App.useApp();
  const [profiles, setProfiles] = useState<Profile[]>(seed?.profiles ?? []);
  const [bindings, setBindings] = useState<Binding[]>(seed?.bindings ?? []);
  const [status, setStatus] = useState<Status | null>(seed?.status ?? null);
  const [discovered, setDiscovered] = useState<DiscoveredConfig[]>(seed?.discovered ?? []);
  const [loading, setLoading] = useState(seed ? false : true);
  const [saving, setSaving] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [addOpen, setAddOpen] = useState(addDraftStore.open);
  const [bindingOpen, setBindingOpen] = useState(bindingDraftStore.open);
  const [profileForm] = Form.useForm();
  const [bindingForm] = Form.useForm();
  const [rotateForm] = Form.useForm();

  const refresh = useCallback(async () => {
    if (seed) return;
    setLoading(true);
    const [p, b, s, d] = await Promise.all([
      loadJson<{ profiles: Profile[] }>("/api/llm/profiles", 10_000),
      loadJson<{ bindings: Binding[] }>("/api/llm/bindings", 10_000),
      loadJson<Status>("/api/llm/status", 10_000),
      loadJson<{ configs: DiscoveredConfig[] }>("/api/llm/discovered", 10_000),
    ]);
    if (p.ok) setProfiles(p.data.profiles);
    else message.error("无法读取模型配置，请检查管家服务。");
    if (b.ok) setBindings(b.data.bindings);
    if (s.ok) setStatus(s.data);
    if (d.ok) setDiscovered(d.data.configs);
    setLoading(false);
  }, [message, seed]);
  useEffect(() => {
    if (!seed) void refresh();
  }, [refresh, seed]);

  const openAdd = () => {
    addDraftStore.open = true;
    setAddOpen(true);
  };
  const closeAdd = () => {
    // 仅收起表单，保留已填内容（草稿不丢）。
    addDraftStore.open = false;
    setAddOpen(false);
  };
  const openBinding = () => {
    bindingDraftStore.open = true;
    setBindingOpen(true);
  };
  const closeBinding = () => {
    bindingDraftStore.open = false;
    setBindingOpen(false);
  };

  const createProfile = async () => {
    const values = await profileForm.validateFields();
    setSaving(true);
    const result = await postJson("/api/llm/profiles", values, 30_000);
    setSaving(false);
    if (!result.ok) return message.error(credentialWriteError(result));
    message.success("模型配置已加密保存并完成连接测试。");
    profileForm.resetFields();
    // 保存成功后清空草稿；失败时保留（见 catch 之外不重置）。
    addDraftStore.values = {};
    addDraftStore.open = false;
    setAddOpen(false);
    await refresh();
  };
  const probe = async (id: string) => {
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(id)}/probe`, {}, 30_000);
    if (result.ok) message.success("连接测试已完成");
    else message.error("连接测试失败");
    await refresh();
  };
  const disable = async (id: string) => {
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(id)}/disable`, {}, 15_000);
    if (result.ok) message.success("配置已禁用");
    else message.error("禁用失败");
    await refresh();
  };
  const rotate = async () => {
    const values = await rotateForm.validateFields();
    if (!rotateId) return;
    setRotating(true);
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(rotateId)}/rotate`, values, 30_000);
    setRotating(false);
    if (!result.ok) return message.error("轮换失败，旧 Key 保持不变。请检查新 Key 和端点。");
    message.success("新 Key 连接测试通过，已切换到新版本。");
    setRotateId(null);
    rotateForm.resetFields();
    await refresh();
  };
  const importDiscovered = async (id: string) => {
    const result = await postJson(`/api/llm/discovered/${encodeURIComponent(id)}/import`, {}, 30_000);
    if (!result.ok) return message.error("导入失败，请确认凭据库可用。");
    message.success("已导入为 disabled profile；请先测试连接并建立绑定。");
    await refresh();
  };
  const copyDraft = async (row: DiscoveredConfig) => {
    const draft = `请在 Hermes 配置中使用以下模型设置（不要把 API Key 写入提示词）：\nprovider: ${row.provider}\nprotocol: ${row.protocol}\nendpoint: ${row.endpoint}\nmodel: ${row.model}\nAPI Key 请从 Butler 的“模型与 API Key”中绑定的 profile 注入。`;
    try {
      await navigator.clipboard.writeText(draft);
      message.success("Hermes 配置提示词草案已复制");
    } catch {
      message.info(draft);
    }
  };
  const addBinding = async () => {
    const values = await bindingForm.validateFields();
    const result = await postJson("/api/llm/bindings", values);
    if (!result.ok) return message.error("绑定失败，请检查该范围是否已有绑定。");
    message.success("已建立明确绑定。");
    bindingForm.resetFields();
    bindingDraftStore.values = {};
    bindingDraftStore.open = false;
    setBindingOpen(false);
    await refresh();
  };
  const removeBinding = async (id: string) => {
    const result = await deleteJson(`/api/llm/bindings/${encodeURIComponent(id)}`);
    if (!result.ok) message.error("移除绑定失败");
    else {
      message.success("绑定已移除");
      await refresh();
    }
  };

  return (
    <section>
      <Flex vertical gap={16}>
        {status?.vault.available === false && (
          <Alert
            type="error"
            showIcon
            message="凭据库未启用"
            description="部署环境缺少有效的 BUTLER_SECRET_MASTER_KEY。Butler 会拒绝保存、注入或明文回退 API Key。"
          />
        )}
        <SectionHeader
          kicker="模型与 API Key"
          title="管家任务模型配置"
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
              刷新
            </Button>
          }
        />
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这里保存的是 Butler 在进化和受管任务中注入的加密凭据，不会覆盖 Hermes 自己的
          `config.yaml` 或 `.env`。密钥不会出现在日志、审计或页面详情中。
        </Paragraph>
        <Descriptions size="small" column={{ xs: 1, sm: 4 }}>
          <Descriptions.Item label="凭据库">{status?.vault.available ? "可用" : "未配置"}</Descriptions.Item>
          <Descriptions.Item label="已保存">{status?.profiles ?? 0}</Descriptions.Item>
          <Descriptions.Item label="连接通过">{status?.activeProfiles ?? 0}</Descriptions.Item>
          <Descriptions.Item label="已绑定">{status?.activeBindings ?? 0}</Descriptions.Item>
        </Descriptions>
        {status !== null && !status.ready && status.vault.available && (
          <Alert
            type="info"
            showIcon
            message="还差最后一步：把已通过连接测试的模型绑定到实例或框架"
            description="保存 API Key 不会自动让任务使用它。建立绑定后，Butler 才会把对应模型安全地注入受管任务。"
          />
        )}

        {/* 已有模型配置及其使用情况（先于添加动作展示）。 */}
        <Card
          size="small"
          title="已有模型配置"
          extra={
            <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={openAdd}>
              添加模型配置
            </Button>
          }
        >
          <Table<Profile>
            size="small"
            loading={loading}
            rowKey="profileId"
            dataSource={profiles}
            pagination={false}
            columns={[
              { title: "提供商 / 模型", render: (_, row) => <div><strong>{row.provider}</strong><br />{row.model}</div> },
              { title: "端点", dataIndex: "endpoint", ellipsis: true },
              { title: "Key", dataIndex: "maskedKey" },
              {
                title: "连接",
                render: (_, row) =>
                  row.probe ? (
                    <span title={row.probe.detail}>
                      <StatusBadge tone={row.probe.status === "pass" ? "ok" : "error"} label={probeStateLabel(row.probe)} />
                      <br />
                      <small>{new Date(row.probe.checkedAt).toLocaleString()}</small>
                    </span>
                  ) : (
                    <StatusBadge tone="unknown" label="未检查" />
                  ),
              },
              { title: "绑定", dataIndex: "bindingCount" },
              {
                title: "操作",
                width: 220,
                render: (_, row) => (
                  <Space size={4} wrap>
                    <Button size="small" onClick={() => void probe(row.profileId)}>测试连接</Button>
                    <Button size="small" onClick={() => { setRotateId(row.profileId); rotateForm.resetFields(); }}>轮换</Button>
                    <Popconfirm title="禁用此配置？" onConfirm={() => void disable(row.profileId)}>
                      <Button size="small" danger>禁用</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
            locale={{ emptyText: "还没有模型配置。添加后必须绑定到实例、技能或进化目标才会被使用。" }}
          />
        </Card>

        {/* 添加模型：显式动作，非常开表单。 */}
        {addOpen && (
          <Card size="small" title="添加模型配置">
            <Form
              form={profileForm}
              layout="vertical"
              initialValues={{ protocol: "openai-compatible", ...addDraftStore.values }}
              onValuesChange={(_, all) => {
                addDraftStore.values = all;
              }}
            >
              <Form.Item name="provider" label="提供商" rules={[{ required: true }]}>
                <Select options={providerOptions} />
              </Form.Item>
              <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
                <Select options={protocolOptions} />
              </Form.Item>
              <Form.Item name="endpoint" label="端点" rules={[{ required: true, type: "url" }]}>
                <Input placeholder="https://api.example.com/v1" />
              </Form.Item>
              <Form.Item name="model" label="模型" rules={[{ required: true }]}>
                <Input placeholder="model-name" />
              </Form.Item>
              <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Space>
                <Button type="primary" icon={<SafetyCertificateOutlined />} loading={saving} disabled={status?.vault.available === false} onClick={() => void createProfile()}>
                  保存并测试连接
                </Button>
                <Button onClick={closeAdd}>稍后再说</Button>
              </Space>
            </Form>
          </Card>
        )}

        {/* 高级绑定：与添加模型分开的两步有意操作。 */}
        <Card
          size="small"
          title="明确绑定"
          extra={
            <Tooltip title={profiles.length === 0 ? "还没有可绑定的配置档案，先添加一个" : "建立模型到实例 / 框架 / 技能 / 插件的绑定"}>
              <Button icon={<ApiOutlined />} disabled={profiles.length === 0} onClick={openBinding}>
                添加绑定
              </Button>
            </Tooltip>
          }
        >
          <Table<Binding>
            size="small"
            rowKey="bindingId"
            dataSource={bindings}
            pagination={false}
            columns={[
              { title: "范围", dataIndex: "scope" },
              { title: "实例", dataIndex: "instanceId", render: (value) => value ?? "—" },
              { title: "目标", dataIndex: "targetRef", render: (value) => value ?? "—" },
              { title: "模型配置", render: (_, row) => profileLabel(profiles.find((pr) => pr.profileId === row.profileId)) },
              {
                title: "",
                render: (_, row) => (
                  <Popconfirm title="移除此绑定？" onConfirm={() => void removeBinding(row.bindingId)}>
                    <Button icon={<DeleteOutlined />} />
                  </Popconfirm>
                ),
              },
            ]}
            locale={{ emptyText: "没有绑定；未绑定的进化任务会被明确阻断。" }}
          />
        </Card>

        {bindingOpen && (
          <Card size="small" title="添加绑定">
            <Form
              form={bindingForm}
              layout="vertical"
              initialValues={{ scope: "instance", frameworkId: "hermes", ...bindingDraftStore.values }}
              onValuesChange={(_, all) => {
                bindingDraftStore.values = all;
              }}
            >
              <Form.Item name="profileId" label="模型配置" rules={[{ required: true }]}>
                <Select options={profiles.map((profile) => ({ value: profile.profileId, label: profileLabel(profile) }))} />
              </Form.Item>
              <Form.Item name="scope" label="范围" rules={[{ required: true }]}>
                <Select options={scopeOptions} />
              </Form.Item>
              <Form.Item name="instanceId" label="实例 ID">
                <Input placeholder="可选，建议填写" />
              </Form.Item>
              <Form.Item name="frameworkId" label="框架">
                <Input placeholder="hermes" />
              </Form.Item>
              <Form.Item name="targetRef" label="技能/插件/目标引用">
                <Input placeholder="skill-name（精确绑定时必填）" />
              </Form.Item>
              <Space>
                <Button icon={<ApiOutlined />} disabled={profiles.length === 0} onClick={() => void addBinding()}>
                  建立绑定
                </Button>
                <Button onClick={closeBinding}>稍后再说</Button>
              </Space>
            </Form>
          </Card>
        )}

        <Card size="small" title="迁移助手 · Hermes 已发现配置">
          <Flex vertical gap={12}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              只读扫描 WSL Hermes 的 `.env/config.yaml`。导入会创建 disabled profile，不会修改原配置，也不会自动绑定。
            </Paragraph>
            <Table<DiscoveredConfig>
              size="small"
              rowKey="id"
              dataSource={discovered}
              pagination={false}
              columns={[
                { title: "来源", dataIndex: "source", ellipsis: true },
                { title: "提供商 / 模型", render: (_, row) => <div><strong>{row.provider}</strong><br />{row.model}</div> },
                { title: "端点", dataIndex: "endpoint", ellipsis: true },
                { title: "Key", dataIndex: "maskedKey" },
                {
                  title: "操作",
                  render: (_, row) => (
                    <Space>
                      <Button onClick={() => void importDiscovered(row.id)} disabled={status?.vault.available === false || !row.importable}>导入</Button>
                      <Button icon={<CopyOutlined />} onClick={() => void copyDraft(row)} disabled={row.runtimeObserved || row.endpoint.trim() === ""}>复制配置草案</Button>
                    </Space>
                  ),
                },
              ]}
              locale={{ emptyText: "没有发现可迁移的 Hermes 模型配置。" }}
            />
          </Flex>
        </Card>
        <Modal open={rotateId !== null} title="轮换 API Key" okText="测试连接并切换" cancelText="取消" confirmLoading={rotating} onCancel={() => setRotateId(null)} onOk={() => void rotate()}>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            新 Key 只有在真实连接测试成功后才会成为 active；失败时旧版本保持可用。
          </Paragraph>
          <Form form={rotateForm} layout="vertical">
            <Form.Item name="apiKey" label="新 API Key" rules={[{ required: true, message: "请输入新 API Key" }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </Form>
        </Modal>
      </Flex>
    </section>
  );
}
