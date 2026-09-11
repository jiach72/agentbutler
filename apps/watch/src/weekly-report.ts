/**
 * M2.1 Agent 周报：全确定性数据组装 + Markdown 渲染 + 周一 08:00 幂等推送。
 *
 * - 数据来源（零 LLM 调用）：成本中枢（costSummary 14 天切片）、月度预算、实例状态、
 *   事件中心、行为审计摘要、技能用量 TOP、最近全量备份。
 * - 周锚点：本地时区周一 00:00；week_start（YYYY-MM-DD）为唯一键，重复生成幂等覆盖。
 * - 调度：每 15 分钟 tick；过点（周一 08:00）且本周尚未生成 → 生成 + 推送；
 *   crash-safe：记录不存在或生成时间早于本周过点才会重跑，之后静默跳过。
 * - 推送：复用网关告警通道（severity "info"，不挤占 warn/critical 告警语义）；
 *   dedupeKey = weekly-report:<weekStart>，网关端天然幂等。
 */
import type { SqliteStore, ReportHistoryRow } from "@butler/core";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";
import type { LlmUsageService, CostSummaryView } from "./llm-usage.js";
import type { SkillAssetService } from "./skill-assets.js";
import type { BackupService } from "./backup.js";
import type { ActionAuditService } from "./action-audit.js";
import type { ProgressIntegrityService } from "./progress-integrity.js";
import type { MemoryDiffService } from "./memory-diff.js";
import type { TrustEventHub } from "./trust-events.js";

/** 周报推送通道（结构兼容 AlertPoster；gateway /api/alerts 接受 info）。 */
export interface WeeklyReportPoster {
  post(body: {
    kind: string;
    severity: "info" | "warn" | "critical";
    title: string;
    body: string;
    source: string;
    dedupeKey: string;
  }): Promise<void>;
}

export interface WeeklyReportSchedule {
  /** 触发日（1=周一，默认 1）。 */
  day?: number;
  /** 触发小时（本地时区，默认 8）。 */
  hour?: number;
  /** 触发分钟（默认 0）。 */
  minute?: number;
}

export interface WeeklyReportServiceOptions {
  store: SqliteStore;
  llmUsage: LlmUsageService;
  skillAssets: SkillAssetService;
  backup: BackupService;
  /** 审计采集器未启用时审计段落显式标注「未启用」。 */
  auditCollector?: ActionAuditService;
  /** M3.3 假进度检测：进度可信度统计与可疑会话点名。 */
  progress?: ProgressIntegrityService;
  /** M4.3 记忆变更流：「本周它记住了什么」TOP5。 */
  memoryDiff?: MemoryDiffService;
  trustEvents: TrustEventHub;
  /** 月度预算（USD；0 = 未配置，周报不显示预算比例）。 */
  monthlyBudgetUsd: number;
  poster: WeeklyReportPoster;
  audit?: { append(input: { actor: string; action: string; target?: string; detail?: unknown }): void };
  now?: () => number;
  driver?: TimerDriver;
  /** tick 间隔毫秒（默认 15 分钟；测试可注入）。 */
  intervalMs?: number;
  schedule?: WeeklyReportSchedule;
  pushEnabled?: boolean;
}

/** 组装数据快照（/report 详情页复用 data_json 渲染，不重新查询）。 */
export interface WeeklyReportData {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  cost: {
    available: boolean;
    /** 本周成本（actual 优先，estimated 兜底；null = Hermes 成本列未接入）。 */
    thisWeekUsd: number | null;
    lastWeekUsd: number | null;
    /** 环比（%；任一周为 null 时不计算）。 */
    deltaPct: number | null;
    monthlyBudgetUsd: number | null;
    monthSpentUsd: number | null;
    topModel: string | null;
    topSessions: Array<{ sessionId: string; model: string; costUsd: number | null }>;
  };
  instances: { total: number; serving: number; degraded: number; stopped: number; byState: Record<string, number> };
  events: { active: number; critical: number; top: Array<{ kind: string; severity: string; title: string; count: number; lastSeen: string }> };
  audit: { enabled: boolean; windowHours: number; total: number; highRisk: number; byKind: Record<string, number> };
  /**
   * 进度可信度（M3.3）：verified / (verified+suspect)。无法验证的声明单独计数，
   * 不掺进分母——分母里塞「无法验证」等于把「不知道」算成「不诚实」。
   */
  progress: {
    enabled: boolean;
    windowDays: number;
    total: number;
    verified: number;
    suspect: number;
    unverifiable: number;
    trustRate: number | null;
    suspectSessions: Array<{ sessionId: string; maxSuspectStreak: number; trustRate: number | null }>;
  };
  skills: { top: Array<{ name: string; calls: number; successRate: number | null }> };
  /** 本周记忆变更（M4.3）：解决「重启失忆」焦虑的感知层。 */
  memory: {
    enabled: boolean;
    added: number;
    modified: number;
    forgotten: number;
    top: Array<{ path: string; change: string; writes: number; deletes: number }>;
  };
  backups: { lastFullAt: string | null; count: number };
}

