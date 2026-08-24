import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fail, ok, type Job, type Result } from "@butler/contract";
import { AuditLog } from "../src/audit";
import { EventBus } from "../src/events";
import { AdapterExecutor } from "../src/executor";
import { SqliteStore } from "../src/store";
import { makeTempDir, rmTempDir } from "./helpers";

/** 测试注入的短超时（毫秒）。 */
const TINY_TIMEOUT_MS = 15;
const HANG_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AdapterExecutor", () => {
  let tmp: string;
  let store: SqliteStore;
  let bus: EventBus;
  let audit: AuditLog;
  let executor: AdapterExecutor;

  beforeEach(() => {
    tmp = makeTempDir();
    store = new SqliteStore(path.join(tmp, "butler.db"));
    bus = new EventBus();
    audit = new AuditLog({ store, bus });
    executor = new AdapterExecutor({ audit, store, bus });
  });

  afterEach(() => {
    store.close();
    rmTempDir(tmp);
  });

  it("成功结果透传且 durationMs 为数字", async () => {
    const result = await executor.invokeAdapter(async () => ok({ value: 42 }), { method: "detect" });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ value: 42 });
    expect(typeof result.durationMs).toBe("number");
  });

  it("适配器手搓 Result 缺 durationMs 时兜底补全", async () => {
    const handMade = { ok: true, data: "raw" } as Result<string>;
    const result = await executor.invokeAdapter(async () => handMade, { method: "detect" });
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("控制类超时 → E202，且超时前已先写审计", async () => {
    const result = await executor.invokeAdapter(async () => {
      await delay(HANG_MS);
      return ok("too late");
    }, { method: "start", instance: "ins-1", timeoutMs: TINY_TIMEOUT_MS });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E202");
    expect(result.error?.message).toContain("timed out");
    expect(result.durationMs).toBeGreaterThanOrEqual(TINY_TIMEOUT_MS);

    const entries = audit.list({ action: "start" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.target).toBe("ins-1");
    expect(entries[0]!.actor).toBe("butler-core");
  });

  it("只读方法超时映射 E103、消息方法超时映射 E302", async () => {
    const readonlyResult = await executor.invokeAdapter(
      async () => {
        await delay(HANG_MS);
        return ok("late");
      },
      { method: "detect", timeoutMs: TINY_TIMEOUT_MS },
    );
    expect(readonlyResult.error?.code).toBe("E103");

    let calls = 0;
    const messagingResult = await executor.invokeAdapter(
      async () => {
        calls++;
        await delay(HANG_MS);
        return ok({ messageId: "m1", accepted: true, deduped: false, deliveredAt: "now" });
      },
      { method: "forwardInbound", timeoutMs: TINY_TIMEOUT_MS },
    );
    // messaging：超时 E302 retryable + maxAutoRetries=1 → 共 2 次尝试后放弃
    expect(messagingResult.error?.code).toBe("E302");
    expect(calls).toBe(2);
  });

  it("默认超时取自 CALL_DISCIPLINE（不注入时不秒失败）", async () => {
    const result = await executor.invokeAdapter(async () => {
      await delay(10);
      return ok("fast enough");
    }, { method: "detect" });
    expect(result.ok).toBe(true);
    expect(result.data).toBe("fast enough");
  });

  it("retryable 错误自动重试至成功（read-only ≤2 次重试）", async () => {
    let calls = 0;
    const result = await executor.invokeAdapter(
      async () => {
        calls++;
        if (calls < 3) return fail("E101", "instance not found yet");
        return ok("found");
      },
      { method: "detect" },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toBe("found");
    expect(calls).toBe(3);
  });

  it("retryable 错误重试耗尽后返回最后一次失败", async () => {
    let calls = 0;
    const result = await executor.invokeAdapter(
      async () => {
        calls++;
        return fail("E101", "still missing");
      },
      { method: "detect" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E101");
    expect(calls).toBe(3); // 1 次执行 + 2 次重试
  });

  it("非 retryable 错误不重试（即使纪律允许重试）", async () => {
    let calls = 0;
    const result = await executor.invokeAdapter(
      async () => {
        calls++;
        return fail("E002", "bad args");
      },
      { method: "detect" }, // read-only 允许 2 次重试，但 E002 不可重试
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E002");
    expect(calls).toBe(1);
  });

  it("control 类失败本身也不重试（纪律 maxAutoRetries=0）", async () => {
    let calls = 0;
    const result = await executor.invokeAdapter(
      async () => {
        calls++;
        return fail("E203", "precheck rejected");
      },
      { method: "restart", instance: "ins-1" },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    expect(audit.list({ action: "restart" })).toHaveLength(1); // 控制类仍写审计
  });

  it("抛出的异常捕获转 fail Result（禁止裸异常越界）", async () => {
    let calls = 0;
    const result = await executor.invokeAdapter(
      async () => {
        calls++;
        throw new Error("adapter exploded");
      },
      { method: "detect" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E002");
    expect((result.error?.cause as Error).message).toBe("adapter exploded");
    expect(calls).toBe(1); // 异常视为契约违规，不重试
    expect(typeof result.durationMs).toBe("number");
  });

  it("审计：control/long-op 写入（含自定义 actor/detail），read-only 不写", async () => {
    await executor.invokeAdapter(async () => ok({ instanceId: "ins-1", action: "stop", startedAt: "t" }), {
      method: "stop",
      instance: "ins-1",
      auditEntry: { actor: "watchdog", detail: { runbook: "restart-1" } },
    });
    await executor.invokeAdapter(async () => ok({ instanceId: "ins-1", action: "start", startedAt: "t" }), {
      method: "start",
      instance: "ins-1",
    });
    await executor.invokeAdapter(async () => ok("just reading"), { method: "stats" });

    const stops = audit.list({ action: "stop" });
    expect(stops).toHaveLength(1);
    expect(stops[0]!.actor).toBe("watchdog");
    expect(stops[0]!.target).toBe("ins-1");
    expect(stops[0]!.detail).toEqual({ runbook: "restart-1" });

    expect(audit.list({ action: "start" })).toHaveLength(1);
    expect(audit.list({ action: "stats" })).toHaveLength(0); // 只读不写审计
  });

  it("幂等：同 idempotencyKey 复用已存 Job，不重复执行", async () => {
    const job: Job = {
      jobId: "job-42",
      kind: "upgrade",
      steps: [{ id: "s1", label: "preflight", status: "passed" }],
    };
    const jobEvents: Job[] = [];
    bus.on("job-event", (e) => jobEvents.push(e.payload.job));

    let calls = 0;
    const first = await executor.invokeAdapter(async () => {
      calls++;
      return ok({ ...job });
    }, { method: "upgrade", instance: "ins-1", idempotencyKey: "key-1" });

    expect(first.ok).toBe(true);
    expect(calls).toBe(1);
    expect(jobEvents).toHaveLength(1);
    const stored = store.findJobByIdempotencyKey("key-1")!;
    expect(stored.jobId).toBe("job-42");
    expect(stored.kind).toBe("upgrade");
    expect(stored.instance).toBe("ins-1");
    expect(stored.status).toBe("done"); // 唯一步骤 passed → 全部收敛

    const second = await executor.invokeAdapter(
      async () => {
        calls++;
        throw new Error("must not be called");
      },
      { method: "upgrade", instance: "ins-1", idempotencyKey: "key-1" },
    );
    expect(second.ok).toBe(true);
    expect(second.data).toEqual(job);
    expect(calls).toBe(1); // 幂等命中，未重复执行
  });

  it("不同 idempotencyKey 各自执行", async () => {
    const makeJob = (id: string): Job => ({ jobId: id, kind: "snapshot", steps: [] });
    await executor.invokeAdapter(async () => ok(makeJob("job-a")), {
      method: "snapshot",
      instance: "ins-1",
      idempotencyKey: "key-a",
    });
    await executor.invokeAdapter(async () => ok(makeJob("job-b")), {
      method: "snapshot",
      instance: "ins-1",
      idempotencyKey: "key-b",
    });
    expect(store.findJobByIdempotencyKey("key-a")!.jobId).toBe("job-a");
    expect(store.findJobByIdempotencyKey("key-b")!.jobId).toBe("job-b");
  });

  it("超时不会泄漏定时器（连续多次超时调用均正常返回）", async () => {
    const spy = vi.fn();
    for (let i = 0; i < 3; i++) {
      const result = await executor.invokeAdapter(
        async () => {
          await delay(HANG_MS);
          return ok("late");
        },
        { method: "restart", instance: "ins-1", timeoutMs: TINY_TIMEOUT_MS },
      );
      expect(result.ok).toBe(false);
      spy();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(audit.list({ action: "restart" })).toHaveLength(3);
  });
});
