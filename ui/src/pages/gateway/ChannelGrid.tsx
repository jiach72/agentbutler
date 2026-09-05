/**
 * 通讯工具卡片组：当前接入的国内 IM、登录账号与健康状态；启停/扫码/配置入口。
 * 卡片为市场风规格：分类色图标底 + 通道名 + 启停状态标签；启停/配置逻辑不变。
 */
import {
  MailOutlined,
  MessageOutlined,
  MobileOutlined,
  QqOutlined,
  ReloadOutlined,
  SendOutlined,
  WechatOutlined,
} from "@ant-design/icons";
import type { ComponentType } from "react";
import { App, Button, Card, Flex, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchJson, postJson } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ChannelConfigModal } from "./ChannelConfigModal.js";
import {
  REFRESH_INTERVAL_MS,
  channelActionError,
  channelKindLabel,
  channelToggleAck,
  channelToggleWarnings,
  loginStateCopy,
} from "./helpers.js";
import type { ChannelDirectoryEntryView } from "./helpers.js";
import { WeixinLoginModal } from "./WeixinLoginModal.js";
import "./gateway.css";

/** 通道名关键词 → 图标与色调（不命中走通用消息图标）。 */
function channelTileOf(label: string): { Icon: ComponentType; tone: string } {
  const lowered = label.toLowerCase();
  if (lowered.includes("微信") || lowered.includes("wechat")) return { Icon: WechatOutlined, tone: "green" };
  if (lowered.includes("telegram")) return { Icon: SendOutlined, tone: "blue" };
  if (lowered.includes("邮件") || lowered.includes("mail") || lowered.includes("smtp"))
    return { Icon: MailOutlined, tone: "teal" };
  if (lowered.includes("短信") || lowered.includes("sms")) return { Icon: MobileOutlined, tone: "gold" };
  if (lowered.includes("qq")) return { Icon: QqOutlined, tone: "blue" };
  return { Icon: MessageOutlined, tone: "gray" };
}

interface ChannelGridProps {
  /** 重新连接通道（复用 GatewayPage 的 reconnectMessages）。 */
  onReconnect: () => void;
}

