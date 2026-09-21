import { BaseRepository, fromJson, nowIso, toJson } from "./base.js";

/* ------------------------- 信任层数据模型（Trust Layer） ------------------------- */

/** 预算核算状态（每月一行；spent_usd 由 Watch 预算引擎周期回写）。 */
export interface BudgetStateRow {
  month: string;
  budgetUsd: number;
  spentUsd: number;
  /** 触线后执行的动作：none | alert(80%) | budget-exhausted(100%)。 */
  action: string;
  /** 已发送通知的阈值标记（["80%","100%"]），用于防重复告警。 */
  notified: string[];
  updatedAt: string;
}

/** 全局急停日志：一次 engage → release 完整生命周期一行。 */
export interface KillswitchLogRow {
  id: number;
  engagedAt: string;
  releasedAt: string | null;
  /** 触发来源：panel | api | budget-engine | unknown。 */
  trigger: string;
  /** engage 前自动全量快照的备份 id（BackupRow.id），快照失败为 null。 */
  snapshotId: number | null;
  actor: string;
  detailJson: string | null;
}

/** 行为审计流单条动作（不含 prompt/对话正文，见隐私红线）。 */
export interface ActionEventRow {
  id: number;
  ts: string;
  kind: "file-write" | "file-delete" | "shell-exec" | "api-call" | "message-send" | "web-fetch" | "raw";
  /** 高危动作（删除/外发/危险命令）为 high，其余 info。 */
  severity: "info" | "high";
  /** 结构化目标：文件路径 / 命令首段 / URL / 通道名，截断到 200 字符。 */
  target: string;
  detailJson: string;
  sessionId: string | null;
  /** 解析器版本；raw = 降级原始日志模式。 */
  parserVersion: string;
}

/** 事件中心统一事件对象（M2.2；与 bus 透传用的 events 表是两回事）。 */
export interface TrustEventRow {
  id: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  status: "active" | "acknowledged" | "resolved" | "regressed";
  evidenceJson: string;
  relatedIds: string;
  /** 去重键：同 key 复发合并计数；resolved 后复发自动转 regressed。 */
  dedupeKey: string;
  updatedAt: string;
}

/** M2.1 Agent 周报存档行（周 key 幂等；markdown 原文 + 组装数据快照）。 */
export interface ReportHistoryRow {
  id: number;
  /** 周一日期（YYYY-MM-DD，本地时区），唯一键。 */
  weekStart: string;
  weekEnd: string;
  status: "generated" | "sent" | "send-failed";
  markdown: string;
  /** 组装数据 JSON 快照（/report 详情页复用，避免重新查询历史数据）。 */
  dataJson: string;
  sentAt: string | null;
  createdAt: string;
}

/** M2.3 会话索引行（Hermes 会话元数据 + butler 动作聚合，不含对话正文）。 */
export interface SessionIndexRow {
  sessionId: string;
  /** 实例标识（多实例部署时区分来源；未知为空串）。 */
  instance: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  model: string | null;
  taskType: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
  costUsd: number | null;
  /** 结束态：ok / error / running / unknown（Hermes 未提供时 unknown，不臆测）。 */
  outcome: string;
  /** 异常标记（JSON 数组，元素见 SessionAnomaly）。 */
  anomalyFlagsJson: string;
  /** 会话内动作计数（来自 action_events 关联）。 */
  actionCount: number;
  highRiskCount: number;
  lastActionAt: string | null;
  updatedAt: string;
}

/**
 * 通知即操作（M3.1）的操作审批单：高危动作 → 推送带按钮卡片 → 用户批准/拒绝。
 * 状态机：pending → approved | denied | expired（超时默认拒绝，不可回到 pending）。
 * action_id 唯一：同一动作事件只允许一张审批单（幂等，防重复打扰）。
 */
