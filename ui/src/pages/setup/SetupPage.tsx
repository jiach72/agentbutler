import {
  ApiOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  CodeOutlined,
  DashboardOutlined,
  HomeOutlined,
  NotificationOutlined,
  ReadOutlined,
  RobotOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Flex, Form, Input, Radio, Select, Space, Spin, Steps, Typography } from "antd";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { loadJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { markSetupDone } from "./state.js";
import { SCENARIO_TEMPLATES, type ScenarioTemplate } from "./templates.js";
import { SetupResults, type SetupResultItem } from "./SetupResults.js";
import "./setup.css";

const { Paragraph, Text } = Typography;

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

/** 场景卡与实例卡的分类色图标底。 */
const SCENARIO_META: Record<ScenarioTemplate["id"], { icon: ComponentType; tone: string }> = {
  daily: { icon: HomeOutlined, tone: "tone-info" },
  notify: { icon: NotificationOutlined, tone: "tone-warn" },
  knowledge: { icon: ReadOutlined, tone: "tone-teal" },
  coding: { icon: CodeOutlined, tone: "tone-cinnabar" },
  watch: { icon: DashboardOutlined, tone: "tone-ok" },
};

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
      const error = isRecord(result.data) ? result.data["error"] : undefined;
      setModelMessage(error === "credential-writes-require-loopback"
        ? "当前部署已关闭模型配置写入。请在 .env 设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true 后重启管家服务，再完成绑定。"
        : "模型已验证，但没有完成绑定。请稍后重试，或到设置页检查是否已有同范围绑定。");
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

  // 第 2 步的检查结论：成功块在前、失败块在后，失败项带修复入口。
  const modelResults: SetupResultItem[] = [];
  if (nativeModelDetected) {
    modelResults.push({
      key: "native",
      tone: "ok",
      title: "已发现 Hermes 原生模型配置",
      detail: `发现 ${discoveredModels.filter((model) => !model.runtimeObserved).length} 项已有配置；不会被本向导覆盖。`,
    });
  } else if (runtimeModelObserved > 0) {
    modelResults.push({
      key: "runtime",
      tone: "ok",
      title: "已观察到 Hermes 正在使用模型",
      detail: `从运行日志识别到 ${runtimeModelObserved} 个模型标识；这不会读取或导入凭据。`,
    });
  } else {
    modelResults.push({
      key: "native-missing",
      tone: "fail",
      title: "还没有发现 Hermes 原生模型配置",
      detail: "如果智能体本身还不能对话，请先在 Hermes 的 config.yaml 或 .env 中完成运行模型配置。",
    });
  }
  if (modelReady) {
    modelResults.push({
      key: "managed",
      tone: "ok",
      title: "当前智能体已有可用的受管任务模型",
      detail: "模型探针通过且已绑定。后续可在设置中轮换 Key 或修改绑定范围。",
    });
  } else {
    modelResults.push({
      key: "managed-missing",
      tone: "fail",
      title: "还没有绑定受管任务模型",
      detail: "这是推荐步骤：它让进化和诊断类任务能使用经过真实探针验证的模型。",
    });
  }
  if (llmStatus?.vault.available === false) {
    modelResults.push({
      key: "vault",
      tone: "fail",
      title: "凭据库还不可用",
      detail: "缺少 BUTLER_SECRET_MASTER_KEY 时，管家不会保存 API Key。请在设置中完成本机安全配置后再继续。",
      action: { label: "打开设置", onClick: () => navigate("/settings") },
    });
  }
  if (modelMessage !== null) {
    modelResults.push({ key: "model-message", tone: modelReady ? "ok" : "fail", title: modelMessage });
  }

  return (
    <section className="setup-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="维护与升级"
          title="连接设置"
          description="五步完成管家与智能体的连接；随时可以回来重新检查。"
        />
        <Steps current={step} items={[{ title: "环境检查" }, { title: "选择智能体" }, { title: "绑定模型" }, { title: "连接验证" }, { title: "选择用途" }]} />
        {loading && <Card size="small"><Flex justify="center" style={{ padding: 32 }}><Space><Spin /><Text type="secondary">正在读取本机环境…</Text></Space></Flex></Card>}
        {!loading && error !== null && (
          <Card size="small">
            <Flex vertical gap={16}>
              <Alert type="warning" showIcon title="暂时读不到管家状态" description={error} />
              <Button icon={<RocketOutlined />} onClick={() => void loadStatus()}>重新检查</Button>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 0 && (
          <Card size="small">
            <Flex vertical gap={16}>
              <SectionHeader kicker="环境检查" title="先确认本机环境" />
              <div className="setup-check-list">
                <div className="setup-check-row">
                  <span className="setup-tile tone-info"><RocketOutlined aria-hidden="true" /></span>
                  <Flex vertical style={{ minWidth: 0, flex: 1 }}>
                    <Text strong>管家 Web 服务</Text>
                    <Text type="secondary">面板本体已在当前浏览器可达</Text>
                  </Flex>
                  <StatusBadge tone="ok" label="已启动" />
                </div>
                <div className="setup-check-row">
                  <span className="setup-tile tone-info"><ApiOutlined aria-hidden="true" /></span>
                  <Flex vertical style={{ minWidth: 0, flex: 1 }}>
                    <Text strong>管家控制通道</Text>
                    <Text type="secondary">与看护服务的通信链路</Text>
                  </Flex>
                  <StatusBadge tone={status.reachable ? "ok" : "warn"} label={status.reachable ? "可用" : "暂时不可用"} />
                </div>
                <div className="setup-check-row">
                  <span className="setup-tile tone-info"><ClusterOutlined aria-hidden="true" /></span>
                  <Flex vertical style={{ minWidth: 0, flex: 1 }}>
                    <Text strong>可管理实例</Text>
                    <Text type="secondary">自动发现的 Hermes 智能体</Text>
                  </Flex>
                  <StatusBadge
                    tone={status.connections.length > 0 ? "ok" : "warn"}
                    label={status.connections.length > 0 ? `已发现 ${status.connections.length} 个` : "暂未发现"}
                  />
                </div>
              </div>
              {status.connections.length === 0 && <Alert type="info" showIcon title="还没有发现 Hermes 实例" description="请先在设置中补充 Hermes 路径，回到这里重新检查。" />}
              <Space wrap className="setup-nav-bar"><Button type="primary" disabled={status.connections.length === 0} onClick={() => setStep(1)}>继续</Button><Button onClick={() => navigate("/settings")}>打开设置</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 1 && (
          <Card size="small">
            <Flex vertical gap={16}>
              <SectionHeader kicker="选择智能体" title="选择要管理的智能体" extra={<Text type="secondary" style={{ fontSize: 12 }}>共 {status.connections.length} 个实例</Text>} />
              <Radio.Group value={selected} onChange={(event) => setSelected(event.target.value)} className="setup-option-grid">
                {status.connections.map((item) => (
                  <Radio key={item.instanceId} value={item.instanceId} className="setup-option-card">
                    <Flex vertical gap={8} style={{ minWidth: 0 }}>
                      <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                        <span className="setup-tile tone-info"><RobotOutlined aria-hidden="true" /></span>
                        <Flex vertical style={{ minWidth: 0 }}>
                          <Text strong ellipsis>{item.displayName ?? item.instanceId}</Text>
                          <Text type="secondary" style={{ fontSize: 11 }}>{item.version ?? "版本未知"}</Text>
                        </Flex>
                      </Flex>
                      <StatusBadge
                        tone={item.connected ? "ok" : "muted"}
                        label={item.connected ? "当前已连接" : item.connectionState ?? "待检查"}
                      />
                    </Flex>
                    <CheckCircleOutlined className="setup-option-check" aria-hidden="true" />
                  </Radio>
                ))}
              </Radio.Group>
              <Space wrap className="setup-nav-bar"><Button onClick={() => setStep(0)}>上一步</Button><Button type="primary" disabled={selected === null} onClick={() => setStep(2)}>继续</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 2 && (
          <Card size="small">
            <Flex vertical gap={16}>
              <SectionHeader kicker="绑定模型" title="检查模型配置" />
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>Hermes 的日常运行使用它自己的 `config.yaml` 或 `.env`；Butler 受管任务使用下方加密保存并绑定的模型。两者职责不同，页面会分别如实显示。</Paragraph>
              <SetupResults items={modelResults} />
              {!modelReady && activeProfiles.length > 0 && (
                <Flex vertical gap={12}>
                  <SectionHeader compact kicker="复用已有配置" title="使用已验证的模型" />
                  <Space wrap>
                    <Select value={selectedExistingProfile ?? undefined} onChange={setSelectedExistingProfile} options={activeProfiles.map((profile) => ({ value: profile.profileId, label: `${profile.provider} · ${profile.model}` }))} />
                    <Button onClick={() => void bindExistingProfile()} loading={savingModel} disabled={selectedExistingProfile === null}>绑定到当前智能体</Button>
                  </Space>
                </Flex>
              )}
              {!modelReady && llmStatus?.vault.available !== false && (
                <Form form={modelForm} layout="vertical" style={{ maxWidth: 560 }} initialValues={{ provider: "OpenAI", protocol: "openai-compatible" }}>
                  <SectionHeader compact kicker="新增模型" title="添加一个模型" />
                  <Form.Item name="provider" label="提供商" rules={[{ required: true, message: "请选择提供商" }]}><Select options={[{ value: "OpenAI", label: "OpenAI" }, { value: "DeepSeek", label: "DeepSeek" }, { value: "通义", label: "通义" }, { value: "自定义 OpenAI-compatible", label: "自定义 OpenAI-compatible" }]} /></Form.Item>
                  <Form.Item name="protocol" label="协议" rules={[{ required: true }]}><Select options={[{ value: "openai-compatible", label: "OpenAI-compatible（推荐 Hermes）" }]} /></Form.Item>
                  <Form.Item name="endpoint" label="端点" rules={[{ required: true, type: "url", message: "请输入完整的 https 地址" }]}><Input placeholder="https://api.example.com/v1" autoComplete="url" /></Form.Item>
                  <Form.Item name="model" label="模型名称" rules={[{ required: true, message: "请输入模型名称" }]}><Input placeholder="例如 gpt-4.1-mini" /></Form.Item>
                  <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: "请输入 API Key" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                  <Button type="primary" loading={savingModel} onClick={() => void createAndBindModel()}>验证并绑定</Button>
                </Form>
              )}
              <Space wrap className="setup-nav-bar"><Button onClick={() => setStep(1)}>上一步</Button><Button type="primary" onClick={() => setStep(3)}>继续</Button><Button type="link" onClick={() => navigate("/settings")}>在设置中详细配置</Button></Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 3 && (
          <Card size="small">
            <Flex vertical gap={16}>
              <SectionHeader kicker="连接验证" title="做一次真实连接检查" />
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>这一步只检测连接，不会修改你的智能体配置。</Paragraph>
              {selectedConnection !== null && <Text>当前选择：<Text strong>{selectedConnection.displayName ?? selectedConnection.instanceId}</Text></Text>}
              {checkResult !== null && (
                <SetupResults
                  items={[
                    {
                      key: "check-result",
                      tone: checkResult.startsWith("连接检查完成") ? "ok" : "fail",
                      title: checkResult,
                      action: checkResult.startsWith("连接检查完成")
                        ? undefined
                        : { label: "回到上一步", onClick: () => setStep(2) },
                    },
                  ]}
                />
              )}
              <Space wrap className="setup-nav-bar">
                <Button onClick={() => setStep(2)}>上一步</Button>
                <Button type="primary" loading={checking} onClick={() => void runCheck()}>开始检查</Button>
              </Space>
            </Flex>
          </Card>
        )}
        {!loading && error === null && status !== null && step === 4 && (
          <Card size="small">
            <Flex vertical gap={16}>
              <SectionHeader kicker="选择用途" title="最后，告诉我你最常用的场景" />
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>这不会擅自安装技能或改写提示词；它只会替你记住最适合的下一个入口。</Paragraph>
              <Radio.Group value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="setup-option-grid">
                {SCENARIO_TEMPLATES.map((template) => {
                  const meta = SCENARIO_META[template.id];
                  const TileIcon = meta.icon;
                  return (
                    <Radio key={template.id} value={template.id} className="setup-option-card">
                      <Flex vertical gap={8} style={{ minWidth: 0 }}>
                        <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                          <span className={`setup-tile ${meta.tone}`}><TileIcon aria-hidden="true" /></span>
                          <Text strong ellipsis>{template.label}</Text>
                        </Flex>
                        <Text type="secondary" style={{ fontSize: 13 }}>{template.description}</Text>
                      </Flex>
                      <CheckCircleOutlined className="setup-option-check" aria-hidden="true" />
                    </Radio>
                  );
                })}
              </Radio.Group>
              <Space wrap className="setup-nav-bar"><Button onClick={() => setStep(3)}>上一步</Button><Button type="primary" onClick={complete}>{selectedTemplate.nextLabel}</Button></Space>
            </Flex>
          </Card>
        )}
      </Flex>
    </section>
  );
}
