import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore, SecretVault, ApiKeyCredentialService } from "@butler/core";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

function makeStubDeps(overrides: Partial<WatchHttpDeps> = {}): WatchHttpDeps {
  return {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "started", instanceId: "test" }),
    upgrade: {
      startUpgrade: () => ({ status: "missing-target-version" }),
      status: () => null,
      listVersions: async () => ({ reachable: false, versions: [] }),
      rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    },
    ...overrides,
  };
}

describe("Credentials API (/api/credentials)", () => {
  let tempDir: string;
  let hermesDir: string;
  let store: SqliteStore;
  let vault: SecretVault;
  let credService: ApiKeyCredentialService;
  let watchHttp: WatchHttp;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "butler-watch-creds-"));
    hermesDir = join(tempDir, "hermes");
    mkdirSync(hermesDir, { recursive: true });
    writeFileSync(join(hermesDir, ".env"), "# Initial env\nEXISTING=1\n");

    store = new SqliteStore(join(tempDir, "butler.db"));
    vault = new SecretVault("b".repeat(64));
    credService = new ApiKeyCredentialService(store, vault);

    const deps = makeStubDeps({
      apiKeyCredentials: credService,
      hermesRoot: hermesDir,
    });

    watchHttp = startWatchHttp(deps, { host: "127.0.0.1", port: 0, credentialWritesAllowed: true });
    const addr = await watchHttp.start();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    watchHttp.close();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /api/credentials 返回列表与预设服务模板", async () => {
    const res = await fetch(`${baseUrl}/api/credentials`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.credentials)).toBe(true);
    expect(Array.isArray(json.presets)).toBe(true);
    expect(json.presets.some((p: { envVar: string }) => p.envVar === "TAVILY_API_KEY")).toBe(true);
    expect(json.presets.some((p: { envVar: string }) => p.envVar === "GOOGLE_API_KEY")).toBe(true);
  });

  it("POST /api/credentials 创建密钥，加密存储并自动同步到 ~/.hermes/.env", async () => {
    const res = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Tavily Search",
        category: "search",
        envVar: "TAVILY_API_KEY",
        provider: "tavily",
        apiKey: "tvly-test-key-123456",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.credential.name).toBe("Tavily Search");
    expect(json.credential.maskedKey).toContain("****");

    // 验证 ~/.hermes/.env 自动同步
    const envContent = readFileSync(join(hermesDir, ".env"), "utf8");
    expect(envContent).toContain('TAVILY_API_KEY="tvly-test-key-123456"');
    expect(envContent).toContain("EXISTING=1");
  });

  it("credentialWritesAllowed 为 false 时阻断 POST / DELETE 操作", async () => {
    // 启动一个不允许写入的只读实例
    const readOnlyDeps = makeStubDeps({
      apiKeyCredentials: credService,
      hermesRoot: hermesDir,
    });
    const readOnlyHttp = startWatchHttp(readOnlyDeps, {
      host: "127.0.0.1",
      port: 0,
      credentialWritesAllowed: false,
    });
    const addr = await readOnlyHttp.start();
    const roUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const postRes = await fetch(`${roUrl}/api/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          category: "custom",
          envVar: "TEST_KEY",
          provider: "test",
          apiKey: "sk-123",
        }),
      });
      expect(postRes.status).toBe(403);
      const postJson = await postRes.json();
      expect(postJson.error).toBe("credential-writes-require-loopback");

      const delRes = await fetch(`${roUrl}/api/credentials/any-id`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(403);
    } finally {
      readOnlyHttp.close();
    }
  });

  it("POST /api/credentials/test 进行轻量连通性测试", async () => {
    const res = await fetch(`${baseUrl}/api/credentials/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        apiKey: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.probe).toBeDefined();
    expect(json.probe.status).toBe("pass");
  });

  it("DELETE /api/credentials/:id 删除密钥并从 ~/.hermes/.env 中清理", async () => {
    // 1. 先保存一个 Key
    const saveRes = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Exa Search",
        category: "search",
        envVar: "EXA_API_KEY",
        provider: "exa",
        apiKey: "exa-secret-999",
      }),
    });
    const { credential } = await saveRes.json();
    expect(readFileSync(join(hermesDir, ".env"), "utf8")).toContain('EXA_API_KEY="exa-secret-999"');

    // 2. 删除
    const delRes = await fetch(`${baseUrl}/api/credentials/${credential.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    // 3. 检查列表与文件已清理
    const listRes = await fetch(`${baseUrl}/api/credentials`);
    const listJson = await listRes.json();
    expect(listJson.credentials.length).toBe(0);

    const envContentAfter = readFileSync(join(hermesDir, ".env"), "utf8");
    expect(envContentAfter).not.toContain('EXA_API_KEY="exa-secret-999"');
  });
});
