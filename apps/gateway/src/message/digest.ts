import type { OutboxMessageView, TaskEvent } from "@butler/contract";

import type { MessagePolicyConfig } from "./types.js";

export interface ProgressDigestInput {
  holder?: OutboxMessageView;
  incoming: OutboxMessageView;
  events: TaskEvent[];
  config: MessagePolicyConfig["digest"];
}

export interface ProgressDigestResult {
  accepted: boolean;
  content?: string;
  transformTrace: string[];
  absorbHolder: boolean;
  absorbIncoming: boolean;
  holderMessageId?: string;
}

const POLICY_ACTIVE_HOLDER_STATES = new Set([
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "retry_wait",
]);

export function buildProgressDigest(input: ProgressDigestInput): ProgressDigestResult {
  const { incoming, config } = input;
  const isNoRunBatch = incoming.channel === "weixin" && isNoRunBatchable(incoming);
  const terminalHolder =
    input.holder !== undefined &&
    (input.holder.messageKind === "final" || input.holder.messageKind === "failure") &&
    ["delivered", "delivering", "delivery_unknown", "absorbed", "dead_letter"].includes(
      input.holder.state,
    )
      ? input.holder
      : undefined;
  const holder =
    input.holder !== undefined &&
    (POLICY_ACTIVE_HOLDER_STATES.has(input.holder.state) || terminalHolder !== undefined)
      ? input.holder
      : undefined;
  if (!isProgressOrFinal(incoming) && !isNoRunBatch) return declined("digest:declined-no-run");
  if (!isNoRunBatch && (typeof incoming.runId !== "string" || incoming.runId === ""))
    return declined("digest:declined-no-run");
  if (
    holder !== undefined &&
    (!sameGroup(holder, incoming) ||
      (isNoRunBatch && !withinWindow(holder, incoming, config.windowSec)))
  ) {
    return declined("digest:declined-unrelated");
  }

  if (isNoRunBatch) {
    const trace = ["digest:batch-aggregated"];
    if (holder !== undefined && isEarlier(holder, incoming)) {
      trace.push("digest:batch-duplicate-absorbed");
      return {
        accepted: true,
        content: `${holder.content}\n${incoming.content}`.trim(),
        transformTrace: trace,
        absorbHolder: false,
        absorbIncoming: true,
        holderMessageId: holder.messageId,
      };
    }
    return {
      accepted: true,
      content: incoming.content,
      transformTrace: trace,
      absorbHolder: false,
      absorbIncoming: false,
    };
  }

  const trace = ["digest:aggregated"];
  const events = orderedEvents(input.events, incoming.runId!, config.maxItems);
  if (events.deduped) trace.push("digest:events-deduped");
  if (events.itemTruncated) trace.push("digest:truncated");

  let absorbHolder = false;
  let absorbIncoming = false;
  let holderMessageId = holder?.messageId;
  if (
    holder !== undefined &&
    (holder.messageKind === "final" || holder.messageKind === "failure") &&
    (incoming.messageKind === "final" || incoming.messageKind === "failure") &&
    (isEarlier(holder, incoming) || isEarlier(incoming, holder))
  ) {
    if (isEarlier(holder, incoming) && POLICY_ACTIVE_HOLDER_STATES.has(holder.state)) {
      absorbHolder = true;
      holderMessageId = incoming.messageId;
      trace.push("digest:terminal-latest-promoted");
    } else {
      absorbIncoming = true;
      trace.push(
        isEarlier(holder, incoming)
          ? "digest:terminal-duplicate-absorbed"
          : "digest:terminal-older-absorbed",
      );
    }
  } else if (
    holder?.messageKind === "task-progress" &&
    incoming.messageKind === "final" &&
    config.finalAbsorbsPendingProgress
  ) {
    absorbHolder = true;
    trace.push("digest:final-absorbed");
  } else if (holder?.messageKind === "task-progress" && incoming.messageKind === "task-progress") {
    if (isEarlier(holder, incoming)) {
      absorbIncoming = true;
      trace.push("digest:duplicate-absorbed");
    } else {
      absorbHolder = true;
      holderMessageId = incoming.messageId;
      trace.push("digest:duplicate-absorbed");
    }
  }

  if (incoming.messageKind !== "task-progress") {
    return { accepted: true, transformTrace: trace, absorbHolder, absorbIncoming, holderMessageId };
  }

  const rendered = renderDigest(incoming.runId!, events.events);
  const content = clampUtf16(rendered, config.maxChars);
  if (content !== rendered && !trace.includes("digest:truncated")) trace.push("digest:truncated");
  return {
    accepted: true,
    content,
    transformTrace: trace,
    absorbHolder,
    absorbIncoming,
    holderMessageId,
  };
}

