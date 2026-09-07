/**
 * 外部记忆系统探针 provider 测试：hindsight（bank 内 retain→recall→删库）、
 * mem0（独立 user_id 写入→search→删条目）与按实例路由工厂。
 * 全部 HTTP 经 fake fetch，文件读取经注入，不触网、不触真实实例。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InspectionContext } from "../src/pipeline.js";
import type { FetchLike } from "../src/dashboard-signal.js";
import {
  createHindsightMemoryProbe,
  createMem0MemoryProbe,
  createRoutedMemoryProbeProvider,
  resolveHindsightBaseUrl,
  resolveMem0ApiKey,
} from "../src/probes/memory-providers.js";
import type { MemoryProbeProviderOptions } from "../src/probes/memory-probe.js";

let root: string;
const NOW = 1_800_000_000_000;
const providerOptions: MemoryProbeProviderOptions = { now: () => NOW, removeOwn: true };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watch-memprov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["BUTLER_HERMES_READ_ONLY"];
});

function ctxOf(rootPath = root): InspectionContext {
  return { instanceId: "hermes-main", frameworkId: "hermes", rootPath, runtime: "process", shared: {} };
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

type FakeResult = { status?: number; data?: unknown };

/** 录制调用的 fake fetch：handler 未命中 → 404。 */
function fetchMock(handler: (call: Call) => FakeResult | undefined): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? "GET", body: init?.body };
    calls.push(call);
    const result = handler(call);
    if (result === undefined) return { ok: false, status: 404, json: async () => ({}) };
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.data ?? {} };
  };
  return { fetchFn, calls };
}

/** 从请求体提取 butler-probe 标记词。 */
function markerOf(body: string | undefined): string {
  const match = /butler-probe:[0-9a-f-]+/.exec(body ?? "");
  if (match === null) throw new Error(`请求体缺少探针标记: ${body}`);
  return match[0];
}

function writeHindsightConfig(config: Record<string, unknown>): void {
  mkdirSync(join(root, "hindsight"), { recursive: true });
  writeFileSync(join(root, "hindsight", "config.json"), JSON.stringify(config));
}

const noopDelay = async () => undefined;

/** 真实读取文件（与 provider 默认实现一致），供「从标记文件解析」用例使用。 */
function realReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

describe("resolveHindsightBaseUrl / resolveMem0ApiKey", () => {
  it("hindsight：显式覆盖优先；否则读 config.json 的 api_url；都缺 → error", () => {
    expect(resolveHindsightBaseUrl(root, { baseUrl: "http://override:1/" }, () => null)).toEqual({
      baseUrl: "http://override:1",
    });
    writeHindsightConfig({ api_url: "http://127.0.0.1:9177" });
    expect(resolveHindsightBaseUrl(root, {}, realReadTextFile)).toEqual({
      baseUrl: "http://127.0.0.1:9177",
    });
    expect(resolveHindsightBaseUrl(root, {}, () => null)["error"]).toContain("BUTLER_HINDSIGHT_BASE_URL");
  });

  it("mem0：显式 Key 优先；否则读 config.json 的 api_key；都缺 → error", () => {
    expect(resolveMem0ApiKey(root, { apiKey: "k1" }, () => null)).toEqual({ apiKey: "k1" });
    expect(resolveMem0ApiKey(root, {}, () => null)["error"]).toContain("BUTLER_MEM0_API_KEY");
  });
});