export interface WeeklyReportService {
  /** 生成本周（或指定周）报告：组装 → upsert（幂等）→ 可选推送。 */
  runFor(weekStart?: string, options?: { push?: boolean }): Promise<ReportHistoryRow>;
  /** 本周实时数据（不落库；/report 页「本周速览」用）。 */
  current(): Promise<{ weekStart: string; weekEnd: string; data: WeeklyReportData; markdown: string }>;
  history(limit?: number): ReportHistoryRow[];
  get(id: number): ReportHistoryRow | undefined;
  /** 调度 tick：过点且未生成本周报告 → 生成推送。返回本轮是否触发生成。 */
  tick(): Promise<boolean>;
  start(): void;
  stop(): void;
}

/** 本地时区周一 YYYY-MM-DD（ms 时刻所属周的周一）。 */
export function weekStartOf(ms: number): string {
  const d = new Date(ms);
  const shift = (d.getDay() + 6) % 7; // 周日→6，周一→0
  d.setDate(d.getDate() - shift);
  return localDateKey(d.getTime());
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const shifted = new Date(base + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayCost(day: { estimatedCostUsd: number | null; actualCostUsd: number | null }): number | null {
  if (day.actualCostUsd !== null && day.actualCostUsd > 0) return day.actualCostUsd;
  if (day.estimatedCostUsd !== null && day.estimatedCostUsd > 0) return day.estimatedCostUsd;
  return day.actualCostUsd ?? day.estimatedCostUsd;
}

function money(usd: number | null): string {
  return usd === null ? "—" : `$${usd.toFixed(2)}`;
}

/** 周一 08:00（默认）本地时刻的 ms。 */
function dueMs(nowMs: number, schedule: Required<WeeklyReportSchedule>): number {
  const d = new Date(nowMs);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift); // 本周一 00:00
  d.setHours(schedule.hour, schedule.minute, 0, 0);
  return d.getTime();
}

export function createWeeklyReportService(options: WeeklyReportServiceOptions): WeeklyReportService {
  const now = options.now ?? (() => Date.now());
  const driver = options.driver ?? defaultTimerDriver;
  const schedule: Required<WeeklyReportSchedule> = {
    day: options.schedule?.day ?? 1,
    hour: options.schedule?.hour ?? 8,
    minute: options.schedule?.minute ?? 0,
  };
  const pushEnabled = options.pushEnabled ?? true;
  let timer: unknown = null;
  let stopped = true;

  async function assemble(weekStart: string): Promise<WeeklyReportData> {
    const weekEnd = addDaysIso(weekStart, 6);
    const generatedAt = new Date(now()).toISOString();

    // 成本：14 天视图按周界切片（本周 = [weekStart, weekStart+7)，上周 = [weekStart-7, weekStart)）。
    const summary: CostSummaryView | null = await options.llmUsage.costSummary(14).catch(() => null);
    const thisFrom = weekStart;
    const lastFrom = addDaysIso(weekStart, -7);
    let thisWeekUsd: number | null = null;
    let lastWeekUsd: number | null = null;
    if (summary !== null && summary.costAvailable) {
      const sumRange = (from: string, to: string): number | null => {
        let total: number | null = null;
        for (const day of summary.days) {
          if (day.date < from || day.date >= to) continue;
          const value = dayCost(day);
          if (value === null) continue;
          total = (total ?? 0) + value;
        }
        return total;
      };
      thisWeekUsd = sumRange(thisFrom, addDaysIso(weekStart, 7));
      lastWeekUsd = sumRange(lastFrom, weekStart);
    }
    const deltaPct =
      thisWeekUsd !== null && lastWeekUsd !== null && lastWeekUsd > 0
        ? Math.round(((thisWeekUsd - lastWeekUsd) / lastWeekUsd) * 1000) / 10
        : null;
    let monthSpentUsd: number | null = null;
    try {
      const month = await options.llmUsage.monthToDateCost();
      monthSpentUsd = month === null ? null : (month.actualUsd ?? month.estimatedUsd);
    } catch {
      monthSpentUsd = null;
    }

    // 实例状态（内核记录为唯一事实来源）。
    const instances = options.store.listInstances();
    const byState: Record<string, number> = {};
    for (const record of instances) {
      const key = record.state || "Unknown";
      byState[key] = (byState[key] ?? 0) + 1;
    }

    // 事件中心：活跃事件 TOP5（critical 优先）。
    const activeEvents = options.trustEvents.list({ limit: 50 }).filter((e) => e.status === "active" || e.status === "regressed");

    // 审计摘要（168h = 7 天）。
    const auditSummary = options.auditCollector?.summary(168) ?? null;

    // 进度可信度（M3.3）：7 天窗口。
    const progressSummary = options.progress?.summary(7) ?? null;

    // 记忆变更（M4.3）：本周它记住了什么。
    const memoryView = options.memoryDiff?.diff(7) ?? null;

    // 技能用量 TOP5。
    const skillUsage = await options.skillAssets.usage(7, "week").catch(() => null);

    // 备份：最近一次全量。
    const fullBackups = options.backup.list("full");
    const lastFull = fullBackups[0] ?? null;

    return {
      weekStart,
      weekEnd,
      generatedAt,
      cost: {
        available: summary?.costAvailable ?? false,
        thisWeekUsd,
        lastWeekUsd,
        deltaPct,
        monthlyBudgetUsd: options.monthlyBudgetUsd > 0 ? options.monthlyBudgetUsd : null,
        monthSpentUsd,
        topModel: summary?.models[0]?.model ?? null,
        topSessions: (summary?.sessions ?? []).slice(0, 3).map((s) => ({
          sessionId: s.sessionId,
          model: s.model,
          costUsd: s.actualCostUsd ?? s.estimatedCostUsd,
        })),
      },
      instances: {
        total: instances.length,
        serving: byState["Serving"] ?? 0,
        degraded: byState["Degraded"] ?? 0,
        stopped: (byState["Stopped"] ?? 0) + (byState["Offline"] ?? 0) + (byState["New"] ?? 0),
        byState,
      },
      events: {
        active: activeEvents.length,
        critical: activeEvents.filter((e) => e.severity === "critical").length,
        top: activeEvents.slice(0, 5).map((e) => ({
          kind: e.kind,
          severity: e.severity,
          title: e.title.slice(0, 60),
          count: e.count,
          lastSeen: e.lastSeen,
        })),
      },
      audit: {
        enabled: options.auditCollector !== undefined,
        windowHours: 168,
        total: auditSummary?.total ?? 0,
        highRisk: auditSummary?.highRisk ?? 0,
        byKind: auditSummary?.byKind ?? {},
      },
      progress: {
        enabled: options.progress !== undefined,
        windowDays: 7,
        total: progressSummary?.total ?? 0,
        verified: progressSummary?.verified ?? 0,
        suspect: progressSummary?.suspect ?? 0,
        unverifiable: progressSummary?.unverifiable ?? 0,
        trustRate: progressSummary?.trustRate ?? null,
        suspectSessions: (progressSummary?.suspectSessions ?? []).map((row) => ({
          sessionId: row.sessionId,
          maxSuspectStreak: row.maxSuspectStreak,
          trustRate: row.trustRate,
        })),
      },
      memory: {
        enabled: options.memoryDiff !== undefined,
        added: memoryView?.summary.added ?? 0,
        modified: memoryView?.summary.modified ?? 0,
        forgotten: memoryView?.summary.forgotten ?? 0,
        top: (memoryView?.top ?? []).map((entry) => ({
          path: entry.path,
          change: entry.change,
          writes: entry.writes,
          deletes: entry.deletes,
        })),
      },
      skills: {
        top: (skillUsage?.skills ?? [])
          .slice()
          .sort((a, b) => b.calls - a.calls)
          .slice(0, 5)
          .map((s) => ({ name: s.name, calls: s.calls, successRate: s.successRate })),
      },
      backups: {
        lastFullAt: lastFull === null ? null : String(lastFull["createdAt"] ?? ""),
        count: fullBackups.length,
      },
    };
  }

  function renderMarkdown(data: WeeklyReportData): string {
    const lines: string[] = [];
    const range = `${data.weekStart} ~ ${data.weekEnd}`;
    lines.push(`# Agent 周报（${range}）`);
    lines.push("");
    lines.push("## 成本");
    if (data.cost.available) {
      const delta =
        data.cost.deltaPct === null ? "" : `（上周 ${money(data.cost.lastWeekUsd)}，${data.cost.deltaPct >= 0 ? "+" : ""}${data.cost.deltaPct}%）`;
      lines.push(`本周 ${money(data.cost.thisWeekUsd)}${delta}`);
    } else {
      lines.push("成本数据待接入（Hermes 侧成本列尚未可用，本期不显示金额）");
    }
    if (data.cost.monthlyBudgetUsd !== null && data.cost.monthSpentUsd !== null) {
      const pct = Math.round((data.cost.monthSpentUsd / data.cost.monthlyBudgetUsd) * 100);
      lines.push(`月度预算 ${money(data.cost.monthlyBudgetUsd)} 已用 ${money(data.cost.monthSpentUsd)}（${pct}%）`);
    }
    if (data.cost.topSessions.length > 0) {
      lines.push(
        `最贵会话：${data.cost.topSessions
          .map((s) => `${s.sessionId}（${money(s.costUsd)}）`)
          .join("、")}`,
      );
    }
    lines.push("");
    lines.push("## 实例");
    if (data.instances.total === 0) {
      lines.push("无注册实例");
    } else {
      lines.push(
        `${data.instances.total} 个实例：Serving ${data.instances.serving} / Degraded ${data.instances.degraded} / 其他 ${data.instances.stopped}`,
      );
    }
    lines.push("");
    lines.push("## 事件中心");
    if (data.events.active === 0) {
      lines.push("本周无活跃事件 ✅");
    } else {
      lines.push(`活跃事件 ${data.events.active} 个（critical ${data.events.critical} 个）：`);
      for (const event of data.events.top) {
        lines.push(`- [${event.severity}] ${event.title}（${event.kind}，累计 ${event.count} 次）`);
      }
    }
    lines.push("");
    lines.push("## 行为审计（7 天）");
    if (!data.audit.enabled) {
      lines.push("审计采集器未启用（BUTLER_AUDIT_ENABLED）");
    } else if (data.audit.total === 0) {
      lines.push("窗口内无动作记录");
    } else {
      const byKind = Object.entries(data.audit.byKind)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(" / ");
      lines.push(`动作 ${data.audit.total} 次，高危 ${data.audit.highRisk} 次（${byKind}）`);
    }
    lines.push("");
    lines.push("## 本周它记住了什么（TOP5）");
    if (!data.memory.enabled) {
      lines.push("记忆变更视图未启用");
    } else if (data.memory.top.length === 0) {
      lines.push("本周观测到 agent 没有改动记忆类文件");
    } else {
      lines.push(`新增 ${data.memory.added} 个 / 修改 ${data.memory.modified} 个 / 遗忘 ${data.memory.forgotten} 个`);
      data.memory.top.forEach((entry) => {
        const verb = entry.change === "added" ? "新增" : entry.change === "forgotten" ? "遗忘" : "修改";
        lines.push(`- ${verb} ${entry.path}（写 ${entry.writes} / 删 ${entry.deletes}）`);
      });
    }
    lines.push("");
    lines.push("## 进度可信度（7 天）");
    if (!data.progress.enabled) {
      lines.push("进度检测未启用（BUTLER_PROGRESS_INTEGRITY_ENABLED=false）");
    } else if (data.progress.verified + data.progress.suspect === 0) {
      lines.push(
        data.progress.unverifiable > 0
          ? `本周无可核实的进度声明（${data.progress.unverifiable} 条无法验证——日志缺少会话归属或该会话无可观测动作）`
          : "本周没有进度声明记录",
      );
    } else {
      lines.push(
        `进度可信度 ${Math.round((data.progress.trustRate ?? 0) * 100)}%` +
          `（有实际动作佐证 ${data.progress.verified} 条 / 无动作佐证 ${data.progress.suspect} 条）`,
      );
      if (data.progress.unverifiable > 0) {
        lines.push(`另有 ${data.progress.unverifiable} 条无法验证（已单列，不计入可信度分母）`);
      }
      if (data.progress.suspectSessions.length > 0) {
        lines.push("需要点名的会话（连续 3 次以上声明进度但无实际动作）：");
        data.progress.suspectSessions.forEach((row) => {
          lines.push(`- ${row.sessionId}（最长连续 ${row.maxSuspectStreak} 次）`);
        });
      }
    }
    lines.push("");
    lines.push("## 技能使用 TOP5（7 天）");
    if (data.skills.top.length === 0) {
      lines.push("窗口内无技能调用记录");
    } else {
      data.skills.top.forEach((skill, index) => {
        const rate = skill.successRate === null ? "" : `，成功率 ${(skill.successRate * 100).toFixed(0)}%`;
        lines.push(`${index + 1}. ${skill.name} — ${skill.calls} 次${rate}`);
      });
    }
    lines.push("");
    lines.push("## 备份");
    if (data.backups.count === 0) {
      lines.push("⚠️ 尚无全量快照");
    } else {
      lines.push(`最近全量：${data.backups.lastFullAt || "时间未知"}（累计 ${data.backups.count} 份）`);
    }
    lines.push("");
    lines.push(`_生成于 ${data.generatedAt}（Agent Butler 信任层 · 零 LLM 组装）_`);
    return lines.join("\n");
  }

  async function push(row: ReportHistoryRow, data: WeeklyReportData): Promise<void> {
    try {
      await options.poster.post({
        kind: "weekly-report",
        severity: "info",
        title: `Agent 周报（${data.weekStart} ~ ${data.weekEnd}）`,
        body: row.markdown,
        source: "butler-watch",
        dedupeKey: `weekly-report:${row.weekStart}`,
      });
      options.store.markReportSent(row.id, new Date(now()).toISOString());
    } catch (error) {
      options.store.markReportSendFailed(row.id);
      options.audit?.append({
        actor: "weekly-report",
        action: "weekly-report-send-failed",
        target: row.weekStart,
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const service: WeeklyReportService = {
    async runFor(weekStart, runOptions) {
      const start = weekStart ?? weekStartOf(now());
      const data = await assemble(start);
      const markdown = renderMarkdown(data);
      const row = options.store.upsertReport({
        weekStart: data.weekStart,
        weekEnd: data.weekEnd,
        status: "generated",
        markdown,
        data,
        at: new Date(now()).toISOString(),
      });
      options.audit?.append({
        actor: "weekly-report",
        action: "weekly-report-generated",
        target: data.weekStart,
        detail: { costAvailable: data.cost.available, events: data.events.active },
      });
      if (runOptions?.push === true && pushEnabled) {
        await push(row, data);
        return options.store.getReportByWeek(row.weekStart) ?? row;
      }
      return row;
    },

    async current() {
      const weekStart = weekStartOf(now());
      const data = await assemble(weekStart);
      return { weekStart, weekEnd: data.weekEnd, data, markdown: renderMarkdown(data) };
    },

    history(limit) {
      return options.store.listReports(limit ?? 12);
    },

    get(id) {
      return options.store.getReport(id);
    },

    async tick() {
      const nowMs = now();
      const due = dueMs(nowMs, schedule);
      if (nowMs < due) return false;
      const weekStart = weekStartOf(nowMs);
      const existing = options.store.getReportByWeek(weekStart);
      if (existing !== undefined && Date.parse(existing.createdAt) >= due) return false;
      await service.runFor(weekStart, { push: true });
      return true;
    },

    start() {
      if (!stopped) return;
      stopped = false;
      const intervalMs = Math.max(60_000, options.intervalMs ?? 15 * 60 * 1000);
      timer = driver.setInterval(() => void service.tick().catch(() => undefined), intervalMs);
      // 启动后错峰 10s 先跑一轮（覆盖「服务重启错过周一 08:00」的场景）；全局定时器，stop 后静默。
      setTimeout(() => {
        if (!stopped) void service.tick().catch(() => undefined);
      }, 10_000).unref?.();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) driver.clearInterval(timer);
      timer = null;
    },
  };

  return service;
}
