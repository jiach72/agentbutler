/**
 * LLM Token 用量与成本只读聚合（大屏 Token 三件套 / 成本中枢数据源）。
 *
 * 直接读 Hermes state.db 的 session_model_usage 表（会话×模型粒度的真实
 * 计数），按「自然日 × 模型」聚合 input+output token：
 * - 只读打开（readOnly），不打扰 Hermes 自身的写入连接；
 * - 表不存在 / 文件不可达 / 结构不符 → usage() 返回 null，HTTP 层映射 503；
 * - 时间桶按容器本地时区的自然日（last_seen Unix 秒 → YYYY-MM-DD）；
 * - cache_read/cache_write/reasoning 不并入总量：不同 provider 对这三者
 *   是否已含在 input/output 里口径不一致，直接相加会重复计数。
 *
 * 信任层升级（M1.1 成本中枢）：
 * - 成本列（计费元数据 billing_provider/billing_mode/cost_status/cost_source
 *   与金额列）由 Hermes 侧写入，本仓库只读。列名按候选清单探测（PRAGMA
 *   table_info），探测不到时 costAvailable=false、金额字段为 null——
 *   绝不用 token 数反推价格伪造成本数据。
 * - costSummary() 按「自然日 / 模型 / 会话」三视图聚合，会话粒度即本表
 *   可归因的最细单位（task 归因需要 Hermes sessions 表的映射，后续接入）。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface LlmUsageDay {
  date: string;
  tokens: number;
  /** 当日成本（USD）；无成本列时为 null。 */
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

