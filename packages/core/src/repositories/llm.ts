import { BaseRepository, nowIso } from "./base.js";

export type LlmProtocol = "openai-compatible" | "anthropic" | "gemini";
export type LlmProfileStatus = "active" | "disabled" | "unsupported";
export type LlmVersionStatus = "active" | "disabled" | "pending";
export type LlmBindingScope = "instance" | "framework" | "skill" | "plugin" | "evolution";

export interface LlmProfileRow {
  profileId: string;
  instanceId: string | null;
  provider: string;
  protocol: LlmProtocol;
  endpoint: string;
  model: string;
  status: LlmProfileStatus;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProfileInput {
  profileId: string;
  instanceId?: string;
  provider: string;
  protocol: LlmProtocol;
  endpoint: string;
  model: string;
  status?: LlmProfileStatus;
  currentVersion?: number;
}

export interface LlmProfileVersionRow {
  id: number;
  profileId: string;
  version: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  status: LlmVersionStatus;
  probeStatus: "pass" | "fail" | "unknown";
  probeCategory: string;
  probeDetail: string;
  probedAt: string | null;
  createdAt: string;
}

export interface LlmProfileVersionInput {
  profileId: string;
  version: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  status?: LlmVersionStatus;
  probeStatus?: "pass" | "fail" | "unknown";
  probeCategory?: string;
  probeDetail?: string;
  probedAt?: string | null;
}

export interface LlmBindingRow {
  bindingId: string;
  scope: LlmBindingScope;
  instanceId: string | null;
  frameworkId: string | null;
  targetRef: string | null;
  profileId: string;
  createdAt: string;
}

export interface LlmBindingInput {
  bindingId: string;
  scope: LlmBindingScope;
  instanceId?: string;
  frameworkId?: string;
  targetRef?: string;
  profileId: string;
}

export class LlmRepository extends BaseRepository {
  /* -------------------------------- llm_profiles -------------------------------- */

  insertLlmProfile(input: LlmProfileInput): LlmProfileRow {
    const ts = nowIso();
    this.prepare(
      `INSERT INTO llm_profiles (profile_id, instance_id, provider, protocol, endpoint, model, status, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.profileId,
      input.instanceId ?? null,
      input.provider,
      input.protocol,
      input.endpoint,
      input.model,
      input.status ?? "disabled",
      input.currentVersion ?? 0,
      ts,
      ts,
    );
    return this.getLlmProfile(input.profileId)!;
  }

  getLlmProfile(profileId: string): LlmProfileRow | undefined {
    const row = this.prepare("SELECT * FROM llm_profiles WHERE profile_id = ?").get(profileId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapLlmProfile(row);
  }

  listLlmProfiles(): LlmProfileRow[] {
    const rows = this.prepare("SELECT * FROM llm_profiles ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmProfile(row));
  }

  updateLlmProfile(
    profileId: string,
    patch: Partial<
      Pick<
        LlmProfileInput,
        "status" | "currentVersion" | "endpoint" | "model" | "provider" | "protocol" | "instanceId"
      >
    >,
  ): LlmProfileRow | undefined {
    const current = this.getLlmProfile(profileId);
    if (!current) return undefined;
    this.prepare(
      `UPDATE llm_profiles SET instance_id = ?, provider = ?, protocol = ?, endpoint = ?, model = ?, status = ?, current_version = ?, updated_at = ? WHERE profile_id = ?`,
    ).run(
      patch.instanceId ?? current.instanceId,
      patch.provider ?? current.provider,
      patch.protocol ?? current.protocol,
      patch.endpoint ?? current.endpoint,
      patch.model ?? current.model,
      patch.status ?? current.status,
      patch.currentVersion ?? current.currentVersion,
      nowIso(),
      profileId,
    );
    return this.getLlmProfile(profileId);
  }

  /* ---------------------------- llm_profile_versions ---------------------------- */

  insertLlmProfileVersion(input: LlmProfileVersionInput): LlmProfileVersionRow {
    const ts = nowIso();
    this.prepare(
      `INSERT INTO llm_profile_versions (profile_id, version, ciphertext, nonce, auth_tag, key_version, status, probe_status, probe_category, probe_detail, probed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.profileId,
      input.version,
      input.ciphertext,
      input.nonce,
      input.authTag,
      input.keyVersion,
      input.status ?? "pending",
      input.probeStatus ?? "unknown",
      input.probeCategory ?? "unknown",
      input.probeDetail ?? "",
      input.probedAt ?? null,
      ts,
    );
    return this.getLlmProfileVersion(input.profileId, input.version)!;
  }

  getLlmProfileVersion(profileId: string, version?: number): LlmProfileVersionRow | undefined {
    const row =
      version === undefined
        ? this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1").get(
            profileId,
          )
        : this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? AND version = ?").get(
            profileId,
            version,
          );
    return row === undefined ? undefined : this.mapLlmProfileVersion(row as Record<string, unknown>);
  }

