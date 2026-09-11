/**
 * 预算引擎（Trust Layer M1.1）：月度预算核算 + 触线动作。
 *
 * - 预算来源：BUTLER_BUDGET_MONTHLY_USD（0 = 未启用，只透出 spent 数据）；
 * - 核算周期：15 分钟（计划书硬性节奏；启动时立即核一轮）；
 * - 80% → warn 告警 + 事件中心事件；100% → critical 告警 + 按配置动作；
 * - 动作语义（BUTLER_BUDGET_ACTION）：alert 仅告警（默认）；
 *   downgrade 建议切换降级模型白名单；pause 建议进入全局急停。
 *   首版动作为「建议 + 事件记录」而非自动执行——自动切换模型/停机属于
 *   侵入性控制，必须让用户显式确认（边界诚实：不假装执行过）。
 * - 状态持久化在 butler 库 budget_state（每月一行），通知阈值防重放。
 */
import type { AuditLog, SqliteStore } from "@butler/core";
import type { AlertPoster } from "./alert-forward.js";
import type { LlmUsageService } from "./llm-usage.js";
import type { TrustEventHub } from "./trust-events.js";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";

/** 核算周期：计划书规定 15 分钟。 */
export const BUDGET_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** 告警阈值。 */
export const BUDGET_WARN_RATIO = 0.8;

export type BudgetActionConfig = "alert" | "downgrade" | "pause";

export interface BudgetEngineOptions {
  store: SqliteStore;
  llmUsage: LlmUsageService;
  poster?: AlertPoster;
  audit?: AuditLog;
  trustEvents?: TrustEventHub;
  config: { monthlyUsd: number; action: BudgetActionConfig };
  now?: () => number;
  driver?: TimerDriver;
  intervalMs?: number;
}

export interface BudgetStatus {
  enabled: boolean;
  budgetUsd: number;
  action: BudgetActionConfig;
  month: string;
  /** 本月迄今成本（USD）；成本列缺失时为 null（前端显示「待接入」）。 */
  spentUsd: number | null;
  spentSource: "actual" | "estimated" | null;
  ratio: number | null;
  threshold: "ok" | "80%" | "100%" | "over";
  /** 已触发的动作记录（advisory = 建议，非自动执行）。 */
  lastAction: string | null;
  lastCheckedAt: string | null;
  projectedExhaustedAt: string | null;
}

export interface BudgetEngine {
  status(): BudgetStatus;
  /** 立即核算一轮（返回核算后的状态；供 HTTP 与调度共用）。 */
  checkNow(): Promise<BudgetStatus>;
  start(): void;
  stop(): void;
}

/** 本地时区 YYYY-MM。 */
function monthKey(at: Date): string {
  return `${at.getFullYear()}-${`${at.getMonth() + 1}`.padStart(2, "0")}`;
}

const ACTION_LABELS: Record<BudgetActionConfig, string> = {
  alert: "仅告警",
  downgrade: "建议切换降级模型白名单",
  pause: "建议进入全局急停",
};

