/**
 * M2.3 会话追踪：把 Hermes 会话元数据（state.db）与 butler 动作流（action_events）
 * 合成会话索引，供 `/sessions` 列表与 `/sessions/:id` 时间线使用。
 *
 * 数据源与可用性（全部按「探测命中才用，缺失显式降级」处理，绝不臆测）：
 * 1. state.db 的 `session_model_usage`（既有事实来源）：session_id / model / token / cost / last_seen
 *    → 索引骨架；
 * 2. state.db 的候选会话表（sessions / session_index / session / hermes_sessions）：列名按候选
 *    清单探测，命中即读 started_at / status / task_type / model；表或列缺失 → 该维度为 null；
 * 3. butler 自有 `action_events`：按 session_id 聚合动作数与高危数。
 *
 * 异常规则（首版 4 条，全部可判定）：
 * - error-terminated：会话终态归一化为 error（需会话表状态列命中）；
 * - context-truncated：会话内动作产物出现上下文超限特征（截断/超窗口）；
 * - long-running：会话时长 > 30 分钟；
 * - high-risk-actions：会话内高危动作 ≥1（来自审计流）。
 * 未实现（Hermes 未提供工具级耗时与失败归因数据，已在 summary.unimplementedRules 显式声明）：
 * 同会话同工具失败 ≥3 次、单次工具调用耗时 >90s。
 *
 * 隐私红线：只索引元数据与结构化动作，**绝不采集对话正文**。
 * `replayEnabled` 开关首版为占位——正文采集未实现，读取时不返回任何正文。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Core, SessionIndexRow, SqliteStore } from "@butler/core";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";

/** 单次采集回看窗口上限（天）：与保留期取小值，避免全量重扫。 */
export const SESSION_SCAN_MAX_DAYS = 90;
/** 索引刷新周期：读 state.db 属重操作，故低于审计流频率。 */
export const SESSION_INDEX_INTERVAL_MS = 5 * 60 * 1000;
/** 长会话阈值（30 分钟）。 */
export const LONG_SESSION_MS = 30 * 60 * 1000;

export type SessionAnomalyKind = "error-terminated" | "context-truncated" | "long-running" | "high-risk-actions";

export interface SessionAnomaly {
  kind: SessionAnomalyKind;
  severity: "warn" | "critical";
  detail: string;
}

export interface SessionIndexItem {
  sessionId: string;
  instance: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  taskType: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
  costUsd: number | null;
  outcome: string;
  anomalies: SessionAnomaly[];
  actionCount: number;
  highRiskCount: number;
  lastActionAt: string | null;
}

export interface SessionIndexSummary {
  total: number;
  anomalies: number;
  returned: number;
  windowDays: number;
  source: {
    /** state.db 是否可读（false → 仅靠动作流索引，会话起止/终态为未知）。 */
    stateDbAvailable: boolean;
    /** 命中的会话表名（null → 未探测到）。 */
    sessionTable: string | null;
    reason: string;
  };
  /** 完整回放（对话正文）状态：首版未实现，恒为 false。 */
  replay: { enabled: boolean; note: string };
  /** 首版未实现的计划书规则（显式声明，不冒名顶替）。 */
  unimplementedRules: string[];
}

export interface SessionTimelineNode {
  kind: "session-start" | "session-end" | "action" | "anomaly";
  at: string;
  label: string;
  severity: "info" | "warn" | "critical";
  detail?: string;
  payload?: unknown;
}

export interface SessionDetail {
  session: SessionIndexItem;
  timeline: SessionTimelineNode[];
  kinds: Record<string, number>;
}

export interface SessionIndexServiceOptions {
  core: Core;
  /** Hermes state.db 绝对路径。 */
  dbPath: string;
  /** 保留期（天）：采集窗口与清理窗口一致。 */
  retentionDays: number;
  now?: () => number;
  driver?: TimerDriver;
  intervalMs?: number;
  /** 完整回放开关（首版占位：正文采集未实现，恒不返回正文）。 */
  replayEnabled?: boolean;
}

export interface SessionIndexService {
  /** 增量刷新索引（幂等 upsert）。 */
  refresh(): Promise<{ scanned: number; indexed: number; stateDbAvailable: boolean; reason: string }>;
  start(): void;
  stop(): void;
  list(filter?: {
    limit?: number;
    offset?: number;
    anomalyOnly?: boolean;
    outcome?: string;
    windowDays?: number;
  }): { items: SessionIndexItem[]; summary: SessionIndexSummary };
  detail(sessionId: string): SessionDetail | null;
  /** 按保留期清理（由 retentionPruner 调用）。 */
  prune(): number;
  /** 最近一次刷新结果（HTTP 概览用）。 */
  lastRefresh(): {
    scanned: number;
    indexed: number;
    stateDbAvailable: boolean;
    sessionTable: string | null;
    reason: string;
    at: string | null;
  };
}

