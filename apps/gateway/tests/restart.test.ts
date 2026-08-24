import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryLoop } from "../src/loop";
import { AlertQueue } from "../src/queue";
import { FakeChannel, gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

describe("重启补发", () => {
  let tmp: string;
  let dbFile: string;
  let queue: AlertQueue;

  beforeEach(() => {
    tmp = makeTempDir();
    dbFile = gatewayDbFile(tmp);
    queue = new AlertQueue(dbFile);
  });

  afterEach(() => {
    queue.close();
    rmTempDir(tmp);
  });

  it("遗留 pending 与超时 delivering 在重启后继续投递", async () => {
    // 第一次"进程"：入队 3 条，其中 critical 已被认领（模拟进程在投递中途崩溃）
    queue.enqueue({ kind: "k", severity: "warn", title: "t1", body: "b", source: "s" });
    const critical = queue.enqueue({
      kind: "k",
      severity: "critical",
      title: "t2",
      body: "b",
      source: "s",
    });
    queue.enqueue({ kind: "k", severity: "warn", title: "t3", body: "b", source: "s" });
    expect(queue.claimNext()?.title).toBe("t1"); // 先领走 t1
    expect(queue.claimNext()?.id).toBe(critical.id); // t2 卡在 delivering
    queue.markDelivered(queue.list().find((r) => r.title === "t1")!.id, "panel"); // t1 正常完结
    expect(queue.counts()).toMatchObject({ pending: 1, delivering: 1, delivered: 1 });
    queue.close();

    // 第二次"进程"：同 db 重开队列 + 新投递循环
    const reopened = new AlertQueue(dbFile);
    expect(reopened.counts()).toEqual({ pending: 2, delivering: 0, failed: 0, delivered: 1 }); // delivering 回置 pending

    const telegram = new FakeChannel("telegram");
    const loop = new DeliveryLoop({ queue: reopened, outbound: [telegram] });
    await loop.tick(); // t2（critical）→ telegram
    await loop.tick(); // t3 → panel

    expect(reopened.counts()).toEqual({ pending: 0, delivering: 0, delivered: 3, failed: 0 });
    expect(reopened.get(critical.id)).toMatchObject({ status: "delivered", channel: "telegram" });
    expect(telegram.sends.map((m) => m.title)).toEqual(["t2"]);
    reopened.close();
  });

  it("重启后 dedupeKey 仍命中遗留 pending（不重复新增）", () => {
    queue.enqueue({
      kind: "k",
      severity: "warn",
      title: "t",
      body: "b",
      source: "s",
      dedupeKey: "dk",
    });
    queue.close();

    const reopened = new AlertQueue(dbFile);
    const again = reopened.enqueue({
      kind: "k",
      severity: "warn",
      title: "t",
      body: "b",
      source: "s",
      dedupeKey: "dk",
    });
    expect(again.mergedCount).toBe(2);
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
  });
});
