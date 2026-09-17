/**
 * Ollama 本地模型调用记录与 Token 每日消耗统计存储。
 *
 * 功能：
 * 1. 持久化记录每次调用（timestamp, date, model, prompt_tokens, completion_tokens, duration_ms, tokens_per_second）；
 * 2. 每日调用量与 Token 消耗连续窗口聚合（填充无调用的日期，保障图表与表格连续）；
 * 3. 汇总统计（今日调用量、今日 Token、总调用量、总 Token、平均生成速率）；
 * 4. 最近调用明细追溯。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface OllamaUsageRecord {
  id: number;
  timestamp: string;
  date: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  tokensPerSecond: number;
  status: "success" | "error";
  errorMessage?: string;
}

export interface OllamaUsageInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  tokensPerSecond?: number;
  status?: "success" | "error";
  errorMessage?: string;
  timestamp?: string;
}

export interface DailyUsageMetric {
  date: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgTokensPerSecond: number;
}

export interface OllamaUsageSummary {
  todayCalls: number;
  todayPromptTokens: number;
  todayCompletionTokens: number;
  todayTokens: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgTokensPerSecond: number;
  dailyHistory: DailyUsageMetric[];
}

export class OllamaUsageStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ollama_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tokens_per_second REAL NOT NULL DEFAULT 0.0,
        status TEXT NOT NULL DEFAULT 'success',
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ollama_usage_date ON ollama_usage(date);
      CREATE INDEX IF NOT EXISTS idx_ollama_usage_timestamp ON ollama_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ollama_usage_model ON ollama_usage(model);
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** 记录一条调用日志。 */
  recordUsage(input: OllamaUsageInput): OllamaUsageRecord {
    const ts = input.timestamp || new Date().toISOString();
    const date = ts.slice(0, 10);
    const promptTokens = Math.max(0, Math.round(input.promptTokens || 0));
    const completionTokens = Math.max(0, Math.round(input.completionTokens || 0));
    const totalTokens = promptTokens + completionTokens;
    const durationMs = Math.max(0, Math.round(input.durationMs || 0));

    let tps = input.tokensPerSecond;
    if (tps === undefined || Number.isNaN(tps)) {
      tps = durationMs > 0 ? Number(((completionTokens / (durationMs / 1000))).toFixed(1)) : 0;
    } else {
      tps = Number(tps.toFixed(1));
    }

    const status = input.status || "success";
    const errorMessage = input.errorMessage || null;

    const stmt = this.db.prepare(`
      INSERT INTO ollama_usage (
        timestamp, date, model, prompt_tokens, completion_tokens,
        total_tokens, duration_ms, tokens_per_second, status, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      ts,
      date,
      input.model.trim(),
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
      tps,
      status,
      errorMessage,
    );

    const lastId = Number(result.lastInsertRowid);
    return {
      id: lastId,
      timestamp: ts,
      date,
      model: input.model.trim(),
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
      tokensPerSecond: tps,
      status,
      errorMessage: errorMessage ?? undefined,
    };
  }

  /** 获取最近 N 天的每日调用量与汇总统计。 */
  getDailySummary(days = 14): OllamaUsageSummary {
    const safeDays = Math.max(1, Math.min(90, Math.round(days)));
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // 1. 全量汇总
    const totalRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total_calls,
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        ROUND(AVG(CASE WHEN tokens_per_second > 0 THEN tokens_per_second ELSE NULL END), 1) AS avg_tokens_per_second
      FROM ollama_usage
      WHERE status = 'success'
    `).get() as Record<string, unknown> | undefined;

    // 2. 今日统计
    const todayRow = this.db.prepare(`
      SELECT
        COUNT(*) AS today_calls,
        COALESCE(SUM(prompt_tokens), 0) AS today_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS today_completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS today_tokens
      FROM ollama_usage
      WHERE date = ? AND status = 'success'
    `).get(todayStr) as Record<string, unknown> | undefined;

    // 3. 最近 N 天每日聚合
    const startDate = new Date(now.getTime() - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
    const dailyRows = this.db.prepare(`
      SELECT
        date,
        COUNT(*) AS call_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        ROUND(AVG(CASE WHEN tokens_per_second > 0 THEN tokens_per_second ELSE NULL END), 1) AS avg_tokens_per_second
      FROM ollama_usage
      WHERE date >= ? AND status = 'success'
      GROUP BY date
      ORDER BY date ASC
    `).all(startDate) as Array<Record<string, unknown>>;

    const dateMap = new Map<string, DailyUsageMetric>();
    for (const r of dailyRows) {
      const d = String(r["date"] ?? "");
      dateMap.set(d, {
        date: d,
        callCount: Number(r["call_count"] ?? 0),
        promptTokens: Number(r["prompt_tokens"] ?? 0),
        completionTokens: Number(r["completion_tokens"] ?? 0),
        totalTokens: Number(r["total_tokens"] ?? 0),
        avgTokensPerSecond: Number(r["avg_tokens_per_second"] ?? 0),
      });
    }

    // 补齐连续日期
    const dailyHistory: DailyUsageMetric[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const dStr = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      const existing = dateMap.get(dStr);
      if (existing) {
        dailyHistory.push(existing);
      } else {
        dailyHistory.push({
          date: dStr,
          callCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          avgTokensPerSecond: 0,
        });
      }
    }

    return {
      todayCalls: Number(todayRow?.["today_calls"] ?? 0),
      todayPromptTokens: Number(todayRow?.["today_prompt_tokens"] ?? 0),
      todayCompletionTokens: Number(todayRow?.["today_completion_tokens"] ?? 0),
      todayTokens: Number(todayRow?.["today_tokens"] ?? 0),
      totalCalls: Number(totalRow?.["total_calls"] ?? 0),
      totalPromptTokens: Number(totalRow?.["total_prompt_tokens"] ?? 0),
      totalCompletionTokens: Number(totalRow?.["total_completion_tokens"] ?? 0),
      totalTokens: Number(totalRow?.["total_tokens"] ?? 0),
      avgTokensPerSecond: Number(totalRow?.["avg_tokens_per_second"] ?? 0),
      dailyHistory,
    };
  }

  /** 获取最近调用明细记录。 */
  getRecentRecords(limit = 20): OllamaUsageRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const rows = this.db.prepare(`
      SELECT
        id, timestamp, date, model, prompt_tokens, completion_tokens,
        total_tokens, duration_ms, tokens_per_second, status, error_message
      FROM ollama_usage
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r["id"]),
      timestamp: String(r["timestamp"]),
      date: String(r["date"]),
      model: String(r["model"]),
      promptTokens: Number(r["prompt_tokens"]),
      completionTokens: Number(r["completion_tokens"]),
      totalTokens: Number(r["total_tokens"]),
      durationMs: Number(r["duration_ms"]),
      tokensPerSecond: Number(r["tokens_per_second"]),
      status: (r["status"] as "success" | "error") || "success",
      errorMessage: r["error_message"] ? String(r["error_message"]) : undefined,
    }));
  }
}
