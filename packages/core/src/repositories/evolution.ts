import { BaseRepository, fromJson, nowIso, toJson } from "./base.js";

export type EvolutionObservationKind = "session" | "tool";
export type EvolutionObservationOutcome = "success" | "failure" | "unknown";

export interface EvolutionObservationRow {
  observationId: string;
  instanceId: string;
  sessionId: string | null;
  runId: string | null;
  kind: EvolutionObservationKind;
  name: string | null;
  outcome: EvolutionObservationOutcome;
  failureCategory: string | null;
  durationMs: number | null;
  occurredAt: string;
  source: "structured" | "logs";
  detail: unknown;
  contentHash: string;
}

export interface EvolutionDailyMetricRow {
  instanceId: string;
  date: string;
  snapshot: unknown;
  createdAt: string;
}

export interface EvolutionSampleRow {
  sampleId: string;
  instanceId: string;
  dataset: string;
  outcome: "positive" | "negative";
  label: string;
  contentHash: string;
  datasetVersion: string;
  synthetic: boolean;
  source: string;
  createdAt: string;
}

export type EvolutionActionStatus = "open" | "checking" | "resolved" | "ignored";

export interface EvolutionActionItemRow {
  actionId: string;
  instanceId: string;
  category: string;
  title: string;
  impact: "blocking" | "high" | "medium" | "low";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  relatedRuns: string[];
  evidence: string;
  nextAction: string;
  status: EvolutionActionStatus;
  resolvedAt: string | null;
  updatedAt: string;
}

export class EvolutionRepository extends BaseRepository {
  saveEvolutionObservation(input: EvolutionObservationRow): void {
    this.prepare(
      `INSERT OR IGNORE INTO evolution_observations
       (observation_id, instance_id, session_id, run_id, kind, name, outcome, failure_category,
        duration_ms, occurred_at, source, detail_json, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.observationId,
      input.instanceId,
      input.sessionId,
      input.runId,
      input.kind,
      input.name,
      input.outcome,
      input.failureCategory,
      input.durationMs,
      input.occurredAt,
      input.source,
      toJson(input.detail),
      input.contentHash,
    );
  }

  listEvolutionObservations(
    filter: { instanceId?: string; since?: string; limit?: number } = {},
  ): EvolutionObservationRow[] {
    const rows = this.prepare(
      `SELECT * FROM evolution_observations
       WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR occurred_at >= ?)
       ORDER BY occurred_at ASC LIMIT ?`,
    ).all(
      filter.instanceId ?? null,
      filter.instanceId ?? null,
      filter.since ?? null,
      filter.since ?? null,
      filter.limit ?? 20_000,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      observationId: String(row["observation_id"]),
      instanceId: String(row["instance_id"]),
      sessionId: (row["session_id"] as string | null) ?? null,
      runId: (row["run_id"] as string | null) ?? null,
      kind: String(row["kind"]) as EvolutionObservationKind,
      name: (row["name"] as string | null) ?? null,
      outcome: String(row["outcome"]) as EvolutionObservationOutcome,
      failureCategory: (row["failure_category"] as string | null) ?? null,
      durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
      occurredAt: String(row["occurred_at"]),
      source: String(row["source"]) as "structured" | "logs",
      detail: fromJson<unknown>(row["detail_json"] as string | null, null),
      contentHash: String(row["content_hash"]),
    }));
  }

  upsertEvolutionDailyMetric(input: {
    instanceId: string;
    date: string;
    snapshot: unknown;
    createdAt?: string;
  }): EvolutionDailyMetricRow {
    const createdAt = input.createdAt ?? nowIso();
    this.prepare(
      `INSERT INTO evolution_daily_metrics (instance_id, date, snapshot_json, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(instance_id, date) DO UPDATE SET snapshot_json = excluded.snapshot_json, created_at = excluded.created_at`,
    ).run(input.instanceId, input.date, toJson(input.snapshot), createdAt);
    return { instanceId: input.instanceId, date: input.date, snapshot: input.snapshot, createdAt };
  }

  listEvolutionDailyMetrics(
    filter: { instanceId?: string; since?: string; limit?: number } = {},
  ): EvolutionDailyMetricRow[] {
    const rows = this.prepare(
      `SELECT * FROM evolution_daily_metrics
       WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR date >= ?)
       ORDER BY date ASC LIMIT ?`,
    ).all(
      filter.instanceId ?? null,
      filter.instanceId ?? null,
      filter.since ?? null,
      filter.since ?? null,
      filter.limit ?? 365,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      instanceId: String(row["instance_id"]),
      date: String(row["date"]),
      snapshot: fromJson(row["snapshot_json"] as string | null, {}),
      createdAt: String(row["created_at"]),
    }));
  }

  saveEvolutionSample(input: EvolutionSampleRow): void {
    this.prepare(
      `INSERT OR IGNORE INTO evolution_samples
       (sample_id, instance_id, dataset, outcome, label, content_hash, dataset_version, synthetic, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sampleId,
      input.instanceId,
      input.dataset,
      input.outcome,
      input.label,
      input.contentHash,
      input.datasetVersion,
      input.synthetic ? 1 : 0,
      input.source,
      input.createdAt,
    );
  }

