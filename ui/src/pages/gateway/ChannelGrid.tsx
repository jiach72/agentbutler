/**
 * 通讯工具卡片组：当前接入的国内 IM、登录账号与健康状态；启停/扫码/配置入口。
 */
import { ReloadOutlined } from "@ant-design/icons";
import { Badge, Button, Card, Flex, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchJson } from "../../lib/api.js";
import { REFRESH_INTERVAL_MS, channelKindLabel, loginStateCopy } from "./helpers.js";
import type { ChannelDirectoryEntryView } from "./helpers.js";
import { WeixinLoginModal } from "./WeixinLoginModal.js";

const LOGIN_BADGE: Record<ChannelDirectoryEntryView["loginState"], "success" | "error" | "warning" | "default"> = {
  logged_in: "success",
  logged_out: "error",
  configuring: "warning",
  unknown: "default",
};

interface ChannelGridProps {
  refreshedAt: Date | null;
  /** 重新连接通道（复用 GatewayPage 的 reconnectMessages）。 */
  onReconnect: () => void;
}

export function ChannelGrid({ refreshedAt, onReconnect }: ChannelGridProps) {
  const [channels, setChannels] = useState<ChannelDirectoryEntryView[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const refresh = useCallback(async () => {
    const data = await fetchJson<{ channels: ChannelDirectoryEntryView[] }>("/api/messages/channels");
    setChannels(data?.channels ?? null);
    setUnreachable(data === null);
  }, []);

  // 保持引用稳定：弹窗轮询 effect 依赖 onConfirmed/onClose，避免目录轮询重渲染重启扫码会话。
  const closeLogin = useCallback(() => {
    setLoginOpen(false);
    void refresh();
  }, [refresh]);
  const confirmLogin = useCallback(() => {
    setLoginOpen(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshedAt]);
  usePolling(() => void refresh(), REFRESH_INTERVAL_MS);

  return (
    <Card
      title="通讯工具"
      extra={
        <Flex wrap="wrap" justify="flex-end" align="center" gap={12}>
          {unreachable && <Tag color="warning">通道服务不可达</Tag>}
          <Button icon={<ReloadOutlined />} onClick={onReconnect}>
            重新连接通道
          </Button>
        </Flex>
      }
    >
      {channels === null ? (
        <Typography.Text type="secondary">{unreachable ? "暂时读不到通道目录，稍后自动重试。" : "正在读取通道目录…"}</Typography.Text>
      ) : (
        <Flex gap={16} wrap="wrap">
          {channels.map((channel) => (
            <Card
              key={channel.id}
              size="small"
              style={{ width: 260 }}
              title={
                <Flex align="center" gap={8}>
                  <span>{channel.label}</span>
                  <Badge status={LOGIN_BADGE[channel.loginState]} text={loginStateCopy(channel.loginState)} />
                </Flex>
              }
            >
              <Flex vertical gap={8}>
                <Typography.Text type="secondary">
                  {channelKindLabel(channel.kind)}
                  {channel.account !== undefined ? ` · ${channel.account}` : ""}
                  {channel.enabled ? "" : " · 已停用"}
                </Typography.Text>
                {channel.kind === "qr-login" ? (
                  <Button size="small" type="primary" onClick={() => setLoginOpen(true)}>
                    扫码登录
                  </Button>
                ) : channel.kind === "credential" ? (
                  /* 配置/启停入口在 M4 接线 */
                  <Button size="small" disabled>
                    配置接入（即将上线）
                  </Button>
                ) : null}
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
      <WeixinLoginModal open={loginOpen} onClose={closeLogin} onConfirmed={confirmLogin} />
    </Card>
  );
}
