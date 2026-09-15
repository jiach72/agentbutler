import type { OutboxState } from "@butler/contract";
import type { MessageItemView, MessageOverviewPayload, MessageStateFilter } from "./helpers.js";

export const ACTIONABLE_MESSAGE_STATES = [
  "dead_letter",
  "policy_error",
  "delivery_unknown",
] as const satisfies readonly OutboxState[];

export function isActionableMessage(message: Pick<MessageItemView, "state">): boolean {
  return ACTIONABLE_MESSAGE_STATES.some((state) => state === message.state);
}

export function messageSummary(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text || "（空消息内容）";
}

/** Query each actionable state before limiting, so delivered history cannot crowd out failures. */
export async function loadMessageOverview(
  fetch: (url: string) => Promise<MessageOverviewPayload | null>,
  pending: boolean,
  filter: MessageStateFilter,
): Promise<MessageOverviewPayload | null> {
  const states = pending ? ACTIONABLE_MESSAGE_STATES : [filter];
  const results = await Promise.all(
    states.map((state) =>
      fetch(`/api/messages/overview?limit=60${state === "all" ? "" : `&state=${state}`}`),
    ),
  );
  if (results.some((result) => result === null)) return null;
  const first = results[0]!;
  const items = [
    ...new Map(
      results
        .flatMap((result) => result!.messages.items)
        .filter((item) => !pending || isActionableMessage(item))
        .map((item) => [item.messageId, item]),
    ).values(),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    ...first,
    reachable: results.every((result) => result!.reachable),
    degraded: [...new Set(results.flatMap((result) => result!.degraded))],
    messages: { counts: first.messages.counts, items },
  };
}

export interface PendingMessageApproval {
  id: string;
  title: string;
  kind: string;
  status: string;
  remainingMs: number;
  escalateRequired: boolean;
}

export interface PendingMessageApprovals {
  items: PendingMessageApproval[];
  summary: { pending: number };
}

export function actionableApprovals(items: PendingMessageApproval[]): PendingMessageApproval[] {
  return items.filter((item) => item.status === "pending" && item.remainingMs > 0);
}
