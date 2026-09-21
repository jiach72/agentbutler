import { z } from "zod";

export const SCHEDULED_TASK_SCHEMA_VERSION = 1;
export const SCHEDULED_TASK_MAX_BODY = 64 * 1024;
export const SCHEDULED_TASK_MAX_RESPONSE = 2 * 1024 * 1024;
export const scheduledTaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/);
const text = (max: number) => z.string().max(max).refine((v) =>
  [...v].every((char) => { const n = char.charCodeAt(0); return n >= 32 && n !== 127 || n === 9 || n === 10 || n === 13; }));
const name = text(120).refine((v) => v.trim().length > 0 && !/[\r\n]/.test(v));
const timestamp = z.string().datetime({ offset: true }).nullable();
const timezone = z.string().min(1).max(80).regex(/^[A-Za-z0-9_+/-]+$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const expression = z.string().max(120).regex(/^[A-Za-z0-9*,/-]+(?: [A-Za-z0-9*,/-]+){4}$/);
export const scheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time, timezone }).strict(),
  z.object({ kind: z.literal("weekdays"), time, timezone }).strict(),
  z.object({ kind: z.literal("weekly"), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((v) => new Set(v).size === v.length), time, timezone }).strict(),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ kind: z.literal("advanced"), expression, timezone }).strict(),
]);
export const scheduledTaskDraftSchema = z.object({
  name,
  prompt: text(16000).refine((v) => v.trim().length > 0),
  schedule: scheduledTaskScheduleSchema,
  delivery: z.object({ enabled: z.boolean() }).strict(),
  advanced: z.object({
    model: z.string().max(160).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*)?$/).optional(),
    skills: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)).max(20).optional(),
    workdir: text(512).refine((v) => v === "" || (v.startsWith("/") && !/[\r\n]/.test(v))).optional(),
  }).strict().optional(),
}).strict();

export const scheduledTaskRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("incidents") }).strict(),
  z.object({ action: z.literal("runs"), id: scheduledTaskIdSchema, limit: z.number().int().min(1).max(500) }).strict(),
  z.object({ action: z.literal("detail"), id: scheduledTaskIdSchema }).strict(),
  z.object({ action: z.literal("preview"), schedule: scheduledTaskScheduleSchema }).strict(),
  z.object({ action: z.literal("create"), requestId, draft: scheduledTaskDraftSchema }).strict(),
  z.object({ action: z.literal("edit"), id: scheduledTaskIdSchema, requestId, draft: scheduledTaskDraftSchema }).strict(),
  z.object({ action: z.literal("pause"), id: scheduledTaskIdSchema, requestId }).strict(),
  z.object({ action: z.literal("resume"), id: scheduledTaskIdSchema, requestId }).strict(),
  z.object({ action: z.literal("run"), id: scheduledTaskIdSchema, requestId }).strict(),
  z.object({ action: z.literal("remove"), id: scheduledTaskIdSchema, requestId, confirmName: name }).strict(),
]);
export type ScheduledTaskDraft = z.infer<typeof scheduledTaskDraftSchema>;
export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>;
export type ScheduledTaskRequest = z.infer<typeof scheduledTaskRequestSchema>;
export type ScheduledTaskAction = ScheduledTaskRequest["action"];

