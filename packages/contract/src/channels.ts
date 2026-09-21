import type { ChannelId } from "./common.js";

export type ChannelLoginState = "logged_in" | "logged_out" | "configuring" | "unknown";

export type ChannelKind = "qr-login" | "credential" | "builtin";

export interface ChannelRuntimeStatus {
  enabled: boolean;
  credentialsConfigured: boolean;
  loginState: ChannelLoginState;
  account?: string;
  lastError?: string;
}

export interface ChannelFieldSchema {
  name: string;
  label: string;
  type: "string";
  required: boolean;
  /** secret=true 的字段回显掩码、留空表示不修改。 */
  secret: boolean;
  description?: string;
}

export interface ChannelSchemaView {
  channel: ChannelId;
  kind: ChannelKind;
  supportsQr?: boolean;
  label: string;
  fields: ChannelFieldSchema[];
}

export interface ChannelDirectoryEntry extends ChannelRuntimeStatus {
  id: ChannelId;
  label: string;
  kind: ChannelKind;
  supportsQr?: boolean;
}

export interface ChannelDirectoryView {
  channels: ChannelDirectoryEntry[];
}

export interface ChannelLoginStartAck {
  sessionId: string;
  qrValue?: string;
  qrUrl: string;
  expiresAt: string;
}

export interface ChannelLoginStatusView {
  state: "wait" | "scanned" | "confirmed" | "expired_refreshing" | "failed";
  qrValue?: string;
  qrUrl?: string;
  account?: string;
  suggestEnable?: boolean;
  reason?: string;
}

export type WeixinLoginStartAck = ChannelLoginStartAck;
export type WeixinLoginStatusView = ChannelLoginStatusView;

/** Bridge 通道控制面端口（仅 Hermes 适配器实现）。 */
export interface ChannelControlPort {
  listChannels(): Promise<ChannelDirectoryView>;
  channelSchema(channel: ChannelId): Promise<ChannelSchemaView>;
  updateChannelConfig(channel: ChannelId, values: Record<string, string>): Promise<{ saved: true }>;
  enableChannel(channel: ChannelId): Promise<{ restarting: boolean }>;
  disableChannel(channel: ChannelId): Promise<{ restarting: boolean }>;
  channelLoginStart(channel: ChannelId): Promise<ChannelLoginStartAck>;
  channelLoginStatus(channel: ChannelId, sessionId: string): Promise<ChannelLoginStatusView>;
  channelLoginCancel(channel: ChannelId, sessionId: string): Promise<{ cancelled: boolean }>;
  weixinLoginStart(): Promise<WeixinLoginStartAck>;
  weixinLoginStatus(sessionId: string): Promise<WeixinLoginStatusView>;
  weixinLoginCancel(sessionId: string): Promise<{ cancelled: boolean }>;
}
