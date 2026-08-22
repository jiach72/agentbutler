import { createHash } from "node:crypto";

import type { ChannelId, PolicySnapshot } from "@butler/contract";

import type { ChannelPolicy, MessagePolicyConfig } from "./types.js";

export const DEFAULT_MESSAGE_POLICY: MessagePolicyConfig = {
  version: "message-policy-v1",
  inlineResponse: "allow",
  digest: {
    windowSec: 120,
    maxItems: 8,
    maxChars: 1800,
    finalAbsorbsPendingProgress: true,
  },
  delivery: {
    maxAttempts: 5,
    retryBaseSec: 15,
    retryMaxSec: 900,
  },
  channels: {
    weixin: {
      minRatePerMin: 1,
      initialRatePerMin: 2,
      maxRatePerMin: 2,
      additiveStep: 0.25,
      multiplicativeFactor: 0.5,
      successWindow: 4,
      nativeMinIntervalSec: 30,
      prewarmTtlSec: 300,
    },
    a2a: {
      minRatePerMin: 6,
      initialRatePerMin: 30,
      maxRatePerMin: 60,
      additiveStep: 2,
      multiplicativeFactor: 0.5,
      successWindow: 5,
      nativeMinIntervalSec: 0,
      prewarmTtlSec: 120,
    },
    "api-server": {
      minRatePerMin: 60,
      initialRatePerMin: 600,
      maxRatePerMin: 600,
      additiveStep: 10,
      multiplicativeFactor: 0.5,
      successWindow: 5,
      nativeMinIntervalSec: 0,
      prewarmTtlSec: 60,
    },
  },
};

const CONFIG_NUMBERS = (config: MessagePolicyConfig): Array<[string, number]> => [
  ["digest.windowSec", config.digest.windowSec],
  ["digest.maxItems", config.digest.maxItems],
  ["digest.maxChars", config.digest.maxChars],
  ["delivery.maxAttempts", config.delivery.maxAttempts],
  ["delivery.retryBaseSec", config.delivery.retryBaseSec],
  ["delivery.retryMaxSec", config.delivery.retryMaxSec],
];

function validateChannelPolicy(channelId: ChannelId, policy: ChannelPolicy): void {
  const numericFields: Array<[string, number]> = [
    ["minRatePerMin", policy.minRatePerMin],
    ["initialRatePerMin", policy.initialRatePerMin],
    ["maxRatePerMin", policy.maxRatePerMin],
    ["additiveStep", policy.additiveStep],
    ["multiplicativeFactor", policy.multiplicativeFactor],
    ["successWindow", policy.successWindow],
    ["nativeMinIntervalSec", policy.nativeMinIntervalSec],
    ["prewarmTtlSec", policy.prewarmTtlSec],
  ];

  for (const [field, value] of numericFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`channels.${channelId}.${field} must be a finite, non-negative number`);
    }
  }

  if (policy.minRatePerMin > policy.initialRatePerMin || policy.initialRatePerMin > policy.maxRatePerMin) {
    throw new Error(`channels.${channelId} rates must satisfy min <= initial <= max`);
  }

  if (policy.multiplicativeFactor <= 0 || policy.multiplicativeFactor >= 1) {
    throw new Error(`channels.${channelId}.multiplicativeFactor must satisfy 0 < beta < 1`);
  }

  if (policy.successWindow < 1) {
    throw new Error(`channels.${channelId}.successWindow must be at least 1`);
  }

  if (channelId === "weixin" && policy.nativeMinIntervalSec < 30) {
    throw new Error("channels.weixin.nativeMinIntervalSec must be at least 30 seconds");
  }
}

export function validateMessagePolicy(config: MessagePolicyConfig): void {
  if (config.inlineResponse !== "allow") {
    throw new Error('inlineResponse must be exactly "allow"');
  }

  for (const [field, value] of CONFIG_NUMBERS(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a finite, non-negative number`);
    }
  }

  for (const [channelId, policy] of Object.entries(config.channels)) {
    validateChannelPolicy(channelId, policy);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }

  return value;
}

export function createPolicySnapshot(config: MessagePolicyConfig): PolicySnapshot {
  validateMessagePolicy(config);
  const canonicalPayload = canonicalize(config) as MessagePolicyConfig;
  const canonicalJson = JSON.stringify(canonicalPayload);
  const sha256 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");

  return {
    version: canonicalPayload.version,
    sha256,
    payload: canonicalPayload as unknown as Record<string, unknown>,
  };
}