/** 会话表名候选（Hermes 侧 schema 可能演进；存在即用）。 */
const SESSION_TABLE_CANDIDATES = ["sessions", "session_index", "session", "hermes_sessions"] as const;
/** 会话列名候选。 */
const SESSION_COLUMN_CANDIDATES = {
  sessionId: ["session_id", "sessionId", "id", "key"],
  startedAt: ["started_at", "created_at", "start_time", "startedAt"],
  endedAt: ["ended_at", "finished_at", "end_time", "updated_at", "last_seen"],
  status: ["status", "outcome", "state", "result"],
  taskType: ["task_type", "taskType", "type", "kind", "title"],
  model: ["model", "model_id"],
} as const;

type SessionColumns = Record<keyof typeof SESSION_COLUMN_CANDIDATES, string | null>;

/** 上下文超限特征（命中即判 context-truncated）。 */
const CONTEXT_OVERFLOW_PATTERN =
  /context\s*(?:length|window|limit)[^a-z]{0,12}(?:exceed|overflow|too\s+long)|maximum\s+context|truncat(?:ed|ion)|上下文(?:超限|截断)|超出上下文/i;

function tableExists(db: InstanceType<typeof DatabaseSync>, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { name?: unknown } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

function columnsOf(db: InstanceType<typeof DatabaseSync>, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((row) => String(row["name"] ?? "")));
  } catch {
    return new Set();
  }
}

/** 探测 Hermes 侧会话表与列；未命中返回 null。 */
function probeSessionSource(db: InstanceType<typeof DatabaseSync>): { table: string; columns: SessionColumns } | null {
  for (const table of SESSION_TABLE_CANDIDATES) {
    if (!tableExists(db, table)) continue;
    const present = columnsOf(db, table);
    const pick = (candidates: readonly string[]): string | null =>
      candidates.find((candidate) => present.has(candidate)) ?? null;
    const columns: SessionColumns = {
      sessionId: pick(SESSION_COLUMN_CANDIDATES.sessionId),
      startedAt: pick(SESSION_COLUMN_CANDIDATES.startedAt),
      endedAt: pick(SESSION_COLUMN_CANDIDATES.endedAt),
      status: pick(SESSION_COLUMN_CANDIDATES.status),
      taskType: pick(SESSION_COLUMN_CANDIDATES.taskType),
      model: pick(SESSION_COLUMN_CANDIDATES.model),
    };
    if (columns.sessionId !== null) return { table, columns };
  }
  return null;
}

