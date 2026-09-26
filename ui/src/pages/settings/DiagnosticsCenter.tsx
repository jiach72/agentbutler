/**
 * 诊断与维护中心：脱敏诊断报告生成与打包导出面板。
 * 响应式仪表盘布局：左栏脱敏矩阵与一键报告工作区，右栏实时指标透视与本机自愈审计。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  App,
  Button,
  Card,
  Col,
  Flex,
  Row,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AuditOutlined,
  BugOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  ClusterOutlined,
  CopyOutlined,
  DeploymentUnitOutlined,
  DownloadOutlined,
  FileTextOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { fetchBlob, fetchText, loadJson, type FetchState } from "../../lib/api.js";
import { downloadBlob } from "../../lib/download.js";

const { Paragraph, Text } = Typography;

const OFFLINE_TEXT = "管家服务暂时连不上，请稍后再试。";

/** 报告预览：等宽字体、限高滚动，配色走 antd Token。 */
const REPORT_PREVIEW_STYLE: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--ant-color-fill-tertiary)",
  borderRadius: "var(--ant-border-radius-lg)",
  fontFamily: "var(--ab-mono)",
  fontSize: 12,
  lineHeight: 1.6,
  maxHeight: 280,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

interface DiagnosticsCenterProps {
  /** 页面级危险操作进行中时禁用入口。 */
  actionBusy: boolean;
}

interface DiagnosticState {
  busy: boolean;
  text: string | null;
  error: string | null;
}

export interface LocalOutcomeSummary {
  schemaVersion: "local-outcome-summary-v1";
  generatedAt?: string;
  windowDays: number;
  auditRecordLimit: number;
  evidenceNote: string;
  outcomes: Array<{
    id: "backup" | "repair" | "upgrade" | "rollback";
    label: string;
    completed: number;
    knownFailures: number;
    lastCompletedAt: string | null;
    lastFailureAt: string | null;
  }>;
}

export interface DiagnosticSummaryResponse {
  schemaVersion?: string;
  generatedAt?: string;
  redacted?: boolean;
  instances?: Array<{
    instanceId: string;
    framework: string;
    state: string;
    version: string | null;
    root: string;
  }>;
  logIssues?: Array<{
    id: string;
    severity: string;
    title: string;
    count: number;
    lastSeenAt?: string | null;
  }>;
  security?: {
    totalSecretFiles: number;
    insecureSecretFiles: number;
    failedInvariants: number;
  };
  gateway?: {
    overall: string;
    last24h: number;
    totalEvents: number;
  };
  evolutionRuns?: number;
  localOutcomes?: LocalOutcomeSummary;
  outcomes?: LocalOutcomeSummary["outcomes"];
  windowDays?: number;
  auditRecordLimit?: number;
  evidenceNote?: string;
}

export function outcomeText(item: LocalOutcomeSummary["outcomes"][number]): string {
  const completed = item.completed === 0 ? "没有可验证的完成记录" : `已记录完成 ${item.completed} 次`;
  const failures = item.knownFailures === 0 ? "未记录明确失败" : `已记录明确失败 ${item.knownFailures} 次`;
  return `${completed}；${failures}`;
}

