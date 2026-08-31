import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmCredentialService, SecretVault, createProviderAdapter } from "../src/llm-credentials.js";
import { SqliteStore } from "../src/store.js";
import { makeTempDir, rmTempDir } from "./helpers.js";

describe("SecretVault", () => {
  it("使用 AES-256-GCM 加密解密，主密钥缺失时 fail-closed", () => {
    const vault = new SecretVault("a".repeat(64));
    expect(vault.available).toBe(true);
    const envelope = vault.encrypt("sk-live-secret");
    expect(envelope.ciphertext).not.toContain("sk-live-secret");
    expect(vault.decrypt(envelope)).toBe("sk-live-secret");
    expect(vault.mask("sk-live-secret")).toBe("sk-****cret");
    expect(new SecretVault().available).toBe(false);
    expect(new SecretVault("not-a-valid-master-key").available).toBe(false);
    expect(() => new SecretVault().encrypt("secret")).toThrow("secret-vault-unavailable");
  });

  it("密文被篡改时拒绝解密", () => {
    const vault = new SecretVault("b".repeat(64));
    const envelope = vault.encrypt("secret");
    const tampered = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => vault.decrypt({ ...envelope, ciphertext: tampered })).toThrow();
  });
});

describe("LlmCredentialService", () => {
  let tmp: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "butler.db"));
  });
  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it.each([
    [401, "credentials"], [403, "credentials"], [404, "configuration"],
    [429, "rate-limit"], [500, "upstream"],
  ] as const)("探针把 HTTP %s 分类为 %s", async (status, category) => {
    const profile = store.insertLlmProfile({ profileId: "p1", provider: "OpenAI", protocol: "openai-compatible", endpoint: "https://llm.test/v1", model: "m", status: "disabled", currentVersion: 1 });
    const vault = new SecretVault("c".repeat(64));
    const encrypted = vault.encrypt("sk-test");
    const version = store.insertLlmProfileVersion({ ...encrypted, profileId: profile.profileId, version: 1 });
    const result = await createProviderAdapter("openai-compatible").probe({ profile, version, apiKey: "sk-test" }, async () => ({ status }));
    expect(result).toMatchObject({ status: "fail", category });
  });

  it("创建、轮换和精确绑定；轮换失败保留旧 active", async () => {
    let status = 200;
    const vault = new SecretVault("d".repeat(64));
    const service = new LlmCredentialService(store, vault, async () => ({ status }));
    const created = await service.createProfile({ profileId: "p1", provider: "OpenAI", protocol: "openai-compatible", endpoint: "https://llm.test/v1", model: "m", instanceId: "hermes-main", apiKey: "sk-old" });
    expect(created.status).toBe("active");
    service.addBinding({ bindingId: "b-instance", scope: "instance", instanceId: "hermes-main", frameworkId: "hermes", profileId: "p1" });
    service.addBinding({ bindingId: "b-skill", scope: "skill", instanceId: "hermes-main", frameworkId: "hermes", targetRef: "demo", profileId: "p1" });
    expect(service.resolveBinding({ instanceId: "hermes-main", frameworkId: "hermes", scope: "skill", targetRef: "demo" })?.apiKey).toBe("sk-old");
    status = 401;
    const failed = await service.rotateProfile("p1", "sk-new");
    expect(failed.status).toBe("active");
    expect(service.resolveBinding({ instanceId: "hermes-main", frameworkId: "hermes", scope: "skill", targetRef: "demo" })?.apiKey).toBe("sk-old");
    status = 200;
    const rotated = await service.rotateProfile("p1", "sk-new");
    expect(rotated.maskedKey).toBe("****");
    expect(service.resolveBinding({ instanceId: "hermes-main", frameworkId: "hermes", scope: "skill", targetRef: "demo" })?.apiKey).toBe("sk-new");
  });

  it("发现配置只返回掩码视图，不泄露 apiKey", async () => {
    const service = new LlmCredentialService(store, new SecretVault("e".repeat(64)));
    service.setDiscoveryReader(async () => [{ id: "d1", source: "/home/jiach/.hermes", provider: "OpenAI", protocol: "openai-compatible", endpoint: "https://llm.test/v1", model: "m", apiKey: "sk-discovered" }]);
    const rows = await service.discover();
    expect(rows[0]).toMatchObject({ id: "d1", maskedKey: "sk-****ered" });
    expect("apiKey" in (rows[0] as object)).toBe(false);
    const imported = await service.importDiscovered("d1");
    expect(imported.status).toBe("disabled");
    expect(imported.maskedKey).toBe("sk-****ered");
  });

  it("运行时模型观测只读展示，不能被当作凭据导入", async () => {
    const service = new LlmCredentialService(store, new SecretVault("f".repeat(64)));
    service.setDiscoveryReader(async () => [{
      id: "runtime-log",
      source: "/home/jiach/.hermes/logs/agent.log",
      provider: "Hermes runtime",
      protocol: "openai-compatible",
      endpoint: "",
      model: "deepseek-v4-flash-vision-exp",
      apiKey: "",
      importable: false,
      runtimeObserved: true,
    }]);

    await expect(service.discover()).resolves.toEqual([
      expect.objectContaining({
        id: "runtime-log",
        maskedKey: "—",
        importable: false,
      }),
    ]);
    await expect(service.importDiscovered("runtime-log")).rejects.toThrow(
      "discovered-runtime-observation",
    );
  });
});
