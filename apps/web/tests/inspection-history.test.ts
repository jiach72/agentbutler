import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@butler/core";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createWebServer,
  inspectionDailyHistory,
  type WebServerOptions,
} from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const DEAD_GATEWAY = "http://127.0.0.1:1";

/** 巡检事件工厂：ts 显式指定便于跨日聚合断言；durationMs 可控。 */
function inspectionEvent(
  store: SqliteStore,
  options: { ts: string; overall?: string; durationMs?: number },
): void {
  store.insertEvent({
    type: "inspection-completed",
    source: "watch",
    payload: {
      instanceId: "hermes-main",
      overall: options.overall ?? "ok",
      checks:
        options.durationMs === undefined
          ? []
          : [{ id: "probe", status: "pass", detail: "", durationMs: options.durationMs }],
    },
  });
}

describe("inspectionDailyHistory 纯函数", () => {
  it("按本地日聚合次数、均值与异常数；空档日期补零", () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const dayFmt = (offsetDays: number) => {
      const d = new Date(today.getTime() - offsetDays * 86_400_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    };
    const ev = (
      offsetDays: number,
      hour: number,
      overall: string,
      durationMs?: number,
    ): {
      id: number;
      ts: string;
      type: string;
      severity: "info";
      source: "";
      payload: Record<string, unknown>;
    } => {
      const d = new Date(today.getTime() - offsetDays * 86_400_000);
      d.setHours(hour);
      return {
        id: 1,
        ts: d.toISOString(),
        type: "inspection-completed",
        severity: "info",
        source: "",
        payload: {
          instanceId: "hermes-main",
          overall,
          checks: durationMs === undefined ? [] : [{ durationMs }],
        },
      };
    };

    const items = inspectionDailyHistory(
      [ev(0, 9, "ok", 100), ev(0, 15, "degraded", 300), ev(1, 8, "ok"), ev(40, 8, "ok", 5)],
      7,
    );
    expect(items).toHaveLength(7);
    const todayRow = items.find((row) => row.date === dayFmt(0))!;
    expect(todayRow.count).toBe(2);
    expect(todayRow.avgDurationMs).toBe(200);
    expect(todayRow.errorCount).toBe(1);
    const yesterdayRow = items.find((row) => row.date === dayFmt(1))!;
    expect(yesterdayRow.count).toBe(1);
    // 无计时时长的巡检不参与均值
    expect(yesterdayRow.avgDurationMs).toBeNull();
    const emptyRow = items.find((row) => row.date === dayFmt(3))!;
    expect(emptyRow.count).toBe(0);
    expect(emptyRow.errorCount).toBe(0);
    // 窗口外的事件不产生额外桶
    expect(items.some((row) => row.date === dayFmt(40))).toBe(false);
  });

  it("days 越界抛错", () => {
    expect(() => inspectionDailyHistory([], 0)).toThrow();
    expect(() => inspectionDailyHistory([], 91)).toThrow();
  });
});

describe("GET /api/inspections/history", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const warmup = Fastify({ logger: false });
    await warmup.close();
  }, 30000);

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(home: string, extra: Partial<WebServerOptions> = {}): FastifyInstance {
    const app = createWebServer({
      home,
      gatewayUrl: DEAD_GATEWAY,
      uiDist,
      watchUrl: "http://127.0.0.1:7533",
      ...extra,
    });
    apps.push(app);
    return app;
  }

  function seed(): void {
    const store = new SqliteStore(path.join(tmp, "data", "butler.db"));
    inspectionEvent(store, { ts: new Date().toISOString(), overall: "ok", durationMs: 120 });
    inspectionEvent(store, {
      ts: new Date().toISOString(),
      overall: "down",
      durationMs: 40,
    });
    store.close();
  }

  it("返回按日聚合行；非法 days 回退默认窗口", async () => {
    seed();
    const app = build(tmp);

    const ok = await app.inject({ method: "GET", url: "/api/inspections/history?days=14" });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      days: number;
      items: Array<{ count: number; avgDurationMs: number | null; errorCount: number }>;
    };
    expect(body.days).toBe(14);
    const todayRows = body.items.filter((row) => row.count > 0);
    expect(todayRows).toHaveLength(1);
    expect(todayRows[0]?.count).toBe(2);
    expect(todayRows[0]?.avgDurationMs).toBe(80);
    expect(todayRows[0]?.errorCount).toBe(1);

    const bad = await app.inject({ method: "GET", url: "/api/inspections/history?days=999" });
    expect(bad.statusCode).toBe(200);
    expect((bad.json() as { degraded: string[] }).degraded).toContain(
      "inspections:invalid-days",
    );
  });

  it("空数据库返回完整的零值时间窗口", async () => {
    const app = build(tmp);
    const res = await app.inject({ method: "GET", url: "/api/inspections/history?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: number;
      items: Array<{ count: number; avgDurationMs: number | null; errorCount: number }>;
    };
    expect(body.days).toBe(7);
    expect(body.items).toHaveLength(7);
    expect(body.items.every((row) => row.count === 0 && row.avgDurationMs === null && row.errorCount === 0)).toBe(true);
  });
});