export interface LlmUsageModel {
  model: string;
  /** rangeDays 窗口内 input+output token 总量（降序排列）。 */
  tokens: number;
  /** 与 days 一一对应的每日 token（窗口外为 0）。 */
  daily: Array<number>;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

export interface LlmUsageCostAggregate {
  estimatedUsd: number | null;
  actualUsd: number | null;
  /** cost_status=verified 的 actual 成本小计（与 provider 账单对账用）。 */
  verifiedUsd: number | null;
}

export interface LlmUsageView {
  rangeDays: number;
  days: Array<LlmUsageDay>;
  models: Array<LlmUsageModel>;
  /** 成本聚合（成本列缺失时 estimatedUsd/actualUsd 均为 null）。 */
  cost: LlmUsageCostAggregate;
  /** state.db 是否具备成本列（false 时成本 UI 显示「待接入」而非 0）。 */
  costAvailable: boolean;
}

export interface CostSummarySession {
  sessionId: string;
  model: string;
  lastSeen: string;
  tokens: number;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
}

export interface CostSummaryView {
  rangeDays: number;
  costAvailable: boolean;
  total: LlmUsageCostAggregate;
  days: Array<LlmUsageDay>;
  models: Array<LlmUsageModel>;
  /** 最贵会话 TOP10（按 actual 优先、estimated 兜底降序）。 */
  sessions: Array<CostSummarySession>;
}

export interface LlmUsageService {
  usage(days: number): Promise<LlmUsageView | null>;
  costSummary(days: number): Promise<CostSummaryView | null>;
  /** 自然月迄今成本（预算引擎核算用；库不可用返回 null）。 */
  monthToDateCost(): Promise<LlmUsageCostAggregate & { month: string } | null>;
}

export interface LlmUsageOptions {
  /** Hermes state.db 绝对路径（容器内 /home/butler/hermes/state.db）。 */
  dbPath: string;
  now?: () => Date;
}

/** 本地时区 YYYY-MM-DD。 */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 成本列名候选清单（Hermes 侧 schema 可能演进；按存在性探测，命中即用）。 */
const COST_COLUMN_CANDIDATES = {
  sessionId: ["session_id", "sessionId", "session"],
  estimatedCost: ["estimated_cost_usd", "estimatedCostUsd", "estimated_cost"],
  actualCost: ["actual_cost_usd", "actualCostUsd", "actual_cost"],
  costStatus: ["cost_status", "costStatus"],
} as const;

interface CostColumns {
  sessionId: string | null;
  estimatedCost: string | null;
  actualCost: string | null;
  costStatus: string | null;
}

/** 用 PRAGMA table_info 探测实际存在的成本列；全部缺失 → costAvailable=false。 */
function probeCostColumns(db: InstanceType<typeof DatabaseSync>): CostColumns {
  let columns: Array<{ name?: unknown }> = [];
  try {
    columns = db.prepare("PRAGMA table_info(session_model_usage)").all() as Array<{ name?: unknown }>;
  } catch {
    return { sessionId: null, estimatedCost: null, actualCost: null, costStatus: null };
  }
  const present = new Set(columns.map((column) => String(column["name"] ?? "")));
  const pick = (candidates: readonly string[]): string | null =>
    candidates.find((candidate) => present.has(candidate)) ?? null;
  return {
    sessionId: pick(COST_COLUMN_CANDIDATES.sessionId),
    estimatedCost: pick(COST_COLUMN_CANDIDATES.estimatedCost),
    actualCost: pick(COST_COLUMN_CANDIDATES.actualCost),
    costStatus: pick(COST_COLUMN_CANDIDATES.costStatus),
  };
}

/** 行级金额：缺失列 / 非有限数值 / 负数 → null（上游自己判断兜底）。 */
function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

interface UsageRow {
  model: string;
  last_seen: number;
  input_tokens: number | null;
  output_tokens: number | null;
  sessionId: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  costStatus: string | null;
}

function buildSelect(columns: CostColumns): string {
  const quoted = (name: string | null): string => (name === null ? "NULL" : `"${name}"`);
  return [
    "SELECT model, last_seen, input_tokens, output_tokens,",
    `${quoted(columns.sessionId)} AS session_id,`,
    `${quoted(columns.estimatedCost)} AS estimated_cost,`,
    `${quoted(columns.actualCost)} AS actual_cost,`,
    `${quoted(columns.costStatus)} AS cost_status`,
    "FROM session_model_usage",
  ].join(" ");
}

/** 单条记录的成本读法：estimated 缺失时允许用 actual 兜底展示（标注来源）。 */
export function createLlmUsageService(options: LlmUsageOptions): LlmUsageService {
  const now = options.now ?? (() => new Date());

  async function loadRows(days: number): Promise<{
    rangeDays: number;
    rows: Array<UsageRow>;
    dayDates: string[];
    bucketStartMs: number;
    windowEndMs: number;
    costColumns: CostColumns;
  } | null> {
    const rangeDays = Number.isInteger(days) && days >= 1 && days <= 180 ? days : 7;
    if (!existsSync(options.dbPath)) return null;
    let db: InstanceType<typeof DatabaseSync>;
    try {
      db = new DatabaseSync(options.dbPath, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const costColumns = probeCostColumns(db);
      const rows = db
        .prepare(buildSelect(costColumns))
        .all() as Array<Record<string, unknown>>;
      // 时间桶：今日为最后一格，往前推 rangeDays 个自然日。
      const today = now();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const buckets: Array<{ date: string; startMs: number }> = [];
      for (let i = rangeDays - 1; i >= 0; i -= 1) {
        const startMs = startOfToday - i * 86_400_000;
        buckets.push({ date: localDateKey(startMs), startMs });
      }
      const windowEndMs = startOfToday + 86_400_000;
      const dayDates = buckets.map((b) => b.date);
      const mapped: Array<UsageRow> = [];
      for (const row of rows) {
        if (typeof row["last_seen"] !== "number" || !(row["last_seen"] > 0)) continue;
        const seenMs = row["last_seen"] * 1000;
        if (seenMs < buckets[0]!.startMs || seenMs >= windowEndMs) continue;
        mapped.push({
          model: String(row["model"] ?? "unknown"),
          last_seen: row["last_seen"],
          input_tokens: numericOrNull(row["input_tokens"]),
          output_tokens: numericOrNull(row["output_tokens"]),
          sessionId: row["session_id"] === null || row["session_id"] === undefined ? null : String(row["session_id"]),
          estimatedCost: numericOrNull(row["estimated_cost"]),
          actualCost: numericOrNull(row["actual_cost"]),
          costStatus: row["cost_status"] === null || row["cost_status"] === undefined ? null : String(row["cost_status"]),
        });
      }
      return {
        rangeDays,
        rows: mapped,
        dayDates,
        bucketStartMs: buckets[0]!.startMs,
        windowEndMs,
        costColumns,
      };
    } catch {
      // 表不存在或结构不符（旧版 Hermes）→ 视为不可用，前端保持「待接入」灰态。
      return null;
    } finally {
      db.close();
    }
  }

  return {
    async usage(days: number): Promise<LlmUsageView | null> {
      const loaded = await loadRows(days);
      if (loaded === null) return null;
      const { rangeDays, rows, dayDates } = loaded;
      const costAvailable = loaded.costColumns.estimatedCost !== null || loaded.costColumns.actualCost !== null;

      const perModel = new Map<string, Array<number>>();
      const perModelCost = new Map<string, { estimated: number; actual: number }>();
      const perDayCost = new Map<number, { estimated: number; actual: number }>();
      let totalEstimated = 0;
      let totalActual = 0;
      let totalVerified: number | null = 0;

      for (const row of rows) {
        const dayIndex = dayDates.indexOf(localDateKey(row.last_seen * 1000));
        if (dayIndex < 0) continue;
        const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
        const series = perModel.get(row.model) ?? Array.from({ length: rangeDays }, () => 0);
        series[dayIndex] = (series[dayIndex] ?? 0) + tokens;
        perModel.set(row.model, series);

        const estimated = row.estimatedCost;
        const actual = row.actualCost;
        if (costAvailable) {
          const modelCost = perModelCost.get(row.model) ?? { estimated: 0, actual: 0 };
          const dayCost = perDayCost.get(dayIndex) ?? { estimated: 0, actual: 0 };
          if (estimated !== null) {
            modelCost.estimated += estimated;
            dayCost.estimated += estimated;
            totalEstimated += estimated;
          }
          if (actual !== null) {
            modelCost.actual += actual;
            dayCost.actual += actual;
            totalActual += actual;
          }
          perModelCost.set(row.model, modelCost);
          perDayCost.set(dayIndex, dayCost);
          if (row.costStatus === "verified" && actual !== null) {
            totalVerified = (totalVerified ?? 0) + actual;
          }
        }
      }

      const models: Array<LlmUsageModel> = Array.from(perModel.entries())
        .map(([model, series]) => {
          const cost = perModelCost.get(model);
          return {
            model,
            tokens: series.reduce((sum, value) => sum + value, 0),
            daily: series,
            estimatedCostUsd: cost === undefined || cost.estimated === 0 ? null : cost.estimated,
            actualCostUsd: cost === undefined || cost.actual === 0 ? null : cost.actual,
          };
        })
        .sort((a, b) => b.tokens - a.tokens);
      const daysView: Array<LlmUsageDay> = dayDates.map((date, index) => {
        const cost = perDayCost.get(index);
        return {
          date,
          tokens: models.reduce((sum, m) => sum + (m.daily[index] ?? 0), 0),
          estimatedCostUsd: cost === undefined || cost.estimated === 0 ? null : cost.estimated,
          actualCostUsd: cost === undefined || cost.actual === 0 ? null : cost.actual,
        };
      });
      return {
        rangeDays,
        days: daysView,
        models,
        cost: {
          estimatedUsd: costAvailable && totalEstimated > 0 ? totalEstimated : null,
          actualUsd: costAvailable && totalActual > 0 ? totalActual : null,
          verifiedUsd: costAvailable && totalVerified !== null && totalVerified > 0 ? totalVerified : null,
        },
        costAvailable,
      };
    },

    async costSummary(days: number): Promise<CostSummaryView | null> {
      const loaded = await loadRows(days);
      if (loaded === null) return null;
      const { rangeDays, rows, dayDates } = loaded;
      const costAvailable = loaded.costColumns.estimatedCost !== null || loaded.costColumns.actualCost !== null;

      const perModel = new Map<string, { tokens: number; estimated: number; actual: number }>();
      const perDayCost = new Map<number, { estimated: number; actual: number }>();
      const perSession = new Map<string, { model: string; lastSeen: number; tokens: number; estimated: number; actual: number }>();
      let totalEstimated = 0;
      let totalActual = 0;
      let totalVerified: number | null = 0;

      for (const row of rows) {
        const seenMs = row.last_seen * 1000;
        const dayIndex = dayDates.indexOf(localDateKey(seenMs));
        const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
        const modelEntry = perModel.get(row.model) ?? { tokens: 0, estimated: 0, actual: 0 };
        modelEntry.tokens += tokens;
        if (row.estimatedCost !== null) modelEntry.estimated += row.estimatedCost;
        if (row.actualCost !== null) modelEntry.actual += row.actualCost;
        perModel.set(row.model, modelEntry);
        if (dayIndex >= 0 && (row.estimatedCost !== null || row.actualCost !== null)) {
          const dayCost = perDayCost.get(dayIndex) ?? { estimated: 0, actual: 0 };
          if (row.estimatedCost !== null) dayCost.estimated += row.estimatedCost;
          if (row.actualCost !== null) dayCost.actual += row.actualCost;
          perDayCost.set(dayIndex, dayCost);
        }
        if (row.sessionId !== null) {
          const key = `${row.sessionId}::${row.model}`;
          const session = perSession.get(key) ?? { model: row.model, lastSeen: seenMs, tokens: 0, estimated: 0, actual: 0 };
          session.tokens += tokens;
          session.lastSeen = Math.max(session.lastSeen, seenMs);
          if (row.estimatedCost !== null) session.estimated += row.estimatedCost;
          if (row.actualCost !== null) session.actual += row.actualCost;
          perSession.set(key, session);
        }
        if (row.estimatedCost !== null) totalEstimated += row.estimatedCost;
        if (row.actualCost !== null) totalActual += row.actualCost;
        if (row.costStatus === "verified" && row.actualCost !== null) {
          totalVerified = (totalVerified ?? 0) + row.actualCost;
        }
      }

      const sessions: Array<CostSummarySession> = Array.from(perSession.entries())
        .map(([key, item]) => {
          const [sessionId] = key.split("::");
          return {
            sessionId: sessionId ?? key,
            model: item.model,
            lastSeen: new Date(item.lastSeen).toISOString(),
            tokens: item.tokens,
            estimatedCostUsd: item.estimated > 0 ? item.estimated : null,
            actualCostUsd: item.actual > 0 ? item.actual : null,
          };
        })
        .sort((a, b) => (b.actualCostUsd ?? b.estimatedCostUsd ?? 0) - (a.actualCostUsd ?? a.estimatedCostUsd ?? 0))
        .slice(0, 10);

      const models: Array<LlmUsageModel> = Array.from(perModel.entries())
        .map(([model, item]) => ({
          model,
          tokens: item.tokens,
          daily: [],
          estimatedCostUsd: item.estimated > 0 ? item.estimated : null,
          actualCostUsd: item.actual > 0 ? item.actual : null,
        }))
        .sort((a, b) => (b.actualCostUsd ?? b.estimatedCostUsd ?? 0) - (a.actualCostUsd ?? a.estimatedCostUsd ?? 0));

      const daysView: Array<LlmUsageDay> = dayDates.map((date, index) => {
        const cost = perDayCost.get(index);
        return {
          date,
          tokens: 0,
          estimatedCostUsd: cost === undefined || cost.estimated === 0 ? null : cost.estimated,
          actualCostUsd: cost === undefined || cost.actual === 0 ? null : cost.actual,
        };
      });

      return {
        rangeDays,
        costAvailable,
        total: {
          estimatedUsd: costAvailable && totalEstimated > 0 ? totalEstimated : null,
          actualUsd: costAvailable && totalActual > 0 ? totalActual : null,
          verifiedUsd: costAvailable && totalVerified !== null && totalVerified > 0 ? totalVerified : null,
        },
        days: daysView,
        models,
        sessions,
      };
    },

    async monthToDateCost() {
      if (!existsSync(options.dbPath)) return null;
      let db: InstanceType<typeof DatabaseSync>;
      try {
        db = new DatabaseSync(options.dbPath, { readOnly: true });
      } catch {
        return null;
      }
      try {
        const costColumns = probeCostColumns(db);
        const estimatedCol = costColumns.estimatedCost;
        const actualCol = costColumns.actualCost;
        if (estimatedCol === null && actualCol === null) return null;
        const today = now();
        const month = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, "0")}`;
        // 本地时区当月 1 号 0 点的 Unix 秒（last_seen 列的口径一致）。
        const monthStartSec = Math.floor(new Date(today.getFullYear(), today.getMonth(), 1).getTime() / 1000);
        const moneyExpr = (column: string): string =>
          `COALESCE(SUM(CASE WHEN typeof("${column}") IN ('integer','real') AND "${column}" >= 0 THEN "${column}" ELSE 0 END), 0)`;
        const row = db
          .prepare(
            `SELECT ${estimatedCol === null ? "0" : moneyExpr(estimatedCol)} AS estimated_usd,
                    ${actualCol === null ? "0" : moneyExpr(actualCol)} AS actual_usd
             FROM session_model_usage WHERE last_seen >= ?`,
          )
          .get(monthStartSec) as { estimated_usd: number | bigint; actual_usd: number | bigint };
        const estimated = Number(row.estimated_usd);
        const actual = Number(row.actual_usd);
        return {
          month,
          estimatedUsd: estimated > 0 ? estimated : null,
          actualUsd: actual > 0 ? actual : null,
          verifiedUsd: null,
        };
      } catch {
        return null;
      } finally {
        db.close();
      }
    },
  };
}