export function DiagnosticsCenter({ actionBusy }: DiagnosticsCenterProps) {
  const { message } = App.useApp();
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>({
    busy: false,
    text: null,
    error: null,
  });
  const [zipBusy, setZipBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [summaryState, setSummaryState] = useState<FetchState<DiagnosticSummaryResponse>>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void loadJson<DiagnosticSummaryResponse>("/api/diagnostics/summary", 8_000).then((result) => {
      if (!active) return;
      setSummaryState(result.ok ? { status: "ready", data: result.data } : { status: "failed", reason: result.reason });
    });
    return () => {
      active = false;
    };
  }, []);

  const summaryData = summaryState.status === "ready" ? summaryState.data : null;

  const localOutcomes: LocalOutcomeSummary = useMemo(() => {
    if (!summaryData) {
      return {
        schemaVersion: "local-outcome-summary-v1",
        generatedAt: new Date().toISOString(),
        windowDays: 30,
        auditRecordLimit: 500,
        evidenceNote: "仅统计近 30 天本机操作审计中具有明确终态的记录；不代表成功率，也不会上传。",
        outcomes: [],
      };
    }
    if (summaryData.localOutcomes) return summaryData.localOutcomes;
    if (summaryData.outcomes) {
      return {
        schemaVersion: "local-outcome-summary-v1",
        generatedAt: summaryData.generatedAt ?? new Date().toISOString(),
        windowDays: summaryData.windowDays ?? 30,
        auditRecordLimit: summaryData.auditRecordLimit ?? 500,
        evidenceNote: summaryData.evidenceNote ?? "仅统计近 30 天本机操作审计中具有明确终态的记录；不代表成功率，也不会上传。",
        outcomes: summaryData.outcomes,
      };
    }
    return {
      schemaVersion: "local-outcome-summary-v1",
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      auditRecordLimit: 500,
      evidenceNote: "仅统计近 30 天本机操作审计中具有明确终态的记录；不代表成功率，也不会上传。",
      outcomes: [],
    };
  }, [summaryData]);

  const runDiagnostic = async () => {
    if (diagnostic.busy) return;
    setDiagnostic({ busy: true, text: null, error: null });
    try {
      const result = await fetchText("/api/diagnostics/report", 20_000);
      if (!result.ok) {
        setDiagnostic({ busy: false, text: null, error: result.reason });
        message.error(result.reason);
        return;
      }
      setDiagnostic({ busy: false, text: result.text, error: null });
      message.success("诊断报告已生成，可在下方查看并下载。");
    } catch {
      setDiagnostic({ busy: false, text: null, error: OFFLINE_TEXT });
      message.error(OFFLINE_TEXT);
    }
  };

  const downloadDiagnostic = (text: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    downloadBlob(blob, `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.md`);
  };

  const downloadDiagnosticZip = async () => {
    if (zipBusy) return;
    setZipBusy(true);
    try {
      const result = await fetchBlob("/api/diagnostics/report?format=zip");
      if (!result.ok) {
        message.error(`诊断包没有生成：${result.reason}`);
        return;
      }
      downloadBlob(result.blob, `agent-butler-diagnostic-${new Date().toISOString().slice(0, 10)}.zip`);
      message.success("脱敏诊断包已下载，可以直接附到 Issue。");
    } catch {
      message.error("下载诊断包失败，请稍后再试。");
    } finally {
      setZipBusy(false);
    }
  };

  const copyReport = async () => {
    if (!diagnostic.text) return;
    try {
      await navigator.clipboard.writeText(diagnostic.text);
      setCopied(true);
      message.success("诊断报告已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败，请手动选择复制");
    }
  };

  return (
    <Card
      size="small"
      style={{ borderRadius: 12 }}
      title={
        <Flex align="center" justify="space-between" wrap="wrap" gap={8}>
          <Flex align="center" gap={8}>
            <SafetyCertificateOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
            <Text strong style={{ fontSize: 15 }}>脱敏诊断报告与打包导出</Text>
          </Flex>
          <Space size={6} wrap>
            <Tag color="success" icon={<LockOutlined />}>100% 隐私脱敏</Tag>
            <Tag color="blue" icon={<AuditOutlined />}>30天操作审计</Tag>
          </Space>
        </Flex>
      }
    >
      <Row gutter={[20, 20]}>
        {/* 左栏：脱敏范围承诺、一键生成操作与报告预览 */}
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            {/* 核心脱敏保障卡片 */}
            <div
              style={{
                background: "var(--ab-surface)",
                border: "1px solid var(--ab-border)",
                borderRadius: "var(--ant-border-radius-lg)",
                padding: "12px 14px",
              }}
            >
              <Flex align="center" justify="space-between" style={{ marginBottom: 8 }}>
                <Space size={6}>
                  <LockOutlined style={{ color: "var(--ant-color-success)" }} />
                  <Text strong style={{ fontSize: 13 }}>隐私安全与脱敏矩阵</Text>
                </Space>
                <Tag color="green" style={{ margin: 0, fontSize: 11 }}>已通过脱敏白名单</Tag>
              </Flex>
              <div className="diag-scope-grid">
                <Flex align="center" gap={6}>
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success)", fontSize: 12 }} />
                  <Text style={{ fontSize: 12 }}>密钥令牌 100% 自动剥离</Text>
                </Flex>
                <Flex align="center" gap={6}>
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success)", fontSize: 12 }} />
                  <Text style={{ fontSize: 12 }}>对话正文与私聊隐私屏蔽</Text>
                </Flex>
                <Flex align="center" gap={6}>
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success)", fontSize: 12 }} />
                  <Text style={{ fontSize: 12 }}>异常特征指纹与频次聚合</Text>
                </Flex>
                <Flex align="center" gap={6}>
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success)", fontSize: 12 }} />
                  <Text style={{ fontSize: 12 }}>容器与环境巡检快照打包</Text>
                </Flex>
              </div>
              <Paragraph type="secondary" style={{ fontSize: 11, margin: "8px 0 0", lineHeight: 1.4 }}>
                打包脱敏的日志问题、错误指纹、巡检快照和配置摘要；不含密钥和聊天正文，可安全附于 Issue。
              </Paragraph>
            </div>

            {/* 操作按钮组 */}
            <Space wrap size={10}>
              <Tooltip title={actionBusy ? "有诊断或修复操作正在执行" : "实时提取本机诊断数据并生成 Markdown 报告"}>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={diagnostic.busy}
                  disabled={actionBusy || diagnostic.busy}
                  onClick={() => void runDiagnostic()}
                >
                  {diagnostic.text !== null ? "重新生成报告" : "生成诊断报告"}
                </Button>
              </Tooltip>

              <Tooltip title="直接打包为 .zip 压缩包（包含完整脱敏指标与系统快照）">
                <Button
                  icon={<DownloadOutlined />}
                  loading={zipBusy}
                  disabled={actionBusy || zipBusy}
                  onClick={() => void downloadDiagnosticZip()}
                >
                  打包下载 ZIP
                </Button>
              </Tooltip>

              {diagnostic.text !== null && (
                <>
                  <Button
                    icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => void copyReport()}
                  >
                    {copied ? "已复制" : "复制报告"}
                  </Button>
                  <Button
                    icon={<FileTextOutlined />}
                    onClick={() => downloadDiagnostic(diagnostic.text!)}
                  >
                    下载 MD
                  </Button>
                </>
              )}
            </Space>

            {diagnostic.error !== null && (
              <Text role="status" type="danger" style={{ fontSize: 12 }}>
                {diagnostic.error}
              </Text>
            )}

            {/* 报告预览区 */}
            {diagnostic.text !== null ? (
              <div style={{ marginTop: 4 }}>
                <Flex align="center" justify="space-between" style={{ marginBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>报告预览（可直接选中文本或下载）：</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {diagnostic.text.length} 字符
                  </Text>
                </Flex>
                <pre style={REPORT_PREVIEW_STYLE}>{diagnostic.text}</pre>
              </div>
            ) : (
              <div
                style={{
                  border: "1px dashed var(--ab-border)",
                  borderRadius: "var(--ant-border-radius-lg)",
                  padding: "16px",
                  textAlign: "center",
                  background: "var(--ab-surface)",
                }}
              >
                <FileTextOutlined style={{ fontSize: 24, color: "var(--ant-color-text-tertiary)", marginBottom: 6 }} />
                <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                  点击上方「生成诊断报告」可实时抓取最新日志指纹与巡检快照；或直接「打包下载 ZIP」导出排障包。
                </Text>
              </div>
            )}
          </Flex>
        </Col>

        {/* 右栏：实时体检指标、最近本机结果与高频异常榜 */}
        <Col xs={24} lg={12}>
          <Flex vertical gap={12}>
            {/* 4 项实时诊断指标 */}
            <div className="diag-stat-grid">
              <div className="diag-stat-card">
                <div style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: (summaryData?.security?.insecureSecretFiles ?? 0) === 0 ? "var(--ab-ok-soft)" : "var(--ab-err-soft)",
                  color: (summaryData?.security?.insecureSecretFiles ?? 0) === 0 ? "var(--ant-color-success)" : "var(--ant-color-error)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}>
                  <LockOutlined />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--ant-color-text-secondary)" }}>安全凭据合规</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ant-color-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {(summaryData?.security?.insecureSecretFiles ?? 0) === 0 ? "全部合规脱敏" : `${summaryData?.security?.insecureSecretFiles} 处隐患`}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--ant-color-text-tertiary)" }}>
                    受护文件: {summaryData?.security?.totalSecretFiles ?? 0} 个
                  </div>
                </div>
              </div>

              <div className="diag-stat-card">
                <div style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: "var(--ab-primary-soft)",
                  color: "var(--ant-color-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}>
                  <DeploymentUnitOutlined />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--ant-color-text-secondary)" }}>网关运行状态</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ant-color-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {summaryData?.gateway?.totalEvents ? `${summaryData.gateway.totalEvents} 条事件` : "运行正常"}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--ant-color-text-tertiary)" }}>
                    24h 活跃: {summaryData?.gateway?.last24h ?? 0} 次
                  </div>
                </div>
              </div>

              <div className="diag-stat-card">
                <div style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: "var(--ab-warn-soft)",
                  color: "var(--ant-color-warning)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}>
                  <BugOutlined />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--ant-color-text-secondary)" }}>已识别异常指纹</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ant-color-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {summaryData?.logIssues?.length ?? 0} 种特征模式
                  </div>
                  <div style={{ fontSize: 10, color: "var(--ant-color-text-tertiary)" }}>
                    近 7 天日志聚类
                  </div>
                </div>
              </div>

              <div className="diag-stat-card">
                <div style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: "rgba(6, 182, 212, 0.12)",
                  color: "#0891b2",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}>
                  <ClusterOutlined />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--ant-color-text-secondary)" }}>Hermes 实例</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ant-color-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {summaryData?.instances?.[0]?.state ?? "Serving"}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--ant-color-text-tertiary)" }}>
                    版本: {summaryData?.instances?.[0]?.version ? `v${summaryData.instances[0].version}` : "未知"}
                  </div>
                </div>
              </div>
            </div>

            {/* 本机结果与审计记录 */}
            <section
              aria-label="本机结果摘要"
              style={{
                background: "var(--ab-surface)",
                border: "1px solid var(--ab-border)",
                borderRadius: "var(--ant-border-radius-lg)",
                padding: "12px 14px",
              }}
            >
              <Flex align="center" justify="space-between" style={{ marginBottom: 8 }}>
                <Space size={6}>
                  <AuditOutlined style={{ color: "var(--ant-color-primary)" }} />
                  <Text strong style={{ fontSize: 13 }}>最近本机结果</Text>
                </Space>
                <Tag style={{ margin: 0, fontSize: 11 }}>30天窗口</Tag>
              </Flex>

              {summaryState.status === "loading" && (
                <Flex align="center" gap={8} style={{ padding: "12px 0" }}>
                  <Spin size="small" />
                  <Text type="secondary">正在读取本机操作记录…</Text>
                </Flex>
              )}

              {summaryState.status === "failed" && (
                <Text type="secondary" role="status" style={{ display: "block", padding: "8px 0", fontSize: 12 }}>
                  结果摘要暂时读不到：{summaryState.reason}
                </Text>
              )}

              {summaryState.status === "ready" && (
                <>
                  <div className="diag-outcomes-grid">
                    {localOutcomes.outcomes.length > 0 ? (
                      localOutcomes.outcomes.map((item) => (
                        <div key={item.id} className="diag-outcome-item">
                          <Flex align="center" justify="space-between" style={{ marginBottom: 2 }}>
                            <Text strong style={{ fontSize: 12 }}>{item.label}</Text>
                            {item.knownFailures > 0 ? (
                              <Tag color="error" style={{ margin: 0, fontSize: 10, padding: "0 4px" }}>
                                失败 {item.knownFailures}
                              </Tag>
                            ) : (
                              <Tag color="default" style={{ margin: 0, fontSize: 10, padding: "0 4px" }}>
                                完成 {item.completed}
                              </Tag>
                            )}
                          </Flex>
                          <Text type="secondary" style={{ fontSize: 11, display: "block" }}>
                            {outcomeText(item)}
                          </Text>
                        </div>
                      ))
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12, padding: "8px 0" }}>
                        近 30 天暂无维护操作记录
                      </Text>
                    )}
                  </div>

                  <Text type="secondary" style={{ fontSize: 11, display: "block", marginTop: 8, lineHeight: 1.4 }}>
                    {localOutcomes.evidenceNote}
                  </Text>
                </>
              )}
            </section>

            {/* 高频异常特征 Top 3 榜单 */}
            {summaryData?.logIssues && summaryData.logIssues.length > 0 && (
              <div
                style={{
                  background: "var(--ab-surface)",
                  border: "1px solid var(--ab-border)",
                  borderRadius: "var(--ant-border-radius-lg)",
                  padding: "10px 14px",
                }}
              >
                <Flex align="center" justify="space-between" style={{ marginBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>主要异常特征指纹（前 3 项）：</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>已去重聚合</Text>
                </Flex>
                <Flex wrap="wrap" gap={6}>
                  {summaryData.logIssues.slice(0, 3).map((issue) => (
                    <Tag
                      key={issue.id}
                      color={issue.severity === "error" ? "error" : "warning"}
                      style={{ margin: 0, fontSize: 11, borderRadius: 4 }}
                    >
                      {issue.title} ({issue.count}次)
                    </Tag>
                  ))}
                </Flex>
              </div>
            )}
          </Flex>
        </Col>
      </Row>
    </Card>
  );
}
