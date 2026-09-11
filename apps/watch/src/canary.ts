/**
 * 升级金丝雀（M3.2）：agent 框架更新不该是开盲盒——新版本先在影子环境跑一轮真实任务，
 * 没问题才切换，有问题 24h 内自动回滚。
 *
 * 三段职责，全部确定性、零 LLM：
 * 1. **任务抽样**：从真实 `session_index` 取近 7 天样本——10 个常规（终态 ok）+ 全部失败
 *    会话（上限 50）。抽样是确定性排序，不是随机，保证可复现。
 * 2. **准入判据**：成功率降幅 ≤ 5pp、token 增幅 ≤ 15%、无新增 error 级指纹——三条全过才放行。
 *    **数据缺失一律按不通过处理**：宁可拦下，也不给「没验证却声称验证过」开口子。
 * 3. **观察窗自动回滚**：切换后观察窗内若事件中心出现 severity ≥ warn 且 kind 为
 *    `upgrade-regression-suspect` 的关联事件 → 自动回滚快照 + 推送说明；窗口内无回归 → 完成。
 *
 * 边界诚实（重要）：本服务**不自己拉起影子实例**。影子执行能力通过 `shadowRunner` 端口注入；
 * 默认实现返回「未配置」而非伪造指标。此时按策略处置：
 * - 激进（aggressive）：跳过金丝雀，状态 `skipped`；
 * - 标准（standard）：升级放行，但状态记为 `unverified` 并在事件/告警里显式标注**未验证**；
 * - 保守（conservative）：升级**拦截**，状态 `blocked`。
 */
import { randomUUID } from "node:crypto";
import type {
  AuditLog,
  CanaryMetrics,
  CanaryPolicy,
  CanaryRunRow,
  CanaryStatus,
  CanaryVerdict,
  SqliteStore,
} from "@butler/core";
import type { AlertPoster } from "./alert-forward.js";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";
import type { TrustEventHub } from "./trust-events.js";
import type { UpgradeService } from "./upgrade.js";

/** 观察窗：标准 24h / 保守 48h（计划书 §M3.2 版本策略）。 */
export const CANARY_OBSERVATION_MS: Record<CanaryPolicy, number> = {
  aggressive: 0,
  standard: 24 * 60 * 60 * 1000,
  conservative: 48 * 60 * 60 * 1000,
};
/** 准入容差：成功率降幅 ≤ 5pp；token 增幅 ≤ 15%。 */
export const CANARY_SUCCESS_RATE_DROP_MAX = 0.05;
export const CANARY_TOKEN_INCREASE_MAX = 0.15;
/** 抽样：10 个常规 + 全部失败（上限）。 */
export const CANARY_SAMPLE_REGULAR = 10;
export const CANARY_SAMPLE_FAILED_CAP = 50;
/** 基线回看窗口。 */
export const CANARY_BASELINE_WINDOW_DAYS = 7;
/** 观察窗巡检间隔：5 分钟（回归检测延迟要求宽松，但不宜过大）。 */
export const CANARY_TICK_INTERVAL_MS = 5 * 60 * 1000;
export const CANARY_RETENTION_DAYS = 180;

/** R1 关联规则产出的事件 kind（观察窗判定的依据）。 */
export const CANARY_REGRESSION_EVENT_KIND = "upgrade-regression-suspect";

export const CANARY_SETTING_POLICY = "upgrade_policy";

export const CANARY_AUDIT_PLAN = "canary-plan";
export const CANARY_AUDIT_VERDICT = "canary-verdict";
export const CANARY_AUDIT_ROLLBACK = "canary-auto-rollback";

export interface CanaryTaskRef {
  sessionId: string;
  outcome: string;
  /** regular（常规样本） | failed（失败样本）。 */
  bucket: "regular" | "failed";
}

export interface CanaryMetricsView extends CanaryMetrics {
  /** 指标来源说明（实测口径，便于用户核对）。 */
  source: string;
}

