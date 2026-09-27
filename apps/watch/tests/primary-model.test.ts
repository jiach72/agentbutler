import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SqliteStore, SecretVault, LlmCredentialService } from "@butler/core";
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

describe("Primary Model API (/api/models/primary)", () => {
  let tempDir: string;
  let hermesDir: string;
  let store: SqliteStore;
  let vault: SecretVault;
  let llmService: LlmCredentialService;
  let watchHttp: WatchHttp;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "butler-watch-primary-"));
    hermesDir = join(tempDir, "hermes");
    mkdirSync(hermesDir, { recursive: true });

    // 初始化已有的 config.yaml
    const initialConfig = {
      model: {
        provider: "deepseek",
        default: "deepseek-chat",
        base_url: "https://api.deepseek.com/v1",
      },
    };
    writeFileSync(join(hermesDir, "config.yaml"), JSON.stringify(initialConfig), "utf8");
    writeFileSync(join(hermesDir, ".env"), "DEEPSEEK_API_KEY=sk-test-deepseek\n");

    store = new SqliteStore(join(tempDir, "butler.db"));
    vault = new SecretVault("b".repeat(64));
    llmService = new LlmCredentialService(store, vault);

    const deps = makeStubDeps({
      llm: llmService,
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

  it("GET /api/models/primary 返回当前 config.yaml 中配置的主模型", async () => {
    const res = await fetch(`${baseUrl}/api/models/primary`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.primary.provider).toBe("deepseek");
    expect(json.primary.model).toBe("deepseek-chat");
    expect(json.primary.endpoint).toBe("https://api.deepseek.com/v1");
    expect(json.primary.costCategory).toBe("standard");
  });

  it("POST /api/models/primary 自动创建备份并更新 config.yaml 为本地 Ollama 模型", async () => {
    const res = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        model: "qwen2.5:0.5b",
        endpoint: "http://ollama:11434/v1",
        source: "ollama",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.primary.provider).toBe("ollama");
    expect(json.primary.model).toBe("qwen2.5:0.5b");
    expect(json.primary.costCategory).toBe("free");

    // 验证备份文件已生成
    const files = readdirSync(hermesDir);
    const backupFile = files.find((f) => f.includes("config.yaml.bak-butler-"));
    expect(backupFile).toBeDefined();

    // 验证 config.yaml 内容已更新
    const updatedYaml = readFileSync(join(hermesDir, "config.yaml"), "utf8");
    const parsed = parseYaml(updatedYaml) as {
      model: { provider: string; default: string; base_url: string };
      custom_providers: Array<{ provider: string }>;
    };
    expect(parsed.model.provider).toBe("ollama");
    expect(parsed.model.default).toBe("qwen2.5:0.5b");
    expect(parsed.model.base_url).toBe("http://ollama:11434/v1");
    expect(parsed.custom_providers.some((p) => p.provider === "ollama")).toBe(true);
  });

  it("POST /api/models/primary 带 API Key 时自动同步到 .env", async () => {
    const res = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
        endpoint: "https://api.openai.com/v1",
        source: "credential",
        envVar: "OPENAI_API_KEY",
        apiKey: "sk-proj-test12345",
      }),
    });

    expect(res.status).toBe(200);
    const envContent = readFileSync(join(hermesDir, ".env"), "utf8");
    expect(envContent).toContain("OPENAI_API_KEY=sk-proj-test12345");
  });
});
