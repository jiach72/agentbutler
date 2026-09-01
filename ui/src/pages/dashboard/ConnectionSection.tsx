/**
 * 服务连接区：Hermes / OpenClaw 连接卡片、OpenClaw 安装面板与实时日志抽屉。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Flex,
  Progress,
  Row,
  Space,
  Steps,
  Tag,
  Typography,
} from "antd";
import { DisconnectOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import {
  connectionStateLabel,
  frameworkLabel,
  instanceLabel,
  instanceRuntimeLabel,
  quickProbeBadge,
} from "./helpers.js";
import type {
  ConnectionsPayload,
  OpenClawInstallJobView,
  OpenClawStatusView,
} from "./types.js";

const { Paragraph, Text, Title } = Typography;

interface ConnectionSectionProps {
  connections: ConnectionsPayload | null;
  openClawStatus: OpenClawStatusView | null;
  openClawInstallJob: OpenClawInstallJobView | null;
  /** 形如 check-<id> / connect-<id> / disconnect-<id> / check-all 的在途动作标记。 */
  connectionBusy: string | null;
  openClawInstallBusy: boolean;
  onCheckAll: () => void;
  onCheckOne: (instanceId: string) => void;
  onToggleConnection: (instanceId: string, action: "connect" | "disconnect") => void;
  onInstall: () => void;
  onCancelInstall: () => void;
}

