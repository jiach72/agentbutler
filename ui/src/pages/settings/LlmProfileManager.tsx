import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Table } from "antd";
import { ApiOutlined, CopyOutlined, DeleteOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { deleteJson, loadJson, postJson } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";

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

function credentialWriteError(result: { status: number; data: unknown }): string {
  if (result.status === 403 && result.data !== null && typeof result.data === "object") {
    const error = (result.data as Record<string, unknown>).error;
    if (error === "credential-writes-require-loopback") {
      return "凭据写入已被安全策略阻断：本机 WSL/Docker 部署可设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true 后重启服务。若 Web 发布到局域网或公网，必须先接入认证并保持该开关关闭。";
    }
  }
  return "保存或探针失败。请检查端点、模型名和 API Key。";
}

const providerOptions = ["OpenAI", "DeepSeek", "通义", "智谱", "Kimi", "豆包", "MiniMax", "百川", "自定义 OpenAI-compatible", "Claude", "Gemini"].map((value) => ({ label: value, value }));

export function LlmProfileManager() {
  const { message } = App.useApp();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [profileForm] = Form.useForm();
  const [bindingForm] = Form.useForm();
  const [rotateForm] = Form.useForm();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [p, b, s, d] = await Promise.all([loadJson<{ profiles: Profile[] }>("/api/llm/profiles", 10_000), loadJson<{ bindings: Binding[] }>("/api/llm/bindings", 10_000), loadJson<Status>("/api/llm/status", 10_000), loadJson<{ configs: DiscoveredConfig[] }>("/api/llm/discovered", 10_000)]);
    if (p.ok) setProfiles(p.data.profiles); else message.error("无法读取模型配置，请检查 Watch 服务。");
    if (b.ok) setBindings(b.data.bindings);
    if (s.ok) setStatus(s.data);
    if (d.ok) setDiscovered(d.data.configs);
    setLoading(false);
  }, [message]);
  useEffect(() => { void refresh(); }, [refresh]);

  const createProfile = async () => {
    const values = await profileForm.validateFields();
    setSaving(true);
    const result = await postJson("/api/llm/profiles", values, 30_000);
    setSaving(false);
    if (!result.ok) return message.error(credentialWriteError(result));
    message.success("模型配置已加密保存并完成探针。");
    profileForm.resetFields();
    await refresh();
  };
  const probe = async (id: string) => {
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(id)}/probe`, {}, 30_000);
    if (result.ok) message.success("探针已完成"); else message.error("探针失败");
    await refresh();
  };
  const disable = async (id: string) => {
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(id)}/disable`, {}, 15_000);
    if (result.ok) message.success("配置已禁用"); else message.error("禁用失败");
    await refresh();
  };
  const rotate = async () => {
    const values = await rotateForm.validateFields();
    if (!rotateId) return;
    setRotating(true);
    const result = await postJson(`/api/llm/profiles/${encodeURIComponent(rotateId)}/rotate`, values, 30_000);
    setRotating(false);
    if (!result.ok) return message.error("轮换失败，旧 Key 保持不变。请检查新 Key 和端点。" );
    message.success("新 Key 探针通过，已切换到新版本。" );
    setRotateId(null);
    rotateForm.resetFields();
    await refresh();
  };
  const importDiscovered = async (id: string) => {
    const result = await postJson(`/api/llm/discovered/${encodeURIComponent(id)}/import`, {}, 30_000);
    if (!result.ok) return message.error("导入失败，请确认凭据库可用。" );
    message.success("已导入为 disabled profile；请先探针并建立绑定。" );
    await refresh();
  };
  const copyDraft = async (row: DiscoveredConfig) => {
    const draft = `请在 Hermes 配置中使用以下模型设置（不要把 API Key 写入提示词）：\nprovider: ${row.provider}\nprotocol: ${row.protocol}\nendpoint: ${row.endpoint}\nmodel: ${row.model}\nAPI Key 请从 Butler 的“模型与 API Key”中绑定的 profile 注入。`;
    try { await navigator.clipboard.writeText(draft); message.success("Hermes 配置提示词草案已复制" ); }
    catch { message.info(draft); }
  };
  const addBinding = async () => { const values = await bindingForm.validateFields(); const result = await postJson("/api/llm/bindings", values); if (!result.ok) return message.error("绑定失败，请检查该范围是否已有绑定。"); message.success("已建立明确绑定。"); bindingForm.resetFields(); await refresh(); };
  const removeBinding = async (id: string) => { const result = await deleteJson(`/api/llm/bindings/${encodeURIComponent(id)}`); if (!result.ok) message.error("移除绑定失败"); else { message.success("绑定已移除"); await refresh(); } };

  return <section className="settings-llm">
    {status?.vault.available === false && <Alert type="error" showIcon message="凭据库未启用" description="部署环境缺少有效的 BUTLER_SECRET_MASTER_KEY。Butler 会拒绝保存、注入或明文回退 API Key。" />}
    <div className="settings-section-head"><div><span>模型与 API Key</span><h2>管家任务模型配置</h2></div><Button icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button></div>
    <p className="hint">这里保存的是 Butler 在进化和受管任务中注入的加密凭据，不会覆盖 Hermes 自己的 `config.yaml` 或 `.env`。密钥不会出现在日志、审计或页面详情中。</p>
    <Descriptions size="small" column={{ xs: 1, sm: 4 }} className="settings-llm-summary"><Descriptions.Item label="凭据库">{status?.vault.available ? "可用" : "未配置"}</Descriptions.Item><Descriptions.Item label="已保存">{status?.profiles ?? 0}</Descriptions.Item><Descriptions.Item label="探针通过">{status?.activeProfiles ?? 0}</Descriptions.Item><Descriptions.Item label="已绑定">{status?.activeBindings ?? 0}</Descriptions.Item></Descriptions>
    {status !== null && !status.ready && status.vault.available && (
      <Alert
        type="info"
        showIcon
        message="还差最后一步：把已通过探针的模型绑定到实例或框架"
        description="保存 API Key 不会自动让任务使用它。建立绑定后，Butler 才会把对应模型安全地注入受管任务。"
      />
    )}
    <div className="settings-llm-grid">
      <div>
        <h3>添加模型配置</h3>
        <Form form={profileForm} layout="vertical" initialValues={{ protocol: "openai-compatible" }}>
          <Form.Item name="provider" label="提供商" rules={[{ required: true }]}><Select options={providerOptions} /></Form.Item>
          <Form.Item name="protocol" label="协议" rules={[{ required: true }]}><Select options={[{ value: "openai-compatible", label: "OpenAI-compatible" }, { value: "anthropic", label: "Anthropic 原生" }, { value: "gemini", label: "Gemini 原生" }]} /></Form.Item>
          <Form.Item name="endpoint" label="端点" rules={[{ required: true, type: "url" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true }]}><Input placeholder="model-name" /></Form.Item>
          <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Button type="primary" icon={<SafetyCertificateOutlined />} loading={saving} disabled={status?.vault.available === false} onClick={() => void createProfile()}>加密保存并探针</Button>
        </Form>
      </div>
      <div>
        <h3>明确绑定</h3>
        <Form form={bindingForm} layout="vertical" initialValues={{ scope: "instance", frameworkId: "hermes" }}>
          <Form.Item name="profileId" label="模型配置" rules={[{ required: true }]}><Select options={profiles.map((profile) => ({ value: profile.profileId, label: `${profile.provider} · ${profile.model}` }))} /></Form.Item>
          <Form.Item name="scope" label="范围" rules={[{ required: true }]}><Select options={[{ value: "instance", label: "实例默认" }, { value: "framework", label: "框架默认" }, { value: "skill", label: "技能" }, { value: "plugin", label: "插件" }, { value: "evolution", label: "进化目标" }]} /></Form.Item>
          <Form.Item name="instanceId" label="实例 ID"><Input placeholder="可选，建议填写" /></Form.Item>
          <Form.Item name="frameworkId" label="框架"><Input placeholder="hermes" /></Form.Item>
          <Form.Item name="targetRef" label="技能/插件/目标引用"><Input placeholder="skill-name（精确绑定时必填）" /></Form.Item>
          <Button icon={<ApiOutlined />} disabled={profiles.length === 0} onClick={() => void addBinding()}>建立绑定</Button>
        </Form>
      </div>
    </div>
    <Table<Profile> size="small" loading={loading} rowKey="profileId" dataSource={profiles} pagination={false} columns={[
      { title: "提供商 / 模型", render: (_, row) => <div><strong>{row.provider}</strong><br />{row.model}</div> },
      { title: "端点", dataIndex: "endpoint", ellipsis: true },
      { title: "Key", dataIndex: "maskedKey" },
      { title: "探针", render: (_, row) => row.probe ? <span title={row.probe.detail}><StatusBadge tone={row.probe.status === "pass" ? "ok" : "error"} label={row.probe.category} /><small>{new Date(row.probe.checkedAt).toLocaleString()}</small></span> : <StatusBadge tone="muted" label="未检查" /> },
      { title: "绑定", dataIndex: "bindingCount" },
      { title: "操作", render: (_, row) => <Space><Button size="small" onClick={() => void probe(row.profileId)}>探针</Button><Button size="small" onClick={() => { setRotateId(row.profileId); rotateForm.resetFields(); }}>轮换</Button><Popconfirm title="禁用此配置？" onConfirm={() => void disable(row.profileId)}><Button size="small" danger>禁用</Button></Popconfirm></Space> },
    ]} locale={{ emptyText: "还没有模型配置。添加后必须绑定到实例、技能或进化目标才会被使用。" }} />
    <Table<Binding> size="small" rowKey="bindingId" dataSource={bindings} pagination={false} className="settings-llm-bindings" columns={[
      { title: "范围", dataIndex: "scope" }, { title: "实例", dataIndex: "instanceId", render: (value) => value ?? "—" }, { title: "目标", dataIndex: "targetRef", render: (value) => value ?? "—" }, { title: "配置", dataIndex: "profileId", ellipsis: true }, { title: "", render: (_, row) => <Popconfirm title="移除此绑定？" onConfirm={() => void removeBinding(row.bindingId)}><Button size="small" icon={<DeleteOutlined />} /></Popconfirm> },
    ]} locale={{ emptyText: "没有绑定；未绑定的进化任务会被明确阻断。" }} />
    <div className="settings-llm-discovered">
      <div className="settings-section-head is-compact"><div><span>迁移助手</span><h3>Hermes 已发现配置</h3></div></div>
      <p className="hint">只读扫描 WSL Hermes 的 `.env/config.yaml`。导入会创建 disabled profile，不会修改原配置，也不会自动绑定。</p>
      <Table<DiscoveredConfig> size="small" rowKey="id" dataSource={discovered} pagination={false} columns={[
        { title: "来源", dataIndex: "source", ellipsis: true },
        { title: "提供商 / 模型", render: (_, row) => <div><strong>{row.provider}</strong><br />{row.model}</div> },
        { title: "端点", dataIndex: "endpoint", ellipsis: true },
        { title: "Key", dataIndex: "maskedKey" },
        { title: "操作", render: (_, row) => <Space><Button size="small" onClick={() => void importDiscovered(row.id)} disabled={status?.vault.available === false || !row.importable}>导入</Button><Button size="small" icon={<CopyOutlined />} onClick={() => void copyDraft(row)} disabled={row.runtimeObserved || row.endpoint.trim() === ""}>复制配置草案</Button></Space> },
      ]} locale={{ emptyText: "没有发现可迁移的 Hermes 模型配置。" }} />
    </div>
    <Modal open={rotateId !== null} title="轮换 API Key" okText="探针并切换" cancelText="取消" confirmLoading={rotating} onCancel={() => setRotateId(null)} onOk={() => void rotate()}>
      <p className="hint">新 Key 只有在真实探针成功后才会成为 active；失败时旧版本保持可用。</p>
      <Form form={rotateForm} layout="vertical"><Form.Item name="apiKey" label="新 API Key" rules={[{ required: true, message: "请输入新 API Key" }]}><Input.Password autoComplete="new-password" /></Form.Item></Form>
    </Modal>
  </section>;
}
