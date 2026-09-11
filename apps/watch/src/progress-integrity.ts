/**
 * 假进度检测（M3.3）——差异化王牌。
 *
 * 用户故事：agent 说「已完成 65%」时，我想知道它是真的在做还是编的。
 * 这是 OpenClaw 流失访谈里最诛心的信任崩塌点，也是全市场空白。
 *
 * 判定逻辑全部确定性、零 LLM：
 * 1. **过程证据核实**：从 Hermes 执行日志增量提取「进度声明」，再看同会话在
 *    [上一条声明, 本条声明] 窗口内是否产生过真实副作用动作（写文件/删文件/执行命令/
 *    调接口/发消息/抓页面）。有 → `verified`；观测得到但窗口内为空 → `suspect`。
 * 2. **连续 suspect**：同一会话连续 ≥ `SUSPECT_STREAK_THRESHOLD` 次无副作用声明 →
 *    会话级事件 `progress-untrusted`（warn）。
 * 3. **会话级假完成**：会话终结为 ok（声称完成）但全程零副作用动作 →
 *    `unverified-completion` 事件（warn）——「说做完了但什么都没留下」。
 *
 * 边界诚实（不可妥协）：归属不到会话的声明、或该会话根本没有任何可观测动作时，
 * 一律判为 `unverifiable`（显式「无法验证」），**绝不猜测**——检测工具本身不能制造
 * 新的信任问题。同理，本模块只读动作元数据，不采集对话正文。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ActionEventRow, AuditLog, ProgressClaimRow, ProgressVerdict, SqliteStore } from "@butler/core";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";
import type { TrustEventHub } from "./trust-events.js";
import type { AlertPoster } from "./alert-forward.js";

/** 产生真实副作用的动作类型（raw = 降级原始行，不构成证据）。 */
export const SIDE_EFFECT_KINDS: readonly ActionEventRow["kind"][] = [
  "file-write",
  "file-delete",
  "shell-exec",
  "api-call",
  "message-send",
  "web-fetch",
];

/** 连续无副作用声明达到该次数 → 会话标记「进度不可信」。 */
export const SUSPECT_STREAK_THRESHOLD = 3;
/** 采集间隔：与行为审计同频（15s）。 */
export const PROGRESS_SCAN_INTERVAL_MS = 15_000;
export const PROGRESS_RETENTION_MIN_DAYS = 7;
export const PROGRESS_RETENTION_MAX_DAYS = 90;
export const PROGRESS_RETENTION_DEFAULT_DAYS = 30;