describe("hindsight 记忆探针", () => {
  /** 真实链路形状：retain 记下 document_id，recall 按 document_id 返回抽取后的 fact。 */
  function happyHandler() {
    let storedDocumentId: string | null = null;
    return fetchMock((call) => {
      if (call.url.endsWith("/health")) return { data: { status: "ok" } };
      if (call.method === "PUT" && call.url.includes("/banks/butler-probe")) return { data: {} };
      if (call.method === "POST" && call.url.endsWith("/memories")) {
        const items = JSON.parse(call.body ?? "{}").items as Array<{ document_id?: string }>;
        storedDocumentId = items[0]?.document_id ?? null;
        return { data: { success: true, items_count: 1 } };
      }
      if (call.method === "POST" && call.url.endsWith("/memories/recall")) {
        return {
          data: {
            results:
              storedDocumentId === null
                ? []
                : [{ id: "m1", text: "抽取后的测试事实", document_id: storedDocumentId }],
          },
        };
      }
      return undefined;
    });
  }

  it("happy path：health → 建探针 bank → retain（document_id 标记）→ recall 归属命中 → 删除探针 bank", async () => {
    writeHindsightConfig({ api_url: "http://127.0.0.1:9177" });
    const { fetchFn, calls } = happyHandler();
    // api_url 走默认文件读取（真实 config.json 已写入 tmp root）。
    const probe = createHindsightMemoryProbe({ fetchFn });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("写入并召回成功");
    expect(result.detail).toContain("bank=butler-probe");
    const methods = calls.map((c) => `${c.method} ${c.url}`);
    expect(methods[0]).toBe("GET http://127.0.0.1:9177/health");
    expect(methods.some((m) => m.startsWith("PUT http://127.0.0.1:9177/v1/default/banks/butler-probe"))).toBe(true);
    expect(methods.some((m) => m.endsWith("/v1/default/banks/butler-probe/memories"))).toBe(true);
    // 探针 bank 整库删除（finally 兜底），用户 bank 不被触碰。
    expect(methods[methods.length - 1]).toBe("DELETE http://127.0.0.1:9177/v1/default/banks/butler-probe");
    expect(calls.some((c) => c.url.includes("/banks/hermes"))).toBe(false);
  });

  it("健康检查失败 → fail 并给容器场景提示；不创建也不删除任何 bank", async () => {
    writeHindsightConfig({ api_url: "http://127.0.0.1:9177" });
    const { fetchFn, calls } = fetchMock((call) => {
      if (call.url.endsWith("/health")) return { status: 503 };
      return undefined;
    });
    const probe = createHindsightMemoryProbe({ fetchFn });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("hindsight 服务不可达");
    expect(result.detail).toContain("BUTLER_HINDSIGHT_BASE_URL");
    expect(calls.filter((c) => c.method === "PUT" || c.method === "DELETE")).toHaveLength(0);
  });

  it("召回未命中（结果不归属探针 document_id）→ fail；探针 bank 仍被清理", async () => {
    writeHindsightConfig({ api_url: "http://127.0.0.1:9177" });
    const { fetchFn, calls } = fetchMock((call) => {
      if (call.url.endsWith("/health")) return { data: {} };
      if (call.method === "PUT") return { data: {} };
      if (call.method === "POST" && call.url.endsWith("/memories")) {
        return { data: { success: true, items_count: 1 } };
      }
      if (call.method === "POST" && call.url.endsWith("/memories/recall")) {
        return { data: { results: [{ id: "x", text: "无关内容", document_id: "someone-else" }] } };
      }
      return undefined;
    });
    const probe = createHindsightMemoryProbe({ fetchFn });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("未能召回刚写入的探针记忆");
    expect(calls[calls.length - 1].method).toBe("DELETE");
  });

  it("config.json 缺 api_url 且无覆盖 → skipped（降级明示，不误报故障）", async () => {
    const probe = createHindsightMemoryProbe({ fetchFn: fetchMock(() => undefined).fetchFn, readTextFile: () => null });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("无法确定 hindsight 服务地址");
  });
});

describe("mem0 记忆探针", () => {
  function writeMem0Config(): void {
    mkdirSync(join(root, "mem0"), { recursive: true });
    writeFileSync(join(root, "mem0", "config.json"), JSON.stringify({ api_key: "mk-test" }));
  }

  it("happy path：add → search 命中 → 删除测试记忆", async () => {
    writeMem0Config();
    let memoryId = "";
    const { fetchFn, calls } = fetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/v1/memories/")) {
        memoryId = "mem-1";
        return { data: { id: memoryId, memory: markerOf(call.body) } };
      }
      if (call.method === "POST" && call.url.endsWith("/v2/memories/search/")) {
        return { data: [{ id: memoryId, memory: `${markerOf(call.body)} 写入召回测试` }] };
      }
      return undefined;
    });
    const probe = createMem0MemoryProbe({ fetchFn, delay: noopDelay });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("user_id=butler-probe");
    expect(calls[calls.length - 1].method).toBe("DELETE");
    expect(calls[calls.length - 1].url).toContain("/v1/memories/mem-1");
  });

  it("索引延迟：第一次 search 未命中、重试命中，只算 pass", async () => {
    writeMem0Config();
    let attempt = 0;
    const { fetchFn } = fetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/v1/memories/")) {
        return { data: { id: "mem-2" } };
      }
      if (call.method === "POST" && call.url.endsWith("/v2/memories/search/")) {
        attempt += 1;
        return attempt === 1
          ? { data: [] }
          : { data: [{ id: "mem-2", memory: markerOf(call.body) }] };
      }
      return undefined;
    });
    const probe = createMem0MemoryProbe({ fetchFn, delay: noopDelay });
    expect(await probe(ctxOf(), providerOptions)).toMatchObject({ status: "pass" });
  });

  it("重试耗尽仍未命中 → fail", async () => {
    writeMem0Config();
    const { fetchFn } = fetchMock((call) => {
      if (call.method === "POST" && call.url.endsWith("/v1/memories/")) {
        return { data: { id: "mem-3" } };
      }
      if (call.method === "POST" && call.url.endsWith("/v2/memories/search/")) {
        return { data: [] };
      }
      return undefined;
    });
    const probe = createMem0MemoryProbe({ fetchFn, delay: noopDelay });
    const result = await probe(ctxOf(), providerOptions);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("未能召回刚写入的标记");
  });

  it("无 API Key → skipped", async () => {
    const probe = createMem0MemoryProbe({ fetchFn: fetchMock(() => undefined).fetchFn, readTextFile: () => null });
    expect(await probe(ctxOf(), providerOptions)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("mem0 API Key"),
    });
  });
});

