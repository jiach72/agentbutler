/**
 * 错误指纹引擎（FingerprintEngine）：归一化 → 签名 → 锚定式突发窗口聚合。
 *
 * 流水线：错误行过滤（可注入 isError）→ normalize 去时间戳/路径/数值等易变
 * 成分得到错误模板 → sha256 前 16 hex 作为 signature → 5 分钟窗口聚合。
 *
 * 窗口语义（锚定式）：每签名维护 { startedAt, count }；新错误行 ts 与窗口
 * 起点差 < windowMs 计入当前窗口（仅 upsertFingerprint 递增计数，不产生新
 * 事件）；超窗或 close() 关闭旧窗口（写 fingerprint_windows），开启新窗口
 * 时 emit 恰好一个 fingerprint-aggregated 事件 —— 60 条同模板错误聚合为
 * 1 个事件。
 *
 * 告警与升级：首见签名 alert=true（新指纹待告警）；已知模式复现 alert=false
 * （只记档）；本窗计数首次超过上一已关闭窗口 2 倍且上窗 >= 3 条时 emit
 * fingerprint-escalated（整窗仅一次）。
 *
 * fingerprints.status：首见 'open'；窗口关闭后 'known'（已知自愈判定依据）；
 * 再次开启活跃窗口时回到 'open'。
 */
import { createHash } from "node:crypto";
import type { LogSource } from "@butler/contract";
import type { EventBus } from "./events.js";
import type { SqliteStore } from "./store.js";

/** 引擎输入行（与 tail.ts 的 TailedLine 对齐，仅取必要字段）。 */
export interface FingerprintLineInput {
  source: LogSource;
  raw: string;
  ts?: string;
}

export type IsErrorPredicate = (line: FingerprintLineInput) => boolean;

export interface FingerprintEngineOptions {
  store: SqliteStore;
  bus: EventBus;
  /** 聚合窗口时长（毫秒），默认 5 分钟。 */
  windowMs?: number;
  /** 错误行判定，可注入替换；缺省用 defaultIsError。 */
  isError?: IsErrorPredicate;
}

/** text 格式错误行关键词（不区分大小写，⚠ 为 Hermes 实际输出）。 */
const ERROR_TEXT_RE = /error|fail|exception|traceback|fatal|warn|⚠/i;

/** jsonl 级别字段（level/severity）的错误判定值。 */
const ERROR_LEVELS = new Set(["error", "warn", "warning", "fatal"]);

/** 默认错误行判定：text 按关键词；jsonl 解析后按 level/severity 字段。 */
export function defaultIsError(line: FingerprintLineInput): boolean {
  if (line.source.format === "jsonl") {
    try {
      const parsed = JSON.parse(line.raw) as Record<string, unknown>;
      const level = parsed["level"] ?? parsed["severity"];
      if (typeof level === "string") return ERROR_LEVELS.has(level.toLowerCase());
      return false; // jsonl 解析成功但无级别字段 → 非错误行
    } catch {
      // 非 JSON 行退回 text 关键词判定
    }
  }
  return ERROR_TEXT_RE.test(line.raw);
}

/** 错误模板归一化：去时间戳/UUID/路径/十六进制/数值，多空白折叠。 */
export function normalizeErrorLine(raw: string): string {
  let s = raw;
  // ISO8601 与 [YYYY-MM-DD HH:MM:SS] / YYYY-MM-DD HH:MM:SS（含毫秒与时区）
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>");
  // 独立 HH:MM:SS(.fff)
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<TS>");
  // UUID（先于路径/十六进制/数字，避免被拆成碎片）
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
  // Unix / Windows 文件路径：组件允许字母数字与 . - _ : + 空格（空格需后随路径字符，
  // 兼容 "Agent Butler" 类目录），遇引号/括号等标点停止
  s = s.replace(/(?:[A-Za-z]:)?[/\\](?:[\w./\\:+-]| (?=[\w./\\:+-]))*/g, "<PATH>");
  // 十六进制串（0x 前缀或 6 位以上连续 hex）
  s = s.replace(/\b(?:0x)?[0-9a-f]{6,}\b/gi, "<HEX>");
  // 纯数字（含小数/百分比）
  s = s.replace(/\b\d+(?:\.\d+)?%?\b/g, "<NUM>");
  return s.replace(/\s+/g, " ").trim();
}

