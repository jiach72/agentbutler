import type { OutboxMessageView } from "@butler/contract";

import type { DndRule } from "./store.js";
import { parseTimestamp } from "./time.js";

export interface DndEvaluationInput {
  message: OutboxMessageView;
  rules: DndRule[];
  now: string;
}

export interface DndEvaluation {
  held: boolean;
  availableAt?: string;
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
    const availableAt = held ? nextInactiveAt(matching, nowMs) : undefined;
    return {
      held,
      ...(availableAt === undefined ? {} : { availableAt }),
      transformTrace: [`dnd:${scope}-${held ? "held" : "inactive"}`],
    };
  }
  return { held: false, transformTrace: ["dnd:none"] };
}

function nextInactiveAt(rules: DndRule[], nowMs: number): string | undefined {
  const candidates = new Set<number>();
  for (const rule of rules) {
    if (rule.pausedUntil === null) continue;
    const pausedUntil = parseTimestamp(rule.pausedUntil, "pausedUntil");
    if (pausedUntil > nowMs) candidates.add(pausedUntil);
  }

  const nextMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset <= 72 * 60; offset += 1) {
    candidates.add(nextMinute + offset * 60_000);
  }

  for (const candidate of [...candidates].sort((a, b) => a - b)) {
    if (candidate <= nowMs) continue;
    if (!rules.some((rule) => isActive(rule, candidate))) return new Date(candidate).toISOString();
  }
  return undefined;
}

function isActive(rule: DndRule, nowMs: number): boolean {
  if (rule.pausedUntil !== null && parseTimestamp(rule.pausedUntil, "pausedUntil") > nowMs) return true;
  if (rule.startMinute === null || rule.endMinute === null) return false;
  const minute = localMinute(nowMs, rule.timeZone);
  if (rule.startMinute === rule.endMinute) return true;
  if (rule.startMinute < rule.endMinute) return minute >= rule.startMinute && minute < rule.endMinute;
  return minute >= rule.startMinute || minute < rule.endMinute;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localMinute(nowMs: number, timeZone: string): number {
  try {
    const parts = getDateTimeFormatter(timeZone).formatToParts(nowMs);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("missing time parts");
    return hour * 60 + minute;
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`);
  }
}
