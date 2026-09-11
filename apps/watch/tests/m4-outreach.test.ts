/**
 * M4 触达扩张测试（服务层可自动化的部分）：
 * - M4.3 记忆变更流：added/modified/forgotten 三态判定、路径识别、诚实边界声明、TOP5；
 * - M4.4 联邦：实例聚合（成本/token/会话）、分组读写、急停覆盖性、孤儿会话单列、
 *   「未登记实例」与「global 事件」不做假归属；
 * - M4.1/M4.2 的移动端与 doctor 属 UI/CLI，由构建与人工验收覆盖（在文档中注明）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import {
  classifyChange,
  createMemoryDiffService,
  isMemoryPath,
} from "../src/memory-diff.js";
import { createFederationService, parseGroups, serializeGroups } from "../src/federation.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-m4-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      // Windows SQLite 句柄延迟释放
    }
  }
});

const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};
const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

const FIXED = Date.parse("2026-09-11T12:00:00Z");

describe("M4.3 记忆变更流：纯函数", () => {
  it("记忆路径识别", () => {
    expect(isMemoryPath("/home/u/.hermes/memory/facts.md")).toBe(true);
    expect(isMemoryPath("/home/u/.hermes/MEMORY.md")).toBe(true);
    expect(isMemoryPath("/home/u/notes/day1.md")).toBe(true);
    expect(isMemoryPath("/home/u/.hermes/knowledge/team.md")).toBe(true);
    expect(isMemoryPath("/home/u/.hermes/skills/fix/index.md")).toBe(false);
    expect(isMemoryPath("/var/log/syslog")).toBe(false);
  });

  it("三态判定", () => {
    // 窗口后删除且未再写 → forgotten
    expect(
      classifyChange({ writes: 2, deletes: 1, lastWriteAt: "2026-09-10T01:00:00Z", lastDeleteAt: "2026-09-10T02:00:00Z", knownBeforeWindow: true }),
    ).toBe("forgotten");
    // 删除后又写回 → modified（忘了又想起来，不算遗忘）
    expect(
      classifyChange({ writes: 3, deletes: 1, lastWriteAt: "2026-09-10T03:00:00Z", lastDeleteAt: "2026-09-10T02:00:00Z", knownBeforeWindow: true }),
    ).toBe("modified");
    // 窗口前不存在 → added
    expect(
      classifyChange({ writes: 1, deletes: 0, lastWriteAt: "2026-09-10T01:00:00Z", lastDeleteAt: null, knownBeforeWindow: false }),
    ).toBe("added");
  });

  it("分组配置序列化往返（防御性解析）", () => {
    const map = parseGroups("a:work,b:lab,c:bogus,,d:");
    expect(map.get("a")).toBe("work");
    expect(map.get("b")).toBe("lab");
    expect(map.has("c")).toBe(false); // 非法分组被丢弃
    expect(serializeGroups(map)).toBe("a:work,b:lab");
    expect(parseGroups(null).size).toBe(0);
  });
});

function seedMemoryAction(
  store: SqliteStore,
  kind: "file-write" | "file-delete",
  target: string,
  atMs: number,
): void {
  store.insertActionEvent({
    ts: new Date(atMs).toISOString(),
    kind,
    severity: "info",
    target,
    parserVersion: "v1",
  });
}

describe("M4.3 记忆变更流：服务", () => {
  it("本周新增 / 修改 / 遗忘 + TOP5 + 边界声明", () => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    // 窗口前（8 天前）已有 old.md（→ modified）。
    seedMemoryAction(store, "file-write", "/h/memory/old.md", FIXED - 8 * 86_400_000);
    // 本周：新增 new.md、修改 old.md、遗忘 gone.md、非记忆文件 noise.log。
    seedMemoryAction(store, "file-write", "/h/memory/new.md", FIXED - 2 * 86_400_000);
    seedMemoryAction(store, "file-write", "/h/memory/old.md", FIXED - 86_400_000);
    seedMemoryAction(store, "file-write", "/h/memory/gone.md", FIXED - 3 * 86_400_000);
    seedMemoryAction(store, "file-delete", "/h/memory/gone.md", FIXED - 86_400_000);
    seedMemoryAction(store, "file-write", "/h/logs/noise.log", FIXED - 86_400_000);

    const service = createMemoryDiffService({ store, now: () => FIXED });
    const view = service.diff(7);
    expect(view.summary).toEqual({ added: 1, modified: 1, forgotten: 1, total: 3 });
    const byPath = new Map(view.entries.map((entry) => [entry.path, entry.change]));
    expect(byPath.get("/h/memory/new.md")).toBe("added");
    expect(byPath.get("/h/memory/old.md")).toBe("modified");
    expect(byPath.get("/h/memory/gone.md")).toBe("forgotten");
    // 非记忆路径不进视图。
    expect(byPath.has("/h/logs/noise.log")).toBe(false);
    // 边界声明必须存在（诚实呈现是功能的一部分）。
    expect(view.basisLimits.length).toBeGreaterThanOrEqual(2);
    // 无 managedPaths 时 stillPresent 为 null（不臆造 false）。
    expect(view.entries.every((entry) => entry.stillPresent === null)).toBe(true);
    // TOP5 按动作量排序，gone.md（写1删1=2）应排在前。
    expect(view.top[0]?.path).toBe("/h/memory/gone.md");
  });

  it("受管清单命中时 stillPresent=true；未命中保持 null（不写成「已删除」）", () => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    seedMemoryAction(store, "file-write", "/h/memory/a.md", FIXED - 86_400_000);
    seedMemoryAction(store, "file-write", "/h/memory/b.md", FIXED - 86_400_000);
    const service = createMemoryDiffService({
      store,
      managedPaths: () => ["/h/memory/a.md"],
      now: () => FIXED,
    });
    const view = service.diff(7);
    const a = view.entries.find((entry) => entry.path === "/h/memory/a.md")!;
    const b = view.entries.find((entry) => entry.path === "/h/memory/b.md")!;
    expect(a.stillPresent).toBe(true);
    expect(b.stillPresent).toBeNull();
  });
});

describe("M4.4 联邦：服务", () => {
  function seed() {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    // 两个实例 + 各自会话；一个无实例归属的孤儿会话。
    for (let i = 0; i < 3; i++) {
      store.upsertSessionIndex({
        sessionId: `w-${i}`,
        instance: "hermes-work",
        startedAt: new Date(FIXED - i * 3_600_000).toISOString(),
        tokenIn: 100,
        tokenOut: 100,
        costUsd: 0.5,
        outcome: "ok",
        at: new Date(FIXED).toISOString(),
      });
    }
    for (let i = 0; i < 2; i++) {
      store.upsertSessionIndex({
        sessionId: `l-${i}`,
        instance: "hermes-lab",
        startedAt: new Date(FIXED - i * 3_600_000).toISOString(),
        tokenIn: 50,
        tokenOut: 50,
        costUsd: null,
        outcome: "ok",
        at: new Date(FIXED).toISOString(),
      });
    }
    store.upsertSessionIndex({
      sessionId: "orphan-1",
      instance: "",
      startedAt: new Date(FIXED - 3_600_000).toISOString(),
      tokenIn: 10,
      tokenOut: 10,
      outcome: "ok",
      at: new Date(FIXED).toISOString(),
    });
    return store;
  }

  it("按实例聚合成本 / token / 会话；孤儿会话单列且不摊派", () => {
    const store = seed();
    const service = createFederationService({ store, killswitchInstances: () => [], now: () => FIXED });
    const view = service.view(7);
    expect(view.instances.length).toBe(2);
    const work = view.instances.find((instance) => instance.instanceId === "hermes-work")!;
    const lab = view.instances.find((instance) => instance.instanceId === "hermes-lab")!;
    expect(work.sessions).toBe(3);
    expect(work.costUsd).toBeCloseTo(1.5, 5);
    expect(work.tokens).toBe(600);
    expect(lab.sessions).toBe(2);
    expect(lab.costUsd).toBeNull(); // 无成本数据 → null，不是 0
    expect(view.orphanSessions).toBe(1);
    expect(view.summary.totalSessions).toBe(5); // 孤儿不计入实例
    expect(view.summary.totalCostUsd).toBeCloseTo(1.5, 5);
  });

  it("分组读写落库；unassigned 移除", () => {
    const store = seed();
    const service = createFederationService({ store, killswitchInstances: () => [], now: () => FIXED });
    service.setGroup("hermes-work", "work");
    service.setGroup("hermes-lab", "lab");
    let view = service.view(7);
    expect(view.summary.byGroup).toEqual({ work: 1, lab: 1, sandbox: 0, unassigned: 0 });
    service.setGroup("hermes-lab", "unassigned");
    view = service.view(7);
    expect(view.summary.byGroup).toEqual({ work: 1, lab: 0, sandbox: 0, unassigned: 1 });
  });

  it("急停覆盖性：engage 清单内 → covered；未 engage → 全部 false", () => {
    const store = seed();
    const engaged = createFederationService({
      store,
      killswitchInstances: () => ["hermes-work"],
      now: () => FIXED,
    });
    let view = engaged.view(7);
    expect(view.instances.find((i) => i.instanceId === "hermes-work")?.killswitchCovered).toBe(true);
    expect(view.instances.find((i) => i.instanceId === "hermes-lab")?.killswitchCovered).toBe(false);
    expect(view.summary.killswitchCoverage).toBe("1 / 2");

    const idle = createFederationService({ store, killswitchInstances: () => [], now: () => FIXED });
    view = idle.view(7);
    expect(view.instances.every((instance) => !instance.killswitchCovered)).toBe(true);
  });
});

describe("M4 HTTP 端点", () => {
  let http: WatchHttp;
  let base: string;
  let cleanup: (() => void) | null = null;

  const boot = async (withServices = true) => {
    const dir = makeTempDir();
    const store = new SqliteStore(join(dir, "butler.db"));
    store.upsertSessionIndex({
      sessionId: "s-1",
      instance: "hermes-a",
      startedAt: new Date(FIXED - 3_600_000).toISOString(),
      tokenIn: 10,
      tokenOut: 10,
      costUsd: 0.1,
      outcome: "ok",
      at: new Date(FIXED).toISOString(),
    });
    seedMemoryAction(store, "file-write", "/h/memory/x.md", FIXED - 3_600_000);
    const memoryDiff = createMemoryDiffService({ store, now: () => FIXED });
    const federation = createFederationService({ store, killswitchInstances: () => [], now: () => FIXED });
    const deps: WatchHttpDeps = {
      scheduler: {
        runNow: () => true,
        status: () => ({ lastAt: null, nextAt: null, intervalMin: 5, inFlight: false }),
      },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-a" }),
      upgrade: upgradeStub,
      gateway: gatewayStub,
      ...(withServices ? { memoryDiff, federation } : {}),
    };
    cleanup = () => store.close();
    http = startWatchHttp(deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  };

  afterEach(() => {
    http?.close();
    cleanup?.();
    cleanup = null;
  });

  it("GET /api/memory-diff → entries + 边界声明", async () => {
    await boot();
    const res = await fetch(`${base}/api/memory-diff?windowDays=7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ path: string; change: string }>;
      summary: { added: number };
      basisLimits: string[];
    };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0]?.change).toBe("added");
    expect(body.basisLimits.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/federation → 聚合视图；POST group 分组", async () => {
    await boot();
    const list = await fetch(`${base}/api/federation`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      instances: Array<{ instanceId: string; group: string }>;
      summary: { totalInstances: number; killswitchCoverage: string };
      groupLabels: Record<string, string>;
    };
    expect(body.instances.length).toBe(1);
    expect(body.summary.totalInstances).toBe(1);
    expect(body.groupLabels["work"]).toBe("工作");

    const assign = await fetch(`${base}/api/federation/group`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-a", group: "work" }),
    });
    expect(assign.status).toBe(200);
    const after = (await (await fetch(`${base}/api/federation`)).json()) as {
      instances: Array<{ group: string }>;
    };
    expect(after.instances[0]?.group).toBe("work");

    const bad = await fetch(`${base}/api/federation/group`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-a", group: "everything" }),
    });
    expect(bad.status).toBe(400);
  });

  it("未接线 → 503", async () => {
    await boot(false);
    expect((await fetch(`${base}/api/memory-diff`)).status).toBe(503);
    expect((await fetch(`${base}/api/federation`)).status).toBe(503);
  });
});