/** 日志行的会话归属（Hermes 日志里常见的几种写法）。 */
const SESSION_PATTERNS: readonly RegExp[] = [
  /\bsession[_-]?id["'\s:=]+([A-Za-z0-9._:-]{6,})/i,
  /\bsession["'\s:=]+([A-Za-z0-9._:-]{6,})/i,
];
/** 无法归属时的占位会话标识（显式标记，不并入任何真实会话）。 */
export const UNATTRIBUTED_SESSION = "(unattributed)";

/**
 * 进度声明模式：**必须**带明确的进度语汇，避免把日志里的裸百分数（如 token 占比、
 * 磁盘用量）误判成进度声明——这是控制误报率的关键。
 */
const CLAIM_PATTERNS: readonly { re: RegExp; group: number; hasPct: boolean }[] = [
  { re: /(?:完成|进度|progress|completed?)\s*(?:到|至|:)?\s*(\d{1,3})\s*%/i, group: 1, hasPct: true },
  { re: /(\d{1,3})\s*%\s*(?:完成|done|complete[d]?|finished)/i, group: 1, hasPct: true },
  { re: /(?:已完成|进度完成|任务完成|task\s+complete[d]?)/i, group: 0, hasPct: false },
];

export interface ProgressClaimView {
  id: number;
  sessionId: string;
  ts: string;
  claimedPct: number | null;
  claimText: string;
  sideEffectCount: number;
  sideEffectKinds: string[];
  verdict: ProgressVerdict;
  reason: string | null;
}

export interface SessionProgressView {
  sessionId: string;
  total: number;
  verified: number;
  suspect: number;
  unverifiable: number;
  maxSuspectStreak: number;
  lastClaimAt: string;
  /** 进度可信度 = verified / (total - unverifiable)；无法计算时 null（不臆造）。 */
  trustRate: number | null;
}

export interface ProgressSummary {
  windowDays: number;
  total: number;
  verified: number;
  suspect: number;
  unverifiable: number;
  /** 全局进度可信度 = verified / (verified + suspect)；无有效样本时 null。 */
  trustRate: number | null;
  /** 连续 suspect 会话（周报异常清单点名用）。 */
  suspectSessions: SessionProgressView[];
  lastScanAt: string | null;
  sources: Array<{ path: string; parsedBytes: number; lastParsedAt: string | null }>;
  mode: "scanning" | "no-sources";
}

export interface ProgressIntegrityService {
  start(): void;
  stop(): void;
  /** 手动驱动一轮增量采集（测试 / 手动刷新）。 */
  tick(): void;
  /** 会话内进度声明（会话时间线 ✓/？ 标记的数据来源）。 */
  claims(filter: { sessionId?: string; verdict?: ProgressVerdict; windowDays?: number; limit?: number }): ProgressClaimView[];
  sessionProgress(sessionId: string): SessionProgressView | null;
  summary(windowDays: number): ProgressSummary;
  /** 超保留期清理。 */
  prune(): number;
}

export interface ProgressIntegrityOptions {
  store: SqliteStore;
  trustEvents: TrustEventHub;
  audit?: AuditLog;
  poster?: AlertPoster;
  /** 待解析的日志文件绝对路径（与行为审计同源）。 */
  logPaths: string[];
  retentionDays?: number;
  now?: () => number;
  driver?: TimerDriver;
  intervalMs?: number;
  /** 注入文件大小 / 片段读取（测试）；缺省 fstatSync + readSync。 */
  fileSize?: (path: string) => number;
  readChunk?: (path: string, start: number, end: number) => string;
}

/* ------------------------------ 纯函数（可独立测试） ------------------------------ */

/** 从一行日志提取进度声明；无明确进度语汇返回 null（宁漏不误报）。 */
export function parseProgressClaim(line: string): { pct: number | null; text: string } | null {
  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.re.exec(line);
    if (match === null) continue;
    let pct: number | null = null;
    if (pattern.hasPct) {
      const raw = match[pattern.group];
      if (raw === undefined) continue;
      const parsed = Number(raw);
      // 百分比必须落在 0-100；越界视为误匹配（如版本号 1.2.300%）。
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) continue;
      pct = parsed;
    }
    return { pct, text: scrub(line).slice(0, 200) };
  }
  return null;
}

/** 提取日志行的会话归属；取不到返回 null（不猜）。 */
export function parseSessionId(line: string): string | null {
  for (const pattern of SESSION_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined && match[1].trim() !== "") return match[1].trim();
  }
  return null;
}

