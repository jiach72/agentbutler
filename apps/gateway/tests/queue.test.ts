import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertQueue, backoffSeconds, MAX_ATTEMPTS } from "../src/queue";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

describe("AlertQueue", () => {
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

  it("入队即持久化：关闭重开后数据仍可见", () => {
    queue.enqueue({
      kind: "agent-stuck",
      severity: "critical",
      title: "实例卡死",
      body: "hermes-main 无响应",
      source: "watch",
    });
    const dbFile = queue.dbFile;
    queue.close();

    const reopened = new AlertQueue(dbFile);
    const rows = reopened.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "agent-stuck",
      severity: "critical",
      title: "实例卡死",
      body: "hermes-main 无响应",
      source: "watch",
      status: "pending",
      attempts: 0,
      mergedCount: 1,
      nextAttemptAt: null,
      channel: null,
      lastError: null,
      deliveredAt: null,
    });
    reopened.close();
  });

  it("dedupeKey 合并：未终结行不新增，merged_count 递增并返回已有 id", () => {
    const first = queue.enqueue({
      kind: "log-error",
      severity: "warn",
      title: "错误刷屏",
      body: "b1",
      source: "watch",
      dedupeKey: "sig-1",
    });
    const second = queue.enqueue({
      kind: "log-error",
      severity: "warn",
      title: "错误刷屏",
      body: "b2",
      source: "watch",
      dedupeKey: "sig-1",
    });
    const third = queue.enqueue({
      kind: "log-error",
      severity: "warn",
      title: "另一个错误",
      body: "b3",
      source: "watch",
      dedupeKey: "sig-2",
    });

    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
    expect(queue.list()).toHaveLength(2);
    expect(queue.get(first.id)).toMatchObject({ mergedCount: 2, status: "pending" });
  });

  it("dedupeKey 终结后（delivered）再次入队会新增行", () => {
    const first = queue.enqueue({
      kind: "k",
      severity: "info",
      title: "t",
      body: "b",
      source: "s",
      dedupeKey: "dk",
    });
    queue.markDelivered(first.id, "panel");

    const again = queue.enqueue({
      kind: "k",
      severity: "info",
      title: "t",
      body: "b",
      source: "s",
      dedupeKey: "dk",
    });
    expect(again.id).not.toBe(first.id);
    expect(again.mergedCount).toBe(1);
    expect(queue.list()).toHaveLength(2);
  });

  it("claimNext 按 created_at 升序认领（入队顺序）", () => {
    for (let i = 1; i <= 3; i += 1) {
      queue.enqueue({ kind: "k", severity: "warn", title: `t${i}`, body: "b", source: "s" });
    }
    const first = queue.claimNext();
    const second = queue.claimNext();
    const third = queue.claimNext();
    expect([first?.title, second?.title, third?.title]).toEqual(["t1", "t2", "t3"]);
    expect(first?.status).toBe("delivering");
    expect(queue.claimNext()).toBeUndefined(); // 全部在投，无 pending 可领
  });

  it("markFailed：attempts 递增、指数退避 next_attempt_at、达到上限转 failed", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const row = queue.enqueue({
      kind: "k",
      severity: "critical",
      title: "t",
      body: "b",
      source: "s",
    });

    const failed1 = queue.markFailed(row.id, "telegram: boom", now);
    expect(failed1).toMatchObject({ attempts: 1, status: "pending", lastError: "telegram: boom" });
    expect(failed1?.nextAttemptAt).toBe("2026-01-01T00:02:00.000Z"); // +120s

    // 未到 next_attempt_at 不可认领；到点后可认领
    expect(queue.claimNext("2026-01-01T00:01:00.000Z")).toBeUndefined();
    expect(queue.claimNext("2026-01-01T00:02:00.000Z")?.id).toBe(row.id);

    // 依次失败到上限
    let attempts = 1;
    let last = failed1!;
    while (attempts < MAX_ATTEMPTS) {
      queue.claimNext("2099-01-01T00:00:00.000Z"); // 强制到期认领
      last = queue.markFailed(row.id, `fail-${attempts + 1}`, now)!;
      attempts += 1;
    }
    expect(last).toMatchObject({ attempts: MAX_ATTEMPTS, status: "failed" });
    expect(last.nextAttemptAt).toBeNull();
    expect(last.lastError).toContain("fail-5");
    expect(queue.counts().failed).toBe(1); // 保留可见，不静默丢弃
  });

  it("backoffSeconds：2^attempts×60s，封顶 30 分钟", () => {
    expect(backoffSeconds(1)).toBe(120);
    expect(backoffSeconds(2)).toBe(240);
    expect(backoffSeconds(3)).toBe(480);
    expect(backoffSeconds(4)).toBe(960);
    expect(backoffSeconds(10)).toBe(1800);
  });

  it("counts 与 list：按状态计数、最新在前、limit 生效", () => {
    const a = queue.enqueue({ kind: "k", severity: "info", title: "a", body: "b", source: "s" });
    queue.enqueue({ kind: "k", severity: "warn", title: "b", body: "b", source: "s" });
    queue.markDelivered(a.id, "panel");

    expect(queue.counts()).toEqual({ pending: 1, delivering: 0, delivered: 1, failed: 0 });
    expect(queue.list().map((r) => r.title)).toEqual(["b", "a"]); // id DESC = 最新在前
    expect(queue.list(1).map((r) => r.title)).toEqual(["b"]);
  });
});
