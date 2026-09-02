/**
 * 主机指标透传与健康检查延迟测试：
 * - GET /api/host/metrics：watch 可达时透传快照载荷；watch 不可达 / 非 2xx /
 *   畸形响应一律 503 { reachable:false } 降级；
 * - GET /api/health：services.{gateway,watch} 携带 latencyMs（可达为非负数，不可达为 null）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";
const GATEWAY_URL = "http://127.0.0.1:7532";

const HOST_METRICS_PAYLOAD = {
  machine: {
    capturedAt: "2026-09-01T08:00:00.000Z",
    cpuPercent: 12.5,
    memTotalBytes: 16_000_000_000,
    memFreeBytes: 8_000_000_000,
    load1: 0.4,
    uptimeSeconds: 7200,
    diskTotalBytes: 1_000_000_000_000,
    diskUsedBytes: 250_000_000_000,
    gpu: null,
  },
  agents: [{ instanceId: "hermes-main", cpuPercent: 3.2, rssBytes: 4096 }],
  samples: [],
};

describe("butler-web 主机指标透传与健康延迟", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

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
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, gatewayUrl: GATEWAY_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("GET /api/host/metrics：watch 可达时透传快照载荷", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${WATCH_URL}/api/host/metrics`);
      return new Response(JSON.stringify(HOST_METRICS_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/host/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as typeof HOST_METRICS_PAYLOAD;
    expect(body.machine.cpuPercent).toBe(12.5);
    expect(body.agents).toHaveLength(1);
  });

  it("GET /api/host/metrics：watch 不可达时 503 降级 reachable:false", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("unreachable");
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/host/metrics" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ reachable: false });
  });

  it("GET /api/host/metrics：watch 服务未接线（503）时同样降级", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "host-metrics-unavailable" }), { status: 503 });
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/host/metrics" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ reachable: false });
  });

  it("GET /api/health：可达服务的 latencyMs 为非负数，不可达为 null", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${WATCH_URL}/healthz`) {
        return new Response(JSON.stringify({ ok: true, serviceVersion: "watch@1", schemaVersion: "v1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("gateway unreachable");
    };
    const app = build(fetchImpl);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      services: { gateway: { latencyMs: number | null }; watch: { latencyMs: number | null } };
    };
    expect(body.services.watch.latencyMs).toBeTypeOf("number");
    expect(body.services.watch.latencyMs as number).toBeGreaterThanOrEqual(0);
    expect(body.services.gateway.reachable).toBe(false);
    expect(body.services.gateway.latencyMs).toBeNull();
  });
});
