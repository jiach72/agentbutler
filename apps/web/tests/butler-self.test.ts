import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

describe("butler-web 管家自身与记忆重建代理", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30_000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(fetchImpl: typeof fetch): FastifyInstance {
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("GET /api/butler/self 可达时透传状态并补 reachable", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${WATCH_URL}/api/butler/self`);
      return new Response(
        JSON.stringify({ version: "0.1.0", commit: "fc0e992", availableUpdates: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/butler/self" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; version: string };
    expect(body.reachable).toBe(true);
    expect(body.version).toBe("0.1.0");
  });

  it("GET /api/butler/self watch 不可达时返回降级载荷", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("unreachable");
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/butler/self" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; availableUpdates: unknown[] };
    expect(body.reachable).toBe(false);
    expect(body.availableUpdates).toEqual([]);
  });

  it("POST /api/butler/self/upgrade 透传 watch 的 202", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`${WATCH_URL}/api/butler/self/upgrade`);
      const body = JSON.parse(String(init?.body));
      expect(body.confirmed).toBe(true);
      return new Response(
        JSON.stringify({ started: true, jobId: "job-1", snapshotId: "snap-1" }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    const app = build(fetchImpl);
    const res = await app.inject({
      method: "POST",
      url: "/api/butler/self/upgrade",
      payload: { target: "v0.2.0", confirmed: true },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { started: boolean }).started).toBe(true);
  });

  it("POST /api/memory/rebuild-index 透传 watch 报告", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${WATCH_URL}/api/memory/rebuild-index`);
      return new Response(
        JSON.stringify({ ok: true, instanceId: "hermes-main", report: { rebuilt: true, rowsAfter: 91 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "POST", url: "/api/memory/rebuild-index", payload: {} });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { report: { rowsAfter: number } }).report.rowsAfter).toBe(91);
  });
});
