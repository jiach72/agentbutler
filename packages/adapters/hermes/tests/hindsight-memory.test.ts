/**
 * hindsight 只读记忆驱动测试：stats/preview 的字段映射、q 检索透传、
 * 服务不可达的 E302 降级与写操作 E403；全部 HTTP 经 fake fetch。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHindsightMemoryDriver } from "../src/drivers/hindsight-memory.js";
import type { DriverScope } from "@butler/contract";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermes-hsdrv-"));
  mkdirSync(join(root, "hindsight"), { recursive: true });
  writeFileSync(join(root, "hindsight", "config.json"), JSON.stringify({ api_url: "http://127.0.0.1:9177", bank_id: "hermes" }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const scope = (): DriverScope => ({
  instance: { instanceId: "hermes-main", rootPath: root, runtime: "process" },
  rootPath: root,
});

interface Call { url: string; method: string }

function fetchMock(handler: (call: Call) => { status?: number; data?: unknown } | undefined): {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET" };
    calls.push(call);
    const result = handler(call);
    if (result === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(result.data ?? {}), { status: result.status ?? 200 });
  }) as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>;
  return { fetch, calls };
}

function driverOf(fetch: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return createHindsightMemoryDriver({ fetchFn: fetch as never, now: () => 1_800_000_000_000 });
}

describe("hindsight 只读记忆驱动", () => {
  it("stats：totalNodes → totalEntries，最新记忆 mentioned_at → lastWriteAt", async () => {
    const { fetch } = fetchMock((call) => {
      if (call.url.endsWith("/memories/list?limit=1")) {
        return { data: { items: [{ id: "m1", text: "事实文本", mentioned_at: "2026-09-07T01:01:36.244647+00:00", state: "valid" }], total: 3620 } };
      }
      if (call.url.endsWith("/stats")) {
        return { data: { total_nodes: 3620, total_documents: 177, failed_operations: 0 } };
      }
      return undefined;
    });
    const result = await driverOf(fetch).stats(scope());
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      totalEntries: 3620,
      lastWriteAt: "2026-09-07T01:01:36.244Z",
      byMonth: [],
      probeEntries: 0,
    });
  });

  it("preview：list 映射为 MemoryEntry，q 透传关键词，limit 钳制在 50 内", async () => {
    const { fetch, calls } = fetchMock((call) => {
      const url = new URL(call.url);
      const limit = Number(url.searchParams.get("limit") ?? "0");
      const items = Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
        id: `m${i}`,
        text: `记忆内容 ${i}`,
        mentioned_at: "2026-09-06T10:00:00+00:00",
        state: "valid",
      }));
      return { data: { items, total: 2 } };
    });
    const result = await driverOf(fetch).preview(scope(), { keyword: "微信", limit: 80 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toHaveLength(2);
    expect(result.ok && result.data![0]).toMatchObject({ entryId: "m0", content: "记忆内容 0" });
    expect(result.ok && result.data![0]!.writtenAt).toBe("2026-09-06T10:00:00.000Z");
    const listCall = calls.find((c) => c.url.includes("/memories/list"));
    expect(listCall).toBeDefined();
    const url = new URL(listCall!.url);
    expect(url.searchParams.get("q")).toBe("微信");
    expect(Number(url.searchParams.get("limit"))).toBe(50);
  });

  it("preview：非 valid 状态的记忆不进预览", async () => {
    const { fetch } = fetchMock(() => ({
      data: {
        items: [
          { id: "m1", text: "有效", state: "valid" },
          { id: "m2", text: "已失效", state: "invalidated" },
        ],
        total: 2,
      },
    }));
    const result = await driverOf(fetch).preview(scope(), {});
    expect(result.ok && result.data).toHaveLength(1);
    expect(result.ok && result.data![0]!.entryId).toBe("m1");
  });

  it("服务不可达 → E302 fail，userHint 指向 BUTLER_HINDSIGHT_BASE_URL", async () => {
    const { fetch } = fetchMock(() => undefined);
    const result = await driverOf(fetch).stats(scope());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error!.code).toBe("E302");
    expect(result.ok === false && result.error!.userHint).toContain("BUTLER_HINDSIGHT_BASE_URL");
  });

  it("config.json 缺 api_url 且无覆盖 → E402", async () => {
    rmSync(join(root, "hindsight", "config.json"));
    const { fetch } = fetchMock(() => undefined);
    const result = await driverOf(fetch).stats(scope());
    expect(result.ok === false && result.error!.code).toBe("E402");
  });

  it("写操作（归档/恢复/清理/重建索引）→ E403 只读语义", async () => {
    const { fetch } = fetchMock(() => undefined);
    const driver = driverOf(fetch);
    const results = [
      await driver.archiveCold(scope, { dryRun: true }),
      await driver.restoreCold(scope, {}),
      await driver.purge(scope, { confirmed: true }),
      await driver.rebuildIndex(scope),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error!.code).toBe("E403");
    }
  });

  it("analyze：后台操作失败时给出 warn 信号与降分", async () => {
    const { fetch } = fetchMock((call) => {
      if (call.url.endsWith("/stats")) return { data: { total_nodes: 10, failed_operations: 5 } };
      return { data: { items: [], total: 0 } };
    });
    const result = await driverOf(fetch).analyze(scope());
    expect(result.ok).toBe(true);
    expect(result.ok && result.data!.score).toBe(70);
    expect(result.ok && result.data!.signals.some((s) => s.status === "warn")).toBe(true);
  });
});