export function ConnectionSection({
  connections,
  openClawStatus,
  openClawInstallJob,
  connectionBusy,
  openClawInstallBusy,
  onCheckAll,
  onCheckOne,
  onToggleConnection,
  onInstall,
  onCancelInstall,
}: ConnectionSectionProps) {
  const [installLogOpen, setInstallLogOpen] = useState(false);
  const connectionItems = connections?.connections ?? [];

  return (
    <section aria-labelledby="connection-section-title">
      <Flex vertical gap={12}>
        <Flex wrap="wrap" justify="space-between" align="flex-start" gap={12}>
          <div style={{ minWidth: 0 }}>
            <Text
              type="secondary"
              style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              服务连接
            </Text>
            <Title level={4} id="connection-section-title" style={{ marginBottom: 4 }}>
              Hermes / OpenClaw 连接状态
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              这里显示最近一次探测、响应耗时和可用能力；连接动作会在完成后自动复核。
            </Paragraph>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={onCheckAll}
            disabled={connectionBusy !== null || connectionItems.length === 0}
          >
            {connectionBusy === "check-all" ? "检查中…" : "手动检查连接"}
          </Button>
        </Flex>
        {connections === null || connections.reachable !== true ? (
          <Alert
            type="warning"
            showIcon
            title="管家控制通道暂时连不上"
            description="无法读取 Hermes / OpenClaw 的实时连接状态，服务恢复后会自动重试。"
          />
        ) : (
          <Row gutter={[12, 12]}>
            {!connectionItems.some((item) => item.frameworkId === "hermes") && (
              <Col xs={24} lg={12}>
                <Card size="small">
                  <Flex vertical gap={8}>
                    <Flex wrap="wrap" justify="space-between" align="center" gap={8}>
                      <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                        <Tag color="cyan" style={{ marginInlineEnd: 0 }}>Hermes</Tag>
                        <Title level={5} style={{ marginBottom: 0 }}>尚未配置</Title>
                      </Flex>
                      <Badge status="default" text="未发现实例" />
                    </Flex>
                    <Flex vertical gap={4}>
                      <Text strong>等待运行目录</Text>
                      <Text type="secondary">配置 Hermes 实例后，管家会在这里显示连接状态。</Text>
                    </Flex>
                    <div>
                      <Link to="/settings">
                        <Button>前往设置</Button>
                      </Link>
                    </div>
                  </Flex>
                </Card>
              </Col>
            )}
            {!connectionItems.some((item) => item.frameworkId === "openclaw") && (
              <Col xs={24} lg={12}>
                <Card size="small">
                  <Flex vertical gap={8}>
                    <Flex wrap="wrap" justify="space-between" align="center" gap={8}>
                      <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                        <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>OpenClaw</Tag>
                        <Title level={5} style={{ marginBottom: 0 }}>
                          {openClawStatus?.installed ? "已安装，等待连接" : "尚未安装"}
                        </Title>
                      </Flex>
                      <Badge
                        status={openClawStatus?.installed ? "warning" : "default"}
                        text={openClawStatus?.installed ? "未连接" : "未安装"}
                      />
                    </Flex>
                    <Flex vertical gap={4}>
                      <Text strong>{openClawStatus?.version ?? "没有可用版本"}</Text>
                      <Text type="secondary">{openClawStatus?.detail ?? "正在读取 OpenClaw 安装状态"}</Text>
                    </Flex>
                    {openClawStatus?.runtime !== undefined && (
                      <AdvancedDetails
                        summary="运行环境详情"
                        extra={openClawStatus.runtime.detail ?? "WSL 运行环境"}
                      >
                        <Flex vertical gap={4}>
                          <Text
                            type="secondary"
                            title={openClawStatus.target?.dataRoot ?? openClawStatus.rootPath ?? undefined}
                          >
                            数据目录：{openClawStatus.target?.dataRoot ?? openClawStatus.rootPath ?? "~/.openclaw"}
                          </Text>
                          <Text
                            type="secondary"
                            title={openClawStatus.target?.npmGlobalRoot ?? undefined}
                          >
                            全局包目录：{openClawStatus.target?.npmGlobalRoot ?? "解析中"}
                          </Text>
                        </Flex>
                      </AdvancedDetails>
                    )}
                    {openClawInstallJob !== null && (
                      <Card size="small">
                        <Flex vertical gap={8}>
                          <Flex wrap="wrap" justify="space-between" align="center" gap={8}>
                            <Text strong>
                              {openClawInstallJob.status === "done" ? "安装完成"
                                : openClawInstallJob.status === "failed" ? "安装失败"
                                  : openClawInstallJob.status === "cancelled" ? "已取消"
                                    : openClawInstallJob.status === "queued" ? "提交中"
                                      : "安装中"}
                            </Text>
                            <StatusBadge
                              tone={
                                openClawInstallJob.status === "failed"
                                  ? "error"
                                  : openClawInstallJob.status === "done"
                                    ? "ok"
                                    : "info"
                              }
                              label={`${openClawInstallJob.progress}%`}
                            />
                          </Flex>
                          <Progress
                            percent={openClawInstallJob.progress}
                            size="small"
                            status={openClawInstallJob.status === "failed" ? "exception" : openClawInstallJob.status === "done" ? "success" : "active"}
                          />
                          {openClawInstallJob.steps.length > 0 && (
                            <Steps
                              size="small"
                              direction="vertical"
                              current={Math.max(0, openClawInstallJob.steps.findIndex((step) => step.status === "running"))}
                              items={openClawInstallJob.steps.map((step) => ({
                                title: step.label,
                                description: step.detail,
                                status: step.status === "failed" ? "error" : step.status === "passed" ? "finish" : step.status === "running" ? "process" : step.status === "cancelled" ? "error" : "wait",
                              }))}
                            />
                          )}
                          {openClawInstallJob.error !== null && <Alert type="error" showIcon title="安装未完成" description={openClawInstallJob.error} />}
                          <Space wrap>
                            {(openClawInstallJob.status === "queued" || openClawInstallJob.status === "running") && (
                              <Button onClick={onCancelInstall}>取消安装</Button>
                            )}
                            {openClawInstallJob.status === "failed" && (
                              <Button type="link" onClick={onInstall}>重试安装</Button>
                            )}
                            {openClawInstallJob.logTail.length > 0 && (
                              <Button type="link" onClick={() => setInstallLogOpen(true)}>查看实时日志</Button>
                            )}
                          </Space>
                        </Flex>
                      </Card>
                    )}
                    <div>
                      <Button
                        type="primary"
                        onClick={onInstall}
                        loading={openClawInstallBusy || openClawStatus?.busy === true || openClawInstallJob?.status === "queued" || openClawInstallJob?.status === "running"}
                        disabled={openClawStatus?.installed === true || openClawInstallJob?.status === "queued" || openClawInstallJob?.status === "running"}
                      >
                        {openClawStatus?.installed ? "已安装 OpenClaw" : "一键安装 OpenClaw"}
                      </Button>
                    </div>
                  </Flex>
                </Card>
              </Col>
            )}
            {connectionItems.map((connection) => {
              const actionBusy = connectionBusy === `connect-${connection.instanceId}` || connectionBusy === `disconnect-${connection.instanceId}`;
              const checkBusy = connectionBusy === `check-${connection.instanceId}`;
              const stateClass = connection.connectionState === "connected"
                ? "ok"
                : connection.connectionState === "disconnected" || connection.connectionState === "error"
                  ? "error"
                  : connection.connectionState === "checking"
                    ? "warn"
                    : "idle";
              return (
                <Col xs={24} lg={12} key={connection.instanceId}>
                  <Card size="small" style={{ height: "100%" }}>
                    <Flex vertical gap={8}>
                      <Flex wrap="wrap" justify="space-between" align="flex-start" gap={8}>
                        <Flex vertical gap={4} style={{ minWidth: 0 }}>
                          <Tag
                            color={connection.frameworkId === "hermes" ? "cyan" : "geekblue"}
                            style={{ alignSelf: "flex-start" }}
                          >
                            {frameworkLabel(connection.frameworkId)}
                          </Tag>
                          <Title level={5} style={{ marginBottom: 0 }}>
                            {connection.displayName || instanceLabel(connection.instanceId)}
                          </Title>
                        </Flex>
                        <Badge
                          status={stateClass === "ok" ? "success" : stateClass === "error" ? "error" : stateClass === "warn" ? "warning" : "default"}
                          text={connectionStateLabel(connection.connectionState)}
                        />
                      </Flex>
                      <Descriptions
                        size="small"
                        column={2}
                        className="dense-descriptions"
                        items={[
                          {
                            key: "runtime",
                            label: "运行环境",
                            children: instanceRuntimeLabel(connection.runtime),
                          },
                          {
                            key: "version",
                            label: "版本",
                            children: connection.version ?? "版本未知",
                          },
                          {
                            key: "latency",
                            label: "响应延迟",
                            children: connection.latencyMs === null ? "尚未测延迟" : `${connection.latencyMs}ms`,
                          },
                          {
                            key: "reachable",
                            label: "可达状态",
                            children: connection.connected ? "服务可达" : connection.connectionState === "checking" ? "正在探测" : "服务不可达",
                          },
                          {
                            key: "root",
                            label: "数据目录",
                            children: <span title={connection.rootPath}>{connection.rootPath || "未配置目录"}</span>,
                          },
                          {
                            key: "lastChecked",
                            label: "最近检查",
                            children: formatRelative(connection.lastCheckedAt),
                          },
                          {
                            key: "lastAction",
                            label: "最近动作",
                            children: formatRelative(connection.lastActionAt),
                          },
                        ]}
                      />
                      {connection.lastError !== null && <Text type="danger">{connection.lastError}</Text>}
                      {connection.checks.length > 0 && (
                        <Flex vertical gap={4}>
                          {connection.checks.slice(0, 6).map((check) => {
                            const badge = quickProbeBadge(check.status);
                            return (
                              <Flex justify="space-between" align="center" gap={8} key={`${connection.instanceId}-${check.id}`}>
                                <Text type="secondary">{check.label}</Text>
                                <StatusBadge tone={badge.tone} label={badge.label} />
                              </Flex>
                            );
                          })}
                        </Flex>
                      )}
                      <Space wrap>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={() => onCheckOne(connection.instanceId)}
                          disabled={connectionBusy !== null}
                        >
                          {checkBusy ? "检查中…" : "重新检查"}
                        </Button>
                        <Button
                          danger={connection.connected}
                          type={connection.connected ? "default" : "primary"}
                          icon={connection.connected ? <DisconnectOutlined /> : <LinkOutlined />}
                          onClick={() => onToggleConnection(connection.instanceId, connection.connected ? "disconnect" : "connect")}
                          disabled={connectionBusy !== null || actionBusy || connection.connectionState === "checking"}
                        >
                          {actionBusy ? "处理中…" : connection.connected ? "断开连接" : "连接服务"}
                        </Button>
                      </Space>
                    </Flex>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </Flex>

      <Drawer
        title="OpenClaw 安装日志"
        open={installLogOpen}
        onClose={() => setInstallLogOpen(false)}
        size={560}
      >
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "var(--ant-color-fill-tertiary)",
            borderRadius: 8,
            fontFamily: "var(--ant-font-family-code)",
            fontSize: 12,
            overflow: "auto",
          }}
        >
          {openClawInstallJob?.logTail.join("\n") || "暂无日志"}
        </pre>
      </Drawer>
    </section>
  );
}
