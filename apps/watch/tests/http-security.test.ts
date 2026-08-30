/**
 * 控制通道安全基线测试。
 *
 * Watch 只监听回环，但回环挡不住浏览器：任意网页都能让用户的浏览器向
 * 127.0.0.1:7533 发 POST。这组用例守住三件事：
 *   1）破坏性动作必须带确认标记（不能只靠前端弹窗）；
 *   2）来自非本机页面的写请求被拒绝；
 *   3）读请求不受来源限制，服务端代理（不带 Origin）照常工作。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startWatchHttp,
  type RunbookExecuteOutcome,
  type RunbookResetOutcome,
  type WatchHttp,
  type WatchHttpDeps,
} from "../src/http.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

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

function makeDeps(executeOutcome: RunbookExecuteOutcome = {
  status: "started",
  instanceId: "hermes-main",
}): { deps: WatchHttpDeps; executed: string[] } {
  const executed: string[] = [];
  const deps: WatchHttpDeps = {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [{ id: "rb-restart", label: "重启", description: "" }],
    executeRunbook: async (id) => {
      executed.push(id);
      return executeOutcome;
    },
    resetRunbookBreaker: async (): Promise<RunbookResetOutcome> => ({
      status: "reset",
      keys: ["rb-restart:hermes-main"],
    }),
    upgrade: upgradeStub,
    gateway: gatewayStub,
  };
  return { deps, executed };
}

describe("控制通道安全基线", () => {
  let http: WatchHttp;
  let base: string;
  let fake: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    fake = makeDeps();
    http = startWatchHttp(fake.deps, { port: 0 });
    const addr = await http.start();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    http.close();
  });

  it("执行修复动作缺少确认标记 → 400，且动作没有真的被执行", async () => {
    const res = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "confirmation-required" });
    expect(fake.executed).toEqual([]);
  });

  it("带上确认标记才能执行修复动作", async () => {
    const res = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, instanceId: "hermes-main" }),
    });
    expect(res.status).toBe(202);
    expect(fake.executed).toEqual(["rb-restart"]);
  });

  it("来自外部站点的写请求 → 403（防跨站触发重启、改配置）", async () => {
    const res = await fetch(`${base}/api/inspect/run`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "origin-not-allowed" });
  });

  it("来自本机面板的写请求放行", async () => {
    const res = await fetch(`${base}/api/inspect/run`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:7531" },
    });
    expect(res.status).toBe(202);
  });

  it("显式白名单中的局域网面板 Origin 放行", async () => {
    const previous = process.env["BUTLER_ALLOWED_ORIGINS"];
    process.env["BUTLER_ALLOWED_ORIGINS"] = "http://192.168.1.88:7531";
    try {
      const res = await fetch(`${base}/api/inspect/run`, {
        method: "POST",
        headers: { origin: "http://192.168.1.88:7531" },
      });
      expect(res.status).toBe(202);
    } finally {
      if (previous === undefined) delete process.env["BUTLER_ALLOWED_ORIGINS"];
      else process.env["BUTLER_ALLOWED_ORIGINS"] = previous;
    }
  });

  it("不带 Origin 的写请求放行（Web 是服务端代理，浏览器不参与）", async () => {
    const res = await fetch(`${base}/api/inspect/run`, { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("读请求不校验来源，外部站点也读不到才算安全边界（本例仅确认不被 403 拦截）", async () => {
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
  });

  it("请求体非法时，413/400 的优先级高于确认校验", async () => {
    const tooLarge = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(17 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    const badJson = await fetch(`${base}/api/runbooks/rb-restart/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
  });
});