export function createBudgetEngine(options: BudgetEngineOptions): BudgetEngine {
  const now = options.now ?? (() => Date.now());
  const driver = options.driver ?? defaultTimerDriver;
  const intervalMs = options.intervalMs ?? BUDGET_CHECK_INTERVAL_MS;
  const { monthlyUsd, action } = options.config;
  let handle: unknown;
  let running = false;
  let lastStatus: BudgetStatus | null = null;
  /** 燃速估算（USD/天，trailing 7d）：触线日预测用；核算时刷新。 */
  let dailyBurnUsd: number | null = null;

  function baseStatus(): BudgetStatus {
    const date = new Date(now());
    const month = monthKey(date);
    const persisted = options.store.getBudgetState(month);
    return {
      enabled: monthlyUsd > 0,
      budgetUsd: monthlyUsd,
      action,
      month,
      spentUsd: null,
      spentSource: null,
      ratio: persisted !== undefined && monthlyUsd > 0 ? persisted.spentUsd / monthlyUsd : null,
      threshold: "ok",
      lastAction: persisted?.action !== undefined && persisted.action !== "none" ? persisted.action : null,
      lastCheckedAt: persisted?.updatedAt ?? null,
      projectedExhaustedAt: null,
    };
  }

  async function checkNow(): Promise<BudgetStatus> {
    const at = new Date(now());
    const month = monthKey(at);
    const status = baseStatus();
    const cost = await options.llmUsage.monthToDateCost().catch(() => null);
    if (cost !== null && cost.month === month) {
      // 优先真实账单（actual），缺失时用 estimated 并显式标注来源。
      const actual = cost.actualUsd;
      const estimated = cost.estimatedUsd;
      if (actual !== null) {
        status.spentUsd = actual;
        status.spentSource = "actual";
      } else if (estimated !== null) {
        status.spentUsd = estimated;
        status.spentSource = "estimated";
      }
    }

    const notified = options.store.getBudgetState(month)?.notified ?? [];
    if (status.spentUsd !== null && monthlyUsd > 0) {
      const ratio = status.spentUsd / monthlyUsd;
      status.ratio = ratio;
      status.threshold = ratio >= 1 ? (ratio > 1 ? "over" : "100%") : ratio >= BUDGET_WARN_RATIO ? "80%" : "ok";
      status.projectedExhaustedAt =
        dailyBurnUsd !== null && dailyBurnUsd > 0 && ratio < 1
          ? new Date(now() + ((monthlyUsd - status.spentUsd) / dailyBurnUsd) * 86_400_000).toISOString()
          : null;

      // 触线判定与通知（防重放：notified 标记持久化）。
      const crossed100 = ratio >= 1 && !notified.includes("100%");
      const crossed80 = ratio >= BUDGET_WARN_RATIO && ratio < 1 && !notified.includes("80%");
      if (crossed80 || crossed100) {
        const marker = crossed100 ? "100%" : "80%";
        const nextNotified = [...notified, marker];
        const actionLabel = crossed100 ? ACTION_LABELS[action] : "仅告警";
        status.lastAction = crossed100 ? `budget-exhausted:${action}` : "alert";
        const advisory = crossed100 && action !== "alert"
          ? `（建议动作：${actionLabel}；自动执行需在面板确认，本系统不擅自动你的 agent）`
          : "";
        options.store.saveBudgetState({
          month,
          budgetUsd: monthlyUsd,
          spentUsd: status.spentUsd,
          action: status.lastAction,
          notified: nextNotified,
        });
        const title = crossed100
          ? `本月 agent 成本已达预算 100%（$${status.spentUsd.toFixed(2)} / $${monthlyUsd.toFixed(2)}）`
          : `本月 agent 成本已达预算 80%（$${status.spentUsd.toFixed(2)} / $${monthlyUsd.toFixed(2)}）`;
        const body = `${title}${advisory} 数据来源：${status.spentSource === "actual" ? "provider 实际账单" : "估算（成本列）"}。`;
        options.trustEvents?.record({
          kind: "budget-threshold",
          severity: crossed100 ? "critical" : "warn",
          title,
          dedupeKey: `budget:${month}:${marker}`,
          evidence: [{ spentUsd: status.spentUsd, budgetUsd: monthlyUsd, ratio, at: at.toISOString() }],
        });
        await options.poster
          ?.post({
            kind: "budget",
            severity: crossed100 ? "critical" : "warn",
            title,
            body,
            source: "butler-watch",
            dedupeKey: `budget:${month}:${marker}`,
          })
          .catch(() => undefined);
        options.audit?.append({
          actor: "budget-engine",
          action: "budget-threshold-crossed",
          target: month,
          detail: { marker, spentUsd: status.spentUsd, budgetUsd: monthlyUsd },
        });
      } else {
        // 未跨新阈值也回写 spent，保证 /api/budget 有最近核算值。
        options.store.saveBudgetState({
          month,
          budgetUsd: monthlyUsd,
          spentUsd: status.spentUsd,
          action: status.lastAction ?? "none",
          notified,
        });
      }
    }

    status.lastCheckedAt = at.toISOString();
    lastStatus = status;
    return status;
  }

  return {
    status() {
      return lastStatus ?? baseStatus();
    },
    checkNow,
    start() {
      if (running) return;
      running = true;
      void checkNow().catch((error) => {
        console.warn("[butler-watch] budget check failed:", error);
      });
      handle = driver.setInterval(() => {
        void checkNow().catch((error) => {
          console.warn("[butler-watch] budget check failed:", error);
        });
      }, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      driver.clearInterval(handle);
      handle = undefined;
    },
  };
}
