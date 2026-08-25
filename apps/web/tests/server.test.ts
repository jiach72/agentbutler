import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeBlockedHome, makeTempDir, makeUiDist, rmTempDir } from "./helpers";

/** 网关探测一律指向必然连接拒绝的端口，保证测试确定性且快速。 */
const DEAD_GATEWAY = "http://127.0.0.1:1";

describe("butler-web 服务（fastify inject）", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  // 本仓位于 /mnt/c（DrvFs）上时，首次 Fastify() 构造有秒级惰性初始化开销，
  // 先预热一个空实例，避免吃掉单个用例的 5s 超时预算。
  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    // app.close() 的 onClose 钩子会关闭 store（释放 WAL 文件）后再删临时目录
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(home: string): FastifyInstance {
    const app = createWebServer({ home, gatewayUrl: DEAD_GATEWAY, uiDist });
    apps.push(app);
    return app;
  }

  /** 在临时 home 预置一套共享 SQLite 数据后关闭，交由 web 服务重新打开。 */
  function seedStore(): void {
    const store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    const now = new Date().toISOString();
    store.insertEvent({ type: "alpha", payload: { n: 1 } });
    store.insertEvent({ type: "beta", severity: "warn", source: "watch" });
    store.insertEvent({ type: "alpha", payload: { n: 2 } });
    store.upsertFingerprint("sig-1", "sample-1");
    store.upsertFingerprint("sig-1", "sample-2");
    store.upsertFingerprint("sig-2");
    store.saveInstance({
      instanceId: "hermes-main",
      frameworkId: "hermes",
      state: "Serving",
      runtime: "docker",
      rootPath: "/srv/hermes",
      version: "0.5.0",
      confidence: 0.9,
      capabilityJson: JSON.stringify({ effectiveLevel: 2, capabilities: {}, anomalies: [] }),
      detailJson: null,
      createdAt: now,
      updatedAt: now,
    });
    store.close();
  }

  it("/api/health：db 可达、网关不可达，载荷含版本", async () => {
    seedStore();
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      db: true,
      gateway: false,
      version: expect.stringMatching(/^web@/),
    });
  });

  it("/api/instances：返回实例列表与 capability 摘要", async () => {
    seedStore();
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/instances" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { instances: Array<Record<string, unknown>> };
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "hermes-main",
      frameworkId: "hermes",
      state: "Serving",
      runtime: "docker",
      version: "0.5.0",
      confidence: 0.9,
    });
    expect(body.instances[0]!["capability"]).toMatchObject({ effectiveLevel: 2 });
  });

  it("/api/events：默认与 type 过滤、limit，最新在前", async () => {
    seedStore();
    const app = build(tmp);

    const all = await app.inject({ method: "GET", url: "/api/events" });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { items: Array<{ id: number; type: string }> };
    expect(allBody.items).toHaveLength(3);
    expect(allBody.items[0]!.type).toBe("alpha"); // 后插入的 alpha(n=2) 在前

    const filtered = await app.inject({ method: "GET", url: "/api/events?type=beta" });
    const filteredBody = filtered.json() as { items: Array<{ type: string; severity: string }> };
    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0]).toMatchObject({ type: "beta", severity: "warn" });

    const limited = await app.inject({ method: "GET", url: "/api/events?limit=2" });
    expect((limited.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it("/api/fingerprints：同签名计数聚合，lastSeen 排序", async () => {
    seedStore();
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/fingerprints?limit=10" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ signature: string; count: number }> };
    expect(body.items).toHaveLength(2);
    expect(body.items.find((f) => f.signature === "sig-1")!.count).toBe(2);
    expect(body.items.find((f) => f.signature === "sig-2")!.count).toBe(1);
  });

  it("db 不可达：各只读 API 返回降级载荷而非 500", async () => {
    const app = build(makeBlockedHome(tmp));

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, db: false });

    for (const url of ["/api/instances", "/api/events", "/api/fingerprints"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ degraded: ["db:unreachable"] });
    }
  });

  it("/api/alerts：网关不可达返回 200 降级载荷（reachable=false）", async () => {
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/alerts" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reachable: false,
      counts: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
      degradedChannels: ["gateway:unreachable"],
      items: [],
    });
  });

  it("/api/connections：通过 web 代理 watch 连接路由，不再落到 web 404", async () => {
    const app = createWebServer({
      home: tmp,
      gatewayUrl: DEAD_GATEWAY,
      watchUrl: "http://watch.test:7533",
      uiDist,
      fetchImpl: (async (input) => {
        expect(String(input)).toBe("http://watch.test:7533/api/connections");
        return new Response(
          JSON.stringify({ checkedAt: "2026-08-25T00:00:00.000Z", connections: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/connections" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reachable: true,
      checkedAt: "2026-08-25T00:00:00.000Z",
      connections: [],
    });
  });

  it("/api/security-baseline：V1 固定结构（未鉴权 + warnings 明示）", async () => {
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/security-baseline" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { listenHost: string; auth: boolean; warnings: string[] };
    expect(typeof body.listenHost).toBe("string");
    expect(body.listenHost.length).toBeGreaterThan(0);
    expect(body.auth).toBe(false);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings.join("\n")).toContain("登录验证");
  });

  it("SPA 回退：非 /api 未匹配路由返回 index.html，/api 未知路由 404 JSON", async () => {
    seedStore();
    const app = build(tmp);

    const spa = await app.inject({ method: "GET", url: "/versions" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["content-type"]).toContain("text/html");
    expect(spa.body).toContain("fixture-ui");

    const deep = await app.inject({ method: "GET", url: "/deep/nested/route" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("fixture-ui");

    const api404 = await app.inject({ method: "GET", url: "/api/unknown" });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toMatchObject({ error: "not-found" });
  });

  it("/ws：连接即推最近 50 条（升序），新事件经 2s 轮询增量推送", { timeout: 15000 }, async () => {
    seedStore();
    const app = build(tmp);
    // 用真实回环端口 + 真 WebSocket 客户端验证（injectWS 的假流会吞掉首推帧）
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const collector = createCollector(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
    });

    // 首推：seedStore 的 3 条按 id 升序（alpha→beta→alpha）
    const first = JSON.parse(await withTimeout(collector.next(), "等待首推超时")) as {
      type: string;
      items: Array<{ type: string }>;
    };
    expect(first.type).toBe("events");
    expect(first.items.map((e) => e.type)).toEqual(["alpha", "beta", "alpha"]);

    // 另开连接写入新事件（web 与其他进程共享同一 SQLite）
    const writer = new SqliteStore(path.join(tmp, "data", "butler.db"));
    writer.insertEvent({ type: "gamma", payload: "fresh" });
    writer.close();

    // 增量：轮询周期 2s，容错等待下一条推送
    const second = JSON.parse(await withTimeout(collector.next(), "等待增量推送超时")) as {
      type: string;
      items: Array<{ type: string }>;
    };
    expect(second.type).toBe("events");
    expect(second.items.map((e) => e.type)).toEqual(["gamma"]);

    ws.close();
  });
});

/** WebSocket 消息收集器：按到达顺序供 await 消费。 */
function createCollector(ws: WebSocket): { next: () => Promise<string> } {
  const queue: string[] = [];
  const waiters: Array<(data: string) => void> = [];
  ws.addEventListener("message", (event) => {
    const data = String((event as MessageEvent).data);
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(data);
    else queue.push(data);
  });
  return {
    next: () =>
      new Promise<string>((resolve) => {
        const buffered = queue.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      }),
  };
}

/** 给 Promise 加兜底超时，避免用例挂死。 */
function withTimeout<T>(promise: Promise<T>, message: string, ms = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
