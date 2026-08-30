import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { LlmBindingRow, LlmBindingScope, LlmProfileRow, LlmProfileVersionRow, LlmProtocol, SqliteStore } from "./store.js";

export interface SecretEnvelope {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export class SecretVault {
  private readonly key: Buffer | null;
  readonly available: boolean;

  constructor(masterKey = process.env["BUTLER_SECRET_MASTER_KEY"]) {
    const raw = masterKey?.trim() ?? "";
    if (raw === "") {
      this.key = null;
      this.available = false;
      return;
    }
    let key: Buffer;
    try {
      if (/^[a-f0-9]{64}$/i.test(raw)) {
        key = Buffer.from(raw, "hex");
      } else if (/^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44}|[A-Za-z0-9_-]{43,44})$/.test(raw)) {
        const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
        key = Buffer.from(normalized, "base64");
        const canonical = key.toString("base64").replace(/=+$/, "");
        if (canonical !== normalized.replace(/=+$/, "")) key = Buffer.alloc(0);
      } else {
        key = Buffer.alloc(0);
      }
    } catch {
      key = Buffer.alloc(0);
    }
    if (key.length !== 32) {
      this.key = null;
      this.available = false;
      return;
    }
    this.key = key;
    this.available = true;
  }

  encrypt(secret: string, keyVersion = 1): SecretEnvelope {
    if (!this.key) throw new Error("secret-vault-unavailable");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64url"), nonce: nonce.toString("base64url"), authTag: cipher.getAuthTag().toString("base64url"), keyVersion };
  }

  decrypt(envelope: Pick<SecretEnvelope, "ciphertext" | "nonce" | "authTag">): string {
    if (!this.key) throw new Error("secret-vault-unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }

  mask(secret: string): string {
    if (secret.length <= 8) return "****";
    return `${secret.slice(0, Math.min(3, secret.length - 4))}****${secret.slice(-4)}`;
  }
}

export type ProbeCategory = "ok" | "credentials" | "configuration" | "rate-limit" | "upstream" | "network" | "unsupported" | "unknown";
export interface ProbeResult { status: "pass" | "fail"; category: ProbeCategory; detail: string; checkedAt: string; }
export interface ResolvedProfile { profile: LlmProfileRow; version: LlmProfileVersionRow; apiKey: string; }

export interface DiscoveredLlmConfig {
  id: string;
  source: string;
  provider: string;
  protocol: LlmProtocol;
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface DiscoveredLlmConfigView extends Omit<DiscoveredLlmConfig, "apiKey"> {
  maskedKey: string;
}

export interface LlmProviderAdapter {
  protocol: LlmProtocol;
  probe(profile: ResolvedProfile, fetchFn?: LlmFetchLike): Promise<ProbeResult>;
  buildEnvironment(profile: ResolvedProfile): Record<string, string>;
}

export type LlmFetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number }>;

function classify(status: number): ProbeCategory {
  if (status === 401 || status === 403) return "credentials";
  if (status === 404) return "configuration";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "upstream";
  return status >= 200 && status < 300 ? "ok" : "unknown";
}

function endpointFor(profile: LlmProfileRow): string {
  const base = profile.endpoint.replace(/\/+$/, "");
  if (profile.protocol === "anthropic") return /\/v1\/messages$/i.test(base) ? base : `${base}/v1/messages`;
  if (profile.protocol === "gemini") {
    if (/:generateContent$/i.test(base)) return base;
    return /\/v1(?:beta)?\/models$/i.test(base)
      ? `${base}/${encodeURIComponent(profile.model)}:generateContent`
      : `${base}/v1beta/models/${encodeURIComponent(profile.model)}:generateContent`;
  }
  return `${base}/models`;
}

function providerKeyEnvironmentName(provider: string): string | null {
  const normalized = provider.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? `${normalized}_API_KEY` : null;
}

function redactProbeDetail(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|x-api-key|token|secret)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}

function normalizeEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("invalid-llm-endpoint");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => /(?:api[_-]?key|token|secret)/i.test(key))) {
    throw new Error("invalid-llm-endpoint");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** Hermes 自我进化当前仅使用 LiteLLM/OpenAI-compatible 环境变量。 */
export function isHermesProtocolSupported(protocol: LlmProtocol): boolean {
  return protocol === "openai-compatible";
}

export function createProviderAdapter(protocol: LlmProtocol): LlmProviderAdapter {
  return {
    protocol,
    async probe(resolved, fetchFn = (url, init) => fetch(url, init as RequestInit)): Promise<ProbeResult> {
      const checkedAt = new Date().toISOString();
      const headers: Record<string, string> = { "content-type": "application/json" };
      let method = "GET";
      let body: string | undefined;
      if (protocol === "openai-compatible") {
        headers["authorization"] = `Bearer ${resolved.apiKey}`;
      } else if (protocol === "anthropic") {
        method = "POST";
        headers["x-api-key"] = resolved.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        body = JSON.stringify({ model: resolved.profile.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
      } else {
        method = "POST";
        headers["x-goog-api-key"] = resolved.apiKey;
        body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } });
      }
      try {
        const response = await fetchFn(endpointFor(resolved.profile), { method, headers, ...(body === undefined ? {} : { body }) });
        const category = classify(response.status);
        return { status: category === "ok" ? "pass" : "fail", category, detail: category === "ok" ? "模型端点鉴权探针通过" : `模型端点返回 HTTP ${response.status}`, checkedAt };
      } catch (error) {
        return { status: "fail", category: "network", detail: redactProbeDetail(error instanceof Error ? error.message : String(error)), checkedAt };
      }
    },
    buildEnvironment(resolved) {
      const env: Record<string, string> = { OPENAI_API_KEY: resolved.apiKey, OPENAI_BASE_URL: resolved.profile.endpoint, OPENAI_MODEL: resolved.profile.model };
      const providerKey = providerKeyEnvironmentName(resolved.profile.provider);
      if (providerKey !== null) env[providerKey] = resolved.apiKey;
      return env;
    },
  };
}

export interface LlmProfileView extends LlmProfileRow { maskedKey: string; bindingCount: number; probe: ProbeResult | null; }

export class LlmCredentialService {
  constructor(private readonly store: SqliteStore, private readonly vault: SecretVault, private readonly fetchFn?: LlmFetchLike) {}

  private audit(action: string, target: string, detail: Record<string, unknown>): void {
    this.store.appendAudit({ actor: "llm-credentials", action, target, detail });
  }

  private profileDetail(profile: LlmProfileRow): Record<string, string | null> {
    return { provider: profile.provider, protocol: profile.protocol, endpoint: profile.endpoint, model: profile.model, instanceId: profile.instanceId };
  }

  listProfiles(): LlmProfileView[] {
    return this.store.listLlmProfiles().map((profile) => {
      const version = this.store.getLlmProfileVersion(profile.profileId, profile.currentVersion);
      const bindings = this.store.listLlmBindings({ profileId: profile.profileId });
      let maskedKey = "****";
      if (version && this.vault.available) {
        try { maskedKey = this.vault.mask(this.vault.decrypt(version)); } catch { maskedKey = "****"; }
      }
      return { ...profile, maskedKey, bindingCount: bindings.length, probe: version?.probedAt ? { status: version.probeStatus === "pass" ? "pass" : "fail", category: version.probeCategory as ProbeCategory, detail: version.probeDetail, checkedAt: version.probedAt } : null };
    });
  }

  createProfile(input: { profileId: string; instanceId?: string; provider: string; protocol: LlmProtocol; endpoint: string; model: string; apiKey: string }): Promise<LlmProfileView> {
    if (!this.vault.available) return Promise.reject(new Error("secret-vault-unavailable"));
    if (!input.provider.trim() || !input.endpoint.trim() || !input.model.trim() || !input.apiKey) return Promise.reject(new Error("invalid-llm-profile"));
    const profile = this.store.insertLlmProfile({ ...input, endpoint: normalizeEndpoint(input.endpoint), status: "disabled", currentVersion: 1 });
    const encrypted = this.vault.encrypt(input.apiKey);
    this.store.insertLlmProfileVersion({ ...encrypted, profileId: profile.profileId, version: 1 });
    this.audit("llm-profile-created", profile.profileId, this.profileDetail(profile));
    return this.probeProfile(profile.profileId).then(() => this.listProfiles().find((item) => item.profileId === profile.profileId)!);
  }

