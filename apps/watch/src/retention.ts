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
/** evolution observations 保留天数：原始观察遥测（量最大），聚合快照已留存。 */
export const EVOLUTION_OBSERVATION_RETENTION_DAYS = 180;
/** evolution daily metrics 保留天数：按日聚合快照，一年回看足够。 */
export const EVOLUTION_DAILY_METRIC_RETENTION_DAYS = 365;
/** 清理执行周期（6 小时）。 */
export const RETENTION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RetentionPrunerOptions {
  pruneEvents: (cutoff: string) => number;
  pruneAudit: (cutoff: string) => number;
  /** 行为审计流（Trust Layer M1.2）：保留期由采集器配置决定，此处只执行删除。 */
  pruneActionEvents?: (cutoff: string) => number;
  /** 事件中心（Trust Layer M2.2）：按 last_seen 清理。 */
  pruneTrustEvents?: (cutoff: string) => number;
  /** 会话索引（Trust Layer M2.3）：保留期由会话服务配置决定，此处只执行删除。 */
  pruneSessionIndex?: (cutoff: string) => number;
  /** 操作审批单（Trust Layer M3.1）：保留期由审批服务配置决定，此处只执行删除。 */
  pruneActionApprovals?: (cutoff: string) => number;
  /** 升级金丝雀运行记录（Trust Layer M3.2）：保留期由金丝雀服务配置决定。 */
  pruneCanaryRuns?: (cutoff: string) => number;
  /** 进度声明核实记录（Trust Layer M3.3）：保留期由进度检测服务配置决定。 */
  pruneProgressClaims?: (cutoff: string) => number;
  /** evolution 遥测（观察/日聚合）：core.store.pruneEvolutionHistory 的直通接线。 */
  pruneEvolutionHistory?: (
    observationCutoff: string,
    dailyMetricCutoff: string,
  ) => { observations: number; dailyMetrics: number };
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
  runOnce(): {
    events: number;
    audit: number;
    actionEvents: number;
    trustEvents: number;
    sessionIndex: number;
    actionApprovals: number;
    canaryRuns: number;
    progressClaims: number;
  };
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

  function runOnce(): {
    events: number;
    audit: number;
    actionEvents: number;
    trustEvents: number;
    sessionIndex: number;
    actionApprovals: number;
    canaryRuns: number;
    progressClaims: number;
  } {
    let events = 0;
    let audit = 0;
    let actionEvents = 0;
    let trustEvents = 0;
    let sessionIndex = 0;
    let actionApprovals = 0;
    let canaryRuns = 0;
    let progressClaims = 0;
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
    try {
      actionEvents = options.pruneActionEvents?.(cutoffIso(AUDIT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      trustEvents = options.pruneTrustEvents?.(cutoffIso(EVENT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      sessionIndex = options.pruneSessionIndex?.(cutoffIso(AUDIT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      actionApprovals = options.pruneActionApprovals?.(cutoffIso(AUDIT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      canaryRuns = options.pruneCanaryRuns?.(cutoffIso(AUDIT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      progressClaims = options.pruneProgressClaims?.(cutoffIso(AUDIT_RETENTION_DAYS)) ?? 0;
    } catch (error) {
      onError(error);
    }
    try {
      options.pruneEvolutionHistory?.(
        cutoffIso(EVOLUTION_OBSERVATION_RETENTION_DAYS),
        cutoffIso(EVOLUTION_DAILY_METRIC_RETENTION_DAYS),
      );
    } catch (error) {
      onError(error);
    }
    return {
      events,
      audit,
      actionEvents,
      trustEvents,
      sessionIndex,
      actionApprovals,
      canaryRuns,
      progressClaims,
    };
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
