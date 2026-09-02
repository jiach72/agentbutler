/**
 * 微信扫码登录弹窗：start → 1s 轮询 status → 二维码/状态步骤条 → 成功或失败。
 */
import { Alert, Button, Flex, Modal, Spin, Steps, Typography } from "antd";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { fetchJson, postJson } from "../../lib/api.js";

interface WeixinLoginModalProps {
  open: boolean;
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

/** postJson 的 data 为 unknown，此处收敛为 start 应答的形状。 */
interface WeixinLoginStartAckData {
  sessionId: string;
  qrUrl: string;
}

export function WeixinLoginModal({ open, onClose, onConfirmed }: WeixinLoginModalProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [linkLost, setLinkLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollFailures = 0; // 连续轮询失败计数：>5 提示失联，但不放弃重试
    setQrUrl(null);
    setStatus(null);
    setLinkLost(false);
    const poll = async (): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      const next = await fetchJson<LoginStatus>(
        `/api/messages/channels/weixin/login/status?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!active) return;
      if (next === null) {
        // 瞬时失败（网络抖动/网关短暂重启）：2s 后重试；连续 >5 次提示失联但继续重试
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
      const ack = await postJson("/api/messages/channels/weixin/login/start", {});
      const data = ack.ok ? (ack.data as Partial<WeixinLoginStartAckData> | null) : null;
      if (data !== null && data.sessionId !== undefined && (cancelledRef.current || !active)) {
        // 弹窗在 start 返回前被关闭/重新生成：会话无人认领，立即取消避免服务端泄漏
        void postJson("/api/messages/channels/weixin/login/cancel", { sessionId: data.sessionId });
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
      if (sessionId !== null) void postJson("/api/messages/channels/weixin/login/cancel", { sessionId });
    };
  }, [open, onConfirmed, attempt]);

  return (
    <Modal
      open={open}
      title="微信扫码登录"
      footer={null}
      onCancel={onClose}
      width={420}
    >
      {linkLost && (
        <Alert type="error" showIcon message="与管家服务暂时失联，正在重试…" style={{ marginBottom: 12 }} />
      )}
      {status?.state === "failed" ? (
        <Flex vertical gap={12}>
          <Alert type="error" showIcon message="登录未完成" description={status.reason ?? "请关闭后重试"} />
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
            items={[{ title: "等待扫码" }, { title: "微信内确认" }, { title: "连接成功" }]}
          />
          <Typography.Text type="secondary">请使用微信扫描二维码，并在手机上确认登录。</Typography.Text>
        </Flex>
      )}
    </Modal>
  );
}