export interface ActionApprovalRow {
  id: string;
  /** 关联 action_events 主键（字符串化，便于跨库/跨实例引用）。 */
  actionId: string;
  /** 动作指纹（kind|target）：用于「同一动作 24h 内第 3 次请求 → 升级」的计数口径。 */
  fingerprint: string;
  instance: string;
  sessionId: string | null;
  /** 动作类型（file-delete / shell-exec / message-send 等）。 */
  kind: string;
  /** 面向人的短标题（脱敏后）。 */
  title: string;
  /** 结构化摘要 JSON（脱敏，绝不存对话正文）。 */
  detailJson: string;
  /** pending | approved | denied | expired。 */
  status: string;
  /** 应答通道：panel | telegram | serverchan | bark | smtp | null（未应答）。 */
  channel: string | null;
  /** 同一动作在升级窗口内的第几次请求（首版即 1）。 */
  attempts: number;
  /** 是否已升级为「需 Web 端确认」（内联按钮不再放行，强制回面板）。 */
  escalateRequired: boolean;
  /** 超时时刻（到期未应答 → 默认拒绝）。 */
  expiresAt: string;
  respondedAt: string | null;
  /** 应答者（通道侧身份或面板操作者）。 */
  actor: string | null;
  /** 拒绝原因 / 超时说明。 */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 假进度检测（M3.3 progress_claims） ---------------- */

/** 进度声明核实结论。unverifiable = 观测能力不足（显式「无法验证」），非「未通过」。 */
export type ProgressVerdict = "verified" | "suspect" | "unverifiable";

export interface ProgressClaimRow {
  id: number;
  sessionId: string;
  ts: string;
  /** 声明的完成百分比；只声明「已完成」而无数字时为 null。 */
  claimedPct: number | null;
  /** 脱敏后的声明原文片段（不含对话正文）。 */
  claimText: string;
  /** 该声明窗口内实际产生副作用的动作数。 */
  sideEffectCount: number;
  /** 副作用动作类型 JSON 数组。 */
  sideEffectKindsJson: string;
  verdict: ProgressVerdict;
  reason: string | null;
  createdAt: string;
}

/* ---------------------- 升级金丝雀（M3.2 canary_runs） ---------------------- */

export type CanaryPolicy = "aggressive" | "standard" | "conservative";
export type CanaryStatus =
  | "planned"
  | "running"
  | "passed"
  | "blocked"
  | "skipped"
  | "unverified"
  | "observing"
  | "completed"
  | "rolled-back";

/** 三指标基线/影子快照（全部为区间实测值，缺失字段为 null 而非 0）。 */
export interface CanaryMetrics {
  /** 成功率：0-1。 */
  successRate: number | null;
  /** 平均 token 消耗。 */
  avgTokens: number | null;
  /** 平均耗时毫秒。 */
  avgDurationMs: number | null;
  /** 采样任务数。 */
  sampleSize: number;
  /** error 级指纹签名集合（用于「无新增」判定）。 */
  errorFingerprints: string[];
  /** 输出相似度（0-1）；无法计算时为 null，不臆造。 */
  outputSimilarity: number | null;
}

/** 准入判据差异报告：逐指标给出实测值与是否通过。 */
export interface CanaryVerdict {
  pass: boolean;
  checks: Array<{
    id: "success-rate" | "token" | "new-error-fingerprints";
    label: string;
    baseline: number | null;
    shadow: number | null;
    /** 允许的变化幅度（百分比或绝对值，按指标语义）。 */
    tolerance: string;
    pass: boolean;
    detail: string;
  }>;
  /** 未参与判定的指标（相似度等）与原因——显式声明，不冒名顶替。 */
  notEvaluated: string[];
}

export interface CanaryRunRow {
  id: string;
  instance: string;
  fromVersion: string | null;
  targetVersion: string;
  policy: CanaryPolicy;
  status: CanaryStatus;
  sampleRegular: number;
  sampleFailed: number;
  /** 抽样任务标识 JSON 数组（来自真实会话索引，非编造）。 */
  taskIdsJson: string;
  baselineJson: string | null;
  shadowJson: string | null;
  verdictJson: string | null;
  /** 观察窗截止时刻；status=observing 时有效。 */
  observationUntil: string | null;
  /** 实际切换（生效）时刻；回归判定以它为起点。 */
  switchedAt: string | null;
  /** 自动回滚所用的快照登记行。 */
  rollbackSnapshotId: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TrustRepository extends BaseRepository {
  /* ----------------------- 信任层（Trust Layer）存取 ----------------------- */

  getBudgetState(month: string): BudgetStateRow | undefined {
    const row = this.prepare("SELECT * FROM budget_state WHERE month = ?").get(month) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return {
      month: String(row["month"]),
      budgetUsd: Number(row["budget_usd"]),
      spentUsd: Number(row["spent_usd"]),
      action: String(row["action"]),
      notified: fromJson<string[]>(row["notified_json"] as string | null, []),
      updatedAt: String(row["updated_at"]),
    };
  }

  saveBudgetState(input: Omit<BudgetStateRow, "updatedAt">): BudgetStateRow {
    const updatedAt = nowIso();
    this.prepare(
      `INSERT INTO budget_state (month, budget_usd, spent_usd, action, notified_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET budget_usd = excluded.budget_usd, spent_usd = excluded.spent_usd,
         action = excluded.action, notified_json = excluded.notified_json, updated_at = excluded.updated_at`,
    ).run(input.month, input.budgetUsd, input.spentUsd, input.action, toJson(input.notified), updatedAt);
    return { ...input, updatedAt };
  }

  insertKillswitchLog(input: {
    engagedAt: string;
    trigger: string;
    snapshotId: number | null;
    actor: string;
    detail?: unknown;
  }): KillswitchLogRow {
    const result = this.prepare(
      "INSERT INTO killswitch_log (engaged_at, trigger, snapshot_id, actor, detail_json) VALUES (?, ?, ?, ?, ?)",
    ).run(input.engagedAt, input.trigger, input.snapshotId, input.actor, toJson(input.detail ?? null));
    return {
      id: Number(result.lastInsertRowid),
      engagedAt: input.engagedAt,
      releasedAt: null,
      trigger: input.trigger,
      snapshotId: input.snapshotId,
      actor: input.actor,
      detailJson: toJson(input.detail ?? null),
    };
  }

  latestKillswitchLog(): KillswitchLogRow | undefined {
    const row = this.prepare("SELECT * FROM killswitch_log ORDER BY id DESC LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapKillswitchLog(row);
  }

  closeKillswitchLog(id: number, releasedAt: string): void {
    this.prepare("UPDATE killswitch_log SET released_at = ? WHERE id = ?").run(releasedAt, id);
  }

  listKillswitchLog(limit = 20): KillswitchLogRow[] {
    const rows = this.prepare("SELECT * FROM killswitch_log ORDER BY id DESC LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.mapKillswitchLog(row));
  }

  private mapKillswitchLog(row: Record<string, unknown>): KillswitchLogRow {
    return {
      id: Number(row["id"]),
      engagedAt: String(row["engaged_at"]),
      releasedAt: (row["released_at"] as string | null) ?? null,
      trigger: String(row["trigger"]),
      snapshotId: (row["snapshot_id"] as number | null) ?? null,
      actor: String(row["actor"]),
      detailJson: (row["detail_json"] as string | null) ?? null,
    };
  }

  /* ------------------------------- action_events ------------------------------- */

  insertActionEvent(input: {
    ts: string;
    kind: ActionEventRow["kind"];
    severity: ActionEventRow["severity"];
    target: string;
    detail?: unknown;
    sessionId?: string | null;
    parserVersion: string;
  }): ActionEventRow {
    const result = this.prepare(
      `INSERT INTO action_events (ts, kind, severity, target, detail_json, session_id, parser_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.ts,
      input.kind,
      input.severity,
      input.target,
      toJson(input.detail ?? {}),
      input.sessionId ?? null,
      input.parserVersion,
    );
    return {
      id: Number(result.lastInsertRowid),
      ts: input.ts,
      kind: input.kind,
      severity: input.severity,
      target: input.target,
      detailJson: toJson(input.detail ?? {}),
      sessionId: input.sessionId ?? null,
      parserVersion: input.parserVersion,
    };
  }

  listActionEvents(
    filter: {
      since?: string;
      until?: string;
      kind?: ActionEventRow["kind"];
      severity?: ActionEventRow["severity"];
      /** 只看指定会话的动作（假进度检测的「同会话副作用」核实用）。 */
      sessionId?: string;
      limit?: number;
    } = {},
  ): ActionEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_events
       WHERE (? IS NULL OR ts >= ?) AND (? IS NULL OR ts < ?)
         AND (? IS NULL OR kind = ?) AND (? IS NULL OR severity = ?)
         AND (? IS NULL OR session_id = ?)
       ORDER BY id DESC LIMIT ?`,
    ).all(
      filter.since ?? null,
      filter.since ?? null,
      filter.until ?? null,
      filter.until ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.severity ?? null,
      filter.severity ?? null,
      filter.sessionId ?? null,
      filter.sessionId ?? null,
      filter.limit ?? 200,
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row["id"]),
      ts: String(row["ts"]),
      kind: String(row["kind"]) as ActionEventRow["kind"],
      severity: String(row["severity"]) as ActionEventRow["severity"],
      target: String(row["target"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      sessionId: (row["session_id"] as string | null) ?? null,
      parserVersion: String(row["parser_version"]),
    }));
  }

  /** 最近 since（ISO）之后的高危动作计数（急停遮罩 / 审计摘要用）。 */
  countActionEvents(since: string, severity?: ActionEventRow["severity"]): number {
    const row = this.prepare(
      "SELECT COUNT(*) AS n FROM action_events WHERE ts >= ? AND (? IS NULL OR severity = ?)",
    ).get(since, severity ?? null, severity ?? null) as { n: number | bigint };
    return Number(row.n);
  }

  /**
   * 按会话聚合动作（M2.3 会话索引用）：会话内动作数、高危数、最后动作时间与动作类型分布。
   * 只统计带 session_id 的行（无法归属的动作不属于任何会话，不强行归并）。
   */
  aggregateActionEventsBySession(since: string): Array<{
    sessionId: string;
    count: number;
    highRisk: number;
    lastAt: string;
    kinds: Record<string, number>;
  }> {
    const rows = this.prepare(
      `SELECT session_id, kind, severity, ts FROM action_events
       WHERE session_id IS NOT NULL AND session_id <> '' AND ts >= ?
       ORDER BY ts ASC`,
    ).all(since) as Array<Record<string, unknown>>;
    const bySession = new Map<
      string,
      { count: number; highRisk: number; lastAt: string; kinds: Record<string, number> }
    >();
    for (const row of rows) {
      const sessionId = String(row["session_id"]);
      const entry = bySession.get(sessionId) ?? { count: 0, highRisk: 0, lastAt: "", kinds: {} };
      entry.count += 1;
      if (String(row["severity"]) === "high") entry.highRisk += 1;
      const ts = String(row["ts"]);
      if (ts > entry.lastAt) entry.lastAt = ts;
      const kind = String(row["kind"]);
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + 1;
      bySession.set(sessionId, entry);
    }
    return Array.from(bySession.entries()).map(([sessionId, entry]) => ({
      sessionId,
      count: entry.count,
      highRisk: entry.highRisk,
      lastAt: entry.lastAt,
      kinds: entry.kinds,
    }));
  }

  pruneActionEvents(cutoff: string): number {
    const result = this.prepare("DELETE FROM action_events WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  listActionEventsAfterId(
    afterId: number,
    filter: { severity?: ActionEventRow["severity"]; limit?: number } = {},
  ): ActionEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_events
       WHERE id > ? AND (? IS NULL OR severity = ?)
       ORDER BY id ASC LIMIT ?`,
    ).all(
      Math.max(0, Math.floor(afterId)),
      filter.severity ?? null,
      filter.severity ?? null,
      Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100))),
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row["id"]),
      ts: String(row["ts"]),
      kind: String(row["kind"]) as ActionEventRow["kind"],
      severity: String(row["severity"]) as ActionEventRow["severity"],
      target: String(row["target"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      sessionId: (row["session_id"] as string | null) ?? null,
      parserVersion: String(row["parser_version"]),
    }));
  }

  /* ------------------------------- trust_events ------------------------------- */

  upsertTrustEvent(input: {
    kind: string;
    severity: TrustEventRow["severity"];
    title: string;
    evidence?: unknown[];
    relatedIds?: string[];
    dedupeKey: string;
    at: string;
  }): TrustEventRow {
    const existing = this.prepare("SELECT * FROM trust_events WHERE dedupe_key = ?").get(input.dedupeKey) as
      | Record<string, unknown>
      | undefined;
    if (existing === undefined) {
      const result = this.prepare(
        `INSERT INTO trust_events (kind, severity, title, first_seen, last_seen, count, status,
           evidence_json, related_ids, dedupe_key, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
      ).run(
        input.kind,
        input.severity,
        input.title,
        input.at,
        input.at,
        toJson(input.evidence ?? []),
        toJson(input.relatedIds ?? []),
        input.dedupeKey,
        input.at,
      );
      return this.getTrustEvent(Number(result.lastInsertRowid))!;
    }
    const status = String(existing["status"]);
    const nextStatus: TrustEventRow["status"] =
      status === "resolved" ? "regressed" : (status as TrustEventRow["status"]);
    this.prepare(
      `UPDATE trust_events SET last_seen = ?, count = count + 1, severity = ?, title = ?,
         status = ?, evidence_json = ?, related_ids = ?, updated_at = ?
       WHERE dedupe_key = ?`,
    ).run(
      input.at,
      input.severity,
      input.title,
      nextStatus,
      toJson(input.evidence ?? []),
      toJson(input.relatedIds ?? []),
      input.at,
      input.dedupeKey,
    );
    return this.getTrustEvent(Number(existing["id"]))!;
  }

  getTrustEvent(id: number): TrustEventRow | undefined {
    const row = this.prepare("SELECT * FROM trust_events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.mapTrustEvent(row);
  }

  listTrustEvents(
    filter: {
      status?: TrustEventRow["status"];
      severity?: TrustEventRow["severity"];
      /** 事件类型精确匹配（如 upgrade-regression-suspect）。 */
      kind?: string;
      /** 只取 last_seen 在该时刻之后的活跃事件（金丝雀观察窗回归判定用）。 */
      lastSeenSince?: string;
      limit?: number;
      /** 分页偏移（与 ORDER BY 一致排序配套，翻页用；默认 0）。 */
      offset?: number;
    } = {},
  ): TrustEventRow[] {
    const rows = this.prepare(
      `SELECT * FROM trust_events
       WHERE (? IS NULL OR status = ?) AND (? IS NULL OR severity = ?)
         AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR last_seen >= ?)
       ORDER BY CASE status WHEN 'regressed' THEN 0 WHEN 'active' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END,
         CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen DESC
       LIMIT ? OFFSET ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      filter.severity ?? null,
      filter.severity ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.lastSeenSince ?? null,
      filter.lastSeenSince ?? null,
      filter.limit ?? 100,
      Math.max(0, Math.floor(filter.offset ?? 0)),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapTrustEvent(row));
  }

  updateTrustEventStatus(id: number, status: TrustEventRow["status"]): TrustEventRow | undefined {
    const current = this.getTrustEvent(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE trust_events SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
    return this.getTrustEvent(id);
  }

  pruneTrustEvents(cutoff: string): number {
    const result = this.prepare("DELETE FROM trust_events WHERE last_seen < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapTrustEvent(row: Record<string, unknown>): TrustEventRow {
    return {
      id: Number(row["id"]),
      kind: String(row["kind"]),
      severity: String(row["severity"]) as TrustEventRow["severity"],
      title: String(row["title"]),
      firstSeen: String(row["first_seen"]),
      lastSeen: String(row["last_seen"]),
      count: Number(row["count"]),
      status: String(row["status"]) as TrustEventRow["status"],
      evidenceJson: String(row["evidence_json"] ?? "[]"),
      relatedIds: String(row["related_ids"] ?? "[]"),
      dedupeKey: String(row["dedupe_key"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  /* ------------------------ M2.1 Agent 周报存档 ------------------------ */

  upsertReport(input: {
    weekStart: string;
    weekEnd: string;
    status: ReportHistoryRow["status"];
    markdown: string;
    data: unknown;
    at: string;
  }): ReportHistoryRow {
    this.prepare(
      `INSERT INTO report_history (week_start, week_end, status, markdown, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         week_end = excluded.week_end, status = excluded.status, markdown = excluded.markdown,
         data_json = excluded.data_json, sent_at = NULL`,
    ).run(input.weekStart, input.weekEnd, input.status, input.markdown, toJson(input.data), input.at);
    return this.getReportByWeek(input.weekStart)!;
  }

  getReportByWeek(weekStart: string): ReportHistoryRow | undefined {
    const row = this.prepare("SELECT * FROM report_history WHERE week_start = ?").get(weekStart) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapReport(row);
  }

  getReport(id: number): ReportHistoryRow | undefined {
    const row = this.prepare("SELECT * FROM report_history WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapReport(row);
  }

  listReports(limit = 12): ReportHistoryRow[] {
    const rows = this.prepare("SELECT * FROM report_history ORDER BY week_start DESC LIMIT ?").all(
      Math.max(1, Math.min(52, Math.floor(limit))),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapReport(row));
  }

  markReportSent(id: number, at: string): ReportHistoryRow | undefined {
    const current = this.getReport(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE report_history SET status = 'sent', sent_at = ? WHERE id = ?").run(at, id);
    return this.getReport(id);
  }

  markReportSendFailed(id: number): ReportHistoryRow | undefined {
    const current = this.getReport(id);
    if (current === undefined) return undefined;
    this.prepare("UPDATE report_history SET status = 'send-failed' WHERE id = ?").run(id);
    return this.getReport(id);
  }

  pruneReports(cutoff: string): number {
    const result = this.prepare("DELETE FROM report_history WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapReport(row: Record<string, unknown>): ReportHistoryRow {
    return {
      id: Number(row["id"]),
      weekStart: String(row["week_start"]),
      weekEnd: String(row["week_end"]),
      status: String(row["status"]) as ReportHistoryRow["status"],
      markdown: String(row["markdown"]),
      dataJson: String(row["data_json"] ?? "{}"),
      sentAt: (row["sent_at"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
    };
  }

  /* ------------------------ M2.3 会话索引 ------------------------ */

  upsertSessionIndex(input: {
    sessionId: string;
    instance?: string;
    startedAt?: string | null;
    endedAt?: string | null;
    durationMs?: number | null;
    model?: string | null;
    taskType?: string | null;
    tokenIn?: number | null;
    tokenOut?: number | null;
    costUsd?: number | null;
    outcome: string;
    anomalyFlags: unknown[];
    actionCount?: number;
    highRiskCount?: number;
    lastActionAt?: string | null;
    at: string;
  }): SessionIndexRow {
    this.prepare(
      `INSERT INTO session_index (session_id, instance, started_at, ended_at, duration_ms, model,
         task_type, token_in, token_out, cost_usd, outcome, anomaly_flags, action_count,
         high_risk_count, last_action_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         instance = excluded.instance, started_at = excluded.started_at, ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms, model = excluded.model, task_type = excluded.task_type,
         token_in = excluded.token_in, token_out = excluded.token_out, cost_usd = excluded.cost_usd,
         outcome = excluded.outcome, anomaly_flags = excluded.anomaly_flags,
         action_count = excluded.action_count, high_risk_count = excluded.high_risk_count,
         last_action_at = excluded.last_action_at, updated_at = excluded.updated_at`,
    ).run(
      input.sessionId,
      input.instance ?? "",
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.durationMs ?? null,
      input.model ?? null,
      input.taskType ?? null,
      input.tokenIn ?? null,
      input.tokenOut ?? null,
      input.costUsd ?? null,
      input.outcome,
      toJson(input.anomalyFlags),
      input.actionCount ?? 0,
      input.highRiskCount ?? 0,
      input.lastActionAt ?? null,
      input.at,
    );
    return this.getSessionIndex(input.sessionId)!;
  }

  getSessionIndex(sessionId: string): SessionIndexRow | undefined {
    const row = this.prepare("SELECT * FROM session_index WHERE session_id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapSessionIndex(row);
  }

  listSessionIndex(
    filter: {
      /** 只看有异常的会话（anomaly_flags 非空数组）。 */
      anomalyOnly?: boolean;
      outcome?: string;
      /** 起始时间下界（ISO；按 started_at 比较，null 的旧行不参与）。 */
      since?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SessionIndexRow[] {
    const rows = this.prepare(
      `SELECT * FROM session_index
       WHERE (? IS NULL OR outcome = ?)
         AND (? IS NULL OR started_at >= ?)
         AND (? = 0 OR (anomaly_flags IS NOT NULL AND anomaly_flags NOT IN ('[]', '')))
       ORDER BY COALESCE(started_at, last_action_at, updated_at) DESC
       LIMIT ? OFFSET ?`,
    ).all(
      filter.outcome ?? null,
      filter.outcome ?? null,
      filter.since ?? null,
      filter.since ?? null,
      filter.anomalyOnly === true ? 1 : 0,
      Math.max(1, Math.min(2000, Math.floor(filter.limit ?? 100))),
      Math.max(0, Math.floor(filter.offset ?? 0)),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapSessionIndex(row));
  }

  countSessionIndex(): { total: number; anomalies: number } {
    const total = this.prepare("SELECT COUNT(*) AS n FROM session_index").get() as { n: number | bigint };
    const anomalies = this.prepare(
      "SELECT COUNT(*) AS n FROM session_index WHERE anomaly_flags IS NOT NULL AND anomaly_flags NOT IN ('[]', '')",
    ).get() as { n: number | bigint };
    return { total: Number(total.n), anomalies: Number(anomalies.n) };
  }

  pruneSessionIndex(cutoff: string): number {
    const result = this.prepare(
      "DELETE FROM session_index WHERE COALESCE(started_at, last_action_at, updated_at) < ?",
    ).run(cutoff);
    return Number(result.changes);
  }

  private mapSessionIndex(row: Record<string, unknown>): SessionIndexRow {
    return {
      sessionId: String(row["session_id"]),
      instance: String(row["instance"] ?? ""),
      startedAt: (row["started_at"] as string | null) ?? null,
      endedAt: (row["ended_at"] as string | null) ?? null,
      durationMs: row["duration_ms"] === null || row["duration_ms"] === undefined ? null : Number(row["duration_ms"]),
      model: (row["model"] as string | null) ?? null,
      taskType: (row["task_type"] as string | null) ?? null,
      tokenIn: row["token_in"] === null || row["token_in"] === undefined ? null : Number(row["token_in"]),
      tokenOut: row["token_out"] === null || row["token_out"] === undefined ? null : Number(row["token_out"]),
      costUsd: row["cost_usd"] === null || row["cost_usd"] === undefined ? null : Number(row["cost_usd"]),
      outcome: String(row["outcome"] ?? "unknown"),
      anomalyFlagsJson: String(row["anomaly_flags"] ?? "[]"),
      actionCount: Number(row["action_count"] ?? 0),
      highRiskCount: Number(row["high_risk_count"] ?? 0),
      lastActionAt: (row["last_action_at"] as string | null) ?? null,
      updatedAt: String(row["updated_at"]),
    };
  }

  /* ---------------------- 通知即操作（M3.1 action_approvals） ---------------------- */

  insertActionApproval(input: {
    id: string;
    actionId: string;
    fingerprint?: string;
    instance?: string;
    sessionId?: string | null;
    kind: string;
    title: string;
    detail?: unknown;
    attempts?: number;
    escalateRequired?: boolean;
    expiresAt: string;
    at: string;
  }): ActionApprovalRow {
    const existing = this.getActionApprovalByActionId(input.actionId);
    if (existing !== undefined) return existing;
    this.prepare(
      `INSERT INTO action_approvals
         (id, action_id, fingerprint, instance, session_id, kind, title, detail_json, status, channel,
          attempts, escalate_required, expires_at, responded_at, actor, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(action_id) DO NOTHING`,
    ).run(
      input.id,
      input.actionId,
      input.fingerprint ?? "",
      input.instance ?? "",
      input.sessionId ?? null,
      input.kind,
      input.title,
      toJson(input.detail ?? {}),
      Math.max(1, Math.floor(input.attempts ?? 1)),
      input.escalateRequired === true ? 1 : 0,
      input.expiresAt,
      input.at,
      input.at,
    );
    const row = this.getActionApproval(input.id) ?? this.getActionApprovalByActionId(input.actionId);
    if (row === undefined) throw new Error(`action_approvals 写入失败: ${input.id}`);
    return row;
  }

  getActionApproval(id: string): ActionApprovalRow | undefined {
    const row = this.prepare("SELECT * FROM action_approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapActionApproval(row);
  }

  getActionApprovalByActionId(actionId: string): ActionApprovalRow | undefined {
    const row = this.prepare("SELECT * FROM action_approvals WHERE action_id = ?").get(actionId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapActionApproval(row);
  }

  getOpenActionApprovalByFingerprint(fingerprint: string): ActionApprovalRow | undefined {
    const row = this.prepare(
      "SELECT * FROM action_approvals WHERE fingerprint = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(fingerprint) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.mapActionApproval(row);
  }

  bumpActionApprovalAttempts(
    id: string,
    input: { attempts: number; escalateRequired: boolean; at: string },
  ): ActionApprovalRow | undefined {
    this.prepare(
      `UPDATE action_approvals
         SET attempts = ?, escalate_required = CASE WHEN escalate_required = 1 THEN 1 ELSE ? END,
             updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(
      Math.max(1, Math.floor(input.attempts)),
      input.escalateRequired ? 1 : 0,
      input.at,
      id,
    );
    const row = this.getActionApproval(id);
    return row !== undefined && row.status === "pending" ? row : undefined;
  }

  listActionApprovals(
    filter: {
      status?: string;
      escalateOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): ActionApprovalRow[] {
    const rows = this.prepare(
      `SELECT * FROM action_approvals
       WHERE (? IS NULL OR status = ?)
         AND (? = 0 OR escalate_required = 1)
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      filter.escalateOnly === true ? 1 : 0,
      Math.max(1, Math.min(2000, Math.floor(filter.limit ?? 100))),
      Math.max(0, Math.floor(filter.offset ?? 0)),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapActionApproval(row));
  }

  countActionApprovals(): {
    total: number;
    pending: number;
    escalated: number;
    expired: number;
    approved: number;
    denied: number;
  } {
    const one = (sql: string): number => {
      const row = this.prepare(sql).get() as { n: number | bigint };
      return Number(row.n);
    };
    return {
      total: one("SELECT COUNT(*) AS n FROM action_approvals"),
      pending: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'pending'"),
      escalated: one(
        "SELECT COUNT(*) AS n FROM action_approvals WHERE escalate_required = 1 AND status = 'pending'",
      ),
      expired: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'expired'"),
      approved: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'approved'"),
      denied: one("SELECT COUNT(*) AS n FROM action_approvals WHERE status = 'denied'"),
    };
  }

  countApprovalRequestsByAction(fingerprint: string, since: string): number {
    const row = this.prepare(
      "SELECT COALESCE(SUM(attempts), 0) AS n FROM action_approvals WHERE fingerprint = ? AND created_at >= ?",
    ).get(fingerprint, since) as { n: number | bigint };
    return Number(row.n);
  }

  decideActionApproval(
    id: string,
    input: {
      status: "approved" | "denied" | "expired";
      actor?: string | null;
      channel?: string | null;
      reason?: string | null;
      at: string;
    },
  ): ActionApprovalRow | undefined {
    const result = this.prepare(
      `UPDATE action_approvals
         SET status = ?, actor = ?, channel = ?, reason = ?, responded_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(
      input.status,
      input.actor ?? null,
      input.channel ?? null,
      input.reason ?? null,
      input.at,
      input.at,
      id,
    );
    if (Number(result.changes) === 0) return undefined;
    return this.getActionApproval(id);
  }

  expireActionApprovals(now: string, reasonOf?: (row: ActionApprovalRow) => string): ActionApprovalRow[] {
    const due = this.prepare(
      "SELECT * FROM action_approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC",
    ).all(now) as Record<string, unknown>[];
    const expired: ActionApprovalRow[] = [];
    for (const raw of due) {
      const row = this.mapActionApproval(raw);
      const updated = this.decideActionApproval(row.id, {
        status: "expired",
        actor: "system:timeout",
        reason: reasonOf === undefined ? "超时未应答，按默认拒绝拦截" : reasonOf(row),
        at: now,
      });
      if (updated !== undefined) expired.push(updated);
    }
    return expired;
  }

  pruneActionApprovals(cutoff: string): number {
    const result = this.prepare("DELETE FROM action_approvals WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapActionApproval(row: Record<string, unknown>): ActionApprovalRow {
    return {
      id: String(row["id"]),
      actionId: String(row["action_id"]),
      fingerprint: String(row["fingerprint"] ?? ""),
      instance: String(row["instance"] ?? ""),
      sessionId: (row["session_id"] as string | null) ?? null,
      kind: String(row["kind"]),
      title: String(row["title"]),
      detailJson: String(row["detail_json"] ?? "{}"),
      status: String(row["status"]),
      channel: (row["channel"] as string | null) ?? null,
      attempts: Number(row["attempts"] ?? 1),
      escalateRequired: Number(row["escalate_required"] ?? 0) === 1,
      expiresAt: String(row["expires_at"]),
      respondedAt: (row["responded_at"] as string | null) ?? null,
      actor: (row["actor"] as string | null) ?? null,
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  /* ---------------------- 升级金丝雀（M3.2 canary_runs） ---------------------- */

  insertCanaryRun(input: {
    id: string;
    instance?: string;
    fromVersion?: string | null;
    targetVersion: string;
    policy: CanaryPolicy;
    status: CanaryStatus;
    sampleRegular?: number;
    sampleFailed?: number;
    taskIds?: unknown[];
    rollbackSnapshotId?: number | null;
    reason?: string | null;
    at: string;
  }): CanaryRunRow {
    this.prepare(
      `INSERT INTO canary_runs
         (id, instance, from_version, target_version, policy, status,
          sample_regular, sample_failed, task_ids, baseline_json, shadow_json, verdict_json,
          observation_until, switched_at, rollback_snapshot_id, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.instance ?? "",
      input.fromVersion ?? null,
      input.targetVersion,
      input.policy,
      input.status,
      Math.max(0, Math.floor(input.sampleRegular ?? 0)),
      Math.max(0, Math.floor(input.sampleFailed ?? 0)),
      JSON.stringify(input.taskIds ?? []),
      input.rollbackSnapshotId ?? null,
      input.reason ?? null,
      input.at,
      input.at,
    );
    const row = this.getCanaryRun(input.id);
    if (row === undefined) throw new Error(`canary_runs 写入失败: ${input.id}`);
    return row;
  }

  getCanaryRun(id: string): CanaryRunRow | undefined {
    const row = this.prepare("SELECT * FROM canary_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : this.mapCanaryRun(row);
  }

  listCanaryRuns(filter: { status?: CanaryStatus; limit?: number } = {}): CanaryRunRow[] {
    const rows = this.prepare(
      `SELECT * FROM canary_runs
       WHERE (? IS NULL OR status = ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      filter.status ?? null,
      filter.status ?? null,
      Math.max(1, Math.min(500, Math.floor(filter.limit ?? 50))),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapCanaryRun(row));
  }

  listCanaryRunsObserving(): CanaryRunRow[] {
    const rows = this.prepare(
      "SELECT * FROM canary_runs WHERE status = 'observing' ORDER BY COALESCE(switched_at, created_at) ASC",
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapCanaryRun(row));
  }

  updateCanaryRun(
    id: string,
    patch: {
      status?: CanaryStatus;
      baseline?: CanaryMetrics | null;
      shadow?: CanaryMetrics | null;
      verdict?: CanaryVerdict | null;
      observationUntil?: string | null;
      switchedAt?: string | null;
      rollbackSnapshotId?: number | null;
      reason?: string | null;
      at: string;
    },
  ): CanaryRunRow | undefined {
    const existing = this.getCanaryRun(id);
    if (existing === undefined) return undefined;
    this.prepare(
      `UPDATE canary_runs
         SET status = ?, baseline_json = ?, shadow_json = ?, verdict_json = ?,
             observation_until = ?, switched_at = ?, rollback_snapshot_id = ?, reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.status ?? existing.status,
      patch.baseline === undefined
        ? existing.baselineJson
        : patch.baseline === null
          ? null
          : JSON.stringify(patch.baseline),
      patch.shadow === undefined
        ? existing.shadowJson
        : patch.shadow === null
          ? null
          : JSON.stringify(patch.shadow),
      patch.verdict === undefined
        ? existing.verdictJson
        : patch.verdict === null
          ? null
          : JSON.stringify(patch.verdict),
      patch.observationUntil === undefined ? existing.observationUntil : patch.observationUntil,
      patch.switchedAt === undefined ? existing.switchedAt : patch.switchedAt,
      patch.rollbackSnapshotId === undefined ? existing.rollbackSnapshotId : patch.rollbackSnapshotId,
      patch.reason === undefined ? existing.reason : patch.reason,
      patch.at,
      id,
    );
    return this.getCanaryRun(id);
  }

  pruneCanaryRuns(cutoff: string): number {
    const result = this.prepare("DELETE FROM canary_runs WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapCanaryRun(row: Record<string, unknown>): CanaryRunRow {
    return {
      id: String(row["id"]),
      instance: String(row["instance"] ?? ""),
      fromVersion: (row["from_version"] as string | null) ?? null,
      targetVersion: String(row["target_version"]),
      policy: String(row["policy"]) as CanaryPolicy,
      status: String(row["status"]) as CanaryStatus,
      sampleRegular: Number(row["sample_regular"] ?? 0),
      sampleFailed: Number(row["sample_failed"] ?? 0),
      taskIdsJson: String(row["task_ids"] ?? "[]"),
      baselineJson: (row["baseline_json"] as string | null) ?? null,
      shadowJson: (row["shadow_json"] as string | null) ?? null,
      verdictJson: (row["verdict_json"] as string | null) ?? null,
      observationUntil: (row["observation_until"] as string | null) ?? null,
      switchedAt: (row["switched_at"] as string | null) ?? null,
      rollbackSnapshotId:
        row["rollback_snapshot_id"] === null || row["rollback_snapshot_id"] === undefined
          ? null
          : Number(row["rollback_snapshot_id"]),
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  /* ---------------------- 假进度检测（M3.3 progress_claims） ---------------------- */

  insertProgressClaim(input: {
    sessionId: string;
    ts: string;
    claimedPct?: number | null;
    claimText: string;
    sideEffectCount: number;
    sideEffectKinds?: string[];
    verdict: ProgressVerdict;
    reason?: string | null;
    at: string;
  }): boolean {
    const result = this.prepare(
      `INSERT INTO progress_claims
         (session_id, ts, claimed_pct, claim_text, side_effect_count, side_effect_kinds, verdict, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ts, claim_text) DO NOTHING`,
    ).run(
      input.sessionId,
      input.ts,
      input.claimedPct ?? null,
      input.claimText,
      Math.max(0, Math.floor(input.sideEffectCount)),
      JSON.stringify(input.sideEffectKinds ?? []),
      input.verdict,
      input.reason ?? null,
      input.at,
    );
    return Number(result.changes) > 0;
  }

  listProgressClaims(
    filter: { sessionId?: string; verdict?: ProgressVerdict; since?: string; limit?: number } = {},
  ): ProgressClaimRow[] {
    const rows = this.prepare(
      `SELECT * FROM progress_claims
       WHERE (? IS NULL OR session_id = ?)
         AND (? IS NULL OR verdict = ?)
         AND (? IS NULL OR ts >= ?)
       ORDER BY ts ASC, id ASC LIMIT ?`,
    ).all(
      filter.sessionId ?? null,
      filter.sessionId ?? null,
      filter.verdict ?? null,
      filter.verdict ?? null,
      filter.since ?? null,
      filter.since ?? null,
      Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 1000))),
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapProgressClaim(row));
  }

  aggregateProgressBySession(since: string): Array<{
    sessionId: string;
    total: number;
    verified: number;
    suspect: number;
    unverifiable: number;
    maxSuspectStreak: number;
    lastClaimAt: string;
  }> {
    const rows = this.listProgressClaims({ since, limit: 5000 });
    const bySession = new Map<
      string,
      {
        total: number;
        verified: number;
        suspect: number;
        unverifiable: number;
        streak: number;
        maxStreak: number;
        lastClaimAt: string;
      }
    >();
    for (const row of rows) {
      const entry =
        bySession.get(row.sessionId) ??
        { total: 0, verified: 0, suspect: 0, unverifiable: 0, streak: 0, maxStreak: 0, lastClaimAt: "" };
      entry.total += 1;
      if (row.verdict === "verified") {
        entry.verified += 1;
        entry.streak = 0;
      } else if (row.verdict === "suspect") {
        entry.suspect += 1;
        entry.streak += 1;
        if (entry.streak > entry.maxStreak) entry.maxStreak = entry.streak;
      } else {
        entry.unverifiable += 1;
        entry.streak = 0;
      }
      if (row.ts > entry.lastClaimAt) entry.lastClaimAt = row.ts;
      bySession.set(row.sessionId, entry);
    }
    return Array.from(bySession.entries()).map(([sessionId, entry]) => ({
      sessionId,
      total: entry.total,
      verified: entry.verified,
      suspect: entry.suspect,
      unverifiable: entry.unverifiable,
      maxSuspectStreak: entry.maxStreak,
      lastClaimAt: entry.lastClaimAt,
    }));
  }

  countProgressClaims(since: string): { total: number; verified: number; suspect: number; unverifiable: number } {
    const one = (sql: string): number => {
      const row = this.prepare(sql).get(since) as { n: number | bigint };
      return Number(row.n);
    };
    return {
      total: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ?"),
      verified: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'verified'"),
      suspect: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'suspect'"),
      unverifiable: one("SELECT COUNT(*) AS n FROM progress_claims WHERE ts >= ? AND verdict = 'unverifiable'"),
    };
  }

  pruneProgressClaims(cutoff: string): number {
    const result = this.prepare("DELETE FROM progress_claims WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }

  private mapProgressClaim(row: Record<string, unknown>): ProgressClaimRow {
    return {
      id: Number(row["id"]),
      sessionId: String(row["session_id"]),
      ts: String(row["ts"]),
      claimedPct:
        row["claimed_pct"] === null || row["claimed_pct"] === undefined ? null : Number(row["claimed_pct"]),
      claimText: String(row["claim_text"]),
      sideEffectCount: Number(row["side_effect_count"] ?? 0),
      sideEffectKindsJson: String(row["side_effect_kinds"] ?? "[]"),
      verdict: String(row["verdict"]) as ProgressVerdict,
      reason: (row["reason"] as string | null) ?? null,
      createdAt: String(row["created_at"]),
    };
  }
}