export interface CanaryRunView {
  id: string;
  instance: string;
  fromVersion: string | null;
  targetVersion: string;
  policy: CanaryPolicy;
  status: CanaryStatus;
  sampleRegular: number;
  sampleFailed: number;
  tasks: CanaryTaskRef[];
  baseline: (CanaryMetrics & { source: string }) | null;
  shadow: (CanaryMetrics & { source: string }) | null;
  verdict: CanaryVerdict | null;
  observationUntil: string | null;
  /** 观察窗剩余毫秒（非观察态为 0）。 */
  observationRemainingMs: number;
  switchedAt: string | null;
  rollbackSnapshotId: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  /** 该策略下的观察窗时长（供 UI 解释「为什么还要等」）。 */
  observationWindowMs: number;
}

export interface CanarySummary {
  total: number;
  observing: number;
  passed: number;
  blocked: number;
  unverified: number;
  skipped: number;
  rolledBack: number;
  completed: number;
  lastAt: string | null;
  policy: CanaryPolicy;
}

export interface ShadowRunResult {
  ok: boolean;
  metrics?: CanaryMetrics & { source: string };
  reason?: string;
}

/** 影子执行器端口：拉起候选版本影子实例并回放抽样任务，产出可比指标。 */
export interface CanaryShadowRunner {
  available(): boolean;
  unavailableReason(): string;
  run(input: {
    runId: string;
    targetVersion: string;
    instance: string;
    tasks: CanaryTaskRef[];
  }): Promise<ShadowRunResult>;
}

export interface CanaryService {
  getPolicy(): CanaryPolicy;
  setPolicy(policy: CanaryPolicy): CanaryPolicy;
  /** 抽样 + 建单（不执行）；供「先看看样本」与测试使用。 */
  plan(input: { targetVersion: string; instance?: string; fromVersion?: string | null }): CanaryRunView;
  /** 三指标准入判据（纯函数式，可独立测试）。 */
  evaluate(input: { baseline: CanaryMetrics; shadow: CanaryMetrics }): CanaryVerdict;
  /** 完整流程：抽样 → 影子验证 → 判定 → 进入观察窗 / 拦截 / 标注未验证。 */
  start(input: {
    targetVersion: string;
    instance?: string;
    fromVersion?: string | null;
    rollbackSnapshotId?: number | null;
  }): Promise<CanaryRunView>;
  get(id: string): CanaryRunView | null;
  list(filter?: { status?: CanaryStatus; limit?: number }): { items: CanaryRunView[]; summary: CanarySummary };
  /** 观察窗守卫：回归检测与自动回滚 / 窗口收敛。返回本轮处置的运行数。 */
  tick(): Promise<number>;
  prune(): number;
  startTimer(): void;
  stopTimer(): void;
}