export const scheduledTaskReasons = [
  "unsupported_framework", "bridge_not_configured", "bridge_unreachable", "invalid_response",
  "unsupported_version", "unsupported_scheduler", "invalid_request", "invalid_schedule",
  "timezone_mismatch", "timezone_unknown", "not_found", "not_editable",
  "confirmation_mismatch", "manual_run_not_supported", "backup_failed", "write_failed",
  "outcome_unknown", "idempotency_conflict", "operation_in_progress", "data_unavailable",
  "token_unavailable", "unauthorized", "body_too_large",
] as const;
export type ScheduledTaskReason = typeof scheduledTaskReasons[number];
const reason = z.enum(scheduledTaskReasons);
const base = {
  schemaVersion: z.literal(1), supported: z.boolean(), reachable: z.boolean(), reason: reason.optional(),
  versionExact: z.boolean().optional(),
  driftedFiles: z.array(z.string()).optional(),
  expectedRevision: z.string().optional(),
  detectedRevision: z.string().optional(),
};
// Hermes keeps "delivery_failed" separate: the run succeeded, only the notification did not arrive.
const lastStatus = z.enum(["success", "failed", "delivery_failed", "running", "never", "unknown"]);
export const scheduledTaskSummarySchema = z.object({
  id: scheduledTaskIdSchema, name,
  enabled: z.boolean(), scheduleLabel: text(160),
  nextRunAt: timestamp, lastRunAt: timestamp, lastStatus,
  failureStreak: z.number().int().nonnegative(),
  deliveryEnabled: z.boolean(), editable: z.boolean(),
  editableReason: z.enum(["advanced_job", "unsupported_schedule", "unsupported_delivery", "timezone_unknown"]).optional(),
});
export type ScheduledTaskSummary = z.infer<typeof scheduledTaskSummarySchema>;
const statusSchema = z.object({
  ...base, schedulerRunning: z.boolean().nullable(), activeCount: z.number().int().nonnegative(),
  todayRunCount: z.number().int().nonnegative(), failedTaskCount: z.number().int().nonnegative(),
  nextRunAt: timestamp, heartbeatAgeSeconds: z.number().finite().nonnegative().nullable(),
  timezone: timezone.nullable(), writesSupported: z.boolean(), runSupported: z.boolean(),
  bridgeVersion: z.string().optional(),
  expectedRevision: z.string().optional(),
  detectedRevision: z.string().optional(),
  supervisor: z.enum(["systemd", "launchd", "none", "unavailable"]).optional(),
});
export type ScheduledTaskStatus = z.infer<typeof statusSchema>;
const listSchema = z.object({ ...base, items: z.array(scheduledTaskSummarySchema).max(1000) });
const detailSchema = z.object({
  ...base, editable: z.boolean(), draft: scheduledTaskDraftSchema.nullable(),
});
const runsSchema = z.object({
  ...base, items: z.array(z.object({
    id: scheduledTaskIdSchema, taskId: scheduledTaskIdSchema,
    status: z.enum(["claimed", "running", "completed", "failed", "unknown"]),
    claimedAt: timestamp, startedAt: timestamp, finishedAt: timestamp,
  })).max(500),
});
const incidentsSchema = z.object({
  ...base, items: z.array(z.object({
    id: scheduledTaskIdSchema, taskId: scheduledTaskIdSchema,
    state: z.enum(["detected", "alerted", "resolved", "closed"]),
    failureType: z.enum(["rate_limit", "timeout", "auth", "delivery", "config", "script", "agent", "unknown"]),
    firstSeenAt: timestamp, lastSeenAt: timestamp,
  })).max(1000),
});
const previewSchema = z.object({
  ...base, scheduleLabel: text(160).nullable(), nextRunAt: timestamp, timezone: timezone.nullable(),
});
const mutationSchema = z.object({
  ...base, requestId, taskId: scheduledTaskIdSchema.nullable(),
  outcome: z.enum(["succeeded", "failed", "unknown"]),
  outputSnippet: z.string().max(4000).optional(),
  errorSnippet: z.string().max(4000).optional(),
  durationMs: z.number().nonnegative().optional(),
  exitCode: z.number().int().optional(),
});
export type ScheduledTaskList = z.infer<typeof listSchema>;
export type ScheduledTaskDetail = z.infer<typeof detailSchema>;
export type ScheduledTaskRuns = z.infer<typeof runsSchema>;
export type ScheduledTaskIncidents = z.infer<typeof incidentsSchema>;
export type ScheduledTaskPreview = z.infer<typeof previewSchema>;
export type ScheduledTaskMutation = z.infer<typeof mutationSchema>;
export type ScheduledTaskResponse = ScheduledTaskStatus | ScheduledTaskList | ScheduledTaskDetail |
  ScheduledTaskRuns | ScheduledTaskIncidents | ScheduledTaskPreview | ScheduledTaskMutation;

