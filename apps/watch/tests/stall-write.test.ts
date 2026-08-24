/**
 * stall-write 停写检测测试：进程存活结论复用 + 静默阈值判定。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStallWriteStage, STALL_WRITE_WARN_PREFIX } from "../src/probes/stall-write.js";
import type { InspectionContext } from "../src/pipeline.js";

let tmp: string;
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-stall-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxOf(shared: Record<string, unknown> = {}): InspectionContext {
  return { instanceId: "hermes-main", frameworkId: "hermes", rootPath: tmp, runtime: "process", shared };
}

describe("stall-write（日志停写检测）", () => {
  it("进程存活 + 日志静默 7h（超 6h 阈值）→ warn", async () => {
    const result = await createStallWriteStage({
      sampler: () => NOW - 7 * HOUR,
      now: () => NOW,
    }).run(ctxOf({ processAlive: "pass" }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain(STALL_WRITE_WARN_PREFIX);
    expect(result.detail).toContain("7h");
  });

  it("进程存活 + 日志静默恰在阈值内 → pass", async () => {
    const result = await createStallWriteStage({
      sampler: () => NOW - 3 * HOUR,
      now: () => NOW,
    }).run(ctxOf({ processAlive: "pass" }));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("日志活跃");
  });

  it("进程未运行（process-alive fail）→ 不报停写，skipped", async () => {
    const result = await createStallWriteStage({
      sampler: () => NOW - 7 * HOUR,
      now: () => NOW,
    }).run(ctxOf({ processAlive: "fail" }));
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("进程未运行");
  });

  it("缺少 process-alive 结论 → skipped 不判定", async () => {
    const result = await createStallWriteStage({
      sampler: () => NOW - 7 * HOUR,
      now: () => NOW,
    }).run(ctxOf());
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("缺少 process-alive 结论");
  });

  it("无日志文件 → skipped", async () => {
    const result = await createStallWriteStage({
      sampler: () => null,
      now: () => NOW,
    }).run(ctxOf({ processAlive: "pass" }));
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("不存在");
  });

  it("阈值可配置：3h 阈值下 3.5h 静默 → warn", async () => {
    const result = await createStallWriteStage({
      thresholdMs: 3 * HOUR,
      sampler: () => NOW - 3.5 * HOUR,
      now: () => NOW,
    }).run(ctxOf({ processAlive: "pass" }));
    expect(result.status).toBe("warn");
  });

  it("默认采集器：真实 logs 目录取最新 mtime；无 logs 目录返回 null", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { defaultLogMtimeSampler } = await import("../src/probes/stall-write.js");
    expect(defaultLogMtimeSampler()(tmp)).toBeNull(); // 无 logs 目录
    mkdirSync(join(tmp, "logs"), { recursive: true });
    writeFileSync(join(tmp, "logs", "agent.log"), "line\n");
    const latest = defaultLogMtimeSampler()(tmp);
    expect(latest).not.toBeNull();
    expect(Math.abs(Date.now() - latest!)).toBeLessThan(60_000); // 刚写入 → 接近当前时刻
  });
});
