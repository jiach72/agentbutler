/**
 * 微信扫码登录弹窗（向后兼容导出，委托给通用的 ChannelQrLoginModal）。
 */
import {
  ChannelQrLoginModal,
  type ChannelQrLoginModalProps,
} from "./ChannelQrLoginModal.js";

export interface WeixinLoginModalProps {
  open: boolean;
  onClose: () => void;
  onConfirmed: () => void;
}

export function WeixinLoginModal(props: WeixinLoginModalProps) {
  return (
    <ChannelQrLoginModal
      {...props}
      channel="weixin"
      channelLabel="微信"
    />
  );
}
export { ChannelQrLoginModal, type ChannelQrLoginModalProps };