  listLlmProfileVersions(profileId: string): LlmProfileVersionRow[] {
    const rows = this.prepare("SELECT * FROM llm_profile_versions WHERE profile_id = ? ORDER BY version DESC").all(
      profileId,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmProfileVersion(row));
  }

  updateLlmProfileVersion(
    profileId: string,
    version: number,
    patch: Partial<
      Pick<LlmProfileVersionInput, "status" | "probeStatus" | "probeCategory" | "probeDetail" | "probedAt">
    >,
  ): LlmProfileVersionRow | undefined {
    const current = this.getLlmProfileVersion(profileId, version);
    if (!current) return undefined;
    this.prepare(
      `UPDATE llm_profile_versions SET status = ?, probe_status = ?, probe_category = ?, probe_detail = ?, probed_at = ? WHERE profile_id = ? AND version = ?`,
    ).run(
      patch.status ?? current.status,
      patch.probeStatus ?? current.probeStatus,
      patch.probeCategory ?? current.probeCategory,
      patch.probeDetail ?? current.probeDetail,
      patch.probedAt === undefined ? current.probedAt : patch.probedAt,
      profileId,
      version,
    );
    return this.getLlmProfileVersion(profileId, version);
  }

  /* -------------------------------- llm_bindings -------------------------------- */

  insertLlmBinding(input: LlmBindingInput): LlmBindingRow {
    const ts = nowIso();
    this.prepare(
      `INSERT INTO llm_bindings (binding_id, scope, instance_id, framework_id, target_ref, profile_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.bindingId,
      input.scope,
      input.instanceId ?? null,
      input.frameworkId ?? null,
      input.targetRef ?? null,
      input.profileId,
      ts,
    );
    return this.getLlmBinding(input.bindingId)!;
  }

  getLlmBinding(bindingId: string): LlmBindingRow | undefined {
    const row = this.prepare("SELECT * FROM llm_bindings WHERE binding_id = ?").get(bindingId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapLlmBinding(row);
  }

  listLlmBindings(filter: { profileId?: string; instanceId?: string } = {}): LlmBindingRow[] {
    const rows = this.prepare(
      "SELECT * FROM llm_bindings WHERE (? IS NULL OR profile_id = ?) AND (? IS NULL OR instance_id = ?) ORDER BY created_at DESC",
    ).all(
      filter.profileId ?? null,
      filter.profileId ?? null,
      filter.instanceId ?? null,
      filter.instanceId ?? null,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapLlmBinding(row));
  }

  deleteLlmBinding(bindingId: string): boolean {
    return this.prepare("DELETE FROM llm_bindings WHERE binding_id = ?").run(bindingId).changes > 0;
  }

  /** 删除模型配置的全部版本行。返回删除的行数。 */
  deleteLlmProfileVersions(profileId: string): number {
    return Number(this.prepare("DELETE FROM llm_profile_versions WHERE profile_id = ?").run(profileId).changes);
  }

  /**
   * 删除模型配置本体。llm_* 三表之间没有外键约束（见建表语句），
   * 必须先删依赖行再删本体；调用方负责先删 versions 与 bindings，本方法
   * 只删 llm_profiles 一行，包事务由调用方决定范围。
   */
  deleteLlmProfile(profileId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteLlmProfileVersions(profileId);
      const changes = Number(this.prepare("DELETE FROM llm_profiles WHERE profile_id = ?").run(profileId).changes);
      this.db.exec("COMMIT");
      return changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private mapLlmProfile(r: Record<string, unknown>): LlmProfileRow {
    return {
      profileId: String(r["profile_id"]),
      instanceId: (r["instance_id"] as string | null) ?? null,
      provider: String(r["provider"]),
      protocol: String(r["protocol"]) as LlmProtocol,
      endpoint: String(r["endpoint"]),
      model: String(r["model"]),
      status: String(r["status"]) as LlmProfileStatus,
      currentVersion: Number(r["current_version"]),
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  private mapLlmProfileVersion(r: Record<string, unknown>): LlmProfileVersionRow {
    return {
      id: Number(r["id"]),
      profileId: String(r["profile_id"]),
      version: Number(r["version"]),
      ciphertext: String(r["ciphertext"]),
      nonce: String(r["nonce"]),
      authTag: String(r["auth_tag"]),
      keyVersion: Number(r["key_version"]),
      status: String(r["status"]) as LlmVersionStatus,
      probeStatus: String(r["probe_status"]) as "pass" | "fail" | "unknown",
      probeCategory: String(r["probe_category"]),
      probeDetail: String(r["probe_detail"]),
      probedAt: (r["probed_at"] as string | null) ?? null,
      createdAt: String(r["created_at"]),
    };
  }

  private mapLlmBinding(r: Record<string, unknown>): LlmBindingRow {
    return {
      bindingId: String(r["binding_id"]),
      scope: String(r["scope"]) as LlmBindingScope,
      instanceId: (r["instance_id"] as string | null) ?? null,
      frameworkId: (r["framework_id"] as string | null) ?? null,
      targetRef: (r["target_ref"] as string | null) ?? null,
      profileId: String(r["profile_id"]),
      createdAt: String(r["created_at"]),
    };
  }
}
