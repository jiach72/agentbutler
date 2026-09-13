/**
 * 连接设置页（v2 连接体检台）。
 *
 * v1 的问题：五步向导（环境→实例→模型→验证→场景）对已完成设置的用户
 * 是纯仪式——每步信息几乎永远全绿，还要走五屏。与首页连接区 80% 重叠。
 *
 * v2 改为「状态面板 + 单点修复」：
 * - 一屏看全链路：控制通道 → 实例连接 → 受管模型，每环绿/黄/红 + 一句话；
 * - 哪一环不绿修哪一环：失败环给内联修复动作（重新检查 / 绑定模型 / 去设置），
 *   不再让用户在五步之间导航；
 * - 全绿时给「完成即走」出口（按记忆的常用场景直达对应页面）；
 * - 首次引导语义保留：未配置时（FirstRunRedirect 会带进来）同一页面引导首连。
 */
import {
  ApiOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  RobotOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Flex, Form, Input, Select, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { loadJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { markSetupDone, readSetupPreferences } from "./state.js";
import { getScenarioTemplate, SCENARIO_TEMPLATES, type ScenarioTemplate } from "./templates.js";
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

function isActiveProfile(profile: LlmProfile): boolean {
  return profile.status === "active" && profile.probe?.status === "pass";
}

type LinkTone = "ok" | "warn" | "error";

/** 单个链路环：图标 + 名称 + 状态 + 一句话 + 可选修复动作。 */
function LinkRow({
  icon,
  title,
  tone,
  statusLabel,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone: LinkTone;
  statusLabel: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <Flex vertical gap={10} className="setup-link-row" data-tone={tone}>
      <Flex align="center" gap={12} wrap>
        <span className={`setup-tile ${tone === "ok" ? "tone-ok" : tone === "warn" ? "tone-warn" : "tone-error"}`}>
          {icon}
        </span>
        <Flex vertical style={{ minWidth: 0, flex: 1 }}>
          <Text strong>{title}</Text>
          <Text type="secondary" style={{ fontSize: 12.5 }}>{detail}</Text>
        </Flex>
        <StatusBadge tone={tone} label={statusLabel} />
      </Flex>
      {children !== undefined && <div className="setup-link-fix">{children}</div>}
    </Flex>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [bindings, setBindings] = useState<LlmBinding[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [selectedExistingProfile, setSelectedExistingProfile] = useState<string | null>(null);
  const [modelFormOpen, setModelFormOpen] = useState(false);
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

  const connections = status?.connections ?? [];
  const activeProfiles = profiles.filter(isActiveProfile);
  const boundProfileIds = useMemo(
    () => new Set(bindings.filter((b) => b.scope === "instance" || b.scope === "framework").map((b) => b.profileId)),
    [bindings],
  );
  const modelReady = activeProfiles.some((p) => boundProfileIds.has(p.profileId));
  const connectedCount = connections.filter((c) => c.connected).length;
  const nativeModelDetected = discoveredModels.some((m) => !m.runtimeObserved);
  const runtimeModelObserved = discoveredModels.filter((m) => m.runtimeObserved).length;

  // 三环判定（绿/黄/红）。
  const controlTone: LinkTone = status === null ? "warn" : status.reachable ? "ok" : "error";
  const instanceTone: LinkTone = connections.length === 0 ? "warn" : connectedCount > 0 ? "ok" : "error";
  const modelTone: LinkTone = modelReady ? "ok" : llmStatus?.vault.available === false ? "error" : activeProfiles.length > 0 || nativeModelDetected || runtimeModelObserved > 0 ? "warn" : "warn";
  const allOk = controlTone === "ok" && instanceTone === "ok" && modelTone === "ok";
  const firstRun = !status?.configured && !readSetupPreferences();

  const rememberedTemplate: ScenarioTemplate = useMemo(() => {
    const prefs = readSetupPreferences();
    return getScenarioTemplate(prefs?.templateId) ?? SCENARIO_TEMPLATES[0]!;
  }, []);

  const runCheck = async () => {
    const target = connections[0]?.instanceId;
    if (target === undefined) return;
    setChecking(true);
    setCheckMessage(null);
    const result = await postJson("/api/connections/check", { instanceId: target }, 20_000);
    setChecking(false);
    if (result.ok) {
      setCheckMessage("连接检查完成，状态已更新。");
      await loadStatus();
    } else {
      setCheckMessage(`连接检查没有完成（${result.status || "网络错误"}）。`);
    }
  };

  const bindProfile = async (profileId: string): Promise<boolean> => {
    const target = connections[0]?.instanceId;
    if (target === undefined) return false;
    const result = await postJson("/api/llm/bindings", { profileId, scope: "instance", instanceId: target }, 15_000);
    if (!result.ok) {
      const errPayload = isRecord(result.data) ? result.data["error"] : undefined;
      setModelMessage(errPayload === "credential-writes-require-loopback"
        ? "当前部署已关闭模型配置写入。请在 .env 设置 BUTLER_CREDENTIAL_WRITES_ALLOWED=true 后重启管家服务，再完成绑定。"
        : "模型已验证，但没有完成绑定。请稍后重试，或到设置页检查是否已有同范围绑定。");
      return false;
    }
    await loadStatus();
    return true;
  };

  const createAndBindModel = async () => {
    const target = connections[0]?.instanceId;
    if (target === undefined) return;
    const values = await modelForm.validateFields();
    setSavingModel(true);
    setModelMessage(null);
    const result = await postJson("/api/llm/profiles", { ...values, instanceId: target }, 30_000);
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
      setModelFormOpen(false);
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

  const finish = () => {
    markSetupDone({ instanceId: connections[0]?.instanceId ?? null, templateId: rememberedTemplate.id });
    navigate(rememberedTemplate.destination, { replace: true });
  };

  return (
    <section className="setup-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="连接设置"
          /* P0-6：首跑指引保留（独有指引）；非首跑分支与侧栏 note 重复，删。 */
          description={firstRun ? "第一次连接：确认下面三环都变绿，管家就准备就绪。" : undefined}
          extra={
            <Button onClick={() => void loadStatus()} loading={loading}>重新体检</Button>
          }
        />

        {loading && (
          <Card size="small">
            <Flex justify="center" style={{ padding: 32 }}>
              <Space><Spin /><Text type="secondary">正在读取连接与模型状态…</Text></Space>
            </Flex>
          </Card>
        )}

        {!loading && error !== null && (
          <Card size="small">
            <Flex vertical gap={16}>
              <Alert type="warning" showIcon title="暂时读不到管家状态" description={error} />
              <Button icon={<RocketOutlined />} onClick={() => void loadStatus()}>重新检查</Button>
            </Flex>
          </Card>
        )}

        {!loading && error === null && status !== null && (
          <>
            {/* 总结论条 */}
            <Flex className={`setup-verdict ${allOk ? "is-ok" : "is-warn"}`} gap={10}>
              <CheckCircleOutlined className="setup-verdict-icon" aria-hidden="true" />
              <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Text strong style={{ fontSize: 14.5 }}>
                  {allOk
                    ? "链路完整，随时可用"
                    : `${[controlTone, instanceTone, modelTone].filter((t) => t !== "ok").length} 环需要处理`}
                </Text>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {allOk
                    ? `控制通道、${connections.length} 个智能体连接与受管模型全部正常。`
                    : "从上往下处理标黄/标红的环，每环都带修复动作；全部变绿即完成。"}
                </Text>
              </Flex>
            </Flex>

            {/* 环 1：控制通道 */}
            <Card size="small">
              <LinkRow
                icon={<ApiOutlined aria-hidden="true" />}
                title="管家控制通道"
                tone={controlTone}
                statusLabel={controlTone === "ok" ? "可用" : "不可用"}
                detail={
                  controlTone === "ok"
                    ? "面板与看护服务的通信链路正常"
                    : "与看护服务通信中断，下方状态可能不是最新"
                }
              >
                {controlTone !== "ok" && (
                  <Button size="small" onClick={() => void loadStatus()}>重试读取</Button>
                )}
              </LinkRow>
            </Card>

            {/* 环 2：智能体连接 */}
            <Card size="small">
              <LinkRow
                icon={<ClusterOutlined aria-hidden="true" />}
                title="智能体连接"
                tone={instanceTone}
                statusLabel={
                  connections.length === 0 ? "未发现实例"
                    : connectedCount > 0 ? `在线 ${connectedCount}/${connections.length}`
                    : "未连接"
                }
                detail={
                  connections.length === 0
                    ? "还没有发现 Hermes / OpenClaw 实例；先在设置中补充路径"
                    : connections.map((c) => `${c.displayName ?? c.instanceId}${c.connected ? "" : "（未连）"}`).join(" · ")
                }
              >
                {connections.length === 0 ? (
                  <Space wrap>
                    <Button size="small" onClick={() => navigate("/settings")}>去设置补充路径</Button>
                  </Space>
                ) : (
                  <Space wrap>
                    <Button size="small" loading={checking} onClick={() => void runCheck()}>
                      {checking ? "检查中…" : connectedCount > 0 ? "再检查一次" : "立即连接检查"}
                    </Button>
                    {connectedCount === 0 && (
                      <Button size="small" onClick={() => navigate("/dashboard")}>在首页手动连接</Button>
                    )}
                  </Space>
                )}
                {checkMessage !== null && (
                  <Text type="secondary" style={{ fontSize: 12 }}>{checkMessage}</Text>
                )}
              </LinkRow>
              {connections.length > 0 && (
                <Flex vertical gap={4} style={{ marginTop: 4 }} className="setup-link-instances">
                  {connections.map((c) => (
                    <Flex key={c.instanceId} align="center" gap={8}>
                      <RobotOutlined aria-hidden="true" style={{ color: "var(--ab-text-2)" }} />
                      <Text style={{ fontSize: 12.5 }}>{c.displayName ?? c.instanceId}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{c.version ?? "版本未知"}</Text>
                      <StatusBadge tone={c.connected ? "ok" : "offline"} label={c.connected ? "已连接" : c.connectionState ?? "待检查"} />
                    </Flex>
                  ))}
                </Flex>
              )}
            </Card>

            {/* 环 3：受管模型 */}
            <Card size="small">
              <LinkRow
                icon={<RocketOutlined aria-hidden="true" />}
                title="受管任务模型"
                tone={modelTone}
                statusLabel={modelReady ? "已绑定" : llmStatus?.vault.available === false ? "凭据库不可用" : "未绑定"}
                detail={
                  modelReady
                    ? "进化与诊断类任务使用经过探针验证的模型"
                    : nativeModelDetected || runtimeModelObserved > 0
                      ? "检测到 Hermes 已在用模型；受管模型是推荐项（加密保存 + 探针验证）"
                      : "还没有可用的受管模型；绑定后进化与诊断任务才有模型可用"
                }
              >
                {llmStatus?.vault.available === false ? (
                  <Button size="small" onClick={() => navigate("/settings")}>去设置完成安全配置</Button>
                ) : !modelReady && activeProfiles.length > 0 ? (
                  <Flex vertical gap={8}>
                    <Space wrap>
                      <Select
                        size="small"
                        style={{ minWidth: 260 }}
                        placeholder="选择已验证的模型"
                        value={selectedExistingProfile ?? undefined}
                        onChange={setSelectedExistingProfile}
                        options={activeProfiles.map((p) => ({ value: p.profileId, label: `${p.provider} · ${p.model}` }))}
                      />
                      <Button size="small" loading={savingModel} disabled={selectedExistingProfile === null} onClick={() => void bindExistingProfile()}>
                        绑定到当前实例
                      </Button>
                    </Space>
                  </Flex>
                ) : !modelReady ? (
                  <Flex vertical gap={8}>
                    {modelFormOpen ? (
                      <Form form={modelForm} layout="vertical" style={{ maxWidth: 560 }} initialValues={{ provider: "OpenAI", protocol: "openai-compatible" }}>
                        <Form.Item name="provider" label="提供商" rules={[{ required: true, message: "请选择提供商" }]}>
                          <Select options={[{ value: "OpenAI", label: "OpenAI" }, { value: "DeepSeek", label: "DeepSeek" }, { value: "通义", label: "通义" }, { value: "自定义 OpenAI-compatible", label: "自定义 OpenAI-compatible" }]} />
                        </Form.Item>
                        <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
                          <Select options={[{ value: "openai-compatible", label: "OpenAI-compatible（推荐 Hermes）" }]} />
                        </Form.Item>
                        <Form.Item name="endpoint" label="端点" rules={[{ required: true, type: "url", message: "请输入完整的 https 地址" }]}>
                          <Input placeholder="https://api.example.com/v1" autoComplete="url" />
                        </Form.Item>
                        <Form.Item name="model" label="模型名称" rules={[{ required: true, message: "请输入模型名称" }]}>
                          <Input placeholder="例如 gpt-4.1-mini" />
                        </Form.Item>
                        <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: "请输入 API Key" }]}>
                          <Input.Password autoComplete="new-password" />
                        </Form.Item>
                        <Space>
                          <Button type="primary" loading={savingModel} onClick={() => void createAndBindModel()}>验证并绑定</Button>
                          <Button onClick={() => setModelFormOpen(false)}>收起</Button>
                        </Space>
                      </Form>
                    ) : (
                      <Space wrap>
                        <Button size="small" onClick={() => setModelFormOpen(true)}>添加模型并绑定</Button>
                        <Button size="small" onClick={() => navigate("/settings")}>在设置中详细配置</Button>
                      </Space>
                    )}
                  </Flex>
                ) : null}
                {modelMessage !== null && (
                  <Text type={modelReady ? "secondary" : "danger"} style={{ fontSize: 12 }}>{modelMessage}</Text>
                )}
              </LinkRow>
              <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, marginTop: 4 }}>
                Hermes 的日常运行使用它自己的 config.yaml / .env；Butler 受管任务使用上方加密保存并绑定的模型，两者职责不同。
              </Paragraph>
            </Card>

            {/* 完成即走：全绿时按记忆场景给直达出口；未全绿也给跳过入口。 */}
            <Card size="small">
              <Flex vertical gap={10}>
                <Text strong>{allOk ? "链路就绪，从这里继续" : "其他入口"}</Text>
                {allOk && (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    上次记录的常用场景是「{rememberedTemplate.label}」，点下面直达；也可以换一个：
                  </Text>
                )}
                <Space wrap>
                  {allOk && (
                    <Button type="primary" onClick={finish}>{rememberedTemplate.nextLabel}</Button>
                  )}
                  {SCENARIO_TEMPLATES.filter((t) => t.id !== rememberedTemplate.id).slice(0, 3).map((t) => (
                    <Button key={t.id} onClick={() => {
                      markSetupDone({ instanceId: connections[0]?.instanceId ?? null, templateId: t.id });
                      navigate(t.destination, { replace: true });
                    }}>
                      {t.label}
                    </Button>
                  ))}
                </Space>
              </Flex>
            </Card>
          </>
        )}
      </Flex>
    </section>
  );
}
