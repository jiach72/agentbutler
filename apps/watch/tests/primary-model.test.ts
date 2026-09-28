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
  let runbookCalls: string[];
  let runbookOutcome: "started" | "unknown-runbook" | "throw";

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

    runbookCalls = [];
    runbookOutcome = "started";

    const deps = makeStubDeps({
      llm: llmService,
      hermesRoot: hermesDir,
      executeRunbook: async (id: string) => {
        runbookCalls.push(id);
        if (runbookOutcome === "throw") throw new Error("runbook boom");
        return runbookOutcome === "started"
          ? { status: "started", instanceId: "test" }
          : { status: "unknown-runbook" };
      },
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

  // P1 空开关回归：面板勾选「立即优雅重启」后必须真的走 rb-restart，
  // 且响应如实返回 restarted——UI 靠它兑现「即刻生效」的承诺。
  it("POST restartNow:true 执行 rb-restart 优雅重启并返回 restarted:true", async () => {
    const res = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
        endpoint: "https://api.openai.com/v1",
        source: "credential",
        restartNow: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.restarted).toBe(true);
    expect(runbookCalls).toEqual(["rb-restart"]);
  });

  it("POST 不带 restartNow 时不触发重启，restarted 为 false", async () => {
    const res = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.restarted).toBe(false);
    expect(runbookCalls).toEqual([]);
  });

  it("POST restartNow:true 但重启失败时仍成功保存且如实返回 restarted:false", async () => {
    runbookOutcome = "unknown-runbook";
    const resUnknown = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o", restartNow: true }),
    });
    expect(resUnknown.status).toBe(200);
    expect((await resUnknown.json()).restarted).toBe(false);

    runbookOutcome = "throw";
    const resThrow = await fetch(`${baseUrl}/api/models/primary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o", restartNow: true }),
    });
    expect(resThrow.status).toBe(200);
    expect((await resThrow.json()).restarted).toBe(false);

    // 两次保存都真实落盘（重启失败不回滚配置写入）
    const parsed = parseYaml(readFileSync(join(hermesDir, "config.yaml"), "utf8")) as {
      model: { default: string };
    };
    expect(parsed.model.default).toBe("gpt-4o");
    expect(runbookCalls).toEqual(["rb-restart", "rb-restart"]);
  });
});