/** 凭据脱敏（与行为审计同一规则集，绝不把密钥写进声明文本）。 */
function scrub(text: string): string {
  return text
    .replace(/\b(?:sk|pk)-[A-Za-z0-9._-]{8,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/(?:access_token|api[_-]?key|token|password|secret)[=:]\s*[^\s&"',;]{6,}/gi, "$1=***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
}

/**
 * 核实结论：给定窗口内的副作用动作情况与会话可观测性。
 * - 窗口内有副作用 → verified
 * - 会话可观测（有过动作）但窗口内为空 → suspect
 * - 会话不可观测（无任何动作）→ unverifiable（显式「无法验证」）
 */
export function verdictOf(input: {
  sideEffectCount: number;
  sessionObservable: boolean;
  attributed: boolean;
}): { verdict: ProgressVerdict; reason: string } {
  if (!input.attributed) {
    return { verdict: "unverifiable", reason: "日志行未附带会话标识，无法归属核实" };
  }
  if (input.sideEffectCount > 0) {
    return { verdict: "verified", reason: `声明窗口内产生 ${input.sideEffectCount} 个副作用动作` };
  }
  if (!input.sessionObservable) {
    return { verdict: "unverifiable", reason: "该会话没有任何可观测动作记录，无法核实（不猜测）" };
  }
  return { verdict: "suspect", reason: "声明窗口内没有任何真实副作用动作" };
}

/* --------------------------------- 服务 --------------------------------- */

export function createProgressIntegrityService(
  options: ProgressIntegrityOptions,
): ProgressIntegrityService {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const driver = options.driver ?? defaultTimerDriver;
  const intervalMs = Math.max(5_000, Math.floor(options.intervalMs ?? PROGRESS_SCAN_INTERVAL_MS));
  const retentionDays = Math.max(
    PROGRESS_RETENTION_MIN_DAYS,
    Math.min(
      PROGRESS_RETENTION_MAX_DAYS,
      Math.floor(options.retentionDays ?? PROGRESS_RETENTION_DEFAULT_DAYS),
    ),
  );

  const sources = options.logPaths
    .filter((path) => path.trim() !== "")
    .map((path) => ({
      path,
      parsedBytes: 0,
      lastParsedAt: null as string | null,
      /** 启动时对齐文件末尾：只采增量，不全量重扫。 */
      initialized: false,
    }));

  const fileSize =
    options.fileSize ??
    ((path: string): number => {
      try {
        const fd = openSync(path, "r");
        try {
          return fstatSync(fd).size;
        } finally {
          closeSync(fd);
        }
      } catch {
        return -1;
      }
    });

  const readChunk =
    options.readChunk ??
    ((path: string, start: number, end: number): string => {
      const fd = openSync(path, "r");
      try {
        const length = Math.max(0, end - start);
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, start);
        return buffer.toString("utf8", 0, read);
      } finally {
        closeSync(fd);
      }
    });

  let handle: unknown = null;
  let running = false;
  let lastScanAt: string | null = null;
  /** 每会话「上一条声明时刻」：作为下一条声明的核实窗口起点。 */
  const lastClaimTs = new Map<string, string>();
  /** 每会话连续 suspect 计数（用于阈值事件，避免重复推送）。 */
  const suspectStreak = new Map<string, number>();
  /** 已经推送过 unverified-completion 的会话，防止重复。 */
  const completionFlagged = new Set<string>();

  function sideEffectsIn(sessionId: string, since: string, until: string): ActionEventRow[] {
    return store
      .listActionEvents({ sessionId, since, until, limit: 500 })
      .filter((row) => SIDE_EFFECT_KINDS.includes(row.kind));
  }

  /** 会话是否「可观测」：有过任意动作记录（有动作才有核实能力）。 */
  function sessionObservable(sessionId: string): boolean {
    return store.listActionEvents({ sessionId, limit: 1 }).length > 0;
  }

  function recordClaim(input: {
    sessionId: string;
    attributed: boolean;
    ts: string;
    pct: number | null;
    text: string;
  }): boolean {
    const windowStart = lastClaimTs.get(input.sessionId) ?? new Date(0).toISOString();
    const effects = input.attributed ? sideEffectsIn(input.sessionId, windowStart, input.ts) : [];
    const observable = input.attributed ? sessionObservable(input.sessionId) : false;
    const { verdict, reason } = verdictOf({
      sideEffectCount: effects.length,
      sessionObservable: observable,
      attributed: input.attributed,
    });

    const inserted = store.insertProgressClaim({
      sessionId: input.sessionId,
      ts: input.ts,
      claimedPct: input.pct,
      claimText: input.text,
      sideEffectCount: effects.length,
      sideEffectKinds: Array.from(new Set(effects.map((row) => row.kind))),
      verdict,
      reason,
      at: iso(),
    });
    if (!inserted) return false;

    lastClaimTs.set(input.sessionId, input.ts);

    // 连续 suspect 阈值 → 会话级事件（每个会话只推一次，靠 dedupeKey 幂等）。
    if (verdict === "suspect" && input.attributed) {
      const streak = (suspectStreak.get(input.sessionId) ?? 0) + 1;
      suspectStreak.set(input.sessionId, streak);
      if (streak >= SUSPECT_STREAK_THRESHOLD) {
        options.trustEvents.record({
          kind: "progress-untrusted",
          severity: "warn",
          title: `会话 ${input.sessionId} 连续 ${streak} 次声明进度但无实际动作`,
          evidence: [{ sessionId: input.sessionId, streak, lastClaimAt: input.ts }],
          relatedIds: [input.sessionId],
          dedupeKey: `progress-untrusted:${input.sessionId}`,
        });
        options.poster?.post({
          kind: "progress-integrity",
          severity: "warn",
          title: `进度声明缺少实际动作：${input.sessionId}`,
          body: `该会话连续 ${streak} 次声明进度，但期间没有任何写文件/执行命令/调接口等真实动作。建议打开会话时间线核对它到底做了什么。`,
          source: "butler-watch",
          dedupeKey: `progress-untrusted:${input.sessionId}`,
        });
      }
    } else if (verdict === "verified" && input.attributed) {
      suspectStreak.set(input.sessionId, 0);
    }
    return true;
  }

  /**
   * 会话级假完成检测：终态 ok 但全程零副作用动作 → unverified-completion。
   * 只对「可观测到会话元数据」的会话生效；索引里没有的会话不做推断。
   */
  function detectUnverifiedCompletions(): void {
    const since = new Date(now() - retentionDays * 86_400_000).toISOString();
    const sessions = store.listSessionIndex({ outcome: "ok", since, limit: 500 });
    for (const session of sessions) {
      if (completionFlagged.has(session.sessionId)) continue;
      const effects = sideEffectsIn(session.sessionId, new Date(0).toISOString(), iso());
      if (effects.length > 0) continue;
      // 零副作用 + 声称完成。若该会话压根没有任何动作记录，则属于「不可观测」，
      // 同样值得提示但要如实区分措辞。
      const observable = sessionObservable(session.sessionId);
      completionFlagged.add(session.sessionId);
      options.trustEvents.record({
        kind: "unverified-completion",
        severity: "warn",
        title: `会话 ${session.sessionId} 声称完成，但没有任何产出动作`,
        evidence: [
          {
            sessionId: session.sessionId,
            outcome: session.outcome,
            actionCount: session.actionCount,
            observable,
            note: observable
              ? "会话内存在动作记录但无副作用动作"
              : "会话内无任何动作记录，产出情况无法核实",
          },
        ],
        relatedIds: [session.sessionId],
        dedupeKey: `unverified-completion:${session.sessionId}`,
      });
    }
  }

  function tick(): void {
    const atMs = now();
    const at = new Date(atMs).toISOString();
    for (const source of sources) {
      const size = fileSize(source.path);
      if (size < 0) continue;
      if (!source.initialized) {
        source.parsedBytes = size;
        source.initialized = true;
        source.lastParsedAt = at;
        continue;
      }
      if (size <= source.parsedBytes) {
        if (size < source.parsedBytes) source.parsedBytes = size;
        continue;
      }
      let chunk: string;
      try {
        chunk = readChunk(source.path, source.parsedBytes, size);
      } catch {
        continue;
      }
      source.parsedBytes = size;
      source.lastParsedAt = at;
      for (const rawLine of chunk.split("\n")) {
        const line = rawLine.trim();
        if (line === "") continue;
        const claim = parseProgressClaim(line);
        if (claim === null) continue;
        const sessionId = parseSessionId(line);
        recordClaim({
          sessionId: sessionId ?? UNATTRIBUTED_SESSION,
          attributed: sessionId !== null,
          ts: at,
          pct: claim.pct,
          text: claim.text,
        });
      }
    }
    detectUnverifiedCompletions();
    lastScanAt = new Date(now()).toISOString();
  }

  function toClaimView(row: ProgressClaimRow): ProgressClaimView {
    return {
      id: row.id,
      sessionId: row.sessionId,
      ts: row.ts,
      claimedPct: row.claimedPct,
      claimText: row.claimText,
      sideEffectCount: row.sideEffectCount,
      sideEffectKinds: safeArray(row.sideEffectKindsJson),
      verdict: row.verdict,
      reason: row.reason,
    };
  }

  function sessionProgress(sessionId: string): SessionProgressView | null {
    const rows = store.listProgressClaims({ sessionId, limit: 5000 });
    if (rows.length === 0) return null;
    const verified = rows.filter((row) => row.verdict === "verified").length;
    const suspect = rows.filter((row) => row.verdict === "suspect").length;
    const unverifiable = rows.filter((row) => row.verdict === "unverifiable").length;
    let streak = 0;
    let maxStreak = 0;
    for (const row of rows) {
      if (row.verdict === "suspect") {
        streak += 1;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        streak = 0;
      }
    }
    const denom = verified + suspect;
    return {
      sessionId,
      total: rows.length,
      verified,
      suspect,
      unverifiable,
      maxSuspectStreak: maxStreak,
      lastClaimAt: rows[rows.length - 1]!.ts,
      trustRate: denom === 0 ? null : verified / denom,
    };
  }

  function summary(windowDays: number): ProgressSummary {
    const days = Math.max(1, Math.min(PROGRESS_RETENTION_MAX_DAYS, Math.floor(windowDays)));
    const since = new Date(now() - days * 86_400_000).toISOString();
    const counts = store.countProgressClaims(since);
    const bySession = store.aggregateProgressBySession(since);
    const denom = counts.verified + counts.suspect;
    return {
      windowDays: days,
      total: counts.total,
      verified: counts.verified,
      suspect: counts.suspect,
      unverifiable: counts.unverifiable,
      trustRate: denom === 0 ? null : counts.verified / denom,
      suspectSessions: bySession
        .filter((row) => row.maxSuspectStreak >= SUSPECT_STREAK_THRESHOLD)
        .sort((a, b) => b.maxSuspectStreak - a.maxSuspectStreak)
        .slice(0, 10)
        .map((row) => {
          const sessionDenom = row.verified + row.suspect;
          return {
            ...row,
            trustRate: sessionDenom === 0 ? null : row.verified / sessionDenom,
          };
        }),
      lastScanAt,
      sources: sources.map((source) => ({
        path: source.path,
        parsedBytes: source.parsedBytes,
        lastParsedAt: source.lastParsedAt,
      })),
      mode: sources.length === 0 ? "no-sources" : "scanning",
    };
  }

  return {
    tick,
    claims(filter = {}) {
      const windowDays = Math.max(1, Math.min(PROGRESS_RETENTION_MAX_DAYS, Math.floor(filter.windowDays ?? 7)));
      const since = new Date(now() - windowDays * 86_400_000).toISOString();
      return store
        .listProgressClaims({
          ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
          ...(filter.verdict === undefined ? {} : { verdict: filter.verdict }),
          since,
          ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        })
        .map(toClaimView);
    },
    sessionProgress,
    summary,
    prune() {
      const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString();
      return store.pruneProgressClaims(cutoff);
    },
    start() {
      if (running) return;
      running = true;
      tick();
      handle = driver.setInterval(() => {
        try {
          tick();
        } catch {
          /* 单轮异常不终止循环 */
        }
      }, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      if (handle !== null) driver.clearInterval(handle);
      handle = null;
    },
  };
}

function safeArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
