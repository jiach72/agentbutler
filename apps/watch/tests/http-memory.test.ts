import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ArchivePolicy,
  PurgePolicy,
  RestorePolicy,
} from "@butler/contract";
import type { MemoryActionResult, SkillsMemoryService } from "../src/skills.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { MemorySelfCheckOutcome } from "../src/http.js";

function makeDeps(): {
  deps: WatchHttpDeps;
  archiveCalls: ArchivePolicy[];
  restoreCalls: RestorePolicy[];
  purgeCalls: PurgePolicy[];
  selfCheckCalls: Array<string | undefined>;
} {
  const archiveCalls: ArchivePolicy[] = [];
  const restoreCalls: RestorePolicy[] = [];
  const purgeCalls: PurgePolicy[] = [];
  const selfCheckCalls: Array<string | undefined> = [];
  const skills: SkillsMemoryService = {
    status: async () => ({
      instance: { instanceId: "hermes-main", frameworkId: "hermes", state: "Serving", version: "0.20.4" },
      skills: { mode: "driver", driverId: "hermes-skill", total: 0, items: [], directory: { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false }, notice: "" },
      memory: {
        mode: "driver",
        driverId: "sqlite-fts5",
        stats: null,
        health: null,
        preview: [],
        previewLimit: 50,
        writeActivity: { status: "unknown", detail: "" },
        directory: { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false },
        notice: "",
      },
    }),
    analyze: async () => ({ ok: true, instanceId: "hermes-main" }),
    archiveCold: async (_query, policy) => {
      archiveCalls.push(policy);
      return { ok: true, instanceId: "hermes-main", report: { archived: 3, freedBytes: 120, dryRun: policy.dryRun ?? false, errors: [] } };
    },
    restoreCold: async (_query, policy) => {
      restoreCalls.push(policy);
      return { ok: true, instanceId: "hermes-main", report: { restored: 2, errors: [] } };
    },
    purge: async (_query, policy) => {
      purgeCalls.push(policy);
      if (policy.confirmed !== true) {
        const result: MemoryActionResult = {
          ok: false,
          instanceId: "hermes-main",
          code: "E002",
          error: "purge requires confirmed: true",
          userHint: "需要先确认",
        };
        return result;
      }
      return { ok: true, instanceId: "hermes-main", report: { purged: 1, freedBytes: 40, errors: [] } };
    },
    rebuildIndex: async () => ({
      ok: true,
      instanceId: "hermes-main",
      report: { rebuilt: true, rowsBefore: 30, rowsAfter: 30, errors: [] },
    }),
    exportEncrypted: async (_query, passphrase) => {
      if (passphrase.length < 8) {
        return {
          ok: false,
          instanceId: "hermes-main",
          code: "passphrase-too-short",
          error: "passphrase-too-short",
          userHint: "口令至少 8 位",
        };
      }
      return {
        ok: true,
        instanceId: "hermes-main",
        filename: "butler-memory-export-test.abmem",
        data: new Uint8Array([1, 2, 3]),
        sizeBytes: 3,
      };
    },
  };
  return {
    archiveCalls,
    restoreCalls,
    purgeCalls,
    selfCheckCalls,
    deps: {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "no-servicing-instance" }),
      upgrade: {
        startUpgrade: () => ({ status: "missing-target-version" }),
        status: () => null,
        listVersions: async () => ({ reachable: false, versions: [] }),
        rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
      },
      gateway: {
        stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
        patches: async () => [],
        applyPatch: async () => ({ status: "unknown-patch" }),
        reapplyPatch: async () => ({ status: "unknown-patch" }),
        detectPatch: async () => ({ status: "unknown-patch" }),
      },
      skills,
      m6WritesEnabled: true,
      memorySelfCheck: async (instanceId?: string): Promise<MemorySelfCheckOutcome> => {
        selfCheckCalls.push(instanceId);
        if (instanceId === "none") {
          return { ok: false, code: "no-servicing-instance", error: "no-servicing-instance" };
        }
        return {
          ok: true,
          instanceId: "hermes-main",
          result: { id: "memory-probe", status: "pass", detail: "写入并召回一条测试记忆，随后已清理" },
        };
      },
    },
  };
}

