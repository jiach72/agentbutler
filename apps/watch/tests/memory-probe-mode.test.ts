/**
 * 关键记忆探针档位测试（成本治理）：
 * recall-only 模式必须零写入——不允许出现 PUT bank / POST memories 这类
 * 会触发提供方侧 LLM 事实抽取的调用（每分钟一次的高频探针靠它控成本）。
 */
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/dashboard-signal.js";
import {
  createHindsightMemoryProbe,
  createMem0MemoryProbe,
} from "../src/probes/memory-providers.js";

const ROOT = "/tmp/probe-mode-test";

type Call = { method: string; url: string };

function recordingFetch(log: Call[]): FetchLike {
  let lastDocumentId = "";
  return (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    log.push({ method, url: String(url) });
    const path = String(url);
    if (path.endsWith("/health")) {
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) } as never;
    }
    if (path.includes("/memories/recall")) {
      // 回显最近一次写入的 document_id（与真实 hindsight 行为一致：按 id 精确归属）
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ document_id: lastDocumentId, text: lastDocumentId }] }),
      } as never;
    }
    if (method === "PUT") {
      return { ok: true, status: 200, json: async () => ({}) } as never;
    }
    if (method === "POST" && /\/memories\/?$/.test(path)) {
      try {
        const parsed = JSON.parse(init?.body ?? "{}") as { items?: Array<{ document_id?: string }>; text?: string };
        lastDocumentId = parsed.items?.[0]?.document_id ?? parsed.text ?? "";
      } catch {
        lastDocumentId = "";
      }
      return { ok: true, status: 200, json: async () => ({ success: true, id: "m1" }) } as never;
    }
    return { ok: true, status: 200, json: async () => [] } as never;
  }) as unknown as FetchLike;
}

function readTextFile(): string | null {
  // 探针从 <root>/hindsight/config.json 读 api_url / bank_id
  return null; // 走显式 baseUrl 覆盖；bank_id 回落默认 hermes
}

const CTX = {
  instanceId: "hermes-main",
  frameworkId: "hermes",
  rootPath: ROOT,
  runtime: "process" as const,
  shared: {},
};

describe("关键记忆探针档位（成本治理）", () => {
  it("hindsight recall-only：零写入，只有 health + recall 两个请求", async () => {
    const log: Call[] = [];
    const probe = createHindsightMemoryProbe({
      baseUrl: "http://127.0.0.1:9177",
      fetchFn: recordingFetch(log),
      readTextFile,
    });
    const result = await probe(CTX, { now: () => Date.now(), removeOwn: true, mode: "recall-only" });
    expect(result.status).toBe("pass");
    const writes = log.filter(
      (call) => call.method === "PUT" || (call.method === "POST" && !call.url.includes("/recall")),
    );
    expect(writes).toEqual([]);
    expect(log.some((call) => call.url.endsWith("/health"))).toBe(true);
    expect(log.some((call) => call.url.includes("/memories/recall"))).toBe(true);
    // detail 明示零写入，审计可读
    expect(result.detail).toContain("零写入");
  });

  it("hindsight full：保持原有写入链路（PUT bank + POST memories）", async () => {
    const log: Call[] = [];
    const probe = createHindsightMemoryProbe({
      baseUrl: "http://127.0.0.1:9177",
      fetchFn: recordingFetch(log),
      readTextFile,
    });
    const result = await probe(CTX, { now: () => Date.now(), removeOwn: true });
    expect(result.status).toBe("pass");
    expect(log.some((call) => call.method === "PUT")).toBe(true);
    expect(log.some((call) => call.method === "POST" && call.url.includes("/memories"))).toBe(true);
  });

  it("mem0 recall-only：只有一次只读检索，零写入零删除", async () => {
    const log: Call[] = [];
    const probe = createMem0MemoryProbe({
      apiKey: "test-key",
      fetchFn: recordingFetch(log),
      readTextFile,
      delay: async () => undefined,
    });
    const result = await probe(CTX, { now: () => Date.now(), removeOwn: true, mode: "recall-only" });
    expect(result.status).toBe("pass");
    expect(log.every((call) => call.method === "POST" && call.url.includes("/search"))).toBe(true);
  });
});
