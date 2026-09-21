import { BaseRepository, nowIso } from "./base.js";

export type ApiCredentialCategory = "search" | "vision" | "llm" | "memory" | "tool" | "custom";
export type ApiCredentialStatus = "active" | "disabled";

export interface ApiCredentialRow {
  id: string;
  name: string;
  category: ApiCredentialCategory;
  envVar: string;
  provider: string;
  endpoint: string | null;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  status: ApiCredentialStatus;
  probeStatus: "pass" | "fail" | "unknown";
  probeCategory: string | null;
  probeDetail: string | null;
  probedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiCredentialInput {
  id?: string;
  name: string;
  category: ApiCredentialCategory;
  envVar: string;
  provider: string;
  endpoint?: string | null;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion?: number;
  status?: ApiCredentialStatus;
  probeStatus?: "pass" | "fail" | "unknown";
  probeCategory?: string | null;
  probeDetail?: string | null;
  probedAt?: string | null;
}

export class ApiCredentialRepository extends BaseRepository {
  listAll(): ApiCredentialRow[] {
    return (
      this.prepare(
        `SELECT id, name, category, env_var AS envVar, provider, endpoint,
                ciphertext, nonce, auth_tag AS authTag, key_version AS keyVersion,
                status, probe_status AS probeStatus, probe_category AS probeCategory,
                probe_detail AS probeDetail, probed_at AS probedAt,
                created_at AS createdAt, updated_at AS updatedAt
         FROM api_credentials
         ORDER BY category ASC, name ASC`,
      ).all() as unknown as ApiCredentialRow[]
    );
  }

  getById(id: string): ApiCredentialRow | null {
    const row = this.prepare(
      `SELECT id, name, category, env_var AS envVar, provider, endpoint,
              ciphertext, nonce, auth_tag AS authTag, key_version AS keyVersion,
              status, probe_status AS probeStatus, probe_category AS probeCategory,
              probe_detail AS probeDetail, probed_at AS probedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM api_credentials
       WHERE id = ?`,
    ).get(id);
    return (row as unknown as ApiCredentialRow) ?? null;
  }

  getByEnvVar(envVar: string): ApiCredentialRow | null {
    const row = this.prepare(
      `SELECT id, name, category, env_var AS envVar, provider, endpoint,
              ciphertext, nonce, auth_tag AS authTag, key_version AS keyVersion,
              status, probe_status AS probeStatus, probe_category AS probeCategory,
              probe_detail AS probeDetail, probed_at AS probedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM api_credentials
       WHERE env_var = ?`,
    ).get(envVar);
    return (row as unknown as ApiCredentialRow) ?? null;
  }

  upsert(input: ApiCredentialInput): ApiCredentialRow {
    const ts = nowIso();
    const existing = input.id ? this.getById(input.id) : this.getByEnvVar(input.envVar);
    const id = input.id ?? existing?.id ?? crypto.randomUUID();

    this.prepare(
      `INSERT INTO api_credentials (
         id, name, category, env_var, provider, endpoint,
         ciphertext, nonce, auth_tag, key_version, status,
         probe_status, probe_category, probe_detail, probed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         category = excluded.category,
         env_var = excluded.env_var,
         provider = excluded.provider,
         endpoint = excluded.endpoint,
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         auth_tag = excluded.auth_tag,
         key_version = excluded.key_version,
         status = excluded.status,
         probe_status = excluded.probe_status,
         probe_category = excluded.probe_category,
         probe_detail = excluded.probe_detail,
         probed_at = excluded.probed_at,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      input.name,
      input.category,
      input.envVar,
      input.provider,
      input.endpoint ?? null,
      input.ciphertext,
      input.nonce,
      input.authTag,
      input.keyVersion ?? 1,
      input.status ?? "active",
      input.probeStatus ?? "unknown",
      input.probeCategory ?? null,
      input.probeDetail ?? null,
      input.probedAt ?? null,
      existing?.createdAt ?? ts,
      ts,
    );

    return this.getById(id)!;
  }

  deleteById(id: string): boolean {
    const info = this.prepare(`DELETE FROM api_credentials WHERE id = ?`).run(id);
    return Number(info.changes) > 0;
  }

  updateProbeResult(
    id: string,
    probeStatus: "pass" | "fail",
    probeCategory: string,
    probeDetail: string,
  ): boolean {
    const ts = nowIso();
    const info = this.prepare(
      `UPDATE api_credentials
       SET probe_status = ?, probe_category = ?, probe_detail = ?, probed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(probeStatus, probeCategory, probeDetail, ts, ts, id);
    return Number(info.changes) > 0;
  }
}
