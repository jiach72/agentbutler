/**
 * 专家工具工作台（运维诊断与治理中心）。
 *
 * 将原本分散深埋在「设置 → 进阶工具」中的底层运维工具提升为一级工作台：
 * 1. 顶部状态中枢：实时感知 Gateway / Bridge 连通态，提供一键体检命令快捷复制；
 * 2. 诊断与排障专区：链路体检、现象排障向导、实时运行日志与脱敏诊断导出；
 * 3. 核心资产与配置：核心 Markdown 指令管理、记忆探针频率与 LLM 成本控制、升级策略；
 * 4. 深度追踪与实验：行为审计、会话上下文回放、记忆变更比对、实例联邦与自进化。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  App,
  Button,
  Flex,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  AuditOutlined,
  CheckOutlined,
  ClusterOutlined,
  CopyOutlined,
  DeploymentUnitOutlined,
  DiffOutlined,
  ExperimentOutlined,
  FileMarkdownOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  RightOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { PageHeader } from "../../components/PageHeader.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import { AdvancedEvidence } from "../../components/AdvancedEvidence.js";
import { DiagnosticsCenter } from "../settings/DiagnosticsCenter.js";
import { MemoryProbeConfigCard } from "../settings/MemoryProbeConfigCard.js";
import { loadJson } from "../../lib/api.js";
import { routeMetaFor } from "../../lib/routeMeta.js";
import { settingsToolPaths } from "../settings/categories.js";
import "./tools.css";

const { Text, Title } = Typography;
const EXPERIMENTS_KEY = "butler.experiments.enabled";
const DOCTOR_COMMAND = "node scripts/doctor.mjs";

interface ToolCardProps {
  to: string;
  icon: React.ReactNode;
  title: string;
  tag?: string;
  tagColor?: string;
  tone?: "blue" | "orange" | "cyan" | "purple" | "indigo" | "emerald" | "rose" | "sky" | "violet" | "pink";
  description: string;
}

function ToolCard({ to, icon, title, tag, tagColor = "blue", tone = "blue", description }: ToolCardProps) {
  return (
    <div className="tool-card">
      <div className="tool-card-header">
        <div className="tool-card-icon-title">
          <div className={`tool-card-icon tone-${tone}`}>{icon}</div>
          <div>
            <div className="tool-card-title">{title}</div>
            {tag && <Tag color={tagColor} style={{ marginTop: 4, borderRadius: 10 }}>{tag}</Tag>}
          </div>
        </div>
      </div>
      <p className="tool-card-desc">{description}</p>
      <div className="tool-card-action">
        <Link to={to} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, fontSize: 13 }}>
          <span>{title}</span>
          <RightOutlined style={{ fontSize: 11 }} />
        </Link>
      </div>
    </div>
  );
}

export function ToolsPage() {
  const { message } = App.useApp();
  const [experiments, setExperiments] = useState(false);
  const [instanceCount, setInstanceCount] = useState<number | null>(null);
  const [gatewayOnline, setGatewayOnline] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      setExperiments(localStorage.getItem(EXPERIMENTS_KEY) === "1");
    } catch {
      /* ignore storage issue */
    }

    let active = true;
    void loadJson<{ instances: { instanceId: string }[] }>("/api/federation?windowDays=7").then(
      (result) => {
        if (active && result.ok) {
          setInstanceCount(new Set(result.data.instances.map((item) => item.instanceId)).size);
        }
      },
    );

    void loadJson<{ ok?: boolean; gateway?: boolean }>("/api/health").then((res) => {
      if (active) {
        setGatewayOnline(res.ok && res.data.gateway !== false);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const handleCopyDoctor = useCallback(() => {
    if (!navigator.clipboard) {
      message.error(`浏览器不允许复制，请使用命令: ${DOCTOR_COMMAND}`);
      return;
    }
    navigator.clipboard
      .writeText(DOCTOR_COMMAND)
      .then(() => {
        setCopied(true);
        message.success("体检命令已复制到剪贴板，可直接在终端执行。");
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => message.error(`复制失败，请使用命令: ${DOCTOR_COMMAND}`));
  }, [message]);

  const paths = settingsToolPaths(experiments, instanceCount);

  const renderReportLinks = (items: string[]) => (
    <div className="tools-report-links-grid">
      {items.map((path) => {
        const route = routeMetaFor(path);
        if (route === null) return null;
        const Icon = route.icon;
        return (
          <Link
            key={path}
            to={path}
            className="tools-report-link-card"
          >
            <span className="tools-report-icon-tile">
              <Icon aria-hidden="true" />
            </span>
            <div className="tools-report-info">
              <span className="tools-report-title">{route.title}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>{route.note}</Text>
            </div>
            <RightOutlined className="tools-report-arrow" />
          </Link>
        );
      })}
    </div>
  );

  return (
    <section className="tools-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="专家工具"
          eyebrow="日常使用"
          extra={
            <Flex align="center" gap={12}>
              <Text strong style={{ fontSize: 13 }}>实验功能</Text>
              <Switch
                aria-label="实验功能"
                checked={experiments}
                onChange={(checked) => {
                  try {
                    localStorage.setItem(EXPERIMENTS_KEY, checked ? "1" : "0");
                    setExperiments(checked);
                    message.info(checked ? "已启用实验功能" : "已关闭实验功能");
                  } catch {
                    message.error("浏览器无法保存偏好，请允许本地存储后重试。");
                  }
                }}
              />
            </Flex>
          }
        />

        <ConclusionBar
          tone={gatewayOnline === false ? "offline" : "info"}
          title={gatewayOnline === false ? "管家服务暂时连不上，部分体检只读" : "专家工具箱就绪"}
          copy={
            gatewayOnline === false
              ? "等后台服务恢复后重试；当前可复制命令在宿主机直接体检。"
              : "提供链路体检、现象排障、容器日志过滤、核心资产管理与脱敏诊断生成。"
          }
          action={
            <Button type="primary" href="/troubleshoot">
              排查当前问题
            </Button>
          }
        />

        {/* 顶部黄金排障与快速指令卡片 */}
        <div className="tools-hero-card">
          <div className="tools-hero-header">
            <div>
              <Title level={5} style={{ margin: 0, marginBottom: 4 }}>
                <ThunderboltOutlined style={{ color: "var(--ant-color-primary)", marginRight: 8 }} />
                宿主机一键体检命令
              </Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                在宿主终端（Linux / WSL / macOS）直接执行，自动核验 Docker 容器、8754/8756 回环端口与 Token 权限
              </Text>
            </div>
            <Flex align="center" gap={12} wrap="wrap">
              <div className="tools-cmd-box">
                <span className="tools-cmd-text">{DOCTOR_COMMAND}</span>
              </div>
              <Button
                type="primary"
                icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                onClick={handleCopyDoctor}
              >
                复制安装体检命令
              </Button>
            </Flex>
          </div>
          <Flex gap={8} wrap="wrap">
            <Button size="small" href="/setup">直达链路体检</Button>
            <Button size="small" href="/troubleshoot">直达排障助手</Button>
            <Button size="small" href="/logs">直达系统日志</Button>
            <Button size="small" href="/core-files">直达核心文件</Button>
          </Flex>
        </div>

        {/* 专区 1：链路诊断与系统维护（包含自动化选择器匹配文本） */}
        <div className="tools-section">
          <div className="tools-section-title" role="button" tabIndex={0}>
            <span className="tools-section-icon-badge badge-blue">
              <ToolOutlined />
            </span>
            <span>专家工具 · 诊断与维护</span>
          </div>
          <div className="tools-grid">
            <ToolCard
              to="/setup"
              icon={<DeploymentUnitOutlined />}
              title="连接体检"
              tag="链路健康"
              tagColor="blue"
              tone="blue"
              description="宿主三环体检，检测 Docker、Token 挂载与 Hermes 网关 8754/8755 连通性，提供自愈指引。"
            />
            <ToolCard
              to="/troubleshoot"
              icon={<ToolOutlined />}
              title="排障助手"
              tag="快速自愈"
              tagColor="orange"
              tone="orange"
              description="按故障现象（模型 401/超时、消息卡死、SQLite 锁死、权限缺失）逐步引导排查与一键自愈。"
            />
            <ToolCard
              to="/logs"
              icon={<FileSearchOutlined />}
              title="系统日志"
              tag="实时流"
              tagColor="cyan"
              tone="cyan"
              description="实时捕获与过滤 Gateway、Watch、Web 各容器日志，支持关键字检索与异常堆栈高亮。"
            />
            {experiments && (
              <ToolCard
                to="/evolution"
                icon={<ExperimentOutlined />}
                title="自进化"
                tag="实验功能"
                tagColor="purple"
                tone="purple"
                description="自主分析运行日志与故障模式，生成系统提示词优化方案与行为反思改进建议。"
              />
            )}
            {instanceCount !== null && instanceCount >= 2 && (
              <ToolCard
                to="/federation"
                icon={<ClusterOutlined />}
                title="实例联邦"
                tag="多实例"
                tagColor="geekblue"
                tone="indigo"
                description={`已探测到 ${instanceCount} 个活跃实例，跨机汇总状态分布、同步会话记录与协同管控。`}
              />
            )}
          </div>
        </div>

        {/* 内置实时诊断报告打包生成器 */}
        <DiagnosticsCenter actionBusy={false} />

        {/* 专区 2：核心配置与资产维护 */}
        <div className="tools-section">
          <div className="tools-section-title">
            <span className="tools-section-icon-badge badge-emerald">
              <FileMarkdownOutlined />
            </span>
            <span>核心配置与资产维护</span>
          </div>
          <div className="tools-grid">
            <ToolCard
              to="/core-files"
              icon={<FileMarkdownOutlined />}
              title="核心文件"
              tag="规则资产"
              tagColor="green"
              tone="emerald"
              description="安全查看、在线编辑与版本历史回滚 AGENTS.md、SOPS.md、HERMES.md 等核心指令文件。"
            />
            <ToolCard
              to="/canary"
              icon={<RocketOutlined />}
              title="升级策略"
              tag="稳定性"
              tagColor="volcano"
              tone="rose"
              description="金丝雀升级与影子环境验证，确保配置与规则在生产环境切换前无抖动零风险。"
            />
          </div>
          <MemoryProbeConfigCard />
        </div>

        {/* 专区 3：审计追踪与深度分析 */}
        <div className="tools-section">
          <div className="tools-section-title">
            <span className="tools-section-icon-badge badge-purple">
              <SafetyCertificateOutlined />
            </span>
            <span>审计追踪与深度分析</span>
          </div>
          <div className="tools-grid">
            <ToolCard
              to="/audit"
              icon={<AuditOutlined />}
              title="行为审计"
              tag="安全存证"
              tagColor="blue"
              tone="sky"
              description="完整记录 Agent 外部工具调用、文件改动、系统命令及审批流转的不可篡改审计时间线。"
            />
            <ToolCard
              to="/sessions"
              icon={<HistoryOutlined />}
              title="会话追踪"
              tag="上下文分析"
              tagColor="purple"
              tone="violet"
              description="按会话深入查看 Hermes 交互明细、模型上下文流转与前后动作序列回放。"
            />
            <ToolCard
              to="/memory-diff"
              icon={<DiffOutlined />}
              title="记忆变更"
              tag="记忆 diff"
              tagColor="magenta"
              tone="pink"
              description="对比管家记忆提取前后的 diff 变更差异，核实长期记忆沉淀的准确性与完整性。"
            />
          </div>
        </div>

        {/* 业务报告直通（折叠收纳，保证向后兼容） */}
        <AdvancedEvidence title="记录与报告">
          {renderReportLinks(paths.reports)}
        </AdvancedEvidence>
      </Flex>
    </section>
  );
}
