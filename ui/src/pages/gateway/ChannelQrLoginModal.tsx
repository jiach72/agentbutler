/**
 * 通用通道扫码登录弹窗：支持微信、飞书、QQ 机器人等通道的多平台扫码。
 * start → 1s 轮询 status → 二维码/状态步骤条 → 成功或失败。
 */
import { Alert, Button, Flex, Modal, Spin, Steps, Typography } from "antd";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, postJson } from "../../lib/api.js";

export interface ChannelQrLoginModalProps {
  open: boolean;
  channel: string;
  channelLabel: string;
  onClose: () => void;
  onConfirmed: () => void;
}

type LoginStatus = {
  state: "wait" | "scanned" | "confirmed" | "expired_refreshing" | "failed";
  qrUrl?: string;
  account?: string;
  reason?: string;
};

const STEP_INDEX: Record<LoginStatus["state"], number> = {
  wait: 0,
  scanned: 1,
  confirmed: 2,
  expired_refreshing: 0,
  failed: 1,
};

interface ChannelLoginStartAckData {
  sessionId: string;
  qrUrl: string;
}

export function ChannelQrLoginModal({
  open,
  channel,
  channelLabel,
  onClose,
  onConfirmed,
}: ChannelQrLoginModalProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [linkLost, setLinkLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const guideText = useMemo(() => {
    if (channel === "weixin") return "请使用微信扫描二维码，并在手机上确认登录。";
    if (channel === "feishu") return "请使用手机飞书扫描二维码，授权后将自动创建并配置 PersonalAgent 机器人。";
    if (channel === "qqbot" || channel === "qq") return "请使用手机 QQ 扫描二维码绑定官方机器人。";
    return `请使用 ${channelLabel} 扫描二维码并在手机上确认授权。`;
  }, [channel, channelLabel]);

  const confirmStepTitle = useMemo(() => {
    if (channel === "weixin") return "微信内确认";
    if (channel === "feishu") return "飞书内授权";
    if (channel === "qqbot" || channel === "qq") return "手机 QQ 确认";
    return "手机端确认";
  }, [channel]);

  const modalTitle = useMemo(() => {
    if (channel === "weixin") return "微信扫码登录";
    if (channel === "feishu") return "飞书扫码接入";
    if (channel === "qqbot" || channel === "qq") return "QQ 机器人扫码绑定";
    return `${channelLabel} 扫码接入`;
  }, [channel, channelLabel]);

  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollFailures = 0;
    setQrUrl(null);
    setStatus(null);
    setLinkLost(false);

    const channelParam = encodeURIComponent(channel);

    const poll = async (): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      const next = await fetchJson<LoginStatus>(
        `/api/messages/channels/${channelParam}/login/status?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!active) return;
      if (next === null) {
        pollFailures += 1;
        if (pollFailures > 5) setLinkLost(true);
        timer = setTimeout(() => void poll(), 2_000);
        return;
      }
      pollFailures = 0;
      setLinkLost(false);
      setStatus(next);
      if (next.state === "confirmed") {
        onConfirmed();
        return;
      }
      if (next.state === "failed") return;
      if (next.qrUrl !== undefined) setQrUrl(next.qrUrl);
      timer = setTimeout(() => void poll(), 1_000);
    };

    void (async () => {
      const ack = await postJson(`/api/messages/channels/${channelParam}/login/start`, {});
      const data = ack.ok ? (ack.data as Partial<ChannelLoginStartAckData> | null) : null;
      if (data !== null && data.sessionId !== undefined && (cancelledRef.current || !active)) {
        void postJson(`/api/messages/channels/${channelParam}/login/cancel`, { sessionId: data.sessionId });
        return;
      }
      if (!active) return;
      if (data === null || data.sessionId === undefined || data.qrUrl === undefined) {
        setStatus({ state: "failed", reason: "无法发起扫码会话" });
        return;
      }
      sessionIdRef.current = data.sessionId;
      setQrUrl(data.qrUrl);
      setStatus({ state: "wait" });
      await poll();
    })();

    return () => {
      active = false;
      cancelledRef.current = true;
      if (timer !== undefined) clearTimeout(timer);
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId !== null) void postJson(`/api/messages/channels/${channelParam}/login/cancel`, { sessionId });
    };
  }, [open, onConfirmed, attempt, channel]);

  return (
    <Modal
      open={open}
      title={modalTitle}
      footer={null}
      onCancel={onClose}
      width={420}
    >
      {linkLost && (
        <Alert type="error" showIcon title="与管家服务暂时失联，正在重试…" style={{ marginBottom: 12 }} />
      )}
      {status?.state === "failed" ? (
        <Flex vertical gap={12}>
          <Alert type="error" showIcon title="接入未完成" description={status.reason ?? "请关闭后重试"} />
          <Button onClick={() => setAttempt((current) => current + 1)}>重新生成二维码</Button>
        </Flex>
      ) : qrUrl === null ? (
        <Flex justify="center" style={{ padding: 32 }}><Spin /></Flex>
      ) : (
        <Flex vertical align="center" gap={16}>
          <QRCodeSVG value={qrUrl} size={220} />
          {status?.state === "expired_refreshing" && (
            <Typography.Text type="warning">二维码已过期，正在刷新…</Typography.Text>
          )}
          <Steps
            size="small"
            current={status === null ? 0 : STEP_INDEX[status.state]}
            status="process"
            items={[{ title: "等待扫码" }, { title: confirmStepTitle }, { title: "连接成功" }]}
          />
          <Typography.Text type="secondary">{guideText}</Typography.Text>
        </Flex>
      )}
    </Modal>
  );
}