describe("startWatchHttp 记忆观察与管理动作端点", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => http.close());

  it("GET /api/memory 返回实例与记忆视图", async () => {
    const response = await fetch(`${base}/api/memory`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { instance: unknown; memory: unknown };
    expect(body.instance).toMatchObject({ instanceId: "hermes-main" });
    expect(body.memory).toMatchObject({ driverId: "sqlite-fts5" });
  });

  it("V1 默认隐藏所有 M6 写路由，同时保留只读列表与临时自检", async () => {
    http.close();
    const v1Deps: WatchHttpDeps = { ...fake.deps, m6WritesEnabled: undefined };
    http = startWatchHttp(v1Deps, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    for (const path of ["archive", "restore", "purge", "rebuild-index", "export"]) {
      const response = await fetch(`${base}/api/memory/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true, passphrase: "long-enough-pass" }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not-found" });
    }
    expect((await fetch(`${base}/api/memory`)).status).toBe(200);
    expect(
      (
        await fetch(`${base}/api/memory/self-check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
    expect(fake.archiveCalls).toHaveLength(0);
    expect(fake.restoreCalls).toHaveLength(0);
    expect(fake.purgeCalls).toHaveLength(0);
  });

  it("POST /api/memory/archive 透传 dryRun 与时间参数", async () => {
    const response = await fetch(`${base}/api/memory/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main", olderThan: "2026-01-01T00:00:00Z", dryRun: true }),
    });
    expect(response.status).toBe(200);
    expect(fake.archiveCalls).toEqual([{ dryRun: true, olderThan: "2026-01-01T00:00:00Z" }]);
  });

  it("POST /api/memory/restore 透传 entryIds", async () => {
    const response = await fetch(`${base}/api/memory/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryIds: ["1", "2"] }),
    });
    expect(response.status).toBe(200);
    expect(fake.restoreCalls).toEqual([{ entryIds: ["1", "2"] }]);
  });

  it("POST /api/memory/purge 未确认返回 400，确认后返回 200", async () => {
    const rejected = await fetch(`${base}/api/memory/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: false }),
    });
    expect(rejected.status).toBe(400);
    expect(fake.purgeCalls).toEqual([{ confirmed: false }]);

    const accepted = await fetch(`${base}/api/memory/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, kind: "probes" }),
    });
    expect(accepted.status).toBe(200);
    expect(fake.purgeCalls[1]).toEqual({ confirmed: true, kind: "probes" });
  });

  it("POST /api/memory/rebuild-index 返回索引重建报告", async () => {
    const response = await fetch(`${base}/api/memory/rebuild-index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; report: { rowsAfter: number } };
    expect(body.ok).toBe(true);
    expect(body.report.rowsAfter).toBe(30);
  });

  it("POST /api/memory/rebuild-index 无服务返回 503，GET 返回 405", async () => {
    const withoutSkills: WatchHttpDeps = { ...fake.deps, skills: undefined };
    const http2 = startWatchHttp(withoutSkills, { port: 0 });
    const addr2 = await http2.start();
    try {
      const base2 = `http://127.0.0.1:${addr2.port}`;
      const noService = await fetch(`${base2}/api/memory/rebuild-index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(noService.status).toBe(503);
      expect((await fetch(`${base2}/api/memory/rebuild-index`)).status).toBe(405);
    } finally {
      http2.close();
    }
  });

  it("POST /api/memory/self-check 透传实例并返回探针结果", async () => {
    const response = await fetch(`${base}/api/memory/self-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      instanceId: string;
      result: { id: string; status: string; detail: string };
    };
    expect(body).toEqual({
      ok: true,
      instanceId: "hermes-main",
      result: { id: "memory-probe", status: "pass", detail: "写入并召回一条测试记忆，随后已清理" },
    });
    expect(fake.selfCheckCalls).toEqual([undefined]);

    const withInstance = await fetch(`${base}/api/memory/self-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(withInstance.status).toBe(200);
    expect(fake.selfCheckCalls[1]).toBe("hermes-main");
  });

  it("POST /api/memory/self-check 无实例或未接线返回 503，GET 返回 405", async () => {
    const noInstance = await fetch(`${base}/api/memory/self-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "none" }),
    });
    expect(noInstance.status).toBe(503);
    expect((await fetch(`${base}/api/memory/self-check`)).status).toBe(405);

    http.close();
    const withoutSelfCheck: WatchHttpDeps = { ...fake.deps, memorySelfCheck: undefined };
    http = startWatchHttp(withoutSelfCheck, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const unavailable = await fetch(`${base}/api/memory/self-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unavailable.status).toBe(503);
  });

  it("未接线服务时返回 503", async () => {
    http.close();
    const withoutSkills: WatchHttpDeps = { ...fake.deps, skills: undefined };
    http = startWatchHttp(withoutSkills, { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/memory`)).status).toBe(503);
    expect(
      (
        await fetch(`${base}/api/memory/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        })
      ).status,
    ).toBe(503);
  });
  it("POST /api/memory/export 返回加密附件", async () => {
    const response = await fetch(`${base}/api/memory/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "long-enough-pass" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("butler-memory-export-test.abmem");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("POST /api/memory/export 口令过短返回 400，GET 返回 405", async () => {
    const short = await fetch(`${base}/api/memory/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "short" }),
    });
    expect(short.status).toBe(400);
    const body = (await short.json()) as { error: string; userHint: string };
    expect(body.error).toBe("passphrase-too-short");
    expect(body.userHint).toContain("8 位");
    expect((await fetch(`${base}/api/memory/export`)).status).toBe(405);
  });

});
