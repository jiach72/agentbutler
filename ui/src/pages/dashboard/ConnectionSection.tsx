/**
 * 服务连接区：Hermes / OpenClaw 连接卡片与 OpenClaw 手动安装指引。
 */
import { App } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { CopyOutlined, DisconnectOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
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
  OpenClawStatusView,
} from "./types.js";

const { Paragraph, Text, Title } = Typography;

/** 与后端探测同源的安装命令；管家不代装，用户在宿主执行。 */
const OPENCLAW_INSTALL_COMMAND = "npm install --global openclaw";

interface ConnectionSectionProps {
  connections: ConnectionsPayload | null;
  openClawStatus: OpenClawStatusView | null;
  /** 形如 check-<id> / connect-<id> / disconnect-<id> / check-all 的在途动作标记。 */
  connectionBusy: string | null;
  onCheckAll: () => void;
  onCheckOne: (instanceId: string) => void;
  onToggleConnection: (instanceId: string, action: "connect" | "disconnect") => void;
}

export function ConnectionSection({
  connections,
  openClawStatus,
  connectionBusy,
  onCheckAll,
  onCheckOne,
  onToggleConnection,
}: ConnectionSectionProps) {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  const connectionItems = connections?.connections ?? [];

  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(OPENCLAW_INSTALL_COMMAND);
      setCopied(true);
      message.success("安装命令已复制，请在宿主终端执行");
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      message.error("复制失败，请手动选择命令文本复制");
    }
  };

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
                    {openClawStatus?.installed !== true && (
                      <Flex vertical gap={4}>
                        <Text type="secondary">
                          在宿主终端执行以下命令完成安装（需要 Node.js 24.15+），完成后回到这里重新检查连接：
                        </Text>
                        <Flex gap={8} align="center">
                          <Text code copyable={false} style={{ flex: 1, padding: "4px 8px" }}>
                            {OPENCLAW_INSTALL_COMMAND}
                          </Text>
                          <Button
                            size="small"
                            icon={<CopyOutlined />}
                            onClick={() => void copyInstallCommand()}
                          >
                            {copied ? "已复制" : "复制"}
                          </Button>
                        </Flex>
                      </Flex>
                    )}
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
                        column={1}
                        className="dense-descriptions"
                        items={[
                          {
                            key: "runtime",
                            label: "运行环境",
                            children: `${instanceRuntimeLabel(connection.runtime)} · ${
                              connection.version ?? "版本未知"
                            } · 延迟 ${
                              connection.latencyMs === null ? "未测" : `${connection.latencyMs}ms`
                            } · 最近检查 ${formatRelative(connection.lastCheckedAt)}`,
                          },
                        ]}
                      />
                      {connection.lastError !== null && <Text type="danger">{connection.lastError}</Text>}
                      {connection.checks.length > 0 && (
                        <Flex wrap gap={12} align="center">
                          {connection.checks.slice(0, 6).map((check) => {
                            const badge = quickProbeBadge(check.status);
                            return (
                              <Tooltip
                                key={`${connection.instanceId}-${check.id}`}
                                title={
                                  check.detail === undefined || check.detail === ""
                                    ? `${check.label}：${badge.label}${check.durationMs === undefined ? "" : `（${check.durationMs}ms）`}`
                                    : `${check.label}：${check.detail}`
                                }
                              >
                                <Flex align="center" gap={4}>
                                  <Text type="secondary" style={{ fontSize: 13 }}>
                                    {check.label}
                                  </Text>
                                  <StatusBadge tone={badge.tone} label={badge.label} />
                                </Flex>
                              </Tooltip>
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
    </section>
  );
}
