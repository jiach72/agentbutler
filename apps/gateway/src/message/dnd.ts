import type { OutboxMessageView } from "@butler/contract";

import type { DndRule } from "./store.js";

export interface DndEvaluationInput {
  message: OutboxMessageView;
  rules: DndRule[];
  now: string;
}

export interface DndEvaluation {
  held: boolean;
  transformTrace: string[];
}

export function evaluateDnd(input: DndEvaluationInput): DndEvaluation {
  const { message, now } = input;
  const nowMs = parseTimestamp(now, "now");
  if (message.metadata.solicitedReply === true) return { held: false, transformTrace: ["dnd:bypass-solicited-reply"] };
  if (message.messageKind === "failure") return { held: false, transformTrace: ["dnd:bypass-failure"] };
  if (message.priority === "urgent") return { held: false, transformTrace: ["dnd:bypass-urgent"] };

  const scopes: Array<["session" | "channel" | "global", string | null]> = [
    ["session", `${message.channel}:${message.chatId}`],
    ["channel", message.channel],
    ["global", null],
  ];
  for (const [scope, scopeKey] of scopes) {
    const matching = input.rules.filter((rule) => rule.enabled && rule.scope === scope && rule.scopeKey === scopeKey);
    if (matching.length === 0) continue;
    const held = matching.some((rule) => isActive(rule, nowMs));
    return { held, transformTrace: [`dnd:${scope}-${held ? "held" : "inactive"}`] };
  }
  return { held: false, transformTrace: ["dnd:none"] };
}

function isActive(rule: DndRule, nowMs: number): boolean {
  if (rule.pausedUntil !== null && parseTimestamp(rule.pausedUntil, "pausedUntil") > nowMs) return true;
  if (rule.startMinute === null || rule.endMinute === null) return false;
  const minute = localMinute(nowMs, rule.timeZone);
  if (rule.startMinute === rule.endMinute) return true;
  if (rule.startMinute < rule.endMinute) return minute >= rule.startMinute && minute < rule.endMinute;
  return minute >= rule.startMinute || minute < rule.endMinute;
}

function localMinute(nowMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("missing time parts");
    return hour * 60 + minute;
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`);
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z") || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
  return parsed;
}
