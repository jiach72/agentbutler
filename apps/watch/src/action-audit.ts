/**
 * 行为审计流（Trust Layer M1.2）：agent 执行动作的结构化采集与查询。
 *
 * 数据源：Hermes 日志文件（默认 <hermesRoot>/logs 下 *.log，可用
 * BUTLER_AUDIT_LOG_PATHS 显式指定）。增量解析（按字节偏移续读，启动时
 * 从文件当前末尾开始——只看新动作，不做全量重扫，满足 CPU 红线）。
 *
 * 隐私红线（不可妥协）：
 * - 只落结构化动作字段：kind / target（≤200 字符）/ 截断脱敏后的行片段；
 * - 不存储 prompt / 对话正文；行片段先过凭据脱敏（sk-…、Bearer …、
 *   access_token=… 模式替换为 ***）再入库；
 * - 解析器版本化（v1）；格式不匹配的行直接跳过，绝不猜测补齐。
 *
 * 高危集合（severity=high）：文件删除、外发消息、危险 shell（rm -rf、
 * sudo、mkfs、dd if=、del /s 等）。
 */
import { openSync, readSync, closeSync, fstatSync, existsSync, readdirSync, statSync } from "node:fs";
import type { SqliteStore, ActionEventRow } from "@butler/core";
import { defaultTimerDriver, type TimerDriver } from "./scheduler.js";

export const ACTION_AUDIT_PARSER_VERSION = "v1";
/** 采集周期（秒）：高危动作 ≤60s 出现在时间线的验收要求留出余量。 */
export const ACTION_AUDIT_INTERVAL_MS = 15_000;
export const AUDIT_RETENTION_MIN_DAYS = 7;
export const AUDIT_RETENTION_MAX_DAYS = 90;
export const AUDIT_RETENTION_DEFAULT_DAYS = 14;

export interface ActionAuditOptions {
  store: SqliteStore;
  /** 待解析的日志文件绝对路径（由接线层解析 env / logs 目录得出）。 */
  logPaths: string[];
  /** 保留天数（默认 14，可调 7-90）。 */
  retentionDays?: number;
  now?: () => number;
  driver?: TimerDriver;
  intervalMs?: number;
  /** 注入文件大小读取（测试）；缺省 fstatSync。 */
  fileSize?: (path: string) => number;
  /** 注入片段读取（测试）；缺省 openSync/readSync。 */
  readChunk?: (path: string, start: number, end: number) => string;
}

export interface ActionAuditView {
  /** 采集器状态。 */
  enabled: boolean;
  sources: Array<{ path: string; parsedBytes: number; lastParsedAt: string | null }>;
  mode: "structured" | "no-matches" | "no-sources";
  lastParsedAt: string | null;
  retentionDays: number;
  parserVersion: string;
}

export interface ActionAuditSummary {
  windowHours: number;
  total: number;
  highRisk: number;
  byKind: Record<string, number>;
  lastActionAt: string | null;
  collector: ActionAuditView;
}

export interface ActionAuditService {
  start(): void;
  stop(): void;
  /** 手动驱动一轮增量解析（测试 / 手动刷新）。 */
  tick(): void;
  collectorView(): ActionAuditView;
  summary(windowHours: number): ActionAuditSummary;
  actions(filter: {
    windowHours?: number;
    kind?: ActionEventRow["kind"];
    severity?: ActionEventRow["severity"];
    limit?: number;
  }): Array<ActionEventRow>;
  /** 超保留期清理（接入 retention pruner）。 */
  prune(): number;
}

/* ------------------------------ 解析规则 ------------------------------ */

type ActionKind = ActionEventRow["kind"];

interface ParsedAction {
  kind: ActionKind;
  severity: "info" | "high";
  target: string;
  detail: Record<string, unknown>;
}