export interface CanaryServiceOptions {
  store: SqliteStore;
  trustEvents: TrustEventHub;
  audit?: AuditLog;
  poster?: AlertPoster;
  upgrade?: UpgradeService;
  /** 影子执行器；缺省 = 未配置（诚实降级，不伪造指标）。 */
  shadowRunner?: CanaryShadowRunner;
  /** 策略缺省值（首次运行时写入运行时设置）。 */
  defaultPolicy?: CanaryPolicy;
  tickIntervalMs?: number;
  retentionDays?: number;
  now?: () => number;
  driver?: TimerDriver;
  idFactory?: () => string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizePolicy(value: string | null | undefined): CanaryPolicy | null {
  return value === "aggressive" || value === "standard" || value === "conservative" ? value : null;
}

export function createCanaryService(options: CanaryServiceOptions): CanaryService {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const driver = options.driver ?? defaultTimerDriver;
  const idFactory = options.idFactory ?? (() => randomUUID());
  const tickIntervalMs = Math.max(5_000, Math.floor(options.tickIntervalMs ?? CANARY_TICK_INTERVAL_MS));
  const retentionDays = Math.max(7, Math.floor(options.retentionDays ?? CANARY_RETENTION_DAYS));
  let timer: unknown = null;
  let running = false;

  /* ------------------------------- 策略 ------------------------------- */

  function getPolicy(): CanaryPolicy {
    const stored = normalizePolicy(store.getRuntimeSetting(CANARY_SETTING_POLICY));
    if (stored !== null) return stored;
    // 首次运行落库缺省值，避免「设置页显示默认但库里没有」的漂移。
    const fallback = options.defaultPolicy ?? "standard";
    store.setRuntimeSetting(CANARY_SETTING_POLICY, fallback, iso());
    return fallback;
  }

  function setPolicy(policy: CanaryPolicy): CanaryPolicy {
    store.setRuntimeSetting(CANARY_SETTING_POLICY, policy, iso());
    options.audit?.append({
      actor: "canary",
      action: "canary-policy-changed",
      target: policy,
      detail: { observationWindowMs: CANARY_OBSERVATION_MS[policy] },
    });
    return policy;
  }

  /* --------------------------- 任务抽样 --------------------------- */

  /**
   * 从真实会话索引抽样：10 个常规（ok）+ 全部失败（error，上限 50）。
   * 常规样本按开始时间倒序取前 N（确定性，可复现）；失败样本全取。
   */
  function sampleTasks(): CanaryTaskRef[] {
    const since = new Date(now() - CANARY_BASELINE_WINDOW_DAYS * 86_400_000).toISOString();
    const okRows = store.listSessionIndex({ outcome: "ok", since, limit: CANARY_SAMPLE_REGULAR });
    const errorRows = store.listSessionIndex({
      outcome: "error",
      since,
      limit: CANARY_SAMPLE_FAILED_CAP,
    });
    return [
      ...okRows.map((row) => ({ sessionId: row.sessionId, outcome: row.outcome, bucket: "regular" as const })),
      ...errorRows.map((row) => ({ sessionId: row.sessionId, outcome: row.outcome, bucket: "failed" as const })),
    ];
  }

  /** 基线指标：直接读当前运行版本的真实观测（会话索引 + 指纹表），零编造。 */
  function baselineFromObservations(): CanaryMetrics & { source: string } {
    const since = new Date(now() - CANARY_BASELINE_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = store.listSessionIndex({ since, limit: 2000 });
    const done = rows.filter((row) => row.outcome === "ok" || row.outcome === "error");
    const ok = done.filter((row) => row.outcome === "ok").length;
    const tokens = rows
      .map((row) => (row.tokenIn ?? 0) + (row.tokenOut ?? 0))
      .filter((value) => value > 0);
    const durations = rows.map((row) => row.durationMs).filter((value): value is number => value !== null && value > 0);
    return {
      successRate: done.length === 0 ? null : ok / done.length,
      avgTokens: tokens.length === 0 ? null : tokens.reduce((sum, value) => sum + value, 0) / tokens.length,
      avgDurationMs:
        durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length,
      sampleSize: rows.length,
      // 基线期「error 级指纹」：指纹表当前 open 的全部签名（无分级字段，按存在即计）。
      errorFingerprints: store.listFingerprints(2000, since).map((row) => row.signature).sort(),
      outputSimilarity: null,
      source: `当前版本近 ${CANARY_BASELINE_WINDOW_DAYS} 天实测（会话索引 ${rows.length} 条 + 指纹表）`,
    };
  }

  /* ------------------------- 准入判据（纯函数） ------------------------- */

  function evaluate(input: { baseline: CanaryMetrics; shadow: CanaryMetrics }): CanaryVerdict {
    const { baseline, shadow } = input;
    const checks: CanaryVerdict["checks"] = [];
    const notEvaluated: string[] = [];

    // ① 成功率降幅 ≤ 5pp。任一缺失 → 不通过（缺数据不得放行）。
    if (baseline.successRate === null || shadow.successRate === null) {
      checks.push({
        id: "success-rate",
        label: "成功率降幅 ≤ 5 个百分点",
        baseline: baseline.successRate,
        shadow: shadow.successRate,
        tolerance: "≤ 5pp",
        pass: false,
        detail: "基线或影子的成功率缺失（采样不足），无法判定——按不通过处理",
      });
    } else {
      const drop = baseline.successRate - shadow.successRate;
      checks.push({
        id: "success-rate",
        label: "成功率降幅 ≤ 5 个百分点",
        baseline: baseline.successRate,
        shadow: shadow.successRate,
        tolerance: "≤ 5pp",
        pass: drop <= CANARY_SUCCESS_RATE_DROP_MAX,
        detail:
          drop <= 0
            ? `成功率未下降（变化 ${(drop * 100).toFixed(1)}pp）`
            : `成功率下降 ${(drop * 100).toFixed(1)}pp（上限 ${(CANARY_SUCCESS_RATE_DROP_MAX * 100).toFixed(0)}pp）`,
      });
    }

    // ② token 增幅 ≤ 15%。
    if (baseline.avgTokens === null || shadow.avgTokens === null || baseline.avgTokens <= 0) {
      checks.push({
        id: "token",
        label: "平均 token 增幅 ≤ 15%",
        baseline: baseline.avgTokens,
        shadow: shadow.avgTokens,
        tolerance: "≤ 15%",
        pass: false,
        detail: "基线或影子的 token 均值缺失（或基线为 0，无法算增幅），无法判定——按不通过处理",
      });
    } else {
      const increase = (shadow.avgTokens - baseline.avgTokens) / baseline.avgTokens;
      checks.push({
        id: "token",
        label: "平均 token 增幅 ≤ 15%",
        baseline: baseline.avgTokens,
        shadow: shadow.avgTokens,
        tolerance: "≤ 15%",
        pass: increase <= CANARY_TOKEN_INCREASE_MAX,
        detail:
          increase <= 0
            ? `token 消耗未增加（变化 ${(increase * 100).toFixed(1)}%）`
            : `token 增加 ${(increase * 100).toFixed(1)}%（上限 ${(CANARY_TOKEN_INCREASE_MAX * 100).toFixed(0)}%）`,
      });
    }

    // ③ 无新增 error 级指纹。
    const baselineSet = new Set(baseline.errorFingerprints);
    const newSignatures = shadow.errorFingerprints.filter((signature) => !baselineSet.has(signature));
    checks.push({
      id: "new-error-fingerprints",
      label: "无新增 error 级指纹",
      baseline: baseline.errorFingerprints.length,
      shadow: shadow.errorFingerprints.length,
      tolerance: "新增数 = 0",
      pass: newSignatures.length === 0,
      detail:
        newSignatures.length === 0
          ? "未出现新的错误指纹"
          : `出现 ${newSignatures.length} 个新错误指纹：${newSignatures.slice(0, 3).join("；")}${newSignatures.length > 3 ? " 等" : ""}`,
    });

    // 输出相似度不参与准入（计划书准入判据只列三项）；显式声明，不冒充已评估。
    notEvaluated.push(
      shadow.outputSimilarity === null && baseline.outputSimilarity === null
        ? "输出相似度：两侧均未计算，未参与判定"
        : "输出相似度：仅作参考展示，不参与准入判定",
    );

    return { pass: checks.every((check) => check.pass), checks, notEvaluated };
  }

  /* ------------------------------ 视图 ------------------------------ */

  function toView(row: CanaryRunRow): CanaryRunView {
    const observing = row.status === "observing";
    const remaining =
      observing && row.observationUntil !== null ? Math.max(0, Date.parse(row.observationUntil) - now()) : 0;
    return {
      id: row.id,
      instance: row.instance,
      fromVersion: row.fromVersion,
      targetVersion: row.targetVersion,
      policy: row.policy,
      status: row.status,
      sampleRegular: row.sampleRegular,
      sampleFailed: row.sampleFailed,
      tasks: parseJson<CanaryTaskRef[]>(row.taskIdsJson, []),
      baseline: parseJson<(CanaryMetrics & { source: string }) | null>(row.baselineJson, null),
      shadow: parseJson<(CanaryMetrics & { source: string }) | null>(row.shadowJson, null),
      verdict: parseJson<CanaryVerdict | null>(row.verdictJson, null),
      observationUntil: row.observationUntil,
      observationRemainingMs: Number.isFinite(remaining) ? remaining : 0,
      switchedAt: row.switchedAt,
      rollbackSnapshotId: row.rollbackSnapshotId,
      reason: row.reason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      observationWindowMs: CANARY_OBSERVATION_MS[row.policy],
    };
  }

  /* --------------------------- 计划与执行 --------------------------- */

  function plan(input: { targetVersion: string; instance?: string; fromVersion?: string | null }): CanaryRunView {
    const policy = getPolicy();
    const tasks = sampleTasks();
    const regular = tasks.filter((task) => task.bucket === "regular").length;
    const failed = tasks.filter((task) => task.bucket === "failed").length;
    const row = store.insertCanaryRun({
      id: idFactory(),
      ...(input.instance === undefined ? {} : { instance: input.instance }),
      fromVersion: input.fromVersion ?? null,
      targetVersion: input.targetVersion,
      policy,
      status: "planned",
      sampleRegular: regular,
      sampleFailed: failed,
      taskIds: tasks,
      at: iso(),
    });
    options.audit?.append({
      actor: "canary",
      action: CANARY_AUDIT_PLAN,
      target: row.id,
      detail: { targetVersion: input.targetVersion, policy, regular, failed },
    });
    return toView(row);
  }

  async function start(input: {
    targetVersion: string;
    instance?: string;
    fromVersion?: string | null;
    rollbackSnapshotId?: number | null;
  }): Promise<CanaryRunView> {
    const policy = getPolicy();
    const tasks = sampleTasks();
    const regular = tasks.filter((task) => task.bucket === "regular").length;
    const failed = tasks.filter((task) => task.bucket === "failed").length;
    const id = idFactory();
    const instance = input.instance ?? "";

    // ① 激进策略：直接跳过（用户明确选择不做金丝雀）。
    if (policy === "aggressive") {
      const row = store.insertCanaryRun({
        id,
        instance,
        fromVersion: input.fromVersion ?? null,
        targetVersion: input.targetVersion,
        policy,
        status: "skipped",
        sampleRegular: regular,
        sampleFailed: failed,
        taskIds: tasks,
        reason: "激进策略：按配置跳过金丝雀验证",
        at: iso(),
      });
      options.audit?.append({
        actor: "canary",
        action: CANARY_AUDIT_PLAN,
        target: id,
        detail: { policy, status: "skipped", targetVersion: input.targetVersion },
      });
      return toView(row);
    }

    const runRow = store.insertCanaryRun({
      id,
      instance,
      fromVersion: input.fromVersion ?? null,
      targetVersion: input.targetVersion,
      policy,
      status: "running",
      sampleRegular: regular,
      sampleFailed: failed,
      taskIds: tasks,
      ...(input.rollbackSnapshotId === undefined ? {} : { rollbackSnapshotId: input.rollbackSnapshotId }),
      at: iso(),
    });

    const runner = options.shadowRunner;
    const runnerAvailable = runner !== undefined && runner.available();

    // ② 影子执行器不可用：按策略处置，绝不伪造「通过」。
    if (!runnerAvailable) {
      const reason = runner?.unavailableReason() ?? "shadow-executor-not-configured";
      const blocked = policy === "conservative";
      const status: CanaryStatus = blocked ? "blocked" : "unverified";
      const updated = store.updateCanaryRun(id, {
        status,
        reason: blocked
          ? `保守策略要求金丝雀验证，但影子执行器不可用（${reason}）：升级已拦截`
          : `影子执行器不可用（${reason}）：本次升级未做金丝雀验证，已记为「未验证」`,
        at: iso(),
      });
      options.audit?.append({
        actor: "canary",
        action: CANARY_AUDIT_VERDICT,
        target: id,
        detail: { policy, status, reason, shadowRunnerAvailable: false },
      });
      if (options.poster !== undefined) {
        void options.poster.post({
          kind: "canary",
          severity: blocked ? "critical" : "warn",
          title: blocked
            ? `升级 ${input.targetVersion} 已被金丝雀策略拦截`
            : `升级 ${input.targetVersion} 未做金丝雀验证`,
          body: blocked
            ? `保守策略要求先跑影子验证再切换，但影子执行器不可用（${reason}）。为避免盲切换，本次升级已拦截；配置影子执行器后可重试。`
            : `影子执行器不可用（${reason}），本次升级在未验证状态下放行——事件中心已标注「未验证」，如随后出现异常可一键回滚。`,
          source: "butler-watch",
          dedupeKey: `canary:${id}`,
        });
      }
      return toView(updated ?? runRow);
    }

    // ③ 跑影子验证 → 取基线（真实观测）→ 判定。
    let shadow: (CanaryMetrics & { source: string }) | null = null;
    try {
      const result = await runner.run({ runId: id, targetVersion: input.targetVersion, instance, tasks });
      if (result.ok && result.metrics !== undefined) {
        shadow = result.metrics;
      } else {
        const failReason = result.reason ?? "shadow-run-failed";
        const updated = store.updateCanaryRun(id, {
          status: policy === "conservative" ? "blocked" : "unverified",
          reason:
            policy === "conservative"
              ? `影子验证执行失败（${failReason}）：保守策略下升级已拦截`
              : `影子验证执行失败（${failReason}）：本次升级记为「未验证」`,
          at: iso(),
        });
        options.audit?.append({
          actor: "canary",
          action: CANARY_AUDIT_VERDICT,
          target: id,
          detail: { policy, shadowRunFailed: true, failReason },
        });
        return toView(updated ?? runRow);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = store.updateCanaryRun(id, {
        status: policy === "conservative" ? "blocked" : "unverified",
        reason: `影子验证异常（${message}）：${policy === "conservative" ? "升级已拦截" : "记为「未验证」"}`,
        at: iso(),
      });
      return toView(updated ?? runRow);
    }

    const baseline = baselineFromObservations();
    const verdict = evaluate({ baseline, shadow });

    if (!verdict.pass) {
      const failed = verdict.checks.filter((check) => !check.pass).map((check) => check.label);
      const updated = store.updateCanaryRun(id, {
        status: "blocked",
        baseline,
        shadow,
        verdict,
        reason: `准入判据未通过（${failed.join("；")}）：升级已拦截`,
        at: iso(),
      });
      options.audit?.append({
        actor: "canary",
        action: CANARY_AUDIT_VERDICT,
        target: id,
        detail: { status: "blocked", failed, policy },
      });
      if (options.poster !== undefined) {
        void options.poster.post({
          kind: "canary",
          severity: "warn",
          title: `升级 ${input.targetVersion} 未通过金丝雀准入判据`,
          body: `影子验证未达标：${verdict.checks
            .filter((check) => !check.pass)
            .map((check) => `${check.label}——${check.detail}`)
            .join("；")}。已拦截本次升级，差异报告可在面板「升级策略」查看。`,
          source: "butler-watch",
          dedupeKey: `canary:${id}`,
        });
      }
      return toView(updated ?? runRow);
    }

    // ④ 通过 → 进入观察窗（切本身由升级流水线执行，这里只登记窗口与起点）。
    const windowMs = CANARY_OBSERVATION_MS[policy];
    const switchedAt = iso();
    const updated = store.updateCanaryRun(id, {
      status: "observing",
      baseline,
      shadow,
      verdict,
      switchedAt,
      observationUntil: new Date(now() + windowMs).toISOString(),
      reason: `准入判据全部通过，已切换并在 ${Math.round(windowMs / 3_600_000)}h 观察窗内监控回归`,
      at: switchedAt,
    });
    options.audit?.append({
      actor: "canary",
      action: CANARY_AUDIT_VERDICT,
      target: id,
      detail: { status: "observing", policy, windowMs },
    });
    return toView(updated ?? runRow);
  }

  /* --------------------------- 观察窗守卫 --------------------------- */

  /**
   * 每轮巡检：
   * - 观察窗内出现 `upgrade-regression-suspect`（severity ≥ warn）→ 自动回滚快照 + 推送说明；
   * - 观察窗到期且无回归 → 完成。
   * 回滚失败不假装成功：状态置 blocked 并把真实原因写明，提示人工处置。
   */
  async function tick(): Promise<number> {
    const observing = store.listCanaryRunsObserving();
    let handled = 0;
    for (const row of observing) {
      const switchedAt = row.switchedAt ?? row.createdAt;
      const regressions = store.listTrustEvents({
        kind: CANARY_REGRESSION_EVENT_KIND,
        lastSeenSince: switchedAt,
        limit: 20,
      });
      if (regressions.length > 0) {
        const detail = regressions
          .slice(0, 3)
          .map((event) => event.title)
          .join("；");
        // 回滚：优先用登记的快照；没有快照就如实说明无法自动回滚。
        let rollbackNote = "未登记可用快照，无法自动回滚——请在面板手动处理";
        let rolledBack = false;
        if (row.rollbackSnapshotId !== null && options.upgrade !== undefined) {
          try {
            const outcome = await options.upgrade.rollbackSnapshot(row.rollbackSnapshotId, row.instance || undefined);
            if (outcome.status === "ok") {
              // status=ok 只代表适配器已受理：真正成败看子步骤（failed 即回滚未落地）。
              const failedSteps = outcome.job.steps.filter((step) => step.status === "failed");
              rolledBack = failedSteps.length === 0;
              rollbackNote = rolledBack
                ? `已自动回滚到快照登记行 ${row.rollbackSnapshotId}`
                : `回滚受理但存在失败子步骤（${failedSteps.map((step) => step.id).join("、")}）——请在面板手动处理`;
            } else {
              rollbackNote = `回滚未成功（${outcome.status}）——请在面板手动处理`;
            }
          } catch (error) {
            rollbackNote = `回滚异常（${error instanceof Error ? error.message : String(error)}）——请人工处置`;
          }
        }
        const updated = store.updateCanaryRun(row.id, {
          status: rolledBack ? "rolled-back" : "blocked",
          reason: `观察窗内检出 ${regressions.length} 条升级疑似回归：${detail}。${rollbackNote}`,
          at: iso(),
        });
        options.audit?.append({
          actor: "canary",
          action: CANARY_AUDIT_ROLLBACK,
          target: row.id,
          detail: {
            regressions: regressions.map((event) => event.id),
            rollbackSnapshotId: row.rollbackSnapshotId,
            rolledBack,
          },
        });
        options.trustEvents.record({
          kind: "canary-rollback",
          severity: rolledBack ? "warn" : "critical",
          title: rolledBack
            ? `升级 ${row.targetVersion} 检出回归，已自动回滚`
            : `升级 ${row.targetVersion} 检出回归，但自动回滚失败`,
          evidence: [{ runId: row.id, regressions: regressions.map((event) => event.id), rollbackNote }],
          relatedIds: [row.id, ...regressions.map((event) => String(event.id))],
          dedupeKey: `canary-rollback:${row.id}`,
        });
        if (options.poster !== undefined) {
          void options.poster.post({
            kind: "canary",
            severity: rolledBack ? "warn" : "critical",
            title: rolledBack
              ? `已自动回滚到升级前版本（${row.targetVersion} 检出回归）`
              : `升级 ${row.targetVersion} 检出回归，自动回滚失败，请人工处理`,
            body: `观察窗内出现升级疑似回归：${detail}。${rollbackNote}。回滚到快照不影响你的历史数据。`,
            source: "butler-watch",
            dedupeKey: `canary:${row.id}`,
          });
        }
        void updated;
        handled += 1;
        continue;
      }

      if (row.observationUntil !== null && Date.parse(row.observationUntil) <= now()) {
        store.updateCanaryRun(row.id, {
          status: "completed",
          reason: `观察窗（${
            row.policy === "conservative" ? "保守" : "标准"
          }策略）内未检出回归，升级已确认`,
          at: iso(),
        });
        options.audit?.append({
          actor: "canary",
          action: CANARY_AUDIT_VERDICT,
          target: row.id,
          detail: { status: "completed" },
        });
        handled += 1;
      }
    }
    return handled;
  }

  /* ------------------------------ 视图 ------------------------------ */

  function list(filter: { status?: CanaryStatus; limit?: number } = {}): {
    items: CanaryRunView[];
    summary: CanarySummary;
  } {
    const rows = store.listCanaryRuns(filter);
    const all = store.listCanaryRuns({ limit: 500 });
    const count = (status: CanaryStatus): number => all.filter((row) => row.status === status).length;
    return {
      items: rows.map(toView),
      summary: {
        total: all.length,
        observing: count("observing"),
        passed: count("passed"),
        blocked: count("blocked"),
        unverified: count("unverified"),
        skipped: count("skipped"),
        rolledBack: count("rolled-back"),
        completed: count("completed"),
        lastAt: all[0]?.createdAt ?? null,
        policy: getPolicy(),
      },
    };
  }

  return {
    getPolicy,
    setPolicy,
    plan,
    evaluate,
    start,
    get(id) {
      const row = store.getCanaryRun(id);
      return row === undefined ? null : toView(row);
    },
    list,
    tick,
    prune() {
      const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString();
      return store.pruneCanaryRuns(cutoff);
    },
    startTimer() {
      if (running) return;
      running = true;
      void Promise.resolve().then(() => {
        void tick().catch(() => undefined);
      });
      timer = driver.setInterval(() => {
        void tick().catch(() => undefined);
      }, tickIntervalMs);
    },
    stopTimer() {
      if (!running) return;
      running = false;
      if (timer !== null) driver.clearInterval(timer);
      timer = null;
    },
  };
}
