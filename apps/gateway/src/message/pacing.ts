import type { OutboxMessageView } from "@butler/contract";

import type { PacingLane } from "./store.js";
import type { ChannelPolicy } from "./types.js";

export interface PacingEvaluationInput {
  message: OutboxMessageView;
  channelLane: PacingLane;
  chatLane: PacingLane;
  policy: ChannelPolicy;
  now: string;
}

export interface PacingEvaluation {
  held: boolean;
  availableAt?: string;
  transformTrace: string[];
}

export interface PacingCongestionInput {
  lane: PacingLane;
  policy: ChannelPolicy;
  now: string;
  retryAfterSec?: number;
  reason: string;
}

export function evaluatePacing(input: PacingEvaluationInput): PacingEvaluation {
  const now = parseTimestamp(input.now, "now");
  validatePolicy(input.policy);
  const constraints = [laneConstraint(input.channelLane, input.message.channel, input.policy, now), laneConstraint(input.chatLane, input.message.channel, input.policy, now)];
  const dueAt = Math.max(now, ...constraints);
  if (dueAt <= now) return { held: false, transformTrace: ["pacing:ready"] };
  return { held: true, availableAt: new Date(dueAt).toISOString(), transformTrace: ["pacing:held"] };
}

export function recordPacingSuccess(lane: PacingLane, policy: ChannelPolicy, now: string = new Date().toISOString()): PacingLane {
  parseTimestamp(now, "now");
  validateLane(lane);
  validatePolicy(policy);
  const successCount = lane.successCount + 1;
  if (successCount < policy.successWindow) return { ...lane, successCount, lastSentAt: now, updatedAt: now };
  return {
    ...lane,
    ratePerMin: Math.min(lane.ratePerMin + policy.additiveStep, policy.maxRatePerMin),
    successCount: 0,
    lastSentAt: now,
    updatedAt: now,
  };
}

export function recordPacingCongestion(input: PacingCongestionInput): PacingLane {
  const now = parseTimestamp(input.now, "now");
  validateLane(input.lane);
  validatePolicy(input.policy);
  if (input.reason.trim() === "") throw new Error("reason must be non-empty");
  if (input.retryAfterSec !== undefined && (!Number.isFinite(input.retryAfterSec) || input.retryAfterSec < 0)) {
    throw new Error("retryAfterSec must be a finite, non-negative number");
  }
  const ratePerMin = Math.max(input.lane.ratePerMin * input.policy.multiplicativeFactor, input.policy.minRatePerMin);
  if (ratePerMin <= 0) throw new Error("reduced rate must be positive");
  const retryAt = now + (input.retryAfterSec ?? 0) * 1000;
  const intervalAt = now + 60_000 / ratePerMin;
  const existingCooldownAt = input.lane.cooldownUntil === null ? now : parseTimestamp(input.lane.cooldownUntil, "cooldownUntil");
  return {
    ...input.lane,
    ratePerMin,
    successCount: 0,
    cooldownUntil: new Date(Math.max(existingCooldownAt, retryAt, intervalAt)).toISOString(),
    lastCongestionReason: input.reason,
    updatedAt: input.now,
  };
}

function laneConstraint(lane: PacingLane, channel: string, policy: ChannelPolicy, now: number): number {
  validateLane(lane);
  let dueAt = now;
  if (lane.cooldownUntil !== null) dueAt = Math.max(dueAt, parseTimestamp(lane.cooldownUntil, "cooldownUntil"));
  if (lane.lastSentAt !== null) {
    const nativeInterval = channel === "weixin" ? Math.max(policy.nativeMinIntervalSec, 30) * 1000 : 0;
    dueAt = Math.max(dueAt, parseTimestamp(lane.lastSentAt, "lastSentAt") + Math.max(60_000 / lane.ratePerMin, nativeInterval));
  }
  return dueAt;
}

function validateLane(lane: PacingLane): void {
  if (!Number.isFinite(lane.ratePerMin) || lane.ratePerMin <= 0) throw new Error("lane ratePerMin must be finite and positive");
  if (!Number.isInteger(lane.successCount) || lane.successCount < 0) throw new Error("lane successCount must be a non-negative integer");
  if (lane.lastSentAt !== null) parseTimestamp(lane.lastSentAt, "lastSentAt");
  if (lane.cooldownUntil !== null) parseTimestamp(lane.cooldownUntil, "cooldownUntil");
}

function validatePolicy(policy: ChannelPolicy): void {
  const fields = [policy.minRatePerMin, policy.maxRatePerMin, policy.additiveStep, policy.multiplicativeFactor, policy.successWindow, policy.nativeMinIntervalSec];
  if (fields.some((value) => !Number.isFinite(value))) throw new Error("channel policy contains a non-finite value");
  if (policy.minRatePerMin <= 0 || policy.maxRatePerMin < policy.minRatePerMin || policy.additiveStep < 0 || policy.successWindow < 1) {
    throw new Error("channel policy has an invalid rate range");
  }
  if (policy.multiplicativeFactor <= 0 || policy.multiplicativeFactor >= 1 || policy.nativeMinIntervalSec < 0) {
    throw new Error("channel policy has an invalid pacing factor");
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z") || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  return parsed;
}