/** 时间值归一化为 ISO：支持 epoch 秒 / epoch 毫秒 / ISO 文本；无法解析 → null。 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) return toIso(asNumber);
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/** 会话终态归一化：error / ok / running / unknown（不臆测未知值）。 */
export function normalizeOutcome(status: unknown): string {
  if (status === null || status === undefined) return "unknown";
  const text = String(status).trim().toLowerCase();
  if (text === "") return "unknown";
  if (/^(error|failed|failure|aborted|abort|crash|timeout)$/.test(text)) return "error";
  if (/^(ok|success|succeeded|completed|complete|done|finished)$/.test(text)) return "ok";
  if (/^(running|active|in_progress|in-progress|pending|started)$/.test(text)) return "running";
  return "unknown";
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createSessionIndexService(options: SessionIndexServiceOptions): SessionIndexService {
  const now = options.now ?? (() => Date.now());
  const driver = options.driver ?? defaultTimerDriver;
  const store: SqliteStore = options.core.store;
  const retentionDays = Math.max(1, Math.min(SESSION_SCAN_MAX_DAYS, Math.floor(options.retentionDays)));
  let timer: unknown = null;
  let running = false;
  let last: {
    scanned: number;
    indexed: number;
    stateDbAvailable: boolean;
    sessionTable: string | null;
    reason: string;
    at: string | null;
  } = {
    scanned: 0,
    indexed: 0,
    stateDbAvailable: false,
    sessionTable: null,
    reason: "尚未刷新",
    at: null,
  };
  const unimplementedRules = [
    "同会话同工具失败 ≥3 次（Hermes 未提供工具级失败归因）",
    "单次工具调用耗时 >90s（Hermes 未提供工具级耗时）",
  ];

  function windowStartIso(): string {
    return new Date(now() - retentionDays * 86_400_000).toISOString();
  }

  /** state.db 会话表侧数据（sessionId → 元数据行）。 */
  function loadStateDb(): {
    available: boolean;
    reason: string;
    sessionTable: string | null;
    usage: Map<string, { model: string | null; tokenIn: number | null; tokenOut: number | null; costUsd: number | null; lastSeen: string | null }>;
    sessions: Map<string, { startedAt: string | null; endedAt: string | null; outcome: string; taskType: string | null; model: string | null }>;
  } {
    const empty = {
      available: false,
      reason: "",
      sessionTable: null as string | null,
      usage: new Map<string, { model: string | null; tokenIn: number | null; tokenOut: number | null; costUsd: number | null; lastSeen: string | null }>(),
      sessions: new Map<string, { startedAt: string | null; endedAt: string | null; outcome: string; taskType: string | null; model: string | null }>(),
    };
    if (!existsSync(options.dbPath)) return { ...empty, reason: "state.db 不可读（文件不存在）" };
    let db: InstanceType<typeof DatabaseSync>;
    try {
      db = new DatabaseSync(options.dbPath, { readOnly: true });
    } catch {
      return { ...empty, reason: "state.db 不可读（打开失败）" };
    }
    try {
      // 1) session_model_usage：索引骨架（表缺失 → 无骨架）。
      const usageColumns = columnsOf(db, "session_model_usage");
      const sessionIdColumn = ["session_id", "sessionId", "session"].find((name) => usageColumns.has(name)) ?? null;
      const costColumnCandidates = ["actual_cost_usd", "estimated_cost_usd", "actual_cost", "estimated_cost"];
      const costColumn = costColumnCandidates.find((name) => usageColumns.has(name)) ?? null;
      if (sessionIdColumn === null) {
        return { ...empty, available: true, reason: "session_model_usage 无会话列（旧版 schema）" };
      }
      const select = [
        "SELECT",
        `"${sessionIdColumn}" AS session_id,`,
        "model,",
        "last_seen,",
        "input_tokens,",
        "output_tokens,",
        costColumn === null ? "NULL AS cost_usd" : `"${costColumn}" AS cost_usd`,
        "FROM session_model_usage WHERE 1 = 1",
      ].join(" ");
      const usageRows = db.prepare(select).all() as Array<Record<string, unknown>>;
      for (const row of usageRows) {
        const sessionId = row["session_id"] === null || row["session_id"] === undefined ? null : String(row["session_id"]);
        if (sessionId === null || sessionId === "") continue;
        const existing = empty.usage.get(sessionId) ?? { model: null, tokenIn: null, tokenOut: null, costUsd: null, lastSeen: null };
        const tokenIn = numericOrNull(row["input_tokens"]);
        const tokenOut = numericOrNull(row["output_tokens"]);
        const cost = numericOrNull(row["cost_usd"]);
        const lastSeen = toIso(row["last_seen"]);
        empty.usage.set(sessionId, {
          model: existing.model ?? (row["model"] === null || row["model"] === undefined ? null : String(row["model"])),
          tokenIn: tokenIn === null ? existing.tokenIn : (existing.tokenIn ?? 0) + tokenIn,
          tokenOut: tokenOut === null ? existing.tokenOut : (existing.tokenOut ?? 0) + tokenOut,
          costUsd: cost === null ? existing.costUsd : (existing.costUsd ?? 0) + cost,
          lastSeen: lastSeen !== null && (existing.lastSeen === null || lastSeen > existing.lastSeen) ? lastSeen : existing.lastSeen,
        });
      }

      // 2) 候选会话表：起止/终态/任务类型（探测命中才读）。
      const source = probeSessionSource(db);
      if (source !== null) {
        const { table, columns } = source;
        const quoted = (name: string | null): string => (name === null ? "NULL" : `"${name}"`);
        const sql = [
          `SELECT ${quoted(columns.sessionId)} AS session_id,`,
          `${quoted(columns.startedAt)} AS started_at,`,
          `${quoted(columns.endedAt)} AS ended_at,`,
          `${quoted(columns.status)} AS status,`,
          `${quoted(columns.taskType)} AS task_type,`,
          `${quoted(columns.model)} AS model`,
          `FROM "${table}"`,
        ].join(" ");
        const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const sessionId = row["session_id"] === null || row["session_id"] === undefined ? null : String(row["session_id"]);
          if (sessionId === null || sessionId === "") continue;
          empty.sessions.set(sessionId, {
            startedAt: toIso(row["started_at"]),
            endedAt: toIso(row["ended_at"]),
            outcome: normalizeOutcome(row["status"]),
            taskType: row["task_type"] === null || row["task_type"] === undefined ? null : String(row["task_type"]),
            model: row["model"] === null || row["model"] === undefined ? null : String(row["model"]),
          });
        }
        empty.sessionTable = table;
      }
      return { ...empty, available: true, reason: source === null ? "state.db 无会话表（仅元数据维度可用）" : "" };
    } catch (error) {
      return { ...empty, reason: `state.db 读取失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      try {
        db.close();
      } catch {
        // 只读句柄关闭失败无副作用
      }
    }
  }

  async function refresh(): Promise<{ scanned: number; indexed: number; stateDbAvailable: boolean; reason: string }> {
    const since = windowStartIso();
    const stateDb = loadStateDb();
    const actions = store.aggregateActionEventsBySession(since);
    const actionsBySession = new Map(actions.map((item) => [item.sessionId, item]));

    // 上下文超限：扫描窗口内动作片段（已脱敏），命中会话打标。
    const overflowSessions = new Set<string>();
    try {
      for (const action of store.listActionEvents({ since, limit: 2000 })) {
        if (action.sessionId === null || action.sessionId === "") continue;
        if (!CONTEXT_OVERFLOW_PATTERN.test(action.detailJson)) continue;
        overflowSessions.add(action.sessionId);
      }
    } catch {
      // 片段扫描失败不影响主体索引
    }

    const allSessionIds = new Set<string>([...stateDb.usage.keys(), ...stateDb.sessions.keys(), ...actionsBySession.keys()]);
    const at = new Date(now()).toISOString();
    let indexed = 0;
    for (const sessionId of allSessionIds) {
      const usage = stateDb.usage.get(sessionId);
      const meta = stateDb.sessions.get(sessionId);
      const action = actionsBySession.get(sessionId);
      const startedAt = meta?.startedAt ?? null;
      const endedAt = meta?.endedAt ?? usage?.lastSeen ?? action?.lastAt ?? null;
      const durationMs =
        startedAt !== null && endedAt !== null ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
      const outcome = meta?.outcome ?? "unknown";
      const highRiskCount = action?.highRisk ?? 0;

      const anomalies: SessionAnomaly[] = [];
      if (outcome === "error") {
        anomalies.push({ kind: "error-terminated", severity: "critical", detail: "会话以错误结束" });
      }
      if (overflowSessions.has(sessionId)) {
        anomalies.push({ kind: "context-truncated", severity: "warn", detail: "出现上下文超限/截断特征" });
      }
      if (durationMs !== null && durationMs > LONG_SESSION_MS) {
        anomalies.push({
          kind: "long-running",
          severity: "warn",
          detail: `会话持续 ${Math.round(durationMs / 60_000)} 分钟（阈值 ${LONG_SESSION_MS / 60_000}）`,
        });
      }
      if (highRiskCount > 0) {
        anomalies.push({
          kind: "high-risk-actions",
          severity: highRiskCount >= 3 ? "critical" : "warn",
          detail: `会话内高危动作 ${highRiskCount} 次`,
        });
      }
      if (startedAt === null && endedAt === null && action === undefined && usage === undefined) continue;

      store.upsertSessionIndex({
        sessionId,
        instance: "",
        startedAt,
        endedAt,
        durationMs,
        model: meta?.model ?? usage?.model ?? null,
        taskType: meta?.taskType ?? null,
        tokenIn: usage?.tokenIn ?? null,
        tokenOut: usage?.tokenOut ?? null,
        costUsd: usage?.costUsd ?? null,
        outcome,
        anomalyFlags: anomalies,
        actionCount: action?.count ?? 0,
        highRiskCount,
        lastActionAt: action?.lastAt ?? null,
        at,
      });
      indexed += 1;
    }

    const reason = stateDb.available ? stateDb.reason : stateDb.reason || "state.db 不可读";
    last = { scanned: allSessionIds.size, indexed, stateDbAvailable: stateDb.available, sessionTable: stateDb.sessionTable, reason, at };
    return { scanned: allSessionIds.size, indexed, stateDbAvailable: stateDb.available, reason };
  }

  function mapRow(row: SessionIndexRow): SessionIndexItem {
    let anomalies: SessionAnomaly[] = [];
    try {
      const parsed = JSON.parse(row.anomalyFlagsJson) as unknown;
      if (Array.isArray(parsed)) anomalies = parsed as SessionAnomaly[];
    } catch {
      anomalies = [];
    }
    return {
      sessionId: row.sessionId,
      instance: row.instance,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      model: row.model,
      taskType: row.taskType,
      tokenIn: row.tokenIn,
      tokenOut: row.tokenOut,
      costUsd: row.costUsd,
      outcome: row.outcome,
      anomalies,
      actionCount: row.actionCount,
      highRiskCount: row.highRiskCount,
      lastActionAt: row.lastActionAt,
    };
  }

  return {
    refresh,
    start() {
      if (running) return;
      running = true;
      void refresh().catch(() => undefined);
      timer = driver.setInterval(() => void refresh().catch(() => undefined), Math.max(30_000, options.intervalMs ?? SESSION_INDEX_INTERVAL_MS));
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== null) driver.clearInterval(timer);
      timer = null;
    },
    list(filter = {}) {
      const windowDays = Math.max(1, Math.min(SESSION_SCAN_MAX_DAYS, Math.floor(filter.windowDays ?? retentionDays)));
      const since = filter.windowDays === undefined ? undefined : new Date(now() - windowDays * 86_400_000).toISOString();
      const rows = store.listSessionIndex({
        anomalyOnly: filter.anomalyOnly,
        outcome: filter.outcome,
        since,
        limit: filter.limit,
        offset: filter.offset,
      });
      const counts = store.countSessionIndex();
      return {
        items: rows.map(mapRow),
        summary: {
          total: counts.total,
          anomalies: counts.anomalies,
          returned: rows.length,
          windowDays,
          source: { stateDbAvailable: last.stateDbAvailable, sessionTable: last.sessionTable, reason: last.reason },
          replay: {
            enabled: options.replayEnabled === true,
            note:
              options.replayEnabled === true
                ? "完整回放开关已打开，但对话正文采集首版尚未实现——当前仍只索引元数据与结构化动作。"
                : "完整回放（对话正文）未启用；当前仅索引元数据与结构化动作，不含任何对话正文。",
          },
          unimplementedRules,
        },
      };
    },
    detail(sessionId) {
      const row = store.getSessionIndex(sessionId);
      if (row === undefined) return null;
      const session = mapRow(row);
      const timeline: SessionTimelineNode[] = [];
      const kinds: Record<string, number> = {};
      if (session.startedAt !== null) {
        timeline.push({ kind: "session-start", at: session.startedAt, label: "会话开始", severity: "info" });
      }
      // 单次查询同时供时间线与类型分布使用（避免重复扫描 action_events）。
      const sessionActions = store
        .listActionEvents({ since: session.startedAt ?? undefined, limit: 500 })
        .filter((action) => action.sessionId === sessionId);
      for (const action of sessionActions) {
        kinds[action.kind] = (kinds[action.kind] ?? 0) + 1;
        let detail: string | undefined;
        let payload: unknown;
        try {
          const parsed = JSON.parse(action.detailJson) as Record<string, unknown>;
          const snippet = parsed["snippet"];
          if (typeof snippet === "string") detail = snippet.slice(0, 200);
          payload = parsed;
        } catch {
          payload = undefined;
        }
        timeline.push({
          kind: "action",
          at: action.ts,
          label: `${action.kind}${action.target === "" ? "" : ` → ${action.target}`}`,
          severity: action.severity === "high" ? "critical" : "info",
          ...(detail === undefined ? {} : { detail }),
          ...(payload === undefined ? {} : { payload }),
        });
      }
      for (const anomaly of session.anomalies) {
        timeline.push({
          kind: "anomaly",
          at: session.lastActionAt ?? session.endedAt ?? session.startedAt ?? new Date(now()).toISOString(),
          label: anomaly.kind,
          severity: anomaly.severity,
          detail: anomaly.detail,
        });
      }
      if (session.endedAt !== null) {
        timeline.push({ kind: "session-end", at: session.endedAt, label: "会话结束", severity: session.outcome === "error" ? "critical" : "info" });
      }
      timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { session, timeline, kinds };
    },
    prune() {
      return store.pruneSessionIndex(new Date(now() - retentionDays * 86_400_000).toISOString());
    },
    lastRefresh() {
      return last;
    },
  };
}