  listEvolutionSamples(
    filter: { instanceId?: string; dataset?: string; limit?: number } = {},
  ): EvolutionSampleRow[] {
    const rows = this.prepare(
      `SELECT * FROM evolution_samples
       WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR dataset = ?)
       ORDER BY created_at DESC LIMIT ?`,
    ).all(
      filter.instanceId ?? null,
      filter.instanceId ?? null,
      filter.dataset ?? null,
      filter.dataset ?? null,
      filter.limit ?? 10_000,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      sampleId: String(row["sample_id"]),
      instanceId: String(row["instance_id"]),
      dataset: String(row["dataset"]),
      outcome: String(row["outcome"]) as "positive" | "negative",
      label: String(row["label"]),
      contentHash: String(row["content_hash"]),
      datasetVersion: String(row["dataset_version"]),
      synthetic: Number(row["synthetic"]) === 1,
      source: String(row["source"]),
      createdAt: String(row["created_at"]),
    }));
  }

  upsertEvolutionActionItem(input: EvolutionActionItemRow): EvolutionActionItemRow {
    this.prepare(
      `INSERT INTO evolution_action_items
       (action_id, instance_id, category, title, impact, first_seen_at, last_seen_at, occurrences,
        related_runs_json, evidence, next_action, status, resolved_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id, category, title) DO UPDATE SET
        action_id = excluded.action_id, impact = excluded.impact, last_seen_at = excluded.last_seen_at,
        occurrences = excluded.occurrences, related_runs_json = excluded.related_runs_json,
        evidence = excluded.evidence, next_action = excluded.next_action,
        status = CASE WHEN evolution_action_items.status = 'resolved' THEN 'open' ELSE evolution_action_items.status END,
        resolved_at = CASE WHEN evolution_action_items.status = 'resolved' THEN NULL ELSE evolution_action_items.resolved_at END,
        updated_at = excluded.updated_at`,
    ).run(
      input.actionId,
      input.instanceId,
      input.category,
      input.title,
      input.impact,
      input.firstSeenAt,
      input.lastSeenAt,
      input.occurrences,
      toJson(input.relatedRuns),
      input.evidence,
      input.nextAction,
      input.status,
      input.resolvedAt,
      input.updatedAt,
    );
    return this.getEvolutionActionItem(input.actionId) ?? input;
  }

  getEvolutionActionItem(actionId: string): EvolutionActionItemRow | undefined {
    const row = this.prepare("SELECT * FROM evolution_action_items WHERE action_id = ?").get(actionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapEvolutionActionItem(row);
  }

  listEvolutionActionItems(
    filter: { instanceId?: string; status?: EvolutionActionStatus; limit?: number } = {},
  ): EvolutionActionItemRow[] {
    const rows = this.prepare(
      `SELECT * FROM evolution_action_items
       WHERE (? IS NULL OR instance_id = ?) AND (? IS NULL OR status = ?)
       ORDER BY CASE impact WHEN 'blocking' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT ?`,
    ).all(
      filter.instanceId ?? null,
      filter.instanceId ?? null,
      filter.status ?? null,
      filter.status ?? null,
      filter.limit ?? 100,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapEvolutionActionItem(row));
  }

  pruneEvolutionHistory(
    observationCutoff: string,
    dailyMetricCutoff: string,
  ): { observations: number; dailyMetrics: number } {
    const observations = Number(
      this.prepare("DELETE FROM evolution_observations WHERE occurred_at < ?").run(observationCutoff).changes,
    );
    const dailyMetrics = Number(
      this.prepare("DELETE FROM evolution_daily_metrics WHERE date < ?").run(dailyMetricCutoff).changes,
    );
    return { observations, dailyMetrics };
  }

  updateEvolutionActionItemStatus(
    actionId: string,
    status: EvolutionActionStatus,
    resolvedAt?: string | null,
  ): EvolutionActionItemRow | undefined {
    const current = this.getEvolutionActionItem(actionId);
    if (current === undefined) return undefined;
    const nextResolvedAt = status === "resolved" ? (resolvedAt ?? nowIso()) : null;
    this.prepare("UPDATE evolution_action_items SET status = ?, resolved_at = ?, updated_at = ? WHERE action_id = ?").run(
      status,
      nextResolvedAt,
      nowIso(),
      actionId,
    );
    return this.getEvolutionActionItem(actionId);
  }

  private mapEvolutionActionItem(row: Record<string, unknown>): EvolutionActionItemRow {
    return {
      actionId: String(row["action_id"]),
      instanceId: String(row["instance_id"]),
      category: String(row["category"]),
      title: String(row["title"]),
      impact: String(row["impact"]) as EvolutionActionItemRow["impact"],
      firstSeenAt: String(row["first_seen_at"]),
      lastSeenAt: String(row["last_seen_at"]),
      occurrences: Number(row["occurrences"]),
      relatedRuns: fromJson<string[]>(row["related_runs_json"] as string | null, []),
      evidence: String(row["evidence"]),
      nextAction: String(row["next_action"]),
      status: String(row["status"]) as EvolutionActionStatus,
      resolvedAt: (row["resolved_at"] as string | null) ?? null,
      updatedAt: String(row["updated_at"]),
    };
  }
}
