/**
 * 服务连接区：Hermes / OpenClaw 连接卡片、OpenClaw 安装面板与实时日志抽屉。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, Drawer, Progress, Space, Steps } from "antd";
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
    <section className="connection-section" aria-labelledby="connection-section-title">
      <div className="connection-section-head">
        <div>
          <span className="product-kicker">服务连接</span>
          <h2 id="connection-section-title">Hermes / OpenClaw 连接状态</h2>
          <p>这里显示最近一次探测、响应耗时和可用能力；连接动作会在完成后自动复核。</p>
        </div>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={onCheckAll}
          disabled={connectionBusy !== null || connectionItems.length === 0}
        >
          {connectionBusy === "check-all" ? "检查中…" : "手动检查连接"}
        </Button>
      </div>
      {connections === null || connections.reachable !== true ? (
        <Alert
          type="warning"
          showIcon
          message="管家控制通道暂时连不上"
          description="无法读取 Hermes / OpenClaw 的实时连接状态，服务恢复后会自动重试。"
        />
      ) : (
        <>
          <div className="connection-grid">
            {!connectionItems.some((item) => item.frameworkId === "hermes") && (
              <Card className="connection-card connection-capability-card is-warn is-hermes" variant="outlined">
                <div className="connection-card-head">
                  <div>
                    <span className="connection-framework is-hermes">Hermes</span>
                    <h3>尚未配置</h3>
                  </div>
                  <Badge status="default" text="未发现实例" />
                </div>
                <div className="connection-summary">
                  <strong>等待运行目录</strong>
                  <span>配置 Hermes 实例后，管家会在这里显示连接状态。</span>
                </div>
                <div className="connection-actions">
                  <Link to="/settings">
                    <Button>前往设置</Button>
                  </Link>
                </div>
              </Card>
            )}
            {!connectionItems.some((item) => item.frameworkId === "openclaw") && (
              <Card className="connection-card connection-capability-card is-warn is-openclaw" variant="outlined">
                <div className="connection-card-head">
                  <div>
                    <span className="connection-framework is-openclaw">OpenClaw</span>
                    <h3>{openClawStatus?.installed ? "已安装，等待连接" : "尚未安装"}</h3>
                  </div>
                  <Badge
                    status={openClawStatus?.installed ? "warning" : "default"}
                    text={openClawStatus?.installed ? "未连接" : "未安装"}
                  />
                </div>
                <div className="connection-summary">
                  <strong>{openClawStatus?.version ?? "没有可用版本"}</strong>
                  <span>{openClawStatus?.detail ?? "正在读取 OpenClaw 安装状态"}</span>
                </div>
                {openClawStatus?.runtime !== undefined && (
                  <AdvancedDetails
                    summary="运行环境详情"
                    extra={openClawStatus.runtime.detail ?? "WSL 运行环境"}
                  >
                    <div className="openclaw-runtime-facts">
                      <span
                        title={openClawStatus.target?.dataRoot ?? openClawStatus.rootPath ?? undefined}
                      >
                        数据目录：{openClawStatus.target?.dataRoot ?? openClawStatus.rootPath ?? "~/.openclaw"}
                      </span>
                      <span title={openClawStatus.target?.npmGlobalRoot ?? undefined}>
                        全局包目录：{openClawStatus.target?.npmGlobalRoot ?? "解析中"}
                      </span>
                    </div>
                  </AdvancedDetails>
                )}
                {openClawInstallJob !== null && (
                  <div className="openclaw-install-panel">
                    <div className="openclaw-install-panel-head">
                      <strong>
                        {openClawInstallJob.status === "done" ? "安装完成"
                          : openClawInstallJob.status === "failed" ? "安装失败"
                            : openClawInstallJob.status === "cancelled" ? "已取消"
                              : openClawInstallJob.status === "queued" ? "提交中"
                                : "安装中"}
                      </strong>
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
                    </div>
                    <Progress percent={openClawInstallJob.progress} size="small" status={openClawInstallJob.status === "failed" ? "exception" : openClawInstallJob.status === "done" ? "success" : "active"} />
                    {openClawInstallJob.steps.length > 0 && (
                      <Steps
                        className="openclaw-install-steps"
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
                    {openClawInstallJob.error !== null && <Alert type="error" showIcon message="安装未完成" description={openClawInstallJob.error} />}
                    <div className="openclaw-install-actions">
                      {(openClawInstallJob.status === "queued" || openClawInstallJob.status === "running") && (
                        <Button size="small" onClick={onCancelInstall}>取消安装</Button>
                      )}
                      {openClawInstallJob.status === "failed" && (
                        <Button size="small" type="link" onClick={onInstall}>重试安装</Button>
                      )}
                      {openClawInstallJob.logTail.length > 0 && (
                        <Button size="small" type="link" onClick={() => setInstallLogOpen(true)}>查看实时日志</Button>
                      )}
                    </div>
                  </div>
                )}
                <div className="connection-actions">
                  <Button
                    type="primary"
                    onClick={onInstall}
                    loading={openClawInstallBusy || openClawStatus?.busy === true || openClawInstallJob?.status === "queued" || openClawInstallJob?.status === "running"}
                    disabled={openClawStatus?.installed === true || openClawInstallJob?.status === "queued" || openClawInstallJob?.status === "running"}
                  >
                    {openClawStatus?.installed ? "已安装 OpenClaw" : "一键安装 OpenClaw"}
                  </Button>
                </div>
              </Card>
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
                <Card className={`connection-card is-${stateClass} is-${connection.frameworkId}`} key={connection.instanceId} variant="outlined">
                  <div className="connection-card-head">
                    <div>
                      <span className={`connection-framework is-${connection.frameworkId}`}>{frameworkLabel(connection.frameworkId)}</span>
                      <h3>{connection.displayName || instanceLabel(connection.instanceId)}</h3>
                    </div>
                    <Badge
                      status={stateClass === "ok" ? "success" : stateClass === "error" ? "error" : stateClass === "warn" ? "warning" : "default"}
                      text={connectionStateLabel(connection.connectionState)}
                    />
                  </div>
                  <div className="connection-meta">
                    <span>{instanceRuntimeLabel(connection.runtime)}</span>
                    <span>{connection.version ?? "版本未知"}</span>
                    <span>{connection.latencyMs === null ? "尚未测延迟" : `响应 ${connection.latencyMs}ms`}</span>
                    <span title={connection.rootPath}>{connection.rootPath || "未配置目录"}</span>
                  </div>
                  <div className="connection-summary">
                    <strong>{connection.connected ? "服务可达" : connection.connectionState === "checking" ? "正在探测服务" : "服务不可达"}</strong>
                    <span>最近检查：{formatRelative(connection.lastCheckedAt)}</span>
                    <span>最近动作：{formatRelative(connection.lastActionAt)}</span>
                  </div>
                  {connection.lastError !== null && <p className="connection-error">{connection.lastError}</p>}
                  {connection.checks.length > 0 && (
                    <ul className="connection-checks">
                      {connection.checks.slice(0, 6).map((check) => {
                        const badge = quickProbeBadge(check.status);
                        return (
                          <li key={`${connection.instanceId}-${check.id}`}>
                            <span>{check.label}</span>
                            <StatusBadge tone={badge.tone} label={badge.label} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="connection-actions">
                    <Space wrap>
                      <Button
                        type="default"
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
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Drawer
        title="OpenClaw 安装日志"
        open={installLogOpen}
        onClose={() => setInstallLogOpen(false)}
        width={560}
      >
        <pre className="openclaw-install-log">{openClawInstallJob?.logTail.join("\n") || "暂无日志"}</pre>
      </Drawer>
    </section>
  );
}
