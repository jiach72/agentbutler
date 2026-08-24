import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryLoop } from "../src/loop";
import { AlertQueue, MAX_ATTEMPTS } from "../src/queue";
import { FakeChannel, fakeClock, gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

describe("DeliveryLoop", () => {
  let tmp: string;
  let queue: AlertQueue;

  beforeEach(() => {
    tmp = makeTempDir();
    queue = new AlertQueue(gatewayDbFile(tmp));
  });

  afterEach(() => {
    queue.close();
    rmTempDir(tmp);
  });

  it("warn：tick 即 delivered(channel='panel')，无需外发", async () => {
    const telegram = new FakeChannel("telegram");
    const loop = new DeliveryLoop({ queue, outbound: [telegram] });

    const row = queue.enqueue({
      kind: "log-error",
      severity: "warn",
      title: "错误刷屏",
      body: "b",
      source: "watch",
    });
    await loop.tick();

    expect(queue.get(row.id)).toMatchObject({ status: "delivered", channel: "panel" });
    expect(telegram.sends).toHaveLength(0); // warn 不占用外发通道
  });

  it("配速缓释：每个 tick 至多处理 1 条，按入队顺序投递", async () => {
    for (let i = 1; i <= 3; i += 1) {
      queue.enqueue({ kind: "k", severity: "warn", title: `t${i}`, body: "b", source: "s" });
    }
    const loop = new DeliveryLoop({ queue, outbound: [] });

    await loop.tick();
    expect(queue.counts()).toMatchObject({ delivered: 1, pending: 2 });

    await loop.tick();
    expect(queue.counts()).toMatchObject({ delivered: 2, pending: 1 });

    await loop.tick();
    expect(queue.counts()).toMatchObject({ delivered: 3, pending: 0 });

    // 投递顺序 = 入队顺序（id 升序即 created_at 升序）
    const deliveredTitles = queue
      .list()
      .filter((r) => r.status === "delivered")
      .sort((a, b) => a.id - b.id)
      .map((r) => r.title);
    expect(deliveredTitles).toEqual(["t1", "t2", "t3"]);
  });

  it("critical 无任何外发通道：降级 delivered(panel)，凭据缺失体现在 degradedChannels", async () => {
    const telegram = new FakeChannel("telegram", { configured: false });
    const smtp = new FakeChannel("smtp", { configured: false });
    const loop = new DeliveryLoop({ queue, outbound: [telegram, smtp] });

    const row = queue.enqueue({
      kind: "agent-stuck",
      severity: "critical",
      title: "实例卡死",
      body: "b",
      source: "watch",
    });
    await loop.tick();

    expect(queue.get(row.id)).toMatchObject({ status: "delivered", channel: "panel", attempts: 0 });
    expect(telegram.sends).toHaveLength(0);
    expect(smtp.sends).toHaveLength(0);
  });

  it("critical 逐级降级：telegram 失败 → smtp 成功，channel='smtp'", async () => {
    const telegram = new FakeChannel("telegram", { failures: [new Error("HTTP 429")] });
    const smtp = new FakeChannel("smtp");
    const loop = new DeliveryLoop({ queue, outbound: [telegram, smtp] });

    const row = queue.enqueue({ kind: "k", severity: "critical", title: "t", body: "b", source: "s" });
    await loop.tick();

    expect(queue.get(row.id)).toMatchObject({ status: "delivered", channel: "smtp" });
    expect(telegram.sends).toHaveLength(1);
    expect(smtp.sends).toHaveLength(1);
  });

  it("critical 逐级降级：telegram 成功则 smtp 不被调用", async () => {
    const telegram = new FakeChannel("telegram");
    const smtp = new FakeChannel("smtp");
    const loop = new DeliveryLoop({ queue, outbound: [telegram, smtp] });

    const row = queue.enqueue({ kind: "k", severity: "critical", title: "t", body: "b", source: "s" });
    await loop.tick();

    expect(queue.get(row.id)).toMatchObject({ status: "delivered", channel: "telegram" });
    expect(smtp.sends).toHaveLength(0);
  });

  it("critical 全通道失败：attempts 递增 + 指数退避，5 次后 failed", async () => {
    const { clock, advance } = fakeClock();
    const failing = new FakeChannel("telegram", {
      failures: Array.from({ length: MAX_ATTEMPTS }, () => new Error("HTTP 500")),
    });
    const loop = new DeliveryLoop({ queue, outbound: [failing], clock });

    const row = queue.enqueue({ kind: "k", severity: "critical", title: "t", body: "b", source: "s" });

    await loop.tick();
    let after = queue.get(row.id)!;
    expect(after).toMatchObject({ attempts: 1, status: "pending" });
    expect(after.nextAttemptAt).toBe("2026-01-01T00:02:00.000Z"); // now + 120s
    expect(after.lastError).toContain("telegram: HTTP 500");

    // 退避期内 tick 不重复认领
    advance(60 * 1000);
    await loop.tick();
    expect(queue.get(row.id)!.attempts).toBe(1);

    // 反复到点重试直至 5 次 → failed
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      advance(31 * 60 * 1000); // 跨过任意一次退避窗口
      await loop.tick();
      after = queue.get(row.id)!;
      expect(after.attempts).toBe(attempt);
    }
    expect(after.status).toBe("failed");
    expect(after.nextAttemptAt).toBeNull();
    expect(after.lastError).toContain("HTTP 500");
    expect(queue.counts().failed).toBe(1);
  });

  it("start/stop：注入调度器驱动 tick，stop 后定时器被取消", async () => {
    let cancelled = false;
    const registered: Array<[number, () => void]> = [];
    const loop = new DeliveryLoop({
      queue,
      outbound: [],
      paceSec: 30,
      scheduler: {
        every: (ms, fn) => {
          registered.push([ms, fn]);
          return () => {
            cancelled = true;
          };
        },
      },
    });

    queue.enqueue({ kind: "k", severity: "warn", title: "t", body: "b", source: "s" });
    loop.start();
    expect(registered).toHaveLength(1);
    expect(registered[0]![0]).toBe(30_000); // tick 间隔 = pace 秒
    await loop.stop(); // 等待启动即跑的 tick 完成并取消定时器
    expect(cancelled).toBe(true);
    expect(queue.counts().delivered).toBe(1);

    queue.enqueue({ kind: "k", severity: "warn", title: "t2", body: "b", source: "s" });
    await loop.tick(); // 手动 tick 仍可投递（调度器已不管）
    expect(queue.counts().delivered).toBe(2);
  });
});
