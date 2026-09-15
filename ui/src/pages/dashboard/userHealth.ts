import { deriveUserHealthSummary, isInstanceOnline, type CapabilityHealth, type HealthAlertInput, type UserHealthInput } from "@butler/contract";
import type { DashboardPayload, MessageStatusPayload } from "./types.js";

export interface HealthConnections {
  reachable: boolean;
  connections?: Array<{ instanceId: string; state: string; connected: boolean; displayName?: string }>;
}

export interface HealthSources {
  dashboard: DashboardPayload | null;
  connections: HealthConnections | null;
  messageStatus: MessageStatusPayload | null;
  alerts: { reachable: boolean; items?: HealthAlertInput[] } | null;
  approvals: { reachable?: boolean; summary?: { pending: number }; items?: Array<{ status: string }> } | null;
  observedAt: string;
}

function checkHealth(statuses: Array<string | null>): CapabilityHealth {
  if (statuses.some((status) => status === "fail")) return "unavailable";
  if (statuses.some((status) => status === "warn")) return "degraded";
  if (statuses.length > 0 && statuses.every((status) => status === "pass")) return "available";
  return "unknown";
}

/** Normalize existing read endpoints once for both surfaces and server parity tests. */
export function buildUserHealthInput(sources: HealthSources): UserHealthInput {
  const { dashboard, connections, messageStatus, alerts, approvals } = sources;
  const byId = new Map(connections?.reachable ? (connections.connections ?? []).map((item) => [item.instanceId, item]) : []);
  const instances = dashboard === null || connections?.reachable !== true ? null
    : (dashboard.instances ?? []).map((instance) => ({
      instanceId: instance.instanceId,
      state: instance.state,
      connected: byId.get(instance.instanceId)?.connected ?? null,
    }));
  // Connections may discover an instance before the dashboard lifecycle snapshot.
  if (instances !== null) {
    for (const connection of byId.values()) {
      if (!instances.some((item) => item.instanceId === connection.instanceId)) instances.push({
        instanceId: connection.instanceId, state: connection.state, connected: connection.connected,
      });
    }
  }
  const inspections = dashboard?.latestInspections ?? [];
  const memoryChecks: Array<string | null> = inspections.flatMap((inspection) => inspection.checks.filter((check) =>
    ["memory", "memory-probe", "critical-memory-probe"].includes(check.id)).map((check) => check.status));
  const modelChecks: Array<string | null> = inspections.flatMap((inspection) => inspection.checks.filter((check) =>
    ["model", "llm-probe", "model-probe"].includes(check.id)).map((check) => check.status));
  const probe = dashboard?.inspectStatus?.criticalProbe;
  if (probe !== undefined && probe.lastStatus !== "skipped") memoryChecks.push(probe.lastStatus);
  for (const instance of instances ?? []) {
    const inspection = inspections.find((item) => item.instanceId === instance.instanceId);
    if (!inspection?.checks.some((check) => ["model", "llm-probe", "model-probe"].includes(check.id))) modelChecks.push(null);
    if (!inspection?.checks.some((check) => ["memory", "memory-probe", "critical-memory-probe"].includes(check.id))
      && (instances!.length !== 1 || probe === undefined)) memoryChecks.push(null);
  }
  const memory = probe?.overdue && checkHealth(memoryChecks) !== "unavailable" ? "degraded" : checkHealth(memoryChecks);
  const bridge = messageStatus?.reachable ? messageStatus.status?.bridge : null;
  const counts = messageStatus?.reachable ? messageStatus.status?.counts : null;
  const pending = approvals?.reachable === false || approvals === null ? null
    : approvals.summary?.pending ?? (approvals.items ? approvals.items.filter((item) => item.status === "pending").length : null);
  return {
    observedAt: sources.observedAt,
    instances,
    alerts: alerts?.reachable === true ? alerts.items ?? null : null,
    pendingApprovals: pending,
    messages: {
      connected: bridge ? bridge.connected && bridge.attached && bridge.outboxWritable : null,
      failed: counts ? counts["failed"] ?? 0 : null,
      unknown: counts ? counts["delivery_unknown"] ?? 0 : null,
    },
    model: checkHealth(modelChecks),
    memory,
  };
}

export function deriveHealthView(sources: HealthSources) {
  const input = buildUserHealthInput(sources);
  return {
    input,
    health: deriveUserHealthSummary(input),
    onlineInstances: input.instances?.filter(isInstanceOnline).length ?? null,
    totalInstances: input.instances?.length ?? null,
  };
}

export function capabilityLabel(state: CapabilityHealth): string {
  return { available: "可用", degraded: "需要留意", unavailable: "不可用", unknown: "待确认" }[state];
}