export function ChannelGrid({ onReconnect }: ChannelGridProps) {
  const { message } = App.useApp();
  const [channels, setChannels] = useState<ChannelDirectoryEntryView[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [configChannel, setConfigChannel] = useState<ChannelDirectoryEntryView | null>(null);
  const [applyingIds, setApplyingIds] = useState<ReadonlySet<string>>(new Set());

  const acquireApplying = useCallback((id: string) => {
    setApplyingIds((prev) => new Set(prev).add(id));
  }, []);

  const releaseApplying = useCallback((id: string) => {
    setApplyingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const data = await fetchJson<{ channels: ChannelDirectoryEntryView[] }>("/api/messages/channels");
    setChannels(data?.channels ?? null);
    setUnreachable(data === null);
  }, []);

  // 优雅重启窗口：60s 内轮询目录，通道到达期望启停状态或超时由下一轮刷新自然呈现
  const pollChannelOnline = useCallback(async (id: string, expectedEnabled: boolean): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const data = await fetchJson<{ channels: ChannelDirectoryEntryView[] }>("/api/messages/channels");
      const target = data?.channels.find((entry) => entry.id === id);
      if (target !== undefined && target.enabled === expectedEnabled && target.loginState !== "configuring") break;
    }
  }, []);

  /** 配置弹窗保存并启用后：保持「应用中」直至通道上线/超时；重启未触发时跳过空等。 */
  const watchChannel = useCallback(
    async (id: string, ack?: { restarting?: boolean } | null): Promise<void> => {
      acquireApplying(id);
      try {
        // restarting === false 说明 Hermes 运行时不支持在线重启（文案已提示手动重启），
        // 继续轮询 60 秒只会让卡片停在「应用中」；直接刷新目录呈现真实状态。
        if (ack?.restarting !== false) {
          await pollChannelOnline(id, true);
        }
      } finally {
        releaseApplying(id);
        void refresh();
      }
    },
    [acquireApplying, pollChannelOnline, releaseApplying, refresh],
  );

  const toggleChannel = useCallback(
    async (id: string, enable: boolean): Promise<void> => {
      acquireApplying(id);
      try {
        const result = await postJson(
          `/api/messages/channels/${encodeURIComponent(id)}/${enable ? "enable" : "disable"}`,
          {},
          10_000,
        );
        if (!result.ok) {
          message.error(channelActionError(result.status, result.data));
          return; // 非 2xx 不进轮询，状态由目录刷新自然呈现
        }
        const ack = channelToggleAck(result.data);
        for (const notice of channelToggleWarnings(ack)) {
          message.warning(notice);
        }
        if (ack?.restarting === false) return; // 已提示手动重启，跳过 60s 空等
        await pollChannelOnline(id, enable);
      } finally {
        releaseApplying(id);
        void refresh();
      }
    },
    [acquireApplying, message, pollChannelOnline, releaseApplying, refresh],
  );

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
  }, [refresh]);
  usePolling(() => void refresh(), REFRESH_INTERVAL_MS);

  return (
    <section className="channel-directory" aria-labelledby="channel-grid-heading">
      <Flex className="channel-directory-head" wrap="wrap" justify="space-between" align="center" gap={12}>
        <Typography.Title id="channel-grid-heading" level={4} style={{ margin: 0 }}>
          通讯工具
        </Typography.Title>
        <Flex wrap="wrap" justify="flex-end" align="center" gap={12}>
          {unreachable && <Tag color="warning">通道服务不可达</Tag>}
          <Button icon={<ReloadOutlined />} onClick={onReconnect}>
            重新连接通道
          </Button>
        </Flex>
      </Flex>
      <div className="channel-grid" aria-live="polite">
        {channels === null ? (
          <Typography.Text type="secondary">{unreachable ? "暂时读不到通道目录，稍后自动重试。" : "正在读取通道目录…"}</Typography.Text>
        ) : (
          <>
          {channels.map((channel) => {
            const { Icon, tone } = channelTileOf(channel.label);
            return (
            <Card
              key={channel.id}
              size="small"
              title={
                <Flex align="center" gap={10}>
                  <span className={`channel-tile tone-${tone}`} aria-hidden="true">
                    <Icon />
                  </span>
                  <span>{channel.label}</span>
                  <StatusBadge tone={channel.enabled ? "ok" : "muted"} label={channel.enabled ? "已启用" : "已停用"} />
                </Flex>
              }
            >
              <Flex vertical gap={8}>
                <Typography.Text type="secondary">
                  {channelKindLabel(channel.kind)}
                  {channel.account !== undefined ? ` · ${channel.account}` : ""}
                  {` · ${loginStateCopy(channel.loginState)}`}
                </Typography.Text>
                {channel.kind === "qr-login" ? (
                  <Button size="small" type="primary" onClick={() => setLoginOpen(true)}>
                    扫码登录
                  </Button>
                ) : channel.kind === "credential" ? (
                  <Flex gap={8} wrap="wrap">
                    <Button size="small" type="primary" onClick={() => setConfigChannel(channel)}>
                      {channel.credentialsConfigured ? "配置" : "配置接入"}
                    </Button>
                    {channel.credentialsConfigured &&
                      (applyingIds.has(channel.id) ? (
                        <Button size="small" loading>
                          应用中
                        </Button>
                      ) : channel.enabled ? (
                        <Button size="small" onClick={() => void toggleChannel(channel.id, false)}>
                          停用
                        </Button>
                      ) : (
                        <Button size="small" onClick={() => void toggleChannel(channel.id, true)}>
                          启用
                        </Button>
                      ))}
                  </Flex>
                ) : null}
              </Flex>
            </Card>
            );
          })}
          </>
        )}
      </div>
      <WeixinLoginModal open={loginOpen} onClose={closeLogin} onConfirmed={confirmLogin} />
      {configChannel !== null && (
        <ChannelConfigModal
          channel={configChannel.id}
          label={configChannel.label}
          onClose={() => setConfigChannel(null)}
          onApplied={(ack) => {
            const id = configChannel.id;
            setConfigChannel(null);
            void watchChannel(id, ack);
          }}
        />
      )}
    </section>
  );
}
