import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { SecretVault } from "../src/llm-credentials.js";
import { ApiKeyCredentialService } from "../src/api-credentials.js";

describe("ApiKeyCredentialService", () => {
  let tempDir: string;
  let store: SqliteStore;
  let vault: SecretVault;
  let service: ApiKeyCredentialService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "butler-creds-test-"));
    store = new SqliteStore(join(tempDir, "butler.db"));
    vault = new SecretVault("a".repeat(64));
    service = new ApiKeyCredentialService(store, vault);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("支持新增、更新、查询、掩码展示与删除", () => {
    // 1. 新增 Tavily Key
    const created = service.saveCredential({
      name: "Tavily Search",
      category: "search",
      envVar: "TAVILY_API_KEY",
      provider: "tavily",
      apiKey: "tvly-secret-12345678",
    });

    expect(created.name).toBe("Tavily Search");
    expect(created.envVar).toBe("TAVILY_API_KEY");
    expect(created.maskedKey).toContain("****");
    expect(created.maskedKey).not.toBe("tvly-secret-12345678");
    expect(created.isPreset).toBe(true);

    // 2. 获取解密后的明文
    const decrypted = service.getDecryptedKey(created.id);
    expect(decrypted).toBe("tvly-secret-12345678");

    // 3. 列出全部
    const list = service.listCredentials();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(created.id);

    // 4. 更新 Key
    const updated = service.saveCredential({
      id: created.id,
      name: "Tavily Search Pro",
      category: "search",
      envVar: "TAVILY_API_KEY",
      provider: "tavily",
      apiKey: "tvly-new-87654321",
    });
    expect(updated.name).toBe("Tavily Search Pro");
    expect(service.getDecryptedKey(created.id)).toBe("tvly-new-87654321");

    // 5. 更新探针状态
    service.updateProbe(created.id, "pass", "ok", "HTTP 200 OK");
    const afterProbe = service.listCredentials()[0]!;
    expect(afterProbe.probeStatus).toBe("pass");
    expect(afterProbe.probeDetail).toBe("HTTP 200 OK");

    // 6. 删除
    expect(service.deleteCredential(created.id)).toBe(true);
    expect(service.listCredentials().length).toBe(0);
  });

  it("非法环境变量名称或空 Key 会抛出明确异常", () => {
    expect(() =>
      service.saveCredential({
        name: "Test",
        category: "custom",
        envVar: "invalid-key!",
        provider: "test",
        apiKey: "sk-123",
      }),
    ).toThrow("invalid-env-var-name");

    expect(() =>
      service.saveCredential({
        name: "Test",
        category: "custom",
        envVar: "VALID_KEY",
        provider: "test",
        apiKey: "   ",
      }),
    ).toThrow("empty-api-key");

    // 引号/反斜杠/换行会破坏 .env 双引号配对甚至注入新环境变量行（中等-2）。
    for (const bad of ['abc"def', "abc\\def", "abc\nEVIL=x", "abc\rdef"]) {
      expect(() =>
        service.saveCredential({
          name: "Test",
          category: "custom",
          envVar: "VALID_KEY",
          provider: "test",
          apiKey: bad,
        }),
      ).toThrow("invalid-api-key-characters");
    }
  });

  it("autoMigrateFromHermesEnv 能够自动发现并强制接管 ~/.hermes/.env 中的历史 Key", async () => {
    const hermesDir = join(tempDir, "hermes");
    mkdirSync(hermesDir, { recursive: true });
    const envFile = join(hermesDir, ".env");

    writeFileSync(
      envFile,
      [
        "# Hermes custom settings",
        "PORT=8000",
        'TAVILY_API_KEY="tvly-mock-key-123"',
        "GOOGLE_API_KEY=google-vision-key-456",
        'MY_CUSTOM_TOKEN="secret-token-789"',
        "# Comments should be preserved",
      ].join("\n"),
    );

    const result = await service.autoMigrateFromHermesEnv(hermesDir);
    expect(result.migratedCount).toBe(3);
    expect(result.keys).toContain("TAVILY_API_KEY");
    expect(result.keys).toContain("GOOGLE_API_KEY");
    expect(result.keys).toContain("MY_CUSTOM_TOKEN");

    const creds = service.listCredentials();
    expect(creds.length).toBe(3);

    const tavily = creds.find((c) => c.envVar === "TAVILY_API_KEY")!;
    expect(tavily.category).toBe("search");
    expect(service.getDecryptedKey(tavily.id)).toBe("tvly-mock-key-123");

    const google = creds.find((c) => c.envVar === "GOOGLE_API_KEY")!;
    expect(google.category).toBe("vision");
    expect(service.getDecryptedKey(google.id)).toBe("google-vision-key-456");

    const custom = creds.find((c) => c.envVar === "MY_CUSTOM_TOKEN")!;
    expect(custom.category).toBe("tool");
    expect(service.getDecryptedKey(custom.id)).toBe("secret-token-789");

    // 再次调用幂等，不重复迁移
    const secondResult = await service.autoMigrateFromHermesEnv(hermesDir);
    expect(secondResult.migratedCount).toBe(0);
  });

  it("syncToHermesEnv 能够原子同步回写至 .env 并保留原有注释且保持 0600 权限", async () => {
    const hermesDir = join(tempDir, "hermes");
    mkdirSync(hermesDir, { recursive: true });
    const envFile = join(hermesDir, ".env");

    writeFileSync(
      envFile,
      [
        "# Pre-existing Hermes config",
        "EXISTING_UNMANAGED_VAR=true",
        'TAVILY_API_KEY="old-key"',
      ].join("\n"),
    );

    // 在受管库中保存新的 Brave 和更新的 Tavily
    service.saveCredential({
      name: "Tavily Search",
      category: "search",
      envVar: "TAVILY_API_KEY",
      provider: "tavily",
      apiKey: "new-tavily-secret",
    });

    service.saveCredential({
      name: "Brave Search",
      category: "search",
      envVar: "BRAVE_API_KEY",
      provider: "brave",
      apiKey: "brave-key-abc",
    });

    const syncRes = await service.syncToHermesEnv(hermesDir);
    expect(syncRes.updated).toBe(2);

    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("EXISTING_UNMANAGED_VAR=true");
    expect(content).toContain('TAVILY_API_KEY="new-tavily-secret"');
    expect(content).toContain('BRAVE_API_KEY="brave-key-abc"');
    expect(existsSync(join(hermesDir, ".env.bak"))).toBe(true);

    if (process.platform !== "win32") {
      const mode = statSync(envFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("syncToHermesEnv 对存量特殊值转义引号、跳过控制字符值，不注入新行", async () => {
    const hermesDir = join(tempDir, "hermes");
    mkdirSync(hermesDir, { recursive: true });
    const envFile = join(hermesDir, ".env");
    // 存量 .env（迁移前）里就可能有含引号/制表符的历史值：迁移接管后
    // 同步回写时必须保持行结构，不允许破坏引号配对或注入新行。
    writeFileSync(
      envFile,
      ['LEGACY_API_KEY=has"quote', "CONTROL_KEY=abc\tdef"].join("\n"),
    );

    const migrated = await service.autoMigrateFromHermesEnv(hermesDir);
    expect(migrated.migratedCount).toBe(2);

    service.saveCredential({
      name: "Fresh",
      category: "custom",
      envVar: "FRESH_KEY",
      provider: "test",
      apiKey: "safe-value",
    });

    const syncRes = await service.syncToHermesEnv(hermesDir);
    expect(syncRes.updated).toBe(3);

    const content = readFileSync(envFile, "utf8");
    // 双引号被转义，引号配对不被破坏。
    expect(content).toContain('LEGACY_API_KEY="has\\"quote"');
    // 含控制字符的存量值不落盘（保存入口已拒绝新值），留注释待人工处理。
    expect(content).toContain("# CONTROL_KEY (skipped: value contains control characters)");
    expect(content).toContain('FRESH_KEY="safe-value"');
    // 换行注入不会改变既有行的行数语义（每行仍是 KEY=value 或注释）。
    for (const line of content.split("\n")) {
      expect(line === "" || line.startsWith("#") || /^[A-Z][A-Z0-9_]*=/.test(line)).toBe(true);
    }
  });
});
