import type { JobStep } from "@butler/contract";
import { BaseRepository, fromJson, nowIso, toJson } from "./base.js";

export interface JobRow {
  jobId: string;
  kind: string;
  instance: string;
  status: string;
  idempotencyKey: string | null;
  steps: JobStep[];
  createdAt: string;
  updatedAt: string;
}

export interface JobInput {
  jobId: string;
  kind: string;
  instance?: string;
  status?: string;
  idempotencyKey?: string;
  steps?: JobStep[];
}

export interface SnapshotRow {
  id: number;
  instance: string;
  scope: unknown;
  label: string | null;
  createdAt: string;
  status: string;
}

export interface BackupRow {
  id: number;
  kind: "full" | "memory" | "event";
  label: string | null;
  target: string;
  path: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export interface BackupInput {
  kind: "full" | "memory" | "event";
  label?: string;
  target: string;
  path: string;
  sizeBytes?: number;
  status?: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
}

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  detail?: unknown;
}

/** instances 表的原始行（lifecycle.ts 负责 InstanceRecord ↔ Row 映射）。 */
export interface InstanceRow {
  instanceId: string;
  frameworkId: string;
  state: string;
  runtime: string;
  rootPath: string;
  version: string | null;
  confidence: number;
  capabilityJson: string | null;
  detailJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 由步骤状态推导 Job 状态：任一 failed→failed；全部收敛→done；否则 running。 */
export function deriveJobStatus(steps: JobStep[]): string {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.length > 0 && steps.every((s) => s.status === "passed" || s.status === "skipped")) {
    return "done";
  }
  return "running";
}

export class LifecycleRepository extends BaseRepository {
  /* ---------------------------------- jobs ---------------------------------- */

  insertJob(input: JobInput): JobRow {
    const ts = nowIso();
    const status = input.status ?? deriveJobStatus(input.steps ?? []);
    this.prepare(
      `INSERT INTO jobs (job_id, kind, instance, status, idempotency_key, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         status = excluded.status,
         steps_json = excluded.steps_json,
         updated_at = excluded.updated_at`,
    ).run(
      input.jobId,
      input.kind,
      input.instance ?? "",
      status,
      input.idempotencyKey ?? null,
      JSON.stringify(input.steps ?? []),
      ts,
      ts,
    );
    const row = this.findJobById(input.jobId);
    if (row === undefined) {
      throw new Error(`job ${input.jobId} disappeared right after upsert`);
    }
    return row;
  }