  async rotateProfile(profileId: string, apiKey: string): Promise<LlmProfileView> {
    if (!this.vault.available) throw new Error("secret-vault-unavailable");
    if (!apiKey) throw new Error("invalid-api-key");
    const profile = this.store.getLlmProfile(profileId);
    if (!profile) throw new Error("profile-not-found");
    const version = Math.max(profile.currentVersion, ...this.store.listLlmProfileVersions(profileId).map((item) => item.version)) + 1;
    const encrypted = this.vault.encrypt(apiKey);
    this.store.insertLlmProfileVersion({ ...encrypted, profileId, version, status: "pending" });
    this.audit("llm-profile-rotation-started", profileId, { version, ...this.profileDetail(profile) });
    const probe = await this.probeProfile(profileId, version);
    if (probe.status === "pass") {
      this.store.updateLlmProfileVersion(profileId, profile.currentVersion, { status: "disabled" });
      this.store.updateLlmProfileVersion(profileId, version, { status: isHermesProtocolSupported(profile.protocol) ? "active" : "disabled" });
      this.store.updateLlmProfile(profileId, { currentVersion: version, status: isHermesProtocolSupported(profile.protocol) ? "active" : "unsupported" });
      this.audit("llm-profile-rotated", profileId, { version, protocol: profile.protocol, probeCategory: probe.category });
    }
    return this.listProfiles().find((item) => item.profileId === profileId)!;
  }

  async probeProfile(profileId: string, version?: number): Promise<ProbeResult> {
    const profile = this.store.getLlmProfile(profileId);
    if (!profile) throw new Error("profile-not-found");
    const selected = this.store.getLlmProfileVersion(profileId, version ?? profile.currentVersion);
    if (!selected) throw new Error("profile-version-not-found");
    if (!this.vault.available) throw new Error("secret-vault-unavailable");
    const adapter = createProviderAdapter(profile.protocol);
    const result = await adapter.probe({ profile, version: selected, apiKey: this.vault.decrypt(selected) }, this.fetchFn);
    const protocolSupported = isHermesProtocolSupported(profile.protocol);
    this.store.updateLlmProfileVersion(profileId, selected.version, { probeStatus: result.status, probeCategory: result.category, probeDetail: redactProbeDetail(result.detail), probedAt: result.checkedAt, status: result.status === "pass" && protocolSupported ? "active" : result.status === "pass" ? "disabled" : selected.status });
    if (result.status === "pass" && selected.version === profile.currentVersion) {
      this.store.updateLlmProfile(profileId, { status: protocolSupported ? "active" : "unsupported" });
    }
    // A failed probe for a pending rotation must not disable the currently
    // active version. Only the active version controls profile availability.
    if (result.status !== "pass" && selected.version === profile.currentVersion) {
      this.store.updateLlmProfile(profileId, { status: result.category === "unsupported" ? "unsupported" : "disabled" });
    }
    this.audit("llm-profile-probed", profileId, { version: selected.version, status: result.status, category: result.category, detail: redactProbeDetail(result.detail) });
    return result;
  }

  disableProfile(profileId: string): LlmProfileView {
    this.store.updateLlmProfile(profileId, { status: "disabled" });
    const profile = this.listProfiles().find((item) => item.profileId === profileId);
    if (!profile) throw new Error("profile-not-found");
    this.audit("llm-profile-disabled", profileId, { protocol: profile.protocol, provider: profile.provider, model: profile.model });
    return profile;
  }

  listBindings(): LlmBindingRow[] { return this.store.listLlmBindings(); }
  addBinding(input: import("./store.js").LlmBindingInput): LlmBindingRow {
    if (!this.store.getLlmProfile(input.profileId)) throw new Error("profile-not-found");
    if ((input.scope === "skill" || input.scope === "plugin" || input.scope === "evolution") && !input.targetRef?.trim()) throw new Error("binding-target-required");
    if (input.scope === "instance" && !input.instanceId?.trim()) throw new Error("binding-instance-required");
    if (input.scope === "framework" && (!input.instanceId?.trim() || !input.frameworkId?.trim())) throw new Error("binding-framework-required");
    const binding = this.store.insertLlmBinding(input);
    this.audit("llm-binding-created", binding.bindingId, { scope: binding.scope, instanceId: binding.instanceId, frameworkId: binding.frameworkId, targetRef: binding.targetRef, profileId: binding.profileId });
    return binding;
  }
  deleteBinding(id: string): boolean {
    const binding = this.store.getLlmBinding(id);
    const deleted = this.store.deleteLlmBinding(id);
    if (deleted) this.audit("llm-binding-deleted", id, binding === undefined ? {} : { scope: binding.scope, instanceId: binding.instanceId, frameworkId: binding.frameworkId, targetRef: binding.targetRef, profileId: binding.profileId });
    return deleted;
  }