/** 签名：sha256(归一化模板) 前 16 hex。 */
export function signatureOf(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** 内存中的活跃窗口状态。 */
interface WindowState {
  startedAtMs: number;
  count: number;
  /** 上一已关闭窗口计数（升级判定基准）。 */
  prevClosedCount: number;
  /** 本窗是否已 emit fingerprint-escalated（整窗仅一次）。 */
  escalatedEmitted: boolean;
}

/** 行 ts 解析：ISO 字符串 / epoch（秒或毫秒）/ 解析失败回退当前时间。 */
function parseTsMs(raw?: string): number {
  if (raw !== undefined) {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n < 1e12 ? n * 1000 : n;
    }
    const t = new Date(raw).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class FingerprintEngine {
  private store: SqliteStore;
  private bus: EventBus;
  private windowMs: number;
  private isError: IsErrorPredicate;
  /** signature → 活跃窗口（未关闭窗口仅存内存，close() 冲刷落库）。 */
  private windows = new Map<string, WindowState>();

  constructor(options: FingerprintEngineOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.windowMs = options.windowMs ?? 300_000;
    this.isError = options.isError ?? defaultIsError;
  }

  /** 同步处理一行：非错误行直接忽略；错误行聚合进签名窗口。 */
  ingest(line: FingerprintLineInput, instanceId?: string): void {
    if (!this.isError(line)) return;

    const template = normalizeErrorLine(line.raw);
    const signature = signatureOf(template);
    const tsMs = parseTsMs(line.ts);

    let state = this.windows.get(signature);
    let windowOpened = false;
    let isFirstEver = false;

    if (state === undefined || tsMs - state.startedAtMs >= this.windowMs) {
      // 超窗（或该签名首个窗口）：先关闭旧窗口（若有）
      if (state !== undefined) {
        this.closeWindow(signature, state, tsMs);
      }
      // 升级基准：优先取刚关闭的窗口计数；引擎重启场景回查 store 最近窗口
      const prevClosedCount =
        state !== undefined
          ? state.count
          : (this.store.listFingerprintWindows({ signature, limit: 1 })[0]?.count ?? 0);
      // 首见判定必须在 upsert 之前查 store
      isFirstEver = this.store.findFingerprint(signature) === undefined;
      state = { startedAtMs: tsMs, count: 0, prevClosedCount, escalatedEmitted: false };
      this.windows.set(signature, state);
      windowOpened = true;
    }

    // 计数入指纹表（活跃窗口期间保持/回到 open）
    this.store.upsertFingerprint(signature, template, instanceId);
    state.count += 1;

    if (windowOpened) {
      if (!isFirstEver) this.store.updateFingerprintStatus(signature, "open");
      this.bus.emit("fingerprint-aggregated", {
        instanceId,
        signature,
        template,
        windowStart: iso(state.startedAtMs),
        count: 1,
        isFirstEver,
        escalated: false, // 窗口开启时恒为 false，升级由 fingerprint-escalated 表达
        alert: isFirstEver,
        sample: line.raw.slice(0, 500),
      });
    }

    // 升级趋势：本窗计数首次超过上一窗口 2 倍且上窗 >= 3 条，整窗仅一次
    if (
      !state.escalatedEmitted &&
      state.prevClosedCount >= 3 &&
      state.count > state.prevClosedCount * 2
    ) {
      state.escalatedEmitted = true;
      this.bus.emit("fingerprint-escalated", {
        instanceId,
        signature,
        template,
        prevCount: state.prevClosedCount,
        count: state.count,
      });
    }
  }

  /** 关闭全部活跃窗口（写 fingerprint_windows 并置 known），可重复调用；
   *  关闭后再次 ingest 视为已知签名的新窗口（升级基准回查 store 历史）。 */
  close(): void {
    const now = Date.now();
    for (const [signature, state] of this.windows) {
      this.closeWindow(signature, state, now);
    }
    this.windows.clear();
  }

  /** 关闭单个窗口：写 fingerprint_windows 记录并把指纹状态置为 known。 */
  private closeWindow(signature: string, state: WindowState, endedAtMs: number): void {
    this.store.insertFingerprintWindow({
      signature,
      startedAt: iso(state.startedAtMs),
      endedAt: iso(Math.max(endedAtMs, state.startedAtMs)),
      count: state.count,
    });
    this.store.updateFingerprintStatus(signature, "known");
  }
}