/** 行片段脱敏：凭据类字符串一律 ***（含 OpenAI 风格 key、Bearer、token 参数）。 */
function scrub(text: string): string {
  return text
    .replace(/\b(?:sk|pk)-[A-Za-z0-9._-]{8,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/(?:access_token|api[_-]?key|token|password|secret)[=:]\s*[^\s&"',;]{6,}/gi, "$1=***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 危险 shell 命令特征（高危信号边）。 */
const DANGEROUS_SHELL = /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bdel\s+\/[sq]\b|\bformat\b\s+[a-z]:|\bshutdown\b|\breboot\b/i;

/** 每行按优先级匹配一个动作类型；全不匹配 → null（跳过，不猜测）。 */
export function parseActionLine(line: string): ParsedAction | null {
  const text = line.trim();
  if (text.length < 8) return null;
  const scrubbed = scrub(text);

  // 1) 文件删除
  let match = /(?:删除|已删除|deleted?|removed?|unlink(?:ed)?)\s*[:：]?\s*(\/?[\w./\\\-~\u4e00-\u9fff]{2,180})/i.exec(scrubbed);
  if (match !== null && /\bfile\b|文件|path|\.|\//i.test(scrubbed)) {
    return {
      kind: "file-delete",
      severity: "high",
      target: truncate(match[1] ?? "", 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  // 2) 文件写入 / 修改（允许 "wrote file xxx" / "写入 文件 xxx" 的连接词）
  match = /(?:写入|已写入|创建|保存|wrote|written|created|saved|modified)\s+(?:file\b|文件|路径)?\s*[:：]?\s*(\/?[\w./\\\-~\u4e00-\u9fff]{2,180})/i.exec(scrubbed);
  if (match !== null && /\bfile\b|文件|path|\.|\//i.test(scrubbed)) {
    return {
      kind: "file-write",
      severity: "info",
      target: truncate(match[1] ?? "", 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  // 3) 外发消息（高危：数据离开本机）
  match = /(?:发送|外发|投递|sent|send(?:ing)?)\s*.{0,40}?(?:到|给|to)\s*([\w@.\-[\]]{2,80})/i.exec(scrubbed);
  if (match !== null) {
    return {
      kind: "message-send",
      severity: "high",
      target: truncate(match[1] ?? "", 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  // 4) shell 执行
  match = /(?:shell|exec|bash|cmd|command|命令|执行了?)\s*[:：]?\s*(.{1,140})/i.exec(scrubbed);
  if (match !== null) {
    const command = (match[1] ?? "").trim();
    return {
      kind: "shell-exec",
      severity: DANGEROUS_SHELL.test(command) ? "high" : "info",
      target: truncate(command, 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  // 5) 网络抓取 / API 调用
  match = /\b(?:fetch|curl|wget|GET|POST|PUT|DELETE|抓取|请求)\s+(https?:\/\/[^\s"']{4,180})/i.exec(scrubbed);
  if (match !== null) {
    return {
      kind: "web-fetch",
      severity: "info",
      target: truncate(match[1] ?? "", 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  match = /(?:api[-_ ]?call|调用)\s*[:：]?\s*([\w./:-]{3,120})/i.exec(scrubbed);
  if (match !== null) {
    return {
      kind: "api-call",
      severity: "info",
      target: truncate(match[1] ?? "", 200),
      detail: { snippet: truncate(scrubbed, 160) },
    };
  }
  return null;
}

/** 行内会话标识（如 session=abc123）。 */
const SESSION_PATTERN = /\bsession[\s_=-]*([A-Za-z0-9_-]{6,64})\b/i;

/** 行内时间戳提取（ISO 或 [MM-DD HH:mm:ss]）；无法提取用采集时间兜底。 */
function extractTs(line: string, fallbackMs: number): string {
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/.exec(line);
  if (iso !== null) {
    const parsed = Date.parse(iso[1]!.replace(" ", "T"));
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

export function createActionAuditService(options: ActionAuditOptions): ActionAuditService {
  const now = options.now ?? (() => Date.now());
  const driver = options.driver ?? defaultTimerDriver;
  const intervalMs = options.intervalMs ?? ACTION_AUDIT_INTERVAL_MS;
  const retentionDays = Math.min(
    AUDIT_RETENTION_MAX_DAYS,
    Math.max(AUDIT_RETENTION_MIN_DAYS, options.retentionDays ?? AUDIT_RETENTION_DEFAULT_DAYS),
  );
  const sources = options.logPaths.filter((path) => path.trim() !== "").map((path) => ({
    path,
    parsedBytes: 0,
    lastParsedAt: null as string | null,
    /** 启动时对齐到文件当前末尾：只采集新动作（增量解析红线）。 */
    initialized: false,
  }));
  const fileSize = options.fileSize ?? ((path: string) => {
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

  let handle: unknown;
  let running = false;
  let anyMatch = false;

  function tick(): void {
    const atMs = now();
    for (const source of sources) {
      const size = fileSize(source.path);
      if (size < 0) continue;
      if (!source.initialized) {
        source.parsedBytes = size;
        source.initialized = true;
        source.lastParsedAt = new Date(atMs).toISOString();
        continue;
      }
      if (size <= source.parsedBytes) {
        // 轮转（size 变小）→ 对齐末尾；未变 → 跳过。
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
      source.lastParsedAt = new Date(atMs).toISOString();
      const lines = chunk.split("\n");
      // 末尾不完整行（无换行符）留在下轮：扣回其字节数。
      if (lines.length > 0 && !chunk.endsWith("\n")) {
        const partial = lines.pop() ?? "";
        source.parsedBytes -= Buffer.byteLength(partial, "utf8");
      }
      for (const line of lines) {
        const parsed = parseActionLine(line);
        if (parsed === null) continue;
        anyMatch = true;
        const sessionMatch = SESSION_PATTERN.exec(line);
        try {
          options.store.insertActionEvent({
            ts: extractTs(line, atMs),
            kind: parsed.kind,
            severity: parsed.severity,
            target: parsed.target,
            detail: parsed.detail,
            sessionId: sessionMatch?.[1] ?? null,
            parserVersion: ACTION_AUDIT_PARSER_VERSION,
          });
        } catch (error) {
          console.warn("[butler-watch] action event insert failed:", error);
        }
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick();
      handle = driver.setInterval(tick, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      driver.clearInterval(handle);
      handle = undefined;
    },
    tick,
    collectorView(): ActionAuditView {
      return {
        enabled: sources.length > 0,
        sources: sources.map(({ path, parsedBytes, lastParsedAt }) => ({ path, parsedBytes, lastParsedAt })),
        mode: sources.length === 0 ? "no-sources" : anyMatch ? "structured" : "no-matches",
        lastParsedAt: sources.reduce<string | null>(
          (latest, source) => (source.lastParsedAt !== null && (latest === null || source.lastParsedAt > latest) ? source.lastParsedAt : latest),
          null,
        ),
        retentionDays,
        parserVersion: ACTION_AUDIT_PARSER_VERSION,
      };
    },
    summary(windowHours): ActionAuditSummary {
      const since = new Date(now() - windowHours * 3_600_000).toISOString();
      const collector = this.collectorView();
      const events = options.store.listActionEvents({ since, limit: 5000 });
      const byKind: Record<string, number> = {};
      let highRisk = 0;
      for (const event of events) {
        byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
        if (event.severity === "high") highRisk += 1;
      }
      return {
        windowHours,
        total: events.length,
        highRisk,
        byKind,
        lastActionAt: events[0]?.ts ?? null,
        collector,
      };
    },
    actions(filter) {
      const windowHours = filter.windowHours ?? 24;
      const since = new Date(now() - windowHours * 3_600_000).toISOString();
      return options.store.listActionEvents({
        since,
        kind: filter.kind,
        severity: filter.severity,
        limit: Math.min(Math.max(1, filter.limit ?? 200), 1000),
      });
    },
    prune() {
      const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString();
      return options.store.pruneActionEvents(cutoff);
    },
  };
}

/** 从目录发现日志文件（接线层用；目录不存在返回空）。 */
export function discoverLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".log") || name.endsWith(".log.1"))
      .map((name) => `${dir}/${name}`)
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}
