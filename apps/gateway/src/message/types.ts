export interface ChannelPolicy {
  minRatePerMin: number;
  initialRatePerMin: number;
  maxRatePerMin: number;
  additiveStep: number;
  multiplicativeFactor: number;
  successWindow: number;
  nativeMinIntervalSec: number;
  prewarmTtlSec: number;
}

export interface MessagePolicyConfig {
  version: string;
  inlineResponse: "allow";
  /** 缺省 takeover；passthrough 时 Bridge 捕获后立即原样发送。 */
  relayMode?: "takeover" | "passthrough";
  digest: {
    windowSec: number;
    maxItems: number;
    maxChars: number;
    finalAbsorbsPendingProgress: boolean;
  };
  delivery: {
    maxAttempts: number;
    retryBaseSec: number;
    retryMaxSec: number;
  };
  channels: Record<string, ChannelPolicy>;
}
