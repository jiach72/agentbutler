/**
 * 停写检测（stall-write，Task 6.3）：进程活着但日志长时间静默 → 疑似停写。
 *
 * - 日志静默度：取 <rootPath>/logs/*.log 的最新 mtime（可注入 stats 采集器）；
 *   无日志文件 → skipped；
 * - 进程存活结论复用巡检 process-alive 阶段（经 ctx.shared["processAlive"] 传递，
 *   不重复 pgrep）；进程未运行 → skipped（停写不适用，进程故障由 process-alive 表达）；
 * - 进程存活 + 静默超过阈值（默认 6h，可配）→ warn "进程存活但疑似停写"；
 *   未超阈值 → pass。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InspectionStage } from "../pipeline.js";

export const STALL_WRITE_CHECK_ID = "stall-write";
export const STALL_WRITE_WARN_PREFIX = "进程存活但疑似停写";
/** 默认静默阈值 6h。 */
export const DEFAULT_STALL_WRITE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** 日志 mtime 采集器：返回 rootPath/logs 下 *.log 的最新 mtimeMs；无日志文件返回 null。 */
export type LogMtimeSampler = (rootPath: string) => number | null;

/** 默认采集器：readdir + stat（可注入）。 */
export function defaultLogMtimeSampler(): LogMtimeSampler {
  return (rootPath) => {
    const logsDir = join(rootPath, "logs");
    let latest: number | null = null;
    let entries: string[];
    try {
      entries = readdirSync(logsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".log")) continue;
      try {
        const mtimeMs = statSync(join(logsDir, entry)).mtimeMs;
        if (latest === null || mtimeMs > latest) latest = mtimeMs;
      } catch {
        // 单文件 stat 失败跳过（轮转窗口内删除等）。
      }
    }
    return latest;
  };
}

export interface StallWriteDeps {
  /** 静默阈值（毫秒，默认 6h）。 */
  thresholdMs?: number;
  /** 日志 mtime 采集器（默认 readdir+stat）。 */
  sampler?: LogMtimeSampler;
  now?: () => number;
}

export function createStallWriteStage(deps: StallWriteDeps = {}): InspectionStage {
  const thresholdMs = deps.thresholdMs ?? DEFAULT_STALL_WRITE_THRESHOLD_MS;
  const sampler = deps.sampler ?? defaultLogMtimeSampler();
  const now = deps.now ?? Date.now;
  return {
    id: STALL_WRITE_CHECK_ID,
    label: "日志停写检测",
    async run(ctx) {
      const latest = sampler(ctx.rootPath);
      if (latest === null) {
        return { id: STALL_WRITE_CHECK_ID, status: "skipped", detail: "logs/*.log 不存在，停写检测无对象" };
      }
      // 复用 process-alive 结论（pipeline 前置阶段写入 shared）。
      const alive = ctx.shared["processAlive"];
      if (alive === "fail") {
        return { id: STALL_WRITE_CHECK_ID, status: "skipped", detail: "进程未运行，停写检测不适用" };
      }
      if (alive === undefined) {
        return { id: STALL_WRITE_CHECK_ID, status: "skipped", detail: "缺少 process-alive 结论，停写检测不判定" };
      }
      const silentMs = now() - latest;
      if (silentMs > thresholdMs) {
        const hours = Math.round(silentMs / 360_000) / 10;
        return {
          id: STALL_WRITE_CHECK_ID,
          status: "warn",
          detail: `${STALL_WRITE_WARN_PREFIX}：日志静默 ${hours}h 超阈值 ${Math.round(thresholdMs / 360_000) / 10}h`,
        };
      }
      const minutes = Math.round(silentMs / 600_00);
      return { id: STALL_WRITE_CHECK_ID, status: "pass", detail: `日志活跃（最新写入 ${minutes} 分钟前）` };
    },
  };
}