  updateJob(jobId: string, patch: { status?: string; steps?: JobStep[] }): boolean {
    const ts = nowIso();
    if (patch.steps !== undefined) {
      const result = this.prepare(
        "UPDATE jobs SET status = COALESCE(?, status), steps_json = ?, updated_at = ? WHERE job_id = ?",
      ).run(patch.status ?? null, JSON.stringify(patch.steps), ts, jobId);
      return result.changes > 0;
    }
    const result = this.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?").run(
      patch.status ?? "running",
      ts,
      jobId,
    );
    return result.changes > 0;
  }

  findJobById(jobId: string): JobRow | undefined {
    const row = this.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  findJobByIdempotencyKey(key: string): JobRow | undefined {
    const row = this.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapJob(row);
  }

  listJobs(filter: { instance?: string; status?: string } = {}): JobRow[] {
    const rows = this.prepare(
      "SELECT * FROM jobs WHERE instance = COALESCE(?, instance) AND status = COALESCE(?, status) ORDER BY created_at DESC",
    ).all(filter.instance ?? null, filter.status ?? null) as Record<string, unknown>[];
    return rows.map((r) => this.mapJob(r));
  }

  private mapJob(r: Record<string, unknown>): JobRow {
    return {
      jobId: String(r["job_id"]),
      kind: String(r["kind"]),
      instance: String(r["instance"]),
      status: String(r["status"]),
      idempotencyKey: (r["idempotency_key"] as string | null) ?? null,
      steps: fromJson<JobStep[]>(r["steps_json"] as string | null, []),
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  /* -------------------------------- snapshots ------------------------------- */

  insertSnapshot(input: {
    instance: string;
    scope: unknown;
    label?: string;
    status?: string;
  }): SnapshotRow {
    const ts = nowIso();
    const result = this.prepare(
      "INSERT INTO snapshots (instance, scope_json, label, created_at, status) VALUES (?, ?, ?, ?, ?)",
    ).run(input.instance, toJson(input.scope), input.label ?? null, ts, input.status ?? "ok");
    return {
      id: Number(result.lastInsertRowid),
      instance: input.instance,
      scope: input.scope,
      label: input.label ?? null,
      createdAt: ts,
      status: input.status ?? "ok",
    };
  }

  listSnapshots(instance?: string): SnapshotRow[] {
    const rows = this.prepare("SELECT * FROM snapshots WHERE instance = COALESCE(?, instance) ORDER BY id DESC").all(
      instance ?? null,
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      instance: String(r["instance"]),
      scope: fromJson<unknown>(r["scope_json"] as string | null, null),
      label: (r["label"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
      status: String(r["status"]),
    }));
  }

  updateSnapshotStatus(id: number, status: string): boolean {
    const result = this.prepare("UPDATE snapshots SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }

  /* --------------------------------- backups --------------------------------- */

  insertBackup(input: BackupInput): BackupRow {
    const ts = nowIso();
    const result = this.prepare(
      "INSERT INTO backups (kind, label, target, path, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.kind,
      input.label ?? null,
      input.target,
      input.path,
      input.sizeBytes ?? 0,
      input.status ?? "ok",
      ts,
    );
    return {
      id: Number(result.lastInsertRowid),
      kind: input.kind,
      label: input.label ?? null,
      target: input.target,
      path: input.path,
      sizeBytes: input.sizeBytes ?? 0,
      status: input.status ?? "ok",
      createdAt: ts,
    };
  }

  listBackups(kind?: string): BackupRow[] {
    const rows = this.prepare("SELECT * FROM backups WHERE kind = COALESCE(?, kind) ORDER BY id DESC").all(
      kind ?? null,
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      kind: String(r["kind"]) as BackupRow["kind"],
      label: (r["label"] as string | null) ?? null,
      target: String(r["target"]),
      path: String(r["path"]),
      sizeBytes: Number(r["size_bytes"]),
      status: String(r["status"]),
      createdAt: String(r["created_at"]),
    }));
  }

  getBackup(id: number): BackupRow | undefined {
    const row = this.prepare("SELECT * FROM backups WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      id: Number(row["id"]),
      kind: String(row["kind"]) as BackupRow["kind"],
      label: (row["label"] as string | null) ?? null,
      target: String(row["target"]),
      path: String(row["path"]),
      sizeBytes: Number(row["size_bytes"]),
      status: String(row["status"]),
      createdAt: String(row["created_at"]),
    };
  }

  updateBackupStatus(id: number, status: string): boolean {
    const result = this.prepare("UPDATE backups SET status = ? WHERE id = ?").run(status, id);
    return result.changes > 0;
  }

  /* ---------------------------------- audit --------------------------------- */

  appendAudit(input: AuditInput): AuditRow {
    const ts = nowIso();
    const target = input.target ?? "";
    const detailJson = input.detail === undefined ? null : JSON.stringify(input.detail);
    const result = this.prepare("INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)").run(
      ts,
      input.actor,
      input.action,
      target,
      detailJson,
    );
    return {
      id: Number(result.lastInsertRowid),
      ts,
      actor: input.actor,
      action: input.action,
      target,
      detail: input.detail ?? null,
    };
  }

  listAudit(filter: { action?: string; target?: string; limit?: number } = {}): AuditRow[] {
    const limit = filter.limit ?? 100;
    const rows = this.prepare(
      "SELECT * FROM audit WHERE action = COALESCE(?, action) AND target = COALESCE(?, target) ORDER BY id DESC LIMIT ?",
    ).all(filter.action ?? null, filter.target ?? null, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      actor: String(r["actor"]),
      action: String(r["action"]),
      target: String(r["target"]),
      detail: fromJson<unknown>(r["detail_json"] as string | null, null),
    }));
  }

  pruneAudit(cutoff: string): number {
    if (typeof cutoff !== "string" || Number.isNaN(Date.parse(cutoff))) {
      throw new Error("audit cutoff must be a valid timestamp");
    }
    const result = this.prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  /* -------------------------------- instances ------------------------------- */

  saveInstance(row: InstanceRow): void {
    this.prepare(
      `INSERT INTO instances (instance_id, framework_id, state, runtime, root_path, version,
                              confidence, capability_json, detail_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         framework_id = excluded.framework_id,
         state = excluded.state,
         runtime = excluded.runtime,
         root_path = excluded.root_path,
         version = excluded.version,
         confidence = excluded.confidence,
         capability_json = excluded.capability_json,
         detail_json = excluded.detail_json,
         updated_at = excluded.updated_at`,
    ).run(
      row.instanceId,
      row.frameworkId,
      row.state,
      row.runtime,
      row.rootPath,
      row.version,
      row.confidence,
      row.capabilityJson,
      row.detailJson,
      row.createdAt,
      row.updatedAt,
    );
  }

  getInstance(instanceId: string): InstanceRow | undefined {
    const row = this.prepare("SELECT * FROM instances WHERE instance_id = ?").get(instanceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapInstance(row);
  }

  listInstances(): InstanceRow[] {
    const rows = this.prepare("SELECT * FROM instances ORDER BY instance_id").all() as Record<string, unknown>[];
    return rows.map((r) => this.mapInstance(r));
  }

  private mapInstance(r: Record<string, unknown>): InstanceRow {
    return {
      instanceId: String(r["instance_id"]),
      frameworkId: String(r["framework_id"]),
      state: String(r["state"]),
      runtime: String(r["runtime"]),
      rootPath: String(r["root_path"]),
      version: (r["version"] as string | null) ?? null,
      confidence: Number(r["confidence"]),
      capabilityJson: (r["capability_json"] as string | null) ?? null,
      detailJson: (r["detail_json"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  /* ---------------------- app_config & runtime_settings ---------------------- */

  getAppConfig(key: string): string | null {
    const row = this.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return row === undefined ? null : String(row["value"]);
  }

  setAppConfig(key: string, value: string): void {
    this.prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, nowIso());
  }

  getRuntimeSetting(key: string): string | null {
    const row = this.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? null : String(row.value);
  }

  setRuntimeSetting(key: string, value: string, at?: string): void {
    const ts = at ?? nowIso();
    this.prepare(
      `INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, ts);
  }
}
