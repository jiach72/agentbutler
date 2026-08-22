import { createHash } from "node:crypto";

import type { MessageDecision, OutboxMessageView, TaskEvent } from "@butler/contract";

import { buildProgressDigest } from "./digest.js";
import { evaluateDnd } from "./dnd.js";
import { evaluatePacing } from "./pacing.js";
import type { DndRule, PacingLane } from "./store.js";
import { validateMessagePolicy } from "./config.js";
import type { MessagePolicyConfig } from "./types.js";

export interface OutboundPolicyInput {
  message: OutboxMessageView;
  holder?: OutboxMessageView;
  taskEvents: TaskEvent[];
  dndRules: DndRule[];
  channelLane: PacingLane;
  chatLane: PacingLane;
  now: string;
  config: MessagePolicyConfig;
}

export interface OutboundPolicyResult {
  decision: MessageDecision;
  companionDecisions: MessageDecision[];
}

export function decideOutboundPolicy(input: OutboundPolicyInput): OutboundPolicyResult {
  validateMessagePolicy(input.config);
  if (input.message.transport !== "queued-push") {
    return { decision: makeDecision(input.message, input.config.version, "policy_error", ["policy:reject-non-queued-push"], "inline response is not an asynchronous candidate"), companionDecisions: [] };
  }
  const channelPolicy = input.config.channels[input.message.channel];
  if (channelPolicy === undefined) {
    return { decision: makeDecision(input.message, input.config.version, "policy_error", ["policy:unknown-channel"], "channel has no policy"), companionDecisions: [] };
  }

  const digest = buildProgressDigest({ holder: input.holder, incoming: input.message, events: input.taskEvents, config: input.config.digest });
  const companionDecisions: MessageDecision[] = [];
  if (digest.accepted && digest.absorbHolder && input.holder !== undefined) {
    companionDecisions.push(makeDecision(input.holder, input.config.version, "absorbed", digest.transformTrace, "progress holder absorbed"));
  }
  if (digest.accepted && digest.absorbIncoming) {
    return { decision: makeDecision(input.message, input.config.version, "absorbed", digest.transformTrace, "duplicate progress absorbed"), companionDecisions };
  }

  const trace = ["policy:queued-push", ...(digest.accepted ? digest.transformTrace : [])];
  const optimizedContent = digest.content;
  if (input.message.metadata.solicitedReply === true) {
    return {
      decision: makeDecision(input.message, input.config.version, "ready", [...trace, "dnd:bypass-solicited-reply", "pacing:bypass-solicited-reply"], "solicited reply", optimizedContent),
      companionDecisions,
    };
  }

  const dnd = evaluateDnd({ message: input.message, rules: input.dndRules, now: input.now });
  trace.push(...dnd.transformTrace);
  if (dnd.held) return { decision: makeDecision(input.message, input.config.version, "held_dnd", trace, "DND rule is active", optimizedContent), companionDecisions };

  const pacing = evaluatePacing({ message: input.message, channelLane: input.channelLane, chatLane: input.chatLane, policy: channelPolicy, now: input.now });
  trace.push(...pacing.transformTrace);
  if (pacing.held) return { decision: makeDecision(input.message, input.config.version, "held_pacing", trace, "pacing constraint", optimizedContent, pacing.availableAt), companionDecisions };
  return { decision: makeDecision(input.message, input.config.version, "ready", trace, "ready for delivery", optimizedContent), companionDecisions };
}

function makeDecision(
  message: OutboxMessageView,
  policyVersion: string,
  state: MessageDecision["state"],
  transformTrace: string[],
  reason: string,
  optimizedContent?: string,
  availableAt?: string,
): MessageDecision {
  const semantic = {
    messageId: message.messageId,
    expectedContentSha256: message.contentSha256,
    policyVersion,
    state,
    availableAt: availableAt ?? null,
    optimizedContent: optimizedContent ?? null,
    transformTrace,
  };
  const decisionId = createHash("sha256").update(JSON.stringify(canonicalize(semantic)), "utf8").digest("hex");
  return {
    decisionId,
    messageId: message.messageId,
    expectedContentSha256: message.contentSha256,
    state,
    ...(availableAt === undefined ? {} : { availableAt }),
    ...(optimizedContent === undefined ? {} : { optimizedContent }),
    transformTrace,
    policyVersion,
    reason,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}
