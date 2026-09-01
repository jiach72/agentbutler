import type { ChannelControlPort } from "@butler/contract";

import type { HermesMessagingOptions } from "./adapter.js";
import { HermesBridgeClient } from "./bridge-client.js";

/** 复用消息面同源的 Bridge 连接参数，暴露通道控制端口。 */
export function createHermesChannelControl(options: HermesMessagingOptions): ChannelControlPort {
  const client = new HermesBridgeClient({
    baseUrl: options.baseUrl,
    token: options.token,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return {
    listChannels: () => client.listChannels(),
    channelSchema: (channel) => client.channelSchema(channel),
    updateChannelConfig: (channel, values) => client.updateChannelConfig(channel, values),
    enableChannel: (channel) => client.enableChannel(channel),
    disableChannel: (channel) => client.disableChannel(channel),
    weixinLoginStart: () => client.weixinLoginStart(),
    weixinLoginStatus: (sessionId) => client.weixinLoginStatus(sessionId),
    weixinLoginCancel: (sessionId) => client.weixinLoginCancel(sessionId),
  };
}