export function parseScheduledTaskRequest(value: unknown): ScheduledTaskRequest | null {
  const parsed = scheduledTaskRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reconstruct responses from allowlisted fields at every network boundary. */
export function parseScheduledTaskResponse(action: ScheduledTaskAction, value: unknown): ScheduledTaskResponse | null {
  const schema = action === "status" ? statusSchema : action === "list" ? listSchema :
    action === "detail" ? detailSchema : action === "runs" ? runsSchema :
      action === "incidents" ? incidentsSchema : action === "preview" ? previewSchema : mutationSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if ((!data.reachable || !data.supported) && !data.reason) return null;
  if ("outcome" in data && data.outcome === "succeeded" &&
    (!data.supported || !data.reachable || data.reason || !data.taskId)) return null;
  if ("writesSupported" in data && data.writesSupported && (!data.supported || !data.reachable)) return null;
  if ("items" in data && (!data.supported || !data.reachable) && data.items.length !== 0) return null;
  if ("draft" in data && (!data.supported || !data.reachable) && data.draft !== null) return null;
  if ("draft" in data && data.editable !== (data.draft !== null)) return null;
  return data;
}

export function scheduledTaskFailure(
  request: ScheduledTaskRequest, why: ScheduledTaskReason,
  reachable = false, supported = true,
): ScheduledTaskResponse {
  const envelope = { schemaVersion: 1 as const, supported, reachable, reason: why };
  if (request.action === "status") return { ...envelope, schedulerRunning: null, activeCount: 0,
    todayRunCount: 0, failedTaskCount: 0, nextRunAt: null, heartbeatAgeSeconds: null, timezone: null,
    writesSupported: false, runSupported: false };
  if (request.action === "detail") return { ...envelope, editable: false, draft: null };
  if (request.action === "preview") return { ...envelope, scheduleLabel: null, nextRunAt: null, timezone: null };
  if ("requestId" in request) return { ...envelope, requestId: request.requestId, taskId: "id" in request ? request.id : null,
    outcome: ["outcome_unknown", "bridge_unreachable", "invalid_response", "operation_in_progress"].includes(why) ? "unknown" : "failed" };
  return { ...envelope, items: [] };
}

/** Shared strict route decoder. No arbitrary query string or body key is forwarded. */
export function scheduledTaskRouteRequest(
  method: string, url: URL, body: unknown = {},
): ScheduledTaskRequest | null {
  const parts = url.pathname.split("/").slice(3);
  let id: string | undefined;
  try { id = parts[0] ? decodeURIComponent(parts[0]) : undefined; } catch { return null; }
  const query = [...url.searchParams.entries()];
  if (method !== "GET" && query.length) return null;
  if (method === "GET") {
    if (parts.length <= 1 && query.length === 0) {
      return parseScheduledTaskRequest(!id ? { action: "list" } :
        ["status", "incidents"].includes(id) ? { action: id } : { action: "detail", id });
    }
    if (parts.length === 2 && parts[1] === "runs" &&
      query.every(([key]) => key === "limit") && query.length <= 1) {
      const raw = url.searchParams.get("limit") ?? "20";
      if (!/^[1-9]\d{0,2}$/.test(raw)) return null;
      return parseScheduledTaskRequest({ action: "runs", id, limit: Number(raw) });
    }
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) ||
    "action" in body || "id" in body) return null;
  if (method === "POST" && !id && parts.length <= 1) return parseScheduledTaskRequest({ ...body, action: "create" });
  if (method === "POST" && id === "preview" && parts.length === 1) return parseScheduledTaskRequest({ ...body, action: "preview" });
  if (method === "PATCH" && id && parts.length === 1) return parseScheduledTaskRequest({ ...body, action: "edit", id });
  if (method === "DELETE" && id && parts.length === 1) return parseScheduledTaskRequest({ ...body, action: "remove", id });
  if (method === "POST" && id && parts.length === 2 && ["pause", "resume", "run"].includes(parts[1])) {
    return parseScheduledTaskRequest({ ...body, action: parts[1], id });
  }
  return null;
}

export function scheduledTaskHttpStatus(response: ScheduledTaskResponse): number {
  if (!response.reason) return 200;
  if (["invalid_request", "invalid_schedule", "timezone_mismatch", "confirmation_mismatch"].includes(response.reason)) return 400;
  if (response.reason === "not_found") return 404;
  if (["not_editable", "idempotency_conflict", "operation_in_progress", "outcome_unknown"].includes(response.reason)) return 409;
  if ("outcome" in response) return response.reason === "manual_run_not_supported" ? 422 : 503;
  return 200;
}
