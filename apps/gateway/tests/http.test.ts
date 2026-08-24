import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayServer, type GatewayApp } from "../src/server";
import { AlertQueue } from "../src/queue";
import { FakeChannel, gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

describe("gateway HTTP API", () => {
  let tmp: string;
  let queue: AlertQueue;
  let app: GatewayApp;
  let telegram: FakeChannel;
  let smtp: FakeChannel;

  beforeEach(() => {
    tmp = makeTempDir();
    queue = new AlertQueue(gatewayDbFile(tmp));
    telegram = new FakeChannel("telegram", { configured: false });
    smtp = new FakeChannel("smtp", { configured: false });
    app = createGatewayServer({
      queue,
      channels: [telegram, smtp],
      startLoop: false, // HTTP 契约测试不启动真实定时器
    });
  });

  afterEach(async () => {
    await app.close(); // 注入队列不由服务关闭，这里手动清理
    queue.close();
    rmTempDir(tmp);
  });

  it("POST /api/alerts：202 返回 id；非法 body 400", async () => {
    const okRes = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        kind: "agent-stuck",
        severity: "critical",
        title: "实例卡死",
        body: "hermes-main 无响应",
        source: "butler-watch",
      },
    });
    expect(okRes.statusCode).toBe(202);
    expect(okRes.json()).toEqual({ id: 1 });

    const badSeverity = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "fatal", title: "t", body: "b", source: "s" },
    });
    expect(badSeverity.statusCode).toBe(400);

    const missingField = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "warn", title: "t", body: "", source: "s" },
    });
    expect(missingField.statusCode).toBe(400);
  });

  it("POST /api/alerts：dedupeKey 命中未终结行返回同 id（消息合并缓释）", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        kind: "log-error",
        severity: "warn",
        title: "错误刷屏",
        body: "b1",
        source: "watch",
        dedupeKey: "sig-1",
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        kind: "log-error",
        severity: "warn",
        title: "错误刷屏",
        body: "b2",
        source: "watch",
        dedupeKey: "sig-1",
      },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json()); // 同 id
    expect(queue.list()).toHaveLength(1); // 不新增行
  });

  it("GET /api/alerts：counts + degradedChannels + items（无敏感字段）", async () => {
    await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "critical", title: "t", body: "b", source: "s" },
    });
    await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "warn", title: "t2", body: "b", source: "s", dedupeKey: "dk" },
    });
    await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "warn", title: "t2", body: "b", source: "s", dedupeKey: "dk" },
    });

    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.counts).toEqual({ pending: 2, delivering: 0, delivered: 0, failed: 0 });
    expect(payload.degradedChannels).toEqual(["telegram:missing-credentials", "smtp:missing-credentials"]);
    expect(payload.items).toHaveLength(2);
    const merged = payload.items.find((i: { title: string }) => i.title === "t2");
    expect(merged).toMatchObject({ mergedCount: 2, dedupeKey: "dk", status: "pending" });
    // 剔除内部调度字段
    expect(merged).not.toHaveProperty("nextAttemptAt");

    // limit 参数生效
    const limited = await app.inject({ method: "GET", url: "/api/alerts?limit=1" });
    expect(limited.json().items).toHaveLength(1);
  });

  it("GET /api/alerts：部分通道可用时 degradedChannels 只列缺失项", async () => {
    const smtpReady = createGatewayServer({
      queue,
      channels: [new FakeChannel("telegram", { configured: false }), new FakeChannel("smtp")],
      startLoop: false,
    });
    const res = await smtpReady.inject({ method: "GET", url: "/api/alerts" });
    expect(res.json().degradedChannels).toEqual(["telegram:missing-credentials"]);
    await smtpReady.close();
  });

  it("GET /healthz：{ ok: true, pending }", async () => {
    await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: { kind: "k", severity: "info", title: "t", body: "b", source: "s" },
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pending: 1 });
  });
});
