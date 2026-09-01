import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Form, Input, Radio, Select, Space, Spin, Steps, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { markSetupDone } from "./state.js";
import { SCENARIO_TEMPLATES, type ScenarioTemplate } from "./templates.js";

interface SetupConnection {
  instanceId: string;
  displayName?: string;
  connected?: boolean;
  connectionState?: string;
  version?: string | null;
}

interface SetupStatus {
  reachable: boolean;
  configured: boolean;
  connections: SetupConnection[];
}

interface LlmStatus {
  vault: { available: boolean };
  activeProfiles: number;
  activeBindings: number;
  ready: boolean;
}

interface LlmProfile {
  profileId: string;
  provider: string;
  model: string;
  status: "active" | "disabled" | "unsupported";
  probe: { status: "pass" | "fail"; detail: string } | null;
}

interface LlmBinding {
  bindingId: string;
  profileId: string;
  scope: string;
  instanceId: string | null;
}

interface DiscoveredModel {
  id: string;
  source: string;
  provider: string;
  model: string;
  importable: boolean;
  runtimeObserved: boolean;
}

function isActiveProfile(profile: LlmProfile): boolean {
  return profile.status === "active" && profile.probe?.status === "pass";
}

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [bindings, setBindings] = useState<LlmBinding[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [selectedExistingProfile, setSelectedExistingProfile] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<ScenarioTemplate["id"]>("daily");
  const [modelForm] = Form.useForm();

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    const [setupResult, llmResult, profileResult, bindingResult, discoveredResult] = await Promise.all([
      loadJson<SetupStatus>("/api/setup/status", 8_000),
      loadJson<LlmStatus>("/api/llm/status", 8_000),
      loadJson<{ profiles: LlmProfile[] }>("/api/llm/profiles", 8_000),
      loadJson<{ bindings: LlmBinding[] }>("/api/llm/bindings", 8_000),
      loadJson<{ configs: DiscoveredModel[] }>("/api/llm/discovered", 8_000),
    ]);
    if (!setupResult.ok) {
      setError(setupResult.reason);
      setStatus(null);
    } else {
      setStatus(setupResult.data);
      setSelected((current) => current ?? setupResult.data.connections[0]?.instanceId ?? null);
    }
    if (llmResult.ok) setLlmStatus(llmResult.data);
    if (profileResult.ok) {
      setProfiles(profileResult.data.profiles);
      setSelectedExistingProfile((current) => current ?? profileResult.data.profiles.find(isActiveProfile)?.profileId ?? null);
    }
    if (bindingResult.ok) setBindings(bindingResult.data.bindings);
    if (discoveredResult.ok) setDiscoveredModels(discoveredResult.data.configs);
    setLoading(false);
  };

  useEffect(() => { void loadStatus(); }, []);

  const selectedConnection = useMemo(
    () => status?.connections.find((item) => item.instanceId === selected) ?? null,
    [selected, status],
  );
  const selectedTemplate = SCENARIO_TEMPLATES.find((item) => item.id === templateId) ?? SCENARIO_TEMPLATES[0]!;
  const activeProfiles = profiles.filter(isActiveProfile);
  const readyProfileIds = new Set(
    bindings
      .filter((binding) => binding.instanceId === selected && (binding.scope === "instance" || binding.scope === "framework"))
      .map((binding) => binding.profileId),
  );
  const modelReady = selected !== null && activeProfiles.some((profile) => readyProfileIds.has(profile.profileId));
  const nativeModelDetected = discoveredModels.some((model) => !model.runtimeObserved);
  const runtimeModelObserved = discoveredModels.filter((model) => model.runtimeObserved).length;

  const runCheck = async () => {
    if (selected === null) return;
    setChecking(true);
    setCheckResult(null);
    const result = await postJson("/api/connections/check", { instanceId: selected }, 20_000);
    setChecking(false);
    if (result.ok) {
      setCheckResult("连接检查完成。最后选一个常用场景，管家就会按这个入口带你继续。");
      setStep(4);
    } else {
      setCheckResult(`连接检查没有完成（${result.status || "网络错误"}）。请先回到上一步换一个实例，或在设置中检查运行环境。`);
    }
  };

  const bindProfile = async (profileId: string): Promise<boolean> => {
    if (selected === null) return false;
    const result = await postJson("/api/llm/bindings", { profileId, scope: "instance", instanceId: selected }, 15_000);
    if (!result.ok) {
      setModelMessage("模型已验证，但没有完成绑定。请稍后重试，或到设置页检查是否已有同范围绑定。");
      return false;
    }
    await loadStatus();
    return true;
  };

  const createAndBindModel = async () => {
    if (selected === null) return;
    const values = await modelForm.validateFields();
    setSavingModel(true);
    setModelMessage(null);
    const result = await postJson("/api/llm/profiles", { ...values, instanceId: selected }, 30_000);
    const profile = result.ok && isRecord(result.data) && isRecord(result.data["profile"])
      ? result.data["profile"] as unknown as LlmProfile
      : undefined;
    if (profile === undefined) {
      setSavingModel(false);
      setModelMessage(result.status === 403
        ? "当前访问方式不允许写入密钥。请在本机打开管家，或到设置里处理访问安全后再试。"
        : "没有通过模型探针。请核对端点、模型名和 API Key。保存前不会覆盖现有配置。");
      return;
    }
    if (!isActiveProfile(profile)) {
      setSavingModel(false);
      setModelMessage("模型信息已保存，但探针没有通过或当前协议不能用于 Hermes 受管任务。请到设置查看详细原因。");
      await loadStatus();
      return;
    }
    const bound = await bindProfile(profile.profileId);
    setSavingModel(false);
    if (bound) {
      modelForm.resetFields();
      setModelMessage("模型已通过探针，并已绑定到当前实例。");
    }
  };

  const bindExistingProfile = async () => {
    if (selectedExistingProfile === null) return;
    setSavingModel(true);
    setModelMessage(null);
    const bound = await bindProfile(selectedExistingProfile);
    setSavingModel(false);
    if (bound) setModelMessage("已把通过探针的模型绑定到当前实例。");
  };

  const complete = () => {
    markSetupDone({ instanceId: selected, templateId: selectedTemplate.id });
    navigate(selectedTemplate.destination, { replace: true });
  };

  return (
    <section className="setup-page">
      <Flex vertical gap={24}>
        <PageHeader eyebrow="首次使用" title="把智能体接好，就能放心交给管家" description="依次确认运行环境、模型和常用用途；每一步都可以复查，不会偷偷改动 Hermes 原有配置。" />
        <Steps current={step} items={[{ title: "环境" }, { title: "智能体" }, { title: "模型" }, { title: "验证" }, { title: "用途" }]} />
        {loading && <Card><Flex justify="center" style={{ padding: 32 }}><Space><Spin /><Typography.Text type="secondary">正在读取本机环境…</Typography.Text></Space></Flex></Card>}
        {!loading && error !== null && (
          <Card>
            <Flex vertical gap={16}>
              <Alert type="warning" showIcon message="暂时读不到管家状态" description={error} />
              <Button icon={<ReloadOutlined />} onClick={() => void loadStatus()}>重新检查</Button>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 0 && (
          <Card>
            <Flex vertical gap={16}>
              <Typography.Title level={4} style={{ marginBottom: 0 }}>先确认本机环境</Typography.Title>
              <Flex vertical gap={8}>
                <Typography.Text type="success"><CheckCircleOutlined /> 管家 Web 服务已启动</Typography.Text>
                <Typography.Text type={status.reachable ? "success" : "warning"}>{status.reachable ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />} 管家控制通道{status.reachable ? "可用" : "暂时不可用"}</Typography.Text>
                <Typography.Text type={status.connections.length > 0 ? "success" : "warning"}>{status.connections.length > 0 ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />} 已发现 {status.connections.length} 个可管理实例</Typography.Text>
              </Flex>
              {status.connections.length === 0 && <Alert type="info" showIcon message="还没有发现 Hermes 实例" description="请先在设置中补充 Hermes 路径，回到这里重新检查。" />}
              <Space wrap><Button type="primary" disabled={status.connections.length === 0} onClick={() => setStep(1)}>继续</Button><Button onClick={() => navigate("/settings")}>打开设置</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 1 && (
          <Card>
            <Flex vertical gap={16}>
              <Typography.Title level={4} style={{ marginBottom: 0 }}>选择要管理的智能体</Typography.Title>
              <Radio.Group value={selected} onChange={(event) => setSelected(event.target.value)} style={{ display: "grid", gap: 12 }}>
                {status.connections.map((item) => (
                  <Radio key={item.instanceId} value={item.instanceId}>
                    <Flex vertical>
                      <Typography.Text strong>{item.displayName ?? item.instanceId}</Typography.Text>
                      <Typography.Text type="secondary">{item.version ?? "版本未知"} · {item.connected ? "当前已连接" : item.connectionState ?? "待检查"}</Typography.Text>
                    </Flex>
                  </Radio>
                ))}
              </Radio.Group>
              <Space wrap><Button onClick={() => setStep(0)}>上一步</Button><Button type="primary" disabled={selected === null} onClick={() => setStep(2)}>继续</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 2 && (
          <Card>
            <Flex vertical gap={16}>
              <Typography.Title level={4} style={{ marginBottom: 0 }}>检查模型配置</Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>Hermes 的日常运行使用它自己的 `config.yaml` 或 `.env`；Butler 受管任务使用下方加密保存并绑定的模型。两者职责不同，页面会分别如实显示。</Typography.Paragraph>
              {nativeModelDetected ? <Alert type="success" showIcon message="已发现 Hermes 原生模型配置" description={`发现 ${discoveredModels.filter((model) => !model.runtimeObserved).length} 项已有配置；不会被本向导覆盖。`} /> : runtimeModelObserved > 0 ? <Alert type="success" showIcon message="已观察到 Hermes 正在使用模型" description={`从运行日志识别到 ${runtimeModelObserved} 个模型标识；这不会读取或导入凭据。`} /> : <Alert type="warning" showIcon message="还没有发现 Hermes 原生模型配置" description="如果智能体本身还不能对话，请先在 Hermes 的 config.yaml 或 .env 中完成运行模型配置。" />}
              {modelReady ? <Alert type="success" showIcon message="当前智能体已有可用的受管任务模型" description="模型探针通过且已绑定。后续可在设置中轮换 Key 或修改绑定范围。" /> : <Alert type="info" showIcon message="还没有绑定受管任务模型" description="这是推荐步骤：它让进化和诊断类任务能使用经过真实探针验证的模型。" />}
              {llmStatus?.vault.available === false && <Alert type="warning" showIcon message="凭据库还不可用" description="缺少 BUTLER_SECRET_MASTER_KEY 时，管家不会保存 API Key。请在设置中完成本机安全配置后再继续。" />}
              {!modelReady && activeProfiles.length > 0 && (
                <Flex vertical gap={12}>
                  <Typography.Title level={5} style={{ marginBottom: 0 }}>使用已验证的模型</Typography.Title>
                  <Space wrap>
                    <Select value={selectedExistingProfile ?? undefined} onChange={setSelectedExistingProfile} options={activeProfiles.map((profile) => ({ value: profile.profileId, label: `${profile.provider} · ${profile.model}` }))} />
                    <Button onClick={() => void bindExistingProfile()} loading={savingModel} disabled={selectedExistingProfile === null}>绑定到当前智能体</Button>
                  </Space>
                </Flex>
              )}
              {!modelReady && llmStatus?.vault.available !== false && (
                <Form form={modelForm} layout="vertical" style={{ maxWidth: 560 }} initialValues={{ provider: "OpenAI", protocol: "openai-compatible" }}>
                  <Typography.Title level={5} style={{ marginBottom: 0 }}>添加一个模型</Typography.Title>
                  <Form.Item name="provider" label="提供商" rules={[{ required: true, message: "请选择提供商" }]}><Select options={[{ value: "OpenAI", label: "OpenAI" }, { value: "DeepSeek", label: "DeepSeek" }, { value: "通义", label: "通义" }, { value: "自定义 OpenAI-compatible", label: "自定义 OpenAI-compatible" }]} /></Form.Item>
                  <Form.Item name="protocol" label="协议" rules={[{ required: true }]}><Select options={[{ value: "openai-compatible", label: "OpenAI-compatible（推荐 Hermes）" }]} /></Form.Item>
                  <Form.Item name="endpoint" label="端点" rules={[{ required: true, type: "url", message: "请输入完整的 https 地址" }]}><Input placeholder="https://api.example.com/v1" autoComplete="url" /></Form.Item>
                  <Form.Item name="model" label="模型名称" rules={[{ required: true, message: "请输入模型名称" }]}><Input placeholder="例如 gpt-4.1-mini" /></Form.Item>
                  <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: "请输入 API Key" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                  <Button type="primary" loading={savingModel} onClick={() => void createAndBindModel()}>验证并绑定</Button>
                </Form>
              )}
              {modelMessage !== null && <Alert type={modelReady ? "success" : "warning"} showIcon message={modelMessage} />}
              <Space wrap><Button onClick={() => setStep(1)}>上一步</Button><Button type="primary" onClick={() => setStep(3)}>继续</Button><Button type="link" onClick={() => navigate("/settings")}>在设置中详细配置</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 3 && (
          <Card>
            <Flex vertical gap={16}>
              <Typography.Title level={4} style={{ marginBottom: 0 }}>做一次真实连接检查</Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>这一步只检测连接，不会修改你的智能体配置。</Typography.Paragraph>
              {selectedConnection !== null && <Typography.Text>当前选择：<Typography.Text strong>{selectedConnection.displayName ?? selectedConnection.instanceId}</Typography.Text></Typography.Text>}
              {checkResult !== null && <Alert type={checkResult.startsWith("连接检查完成") ? "success" : "warning"} showIcon message={checkResult} />}
              <Space wrap>
                <Button onClick={() => setStep(2)}>上一步</Button>
                <Button type="primary" loading={checking} onClick={() => void runCheck()}>开始检查</Button>
              </Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 4 && (
          <Card>
            <Flex vertical gap={16}>
              <Typography.Title level={4} style={{ marginBottom: 0 }}>最后，告诉我你最常用的场景</Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>这不会擅自安装技能或改写提示词；它只会替你记住最适合的下一个入口。</Typography.Paragraph>
              <Radio.Group value={templateId} onChange={(event) => setTemplateId(event.target.value)} style={{ display: "grid", gap: 12 }}>
                {SCENARIO_TEMPLATES.map((template) => (
                  <Radio key={template.id} value={template.id}>
                    <Flex vertical>
                      <Typography.Text strong>{template.label}</Typography.Text>
                      <Typography.Text type="secondary">{template.description}</Typography.Text>
                    </Flex>
                  </Radio>
                ))}
              </Radio.Group>
              <Space wrap><Button onClick={() => setStep(3)}>上一步</Button><Button type="primary" onClick={complete}>{selectedTemplate.nextLabel}</Button></Space>
            </Flex>
          </Card>
        )}
      </Flex>
    </section>
  );
}
