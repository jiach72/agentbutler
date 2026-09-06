/**
 * 本地数据库保留期清理（events / audit 追加式表）。
 *
 * events 与 audit 只增不删：安全复验每 30 秒、关键记忆探针每分钟、巡检与
 * runbook 步骤都会持续追加，长期常驻会让 butler.db 无限膨胀并拖慢所有依赖
 * 这两张表的读取路径（面板事件流、诊断报告、dailyInspectionMetrics）。
 * 本模块按固定低频周期删除超出保留期的旧行；清理是有界 DELETE，不参与巡检节奏。
 */
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";

/** events 保留天数：覆盖进化分析最长的 30 天回看窗口并留出跨时区余量。 */
export const EVENT_RETENTION_DAYS = 45;
/** audit 保留天数：审计用于事后追溯，保留更久。 */
export const AUDIT_RETENTION_DAYS = 90;
/** 清理执行周期（6 小时）。 */
export const RETENTION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RetentionPrunerOptions {
  pruneEvents: (cutoff: string) => number;
  pruneAudit: (cutoff: string) => number;
  /** 可注入时钟（epoch 毫秒，与 WatchAppOptions.now 一致）。 */
  now?: () => number;
  driver?: TimerDriver;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface RetentionPruner {
  start(): void;
  stop(): void;
  /** 立即执行一轮清理并返回删除行数（测试与手动触发用）。 */
  runOnce(): { events: number; audit: number };
}

export function createRetentionPruner(options: RetentionPrunerOptions): RetentionPruner {
  const now = options.now ?? (() => Date.now());
  const driver = options.driver ?? defaultTimerDriver;
  const intervalMs = options.intervalMs ?? RETENTION_PRUNE_INTERVAL_MS;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.warn("[butler-watch] retention prune failed:", error);
    });
  let handle: unknown;
  let running = false;

  const cutoffIso = (days: number): string =>
    new Date(now() - days * 24 * 60 * 60 * 1000).toISOString();

  function runOnce(): { events: number; audit: number } {
    let events = 0;
    let audit = 0;
    try {
      events = options.pruneEvents(cutoffIso(EVENT_RETENTION_DAYS));
    } catch (error) {
      onError(error);
    }
    try {
      audit = options.pruneAudit(cutoffIso(AUDIT_RETENTION_DAYS));
    } catch (error) {
      onError(error);
    }
    return { events, audit };
  }

  return {
    start() {
      if (running) return;
      running = true;
      runOnce(); // 启动后先清一轮，长期积压的旧库在下次重启也能收敛
      handle = driver.setInterval(() => runOnce(), intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      driver.clearInterval(handle);
      handle = undefined;
    },
    runOnce,
  };
}