describe("路由工厂 createRoutedMemoryProbeProvider", () => {
  it("auto + hindsight 标记 → 分发到 hindsight 探针", async () => {
    writeHindsightConfig({ api_url: "http://127.0.0.1:9177" });
    let storedDocumentId: string | null = null;
    const { fetchFn, calls } = fetchMock((call) => {
      if (call.url.endsWith("/health")) return { data: {} };
      if (call.method === "PUT") return { data: {} };
      if (call.method === "POST" && call.url.endsWith("/memories")) {
        const items = JSON.parse(call.body ?? "{}").items as Array<{ document_id?: string }>;
        storedDocumentId = items[0]?.document_id ?? null;
        return { data: { success: true } };
      }
      if (call.method === "POST" && call.url.endsWith("/memories/recall")) {
        return {
          data: { results: [{ id: "m", text: "抽取事实", document_id: storedDocumentId }] },
        };
      }
      return undefined;
    });
    const provider = createRoutedMemoryProbeProvider({ fetchFn, delay: noopDelay });
    const result = await provider(ctxOf(), providerOptions);
    expect(result.status).toBe("pass");
    expect(calls.some((c) => c.url.endsWith("/health"))).toBe(true);
  });

  it("auto + 显式 env mem0 + 无 Key → skipped（env 声明优先于标记缺失）", async () => {
    const provider = createRoutedMemoryProbeProvider({
      configured: "mem0",
      fetchFn: fetchMock(() => undefined).fetchFn,
      readTextFile: () => null,
    });
    const result = await provider(ctxOf(), providerOptions);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("mem0 API Key");
  });

  it("auto + 无标记 → 回落默认 SQLite 探针（removeOwn 透传）", async () => {
    const fallbackCalls: Array<{ rootPath: string; removeOwn: boolean }> = [];
    const provider = createRoutedMemoryProbeProvider({
      fallbackSqlite: async (ctx, options) => {
        fallbackCalls.push({ rootPath: ctx.rootPath, removeOwn: options.removeOwn });
        return { status: "pass", detail: "sqlite-fallback" };
      },
    });
    const result = await provider(ctxOf(), providerOptions);
    expect(result).toEqual({ status: "pass", detail: "sqlite-fallback" });
    expect(fallbackCalls).toEqual([{ rootPath: root, removeOwn: true }]);
  });

  it("默认 SQLite 回落 + 注入 opener：对真实 FTS5 fixture 完成写入召回（即删）", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(root, "memory_store.db");
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TABLE facts (
        fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL UNIQUE,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '',
        trust_score REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id, tokenize='trigram');
      CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content, tags) VALUES (new.fact_id, new.content, new.tags);
      END;
    `);
    setup.close();
    const provider = createRoutedMemoryProbeProvider({
      sqlite: (path) => new DatabaseSync(path) as unknown as import("../src/probes/memory-probe.js").SqliteDbLike,
      now: () => NOW,
    });
    const result = await provider(ctxOf(), providerOptions);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("写入并召回成功");
    expect(result.detail).toContain("本次测试行已清理");
  });

  it("只读挂载（容器部署常态）：默认后端 skipped，不因路由变成写失败", async () => {
    process.env["BUTLER_HERMES_READ_ONLY"] = "true";
    const provider = createRoutedMemoryProbeProvider({});
    const result = await provider(ctxOf(), providerOptions);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("只读");
  });
});
