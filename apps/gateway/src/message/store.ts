import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isOutboxState, MESSAGE_KINDS, TASK_EVENT_KINDS } from "@butler/contract";
import type {
  InboundEnvelope,
  MessageDecision,
  OutboxChangeBatch,
  OutboxMessageView,
  OutboxState,
  PolicySnapshot,
  TaskEvent,
} from "@butler/contract";

import { createPolicySnapshot } from "./config.js";
import type { MessagePolicyConfig } from "./types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS bridge_cursors (
  instance_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_projection (
  message_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  bridge_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  available_at TEXT,
  content_sha256 TEXT NOT NULL,
  decision_id TEXT,
  pending_decision_json TEXT,
  last_policy_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_projection (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events_projection (
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, event_sequence)
);
CREATE TABLE IF NOT EXISTS inbound_projection (
  inbound_message_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dnd_rules (
  rule_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT,
  time_zone TEXT NOT NULL,
  start_minute INTEGER,
  end_minute INTEGER,
  paused_until TEXT,
  enabled INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pacing_lanes (
  lane_key TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id TEXT,
  rate_per_min REAL NOT NULL,
  success_count INTEGER NOT NULL,
  cooldown_until TEXT,
  last_sent_at TEXT,
  last_congestion_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prewarm_cache (
  channel TEXT PRIMARY KEY,
  warmed INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT,
  detail TEXT
);
`;

const ALL_OUTBOX_STATES: readonly OutboxState[] = [
  "captured",
  "policy_pending",
  "held_dnd",
  "held_pacing",
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "delivery_unknown",
  "absorbed",
  "policy_error",
  "dead_letter",
  "cancelled",
];
const DECISION_STATES = new Set(["held_dnd", "held_pacing", "ready", "absorbed", "policy_error", "cancelled"]);
const TRANSPORT_CLASSES = new Set(["queued-push", "inline-response"]);
const MESSAGE_PRIORITIES = new Set(["urgent", "normal", "low"]);
const DND_SCOPES = new Set(["global", "channel", "session"]);

export interface ProjectedMessageView extends OutboxMessageView {
  decisionId: string | null;
  lastPolicyError: string | null;
  updatedAt: string;
}

export interface TaskProjectionView {
  runId: string;
  sessionId: string;
  state: string;
  lastEventSequence: number;
  updatedAt: string;
  events: TaskEvent[];
}

export type DndScope = "global" | "channel" | "session" | (string & {});

export interface DndRule {
  ruleId: string;
  scope: DndScope;
  scopeKey: string | null;
  timeZone: string;
  startMinute: number | null;
  endMinute: number | null;
  pausedUntil: string | null;
  enabled: boolean;
  source: string;
  updatedAt: string;
}

export type DndRuleInput = Omit<DndRule, "updatedAt"> & { updatedAt?: string };

export interface PacingLane {
  laneKey: string;
  channel: string;
  chatId: string | null;
  ratePerMin: number;
  successCount: number;
  cooldownUntil: string | null;
  lastSentAt: string | null;
  lastCongestionReason: string | null;
  updatedAt: string;
}

export type PacingLaneInput = Omit<PacingLane, "updatedAt"> & { updatedAt?: string };

export interface PrewarmCacheEntry {
  channel: string;
  warmed: boolean;
  checkedAt: string;
  expiresAt: string | null;
  detail: string | null;
}

/**
 * Butler's durable read model of the authoritative WSL Bridge outbox.
 * It never originates messages; reconciliation writes Bridge observations here first.
 */
export class MessagePolicyStore {
  readonly dbFile: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(DDL);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  cursor(instanceId: string): number {
    const row = this.db
      .prepare("SELECT sequence FROM bridge_cursors WHERE instance_id = ?")
      .get(instanceId) as Record<string, unknown> | undefined;
    return row === undefined ? 0 : Number(row["sequence"]);
  }

  /** Applies an ordered Bridge delta and advances its cursor only after all projections are durable. */
  ingestBatch(batch: OutboxChangeBatch, explicitInstanceId?: string): void {
    validateBatch(batch);

    const instanceId = this.resolveBatchInstanceId(batch, explicitInstanceId);
    if (instanceId === undefined) {
      // An empty no-op batch has no instance identifier in the protocol and changes no durable state.
      return;
    }

    this.withImmediateTransaction(() => {
      const durableCursor = this.cursor(instanceId);
      if (batch.nextSequence <= durableCursor) return;
      if (batch.afterSequence !== durableCursor) {
        throw new Error(
          `bridge cursor mismatch for ${instanceId}: durable=${durableCursor}, batch.after=${batch.afterSequence}`,
        );
      }

      const now = new Date().toISOString();
      for (const item of batch.items) {
        this.upsertMessage(item, undefined, now);
      }
      for (const inbound of batch.inbound) {
        this.upsertInbound(inbound);
      }

      const affectedRuns = new Set<string>();
      const insertTaskEvent = this.db.prepare(
        `INSERT OR IGNORE INTO task_events_projection (run_id, event_sequence, payload_json)
         VALUES (?, ?, ?)`,
      );
      for (const event of batch.taskEvents) {
        insertTaskEvent.run(event.runId, event.sequence, JSON.stringify(event));
        affectedRuns.add(event.runId);
      }
      for (const runId of affectedRuns) {
        this.rebuildTaskProjection(runId, now);
      }

      this.db
        .prepare(
          `INSERT INTO bridge_cursors (instance_id, sequence) VALUES (?, ?)
           ON CONFLICT(instance_id) DO UPDATE SET sequence = excluded.sequence`,
        )
        .run(instanceId, batch.nextSequence);
    });
  }

  listPolicyCandidates(now: string = new Date().toISOString()): ProjectedMessageView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM message_projection
         WHERE state IN ('captured', 'policy_pending', 'ready')
            OR (state IN ('held_dnd', 'held_pacing', 'retry_wait') AND available_at IS NOT NULL AND available_at <= ?)
         ORDER BY bridge_sequence ASC, instance_id ASC, message_id ASC`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map((row) => this.mapMessage(row));
  }

  /** Records one Bridge response and its replay identifier atomically. */
  updateRemoteView(row: OutboxMessageView, decisionId?: string): void {
    validateOutboxMessage(row);
    if (decisionId !== undefined) requireNonEmptyString(decisionId, "decisionId");
    this.withImmediateTransaction(() => {
      const pending = this.pendingDecision(row.messageId);
      const clearsPending = decisionId !== undefined && pending?.decisionId === decisionId;
      this.upsertMessage(row, decisionId, new Date().toISOString(), clearsPending);
    });
  }

  /** Persists the exact Bridge request before the worker performs the HTTP call. */
  stageDecision(messageId: string, decision: MessageDecision): void {
    requireNonEmptyString(messageId, "messageId");
    validateMessageDecision(decision);
    if (decision.messageId !== messageId) {
      throw new Error(`decision messageId ${decision.messageId} does not match ${messageId}`);
    }
    if (decision.decisionId.trim() === "") {
      throw new Error("decisionId must be non-empty");
    }
    const serialized = JSON.stringify(canonicalize(decision));

    this.withImmediateTransaction(() => {
      const pending = this.pendingDecision(messageId);
      if (pending !== undefined && JSON.stringify(canonicalize(pending)) !== serialized) {
        throw new Error(`message ${messageId} already has a different pending decision`);
      }
      const result = this.db
        .prepare(
          `UPDATE message_projection
           SET decision_id = ?, pending_decision_json = ?, updated_at = ?
           WHERE message_id = ?`,
        )
        .run(decision.decisionId, serialized, new Date().toISOString(), messageId);
      if (Number(result.changes) !== 1) {
        throw new Error(`cannot stage a decision for unknown message ${messageId}`);
      }
    });
  }

  pendingDecision(messageId: string): MessageDecision | undefined {
    const row = this.db
      .prepare("SELECT pending_decision_json FROM message_projection WHERE message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    const payload = row?.["pending_decision_json"] as string | null | undefined;
    return payload === null || payload === undefined ? undefined : (JSON.parse(payload) as MessageDecision);
  }

  clearPendingDecision(messageId: string): void {
    this.withImmediateTransaction(() => {
      this.db
        .prepare("UPDATE message_projection SET pending_decision_json = NULL, updated_at = ? WHERE message_id = ?")
        .run(new Date().toISOString(), messageId);
    });
  }

  savePolicy(policy: MessagePolicyConfig | PolicySnapshot): PolicySnapshot {
    const snapshot = this.canonicalPolicySnapshot(policy);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO message_policy (singleton, version, sha256, payload_json, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           version = excluded.version,
           sha256 = excluded.sha256,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(snapshot.version, snapshot.sha256, JSON.stringify(snapshot.payload), now);
    return snapshot;
  }

  loadPolicy(): PolicySnapshot | undefined {
    const row = this.db
      .prepare("SELECT version, sha256, payload_json FROM message_policy WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;

    const snapshot = this.canonicalPolicySnapshot(JSON.parse(String(row["payload_json"])) as MessagePolicyConfig);
    if (snapshot.version !== String(row["version"]) || snapshot.sha256 !== String(row["sha256"])) {
      throw new Error("stored message policy failed canonical hash validation");
    }
    return snapshot;
  }

  upsertDndRule(rule: DndRuleInput): DndRule {
    validateDndRule(rule);
    const saved: DndRule = { ...rule, updatedAt: rule.updatedAt ?? new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO dnd_rules (
           rule_id, scope, scope_key, time_zone, start_minute, end_minute, paused_until, enabled, source, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           scope = excluded.scope,
           scope_key = excluded.scope_key,
           time_zone = excluded.time_zone,
           start_minute = excluded.start_minute,
           end_minute = excluded.end_minute,
           paused_until = excluded.paused_until,
           enabled = excluded.enabled,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(
        saved.ruleId,
        saved.scope,
        saved.scopeKey,
        saved.timeZone,
        saved.startMinute,
        saved.endMinute,
        saved.pausedUntil,
        saved.enabled ? 1 : 0,
        saved.source,
        saved.updatedAt,
      );
    return saved;
  }

  resolveDndRules(): DndRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dnd_rules
         WHERE enabled = 1
         ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'channel' THEN 1 WHEN 'session' THEN 2 ELSE 3 END, rule_id ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapDndRule(row));
  }

  getPacingLane(laneKey: string): PacingLane | undefined {
    const row = this.db.prepare("SELECT * FROM pacing_lanes WHERE lane_key = ?").get(laneKey) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapPacingLane(row);
  }

  savePacingLane(lane: PacingLaneInput): PacingLane {
    validatePacingLane(lane);
    const saved: PacingLane = { ...lane, updatedAt: lane.updatedAt ?? new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO pacing_lanes (
           lane_key, channel, chat_id, rate_per_min, success_count, cooldown_until,
           last_sent_at, last_congestion_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane_key) DO UPDATE SET
           channel = excluded.channel,
           chat_id = excluded.chat_id,
           rate_per_min = excluded.rate_per_min,
           success_count = excluded.success_count,
           cooldown_until = excluded.cooldown_until,
           last_sent_at = excluded.last_sent_at,
           last_congestion_reason = excluded.last_congestion_reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        saved.laneKey,
        saved.channel,
        saved.chatId,
        saved.ratePerMin,
        saved.successCount,
        saved.cooldownUntil,
        saved.lastSentAt,
        saved.lastCongestionReason,
        saved.updatedAt,
      );
    return saved;
  }

  getPrewarm(channel: string): PrewarmCacheEntry | undefined {
    const row = this.db.prepare("SELECT * FROM prewarm_cache WHERE channel = ?").get(channel) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapPrewarm(row);
  }

  savePrewarm(entry: PrewarmCacheEntry): PrewarmCacheEntry {
    validatePrewarmCacheEntry(entry);
    this.db
      .prepare(
        `INSERT INTO prewarm_cache (channel, warmed, checked_at, expires_at, detail)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel) DO UPDATE SET
           warmed = excluded.warmed,
           checked_at = excluded.checked_at,
           expires_at = excluded.expires_at,
           detail = excluded.detail`,
      )
      .run(entry.channel, entry.warmed ? 1 : 0, entry.checkedAt, entry.expiresAt, entry.detail);
    return entry;
  }

  taskView(runId: string): TaskProjectionView | undefined {
    const row = this.db.prepare("SELECT * FROM task_projection WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    const eventRows = this.db
      .prepare(
        `SELECT payload_json FROM task_events_projection
         WHERE run_id = ? ORDER BY event_sequence ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return {
      runId: String(row["run_id"]),
      sessionId: String(row["session_id"]),
      state: String(row["state"]),
      lastEventSequence: Number(row["last_event_sequence"]),
      updatedAt: String(row["updated_at"]),
      events: eventRows.map((event) => JSON.parse(String(event["payload_json"])) as TaskEvent),
    };
  }

  messageView(messageId: string): ProjectedMessageView | undefined {
    const row = this.db.prepare("SELECT * FROM message_projection WHERE message_id = ?").get(messageId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapMessage(row);
  }

  counts(): Record<OutboxState, number> {
    const counts = Object.fromEntries(ALL_OUTBOX_STATES.map((state) => [state, 0])) as Record<OutboxState, number>;
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS count FROM message_projection GROUP BY state")
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const state = String(row["state"]) as OutboxState;
      if (state in counts) counts[state] = Number(row["count"]);
    }
    return counts;
  }

  private resolveBatchInstanceId(batch: OutboxChangeBatch, explicitInstanceId?: string): string | undefined {
    const ids = new Set<string>();
    for (const item of batch.items) ids.add(item.instanceId);
    for (const inbound of batch.inbound) ids.add(inbound.instanceId);
    if (ids.size > 1) throw new Error("a Bridge batch must contain exactly one instance");
    if (explicitInstanceId !== undefined) {
      requireNonEmptyString(explicitInstanceId, "instanceId");
      if (ids.size === 1 && ids.values().next().value !== explicitInstanceId) {
        throw new Error(`explicit instanceId ${explicitInstanceId} does not match the batch envelope`);
      }
      return explicitInstanceId;
    }
    if (ids.size === 1) return ids.values().next().value as string;

    if (batch.nextSequence === batch.afterSequence && batch.items.length === 0 && batch.taskEvents.length === 0 && batch.inbound.length === 0) {
      return undefined;
    }

    const candidates = this.db
      .prepare("SELECT instance_id FROM bridge_cursors WHERE sequence = ?")
      .all(batch.afterSequence) as Record<string, unknown>[];
    if (candidates.length === 1) return String(candidates[0]["instance_id"]);
    throw new Error("cannot determine Bridge instance for a non-empty batch without a message or inbound envelope");
  }

  private upsertMessage(
    row: OutboxMessageView,
    decisionId: string | undefined,
    updatedAt: string,
    clearPendingDecision = false,
  ): void {
    this.db
      .prepare(
        `INSERT INTO message_projection (
           message_id, instance_id, bridge_sequence, payload_json, state, available_at,
           content_sha256, decision_id, pending_decision_json, last_policy_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           instance_id = excluded.instance_id,
           bridge_sequence = excluded.bridge_sequence,
           payload_json = excluded.payload_json,
           state = excluded.state,
           available_at = excluded.available_at,
           content_sha256 = excluded.content_sha256,
           decision_id = COALESCE(excluded.decision_id, message_projection.decision_id),
           pending_decision_json = CASE WHEN ? = 1 THEN NULL ELSE message_projection.pending_decision_json END,
           last_policy_error = excluded.last_policy_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.messageId,
        row.instanceId,
        row.sequence,
        JSON.stringify(row),
        row.state,
        row.availableAt,
        row.contentSha256,
        decisionId ?? null,
        null,
        row.state === "policy_error" ? row.lastError : null,
        updatedAt,
        clearPendingDecision ? 1 : 0,
      );
  }

  private upsertInbound(inbound: InboundEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO inbound_projection (inbound_message_id, payload_json) VALUES (?, ?)
         ON CONFLICT(inbound_message_id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(inbound.inboundMessageId, JSON.stringify(inbound));
  }

  private rebuildTaskProjection(runId: string, updatedAt: string): void {
    const rows = this.db
      .prepare(
        `SELECT event_sequence, payload_json FROM task_events_projection
         WHERE run_id = ? ORDER BY event_sequence ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    if (rows.length === 0) return;
    const latest = JSON.parse(String(rows[rows.length - 1]["payload_json"])) as TaskEvent;
    this.db
      .prepare(
        `INSERT INTO task_projection (run_id, session_id, state, last_event_sequence, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           session_id = excluded.session_id,
           state = excluded.state,
           last_event_sequence = excluded.last_event_sequence,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(runId, latest.sessionId, latest.kind, latest.sequence, JSON.stringify(latest), updatedAt);
  }

  private mapMessage(row: Record<string, unknown>): ProjectedMessageView {
    const payload = JSON.parse(String(row["payload_json"])) as OutboxMessageView;
    return {
      ...payload,
      sequence: Number(row["bridge_sequence"]),
      state: String(row["state"]) as OutboxState,
      availableAt: (row["available_at"] as string | null) ?? null,
      contentSha256: String(row["content_sha256"]),
      decisionId: (row["decision_id"] as string | null) ?? null,
      lastPolicyError: (row["last_policy_error"] as string | null) ?? null,
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapDndRule(row: Record<string, unknown>): DndRule {
    return {
      ruleId: String(row["rule_id"]),
      scope: String(row["scope"]),
      scopeKey: (row["scope_key"] as string | null) ?? null,
      timeZone: String(row["time_zone"]),
      startMinute: (row["start_minute"] as number | null) ?? null,
      endMinute: (row["end_minute"] as number | null) ?? null,
      pausedUntil: (row["paused_until"] as string | null) ?? null,
      enabled: Number(row["enabled"]) === 1,
      source: String(row["source"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapPacingLane(row: Record<string, unknown>): PacingLane {
    return {
      laneKey: String(row["lane_key"]),
      channel: String(row["channel"]),
      chatId: (row["chat_id"] as string | null) ?? null,
      ratePerMin: Number(row["rate_per_min"]),
      successCount: Number(row["success_count"]),
      cooldownUntil: (row["cooldown_until"] as string | null) ?? null,
      lastSentAt: (row["last_sent_at"] as string | null) ?? null,
      lastCongestionReason: (row["last_congestion_reason"] as string | null) ?? null,
      updatedAt: String(row["updated_at"]),
    };
  }

  private mapPrewarm(row: Record<string, unknown>): PrewarmCacheEntry {
    return {
      channel: String(row["channel"]),
      warmed: Number(row["warmed"]) === 1,
      checkedAt: String(row["checked_at"]),
      expiresAt: (row["expires_at"] as string | null) ?? null,
      detail: (row["detail"] as string | null) ?? null,
    };
  }

  private canonicalPolicySnapshot(policy: MessagePolicyConfig | PolicySnapshot): PolicySnapshot {
    const payload = "payload" in policy ? policy.payload : policy;
    const canonicalPayload = JSON.parse(JSON.stringify(canonicalize(payload))) as MessagePolicyConfig;
    const snapshot = createPolicySnapshot(canonicalPayload);
    if ("sha256" in policy && (policy.sha256 !== snapshot.sha256 || policy.version !== snapshot.version)) {
      throw new Error("message policy snapshot does not match its canonical payload");
    }
    return snapshot;
  }

  private withImmediateTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}

function validateBatch(batch: OutboxChangeBatch): void {
  requireNonNegativeInteger(batch.afterSequence, "batch.afterSequence");
  requireNonNegativeInteger(batch.nextSequence, "batch.nextSequence");
  if (batch.nextSequence < batch.afterSequence) {
    throw new Error("batch.nextSequence must be no smaller than batch.afterSequence");
  }
  if (!Array.isArray(batch.items) || !Array.isArray(batch.taskEvents) || !Array.isArray(batch.inbound)) {
    throw new Error("batch items, taskEvents, and inbound must be arrays");
  }
  for (const item of batch.items) validateOutboxMessage(item);
  for (const event of batch.taskEvents) validateTaskEvent(event);
  for (const inbound of batch.inbound) validateInboundEnvelope(inbound);
}

function validateOutboxMessage(row: OutboxMessageView): void {
  requireNonEmptyString(row.messageId, "messageId");
  requireNonEmptyString(row.instanceId, "instanceId");
  requireNonEmptyString(row.adapterId, "adapterId");
  requireNonEmptyString(row.channel, "channel");
  requireNonEmptyString(row.chatId, "chatId");
  requireNonEmptyString(row.sessionId, "sessionId");
  requireNonEmptyString(row.messageKind, "messageKind");
  if (!(MESSAGE_KINDS as readonly string[]).includes(row.messageKind)) {
    throw new Error(`messageKind is not supported: ${row.messageKind}`);
  }
  if (!TRANSPORT_CLASSES.has(row.transport)) throw new Error(`transport is not supported: ${row.transport}`);
  if (!MESSAGE_PRIORITIES.has(row.priority)) throw new Error(`priority is not supported: ${row.priority}`);
  requireNonEmptyString(row.content, "content");
  requireNonEmptyString(row.contentSha256, "contentSha256");
  requireIsoTimestamp(row.capturedAt, "capturedAt");
  requireNonNegativeInteger(row.sequence, "sequence");
  if (!isOutboxState(row.state)) throw new Error(`state is not supported: ${String(row.state)}`);
  validateNullableTimestamp(row.availableAt, "availableAt");
  requireNonNegativeInteger(row.attemptCount, "attemptCount");
  validateNullableString(row.providerMessageId, "providerMessageId");
  validateNullableTimestamp(row.deliveredAt, "deliveredAt");
  validateNullableString(row.lastError, "lastError");
  validateOptionalNullableString(row.accountId, "accountId");
  validateOptionalNullableString(row.threadId, "threadId");
  validateOptionalNullableString(row.runId, "runId");
  validateOptionalNullableString(row.inboundMessageId, "inboundMessageId");
  validateOptionalNullableString(row.replyTo, "replyTo");
  validateJsonObject(row.metadata, "metadata");
  validateStringArray(row.transformTrace, "transformTrace");
}

function validateTaskEvent(event: TaskEvent): void {
  requireNonEmptyString(event.runId, "taskEvent.runId");
  requireNonNegativeInteger(event.sequence, "taskEvent.sequence");
  requireNonEmptyString(event.sessionId, "taskEvent.sessionId");
  if (!(TASK_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    throw new Error(`taskEvent.kind is not supported: ${event.kind}`);
  }
  requireIsoTimestamp(event.occurredAt, "taskEvent.occurredAt");
  if (event.summary !== undefined && typeof event.summary !== "string") {
    throw new Error("taskEvent.summary must be a string when provided");
  }
  if (event.etaSec !== undefined) requireFiniteNonNegative(event.etaSec, "taskEvent.etaSec");
}

function validateInboundEnvelope(inbound: InboundEnvelope): void {
  requireNonEmptyString(inbound.inboundMessageId, "inbound.inboundMessageId");
  requireNonEmptyString(inbound.instanceId, "inbound.instanceId");
  requireNonEmptyString(inbound.adapterId, "inbound.adapterId");
  requireNonEmptyString(inbound.channel, "inbound.channel");
  requireNonEmptyString(inbound.chatId, "inbound.chatId");
  requireNonEmptyString(inbound.content, "inbound.content");
  requireIsoTimestamp(inbound.receivedAt, "inbound.receivedAt");
  validateOptionalNullableString(inbound.threadId, "inbound.threadId");
  validateOptionalNullableString(inbound.userId, "inbound.userId");
  validateOptionalNullableString(inbound.sessionId, "inbound.sessionId");
  validateOptionalNullableString(inbound.runId, "inbound.runId");
}

function validateMessageDecision(decision: MessageDecision): void {
  requireNonEmptyString(decision.decisionId, "decisionId");
  requireNonEmptyString(decision.messageId, "decision.messageId");
  requireNonEmptyString(decision.expectedContentSha256, "decision.expectedContentSha256");
  if (!DECISION_STATES.has(decision.state)) throw new Error(`decision.state is not supported: ${decision.state}`);
  if (decision.availableAt !== undefined) requireIsoTimestamp(decision.availableAt, "decision.availableAt");
  if (decision.optimizedContent !== undefined && typeof decision.optimizedContent !== "string") {
    throw new Error("decision.optimizedContent must be a string when provided");
  }
  validateStringArray(decision.transformTrace, "decision.transformTrace");
  requireNonEmptyString(decision.policyVersion, "decision.policyVersion");
  requireNonEmptyString(decision.reason, "decision.reason");
}

function validateDndRule(rule: DndRuleInput): void {
  requireNonEmptyString(rule.ruleId, "ruleId");
  if (!DND_SCOPES.has(rule.scope)) throw new Error(`scope is not supported: ${rule.scope}`);
  if (rule.scope === "global") {
    if (rule.scopeKey !== null) throw new Error("global DND rules must use a null scopeKey");
  } else {
    requireNonEmptyString(rule.scopeKey, "scopeKey");
  }
  requireIanaTimeZone(rule.timeZone, "timeZone");
  validateMinutePair(rule.startMinute, rule.endMinute);
  validateNullableTimestamp(rule.pausedUntil, "pausedUntil");
  if (typeof rule.enabled !== "boolean") throw new Error("enabled must be a boolean");
  requireNonEmptyString(rule.source, "source");
  if (rule.updatedAt !== undefined) requireIsoTimestamp(rule.updatedAt, "updatedAt");
}

function validatePacingLane(lane: PacingLaneInput): void {
  requireNonEmptyString(lane.laneKey, "laneKey");
  requireNonEmptyString(lane.channel, "channel");
  validateNullableString(lane.chatId, "chatId");
  requireFiniteNonNegative(lane.ratePerMin, "ratePerMin");
  requireNonNegativeInteger(lane.successCount, "successCount");
  validateNullableTimestamp(lane.cooldownUntil, "cooldownUntil");
  validateNullableTimestamp(lane.lastSentAt, "lastSentAt");
  validateNullableString(lane.lastCongestionReason, "lastCongestionReason");
  if (lane.updatedAt !== undefined) requireIsoTimestamp(lane.updatedAt, "updatedAt");
}

function validatePrewarmCacheEntry(entry: PrewarmCacheEntry): void {
  requireNonEmptyString(entry.channel, "channel");
  if (typeof entry.warmed !== "boolean") throw new Error("warmed must be a boolean");
  requireIsoTimestamp(entry.checkedAt, "checkedAt");
  validateNullableTimestamp(entry.expiresAt, "expiresAt");
  if (entry.expiresAt !== null && Date.parse(entry.expiresAt) < Date.parse(entry.checkedAt)) {
    throw new Error("expiresAt must not be earlier than checkedAt");
  }
  validateNullableString(entry.detail, "detail");
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
}

function validateOptionalString(value: unknown, field: string): void {
  if (value !== undefined) requireNonEmptyString(value, field);
}

function validateOptionalNullableString(value: unknown, field: string): void {
  if (value !== undefined && value !== null) requireNonEmptyString(value, field);
}

function validateNullableString(value: unknown, field: string): void {
  if (value !== null) requireNonEmptyString(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer`);
}

function requireFiniteNonNegative(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite, non-negative number`);
  }
}

function requireIsoTimestamp(value: unknown, field: string): asserts value is string {
  requireNonEmptyString(value, field);
  const time = Date.parse(value);
  if (!value.endsWith("Z") || Number.isNaN(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
}

function validateNullableTimestamp(value: unknown, field: string): void {
  if (value !== null) requireIsoTimestamp(value, field);
}

function validateStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function validateJsonObject(value: unknown, field: string): void {
  if (!isPlainJsonObject(value) || !isJsonSafe(value)) {
    throw new Error(`${field} must be a JSON-safe object`);
  }
}

function isJsonSafe(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (isPlainJsonObject(value)) return Object.values(value).every(isJsonSafe);
  return false;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireIanaTimeZone(value: unknown, field: string): void {
  requireNonEmptyString(value, field);
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`${field} must be an IANA time zone`);
  }
}

function validateMinutePair(startMinute: unknown, endMinute: unknown): void {
  if (startMinute === null && endMinute === null) return;
  if (startMinute === null || endMinute === null) {
    throw new Error("startMinute and endMinute must both be null or both be set");
  }
  for (const [field, value] of [["startMinute", startMinute], ["endMinute", endMinute]] as const) {
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= 24 * 60) {
      throw new Error(`${field} must be an integer from 0 through 1439`);
    }
  }
}