function declined(trace: string): ProgressDigestResult {
  return { accepted: false, transformTrace: [trace], absorbHolder: false, absorbIncoming: false };
}

function isProgressOrFinal(message: OutboxMessageView): boolean {
  return (
    message.messageKind === "task-progress" ||
    message.messageKind === "final" ||
    message.messageKind === "failure"
  );
}

function isNoRunBatchable(message: OutboxMessageView): boolean {
  return (
    (message.runId === undefined || message.runId === null) &&
    (message.messageKind === "system" ||
      message.messageKind === "alert" ||
      message.metadata.proactive === true)
  );
}

function sameGroup(a: OutboxMessageView, b: OutboxMessageView): boolean {
  const sameRun =
    (a.runId === undefined || a.runId === null) && (b.runId === undefined || b.runId === null)
      ? true
      : a.runId === b.runId;
  return (
    a.instanceId === b.instanceId && a.channel === b.channel && a.chatId === b.chatId && sameRun
  );
}

function isEarlier(a: OutboxMessageView, b: OutboxMessageView): boolean {
  return a.sequence < b.sequence || (a.sequence === b.sequence && a.messageId <= b.messageId);
}

function withinWindow(a: OutboxMessageView, b: OutboxMessageView, windowSec: number): boolean {
  const aTime = Date.parse(a.capturedAt);
  const bTime = Date.parse(b.capturedAt);
  return (
    Number.isFinite(aTime) &&
    Number.isFinite(bTime) &&
    Math.abs(aTime - bTime) <= Math.max(0, windowSec) * 1_000
  );
}

function orderedEvents(
  events: TaskEvent[],
  runId: string,
  maxItems: number,
): { events: TaskEvent[]; deduped: boolean; itemTruncated: boolean } {
  const sorted = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.runId === runId)
    .sort((a, b) => a.event.sequence - b.event.sequence || a.index - b.index);
  const seen = new Set<number>();
  const unique = sorted.filter(({ event }) => {
    if (seen.has(event.sequence)) return false;
    seen.add(event.sequence);
    return true;
  });
  const bounded = unique.slice(Math.max(0, unique.length - Math.max(0, Math.floor(maxItems))));
  return {
    events: bounded.map(({ event }) => event),
    deduped: unique.length !== sorted.length,
    itemTruncated: bounded.length !== unique.length,
  };
}

function renderDigest(runId: string, events: TaskEvent[]): string {
  const progress = events.filter((event) => event.kind === "progress");
  const current = progress.at(-1) ?? events.at(-1);
  const completed = [...events.filter((event) => event.kind === "done"), ...progress.slice(0, -1)]
    .map((event) => event.summary)
    .filter((summary): summary is string => summary !== undefined && summary !== "")
    .slice(0, 4);
  const failures = events
    .filter((event) => event.kind === "failed")
    .map((event) => event.summary)
    .filter((summary): summary is string => summary !== undefined && summary !== "");
  const lines = [`任务 ${runId.slice(0, 8)}`];
  if (completed.length > 0) lines.push(`已完成：${completed.join("、")}`);
  if (current?.summary !== undefined && current.summary !== "")
    lines.push(`进行中：${current.summary}`);
  if (failures.length > 0) lines.push(`失败：${failures.join("、")}`);
  if (current?.etaSec !== undefined) lines.push(`预计剩余：${current.etaSec}秒`);
  return lines.join("\n");
}

function clampUtf16(value: string, maxChars: number): string {
  const maximum = Math.max(0, Math.floor(maxChars));
  if (value.length <= maximum) return value;
  if (maximum === 0) return "";
  if (maximum === 1) return "…";
  return `${value.slice(0, maximum - 1)}…`;
}