  status() {
    const profiles = this.listProfiles();
    const bindings = this.listBindings();
    const activeProfileIds = new Set(
      profiles.filter((item) => item.status === "active" && item.probe?.status === "pass").map((item) => item.profileId),
    );
    const activeBindings = bindings.filter((binding) => activeProfileIds.has(binding.profileId));
    return {
      vault: { available: this.vault.available },
      profiles: profiles.length,
      activeProfiles: profiles.filter((item) => item.status === "active").length,
      bindings: bindings.length,
      activeBindings: activeBindings.length,
      ready: this.vault.available && activeBindings.length > 0,
      blocked: profiles.filter((item) => item.status !== "active").map((item) => ({ profileId: item.profileId, status: item.status, detail: item.probe?.detail ?? "尚未探针" })),
    };
  }

  vaultAvailable(): boolean { return this.vault.available; }

  buildEnvironment(resolved: ResolvedProfile): Record<string, string> {
    return createProviderAdapter(resolved.profile.protocol).buildEnvironment(resolved);
  }

  resolveBinding(input: { instanceId?: string; frameworkId?: string; scope?: LlmBindingScope; targetRef?: string; profileId?: string }): ResolvedProfile | null {
    const bindings = this.store.listLlmBindings().filter((binding) =>
      (binding.instanceId === null || binding.instanceId === input.instanceId) &&
      (binding.frameworkId === null || binding.frameworkId === input.frameworkId),
    );
    const exact = bindings.find((b) => (b.scope === "skill" || b.scope === "plugin" || b.scope === "evolution") && b.targetRef && input.targetRef && b.targetRef === input.targetRef && (b.scope === "evolution" || !input.scope || b.scope === input.scope));
    const framework = bindings.find((b) => b.scope === "framework" && b.frameworkId && input.frameworkId && b.frameworkId === input.frameworkId);
    const instance = bindings.find((b) => b.scope === "instance" && b.instanceId && input.instanceId && b.instanceId === input.instanceId && !b.targetRef);
    const profileId = exact?.profileId ?? framework?.profileId ?? instance?.profileId;
    if (!profileId || (input.profileId !== undefined && input.profileId !== profileId)) return null;
    const profile = this.store.getLlmProfile(profileId);
    if (!profile || profile.status !== "active") return null;
    const version = this.store.getLlmProfileVersion(profileId, profile.currentVersion);
    if (!version || version.status !== "active" || !this.vault.available) return null;
    return { profile, version, apiKey: this.vault.decrypt(version) };
  }

  private discoveryReader?: () => Promise<DiscoveredLlmConfig[]>;

  setDiscoveryReader(reader: () => Promise<DiscoveredLlmConfig[]>): void {
    this.discoveryReader = reader;
  }

  async discover(): Promise<DiscoveredLlmConfigView[]> {
    const rows = this.discoveryReader ? await this.discoveryReader() : [];
    return rows.map((row) => {
      const { apiKey, ...safe } = row;
      return { ...safe, maskedKey: this.vault.mask(apiKey) };
    });
  }

  async importDiscovered(id: string): Promise<LlmProfileView> {
    if (!this.vault.available) throw new Error("secret-vault-unavailable");
    const rows = this.discoveryReader ? await this.discoveryReader() : [];
    const discovered = rows.find((row) => row.id === id);
    if (!discovered) throw new Error("discovered-config-not-found");
    if (!discovered.endpoint.trim() || !discovered.model.trim() || !discovered.apiKey) throw new Error("discovered-config-incomplete");
    const profile = this.store.insertLlmProfile({ profileId: randomUUID(), provider: discovered.provider, protocol: discovered.protocol, endpoint: normalizeEndpoint(discovered.endpoint), model: discovered.model, status: "disabled", currentVersion: 1 });
    const encrypted = this.vault.encrypt(discovered.apiKey);
    this.store.insertLlmProfileVersion({ ...encrypted, profileId: profile.profileId, version: 1, status: "disabled", probeStatus: "unknown", probeCategory: "unknown", probeDetail: "从 Hermes 配置导入，等待手动探针" });
    this.audit("llm-profile-imported", profile.profileId, { source: discovered.source, ...this.profileDetail(profile) });
    return this.listProfiles().find((item) => item.profileId === profile.profileId)!;
  }
}

export function hashMasterKey(masterKey: string): string { return createHash("sha256").update(masterKey).digest("hex"); }
