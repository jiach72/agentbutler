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
