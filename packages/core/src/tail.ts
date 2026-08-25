/**
 * 日志尾随器（LogTailer）：按持久化字节位点断点续读多个日志源。
 *
 * at-least-once 语义：poll(handler) 回调式——先把本批完整行交给 handler，
 * handler 成功返回后才把位点持久化到 tail_positions；处理中断（抛错或进程
 * 崩溃）时位点不推进，重启后重读同一批行（宁可重复不可丢失）。
 *
 * 截断/轮转：文件当前 size < 已存位点 → 视为截断/轮转，位点重置 0 全量重读，
 * 并广播 tail-rotated 事件。文件不存在 → 跳过不报错。
 *
 * 末尾不完整行：offset 只推进到最后一个完整换行符之后，部分行等下次 poll。
 * 由上层调度器（Task 5 butler-watch）周期驱动，本模块不做定时循环。
 */
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { LogSource } from "@butler/contract";
import type { EventBus } from "./events.js";
import type { SqliteStore } from "./store.js";

/** 尾随出的一行：raw 为原始文本（去掉行尾换行符），jsonl 格式解析出 ts。 */
export interface TailedLine {
  source: LogSource;
  raw: string;
  ts?: string;
}

/** 一次 poll 中单个源的新增批：startOffset → endOffset 为本批字节区间。 */
export interface TailedBatch {
  source: LogSource;
  lines: TailedLine[];
  startOffset: number;
  endOffset: number;
}

export type TailHandler = (batch: TailedBatch) => void | Promise<void>;

/** 单次磁盘读取上限，避免按日志增量大小申请巨型 Buffer。 */
const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export interface LogTailerOptions {
  store: SqliteStore;
  /** 提供时截断/轮转检测广播 tail-rotated；缺省静默重置。 */
  bus?: EventBus;
}

export class LogTailer {
  private store: SqliteStore;
  private bus?: EventBus;
  private sources = new Map<string, LogSource>();

  constructor(options: LogTailerOptions) {
    this.store = options.store;
    this.bus = options.bus;
  }

  /** 注册/覆盖日志源集合（同 id 后注册者生效）。 */
  registerSources(sources: LogSource[]): void {
    for (const source of sources) {
      this.sources.set(source.id, source);
    }
  }

  /** 当前已注册的日志源（快照）。 */
  listSources(): LogSource[] {
    return [...this.sources.values()];
  }

  /**
   * 轮询全部源：读取自上次已提交位点以来的完整行，逐源回调 handler，
   * 回调成功后才提交位点。handler 抛错时立即上抛且该源位点不推进。
   */
  async poll(handler: TailHandler): Promise<void> {
    for (const source of this.sources.values()) {
      let offset = this.store.getTailPosition(source.id) ?? 0;
      let size: number;
      try {
        size = fs.statSync(source.path).size;
      } catch {
        continue; // 文件不存在 → 跳过不报错
      }

      // 截断/轮转：当前大小小于已存位点 → 重置 0 重读并广播。
      if (size < offset) {
        this.bus?.emit("tail-rotated", { sourceId: source.id, path: source.path, oldOffset: offset });
        offset = 0;
      }
      if (size === offset) continue;

      // 从位点读到 EOF，只保留到最后一个完整换行符为止的内容。
      const fd = fs.openSync(source.path, "r");
      let batch: TailedBatch | undefined;
      try {
        // 第一遍只扫描换行位置，避免把整个增量读入内存；末尾无换行的
        // 部分行不会推进位点，下一轮会从原 offset 重新读取。
        const lastNewline = findLastNewline(fd, offset, size);
        if (lastNewline !== -1) {
          const endOffset = lastNewline + 1;
          const lines = readLines(fd, source, offset, endOffset);
          if (lines.length > 0) batch = { source, lines, startOffset: offset, endOffset };
        }
      } finally {
        fs.closeSync(fd);
      }
      if (batch === undefined) continue;

      await handler(batch);
      this.store.setTailPosition(source.id, batch.endOffset); // 处理成功才提交位点
    }
  }
}

/** 返回 [start, end) 范围内最后一个换行符的绝对字节位置。 */
function findLastNewline(fd: number, start: number, end: number): number {
  const buffer = Buffer.alloc(Math.min(TAIL_READ_CHUNK_BYTES, end - start));
  let position = start;
  let lastNewline = -1;
  while (position < end) {
    const requested = Math.min(buffer.length, end - position);
    const bytesRead = fs.readSync(fd, buffer, 0, requested, position);
    if (bytesRead <= 0) break;
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) lastNewline = position + newline;
    position += bytesRead;
  }
  return lastNewline;
}

/** 分块解码并组装完整行；StringDecoder 负责跨块 UTF-8 字符边界。 */
function readLines(fd: number, source: LogSource, start: number, end: number): TailedLine[] {
  const buffer = Buffer.alloc(Math.min(TAIL_READ_CHUNK_BYTES, end - start));
  const decoder = new StringDecoder("utf8");
  const lines: TailedLine[] = [];
  const parts: string[] = [];
  let position = start;

  const consume = (text: string): void => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      if (newline === -1) {
        if (cursor < text.length) parts.push(text.slice(cursor));
        return;
      }
      if (newline > cursor) parts.push(text.slice(cursor, newline));
      let raw = parts.join("");
      parts.length = 0;
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      lines.push(buildLine(source, raw));
      cursor = newline + 1;
    }
  };

  while (position < end) {
    const requested = Math.min(buffer.length, end - position);
    const bytesRead = fs.readSync(fd, buffer, 0, requested, position);
    if (bytesRead <= 0) break;
    consume(decoder.write(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  consume(decoder.end());
  return lines;
}

/** 按源格式组装 TailedLine：jsonl 解析 tsField，text 不解析 ts。 */
function buildLine(source: LogSource, raw: string): TailedLine {
  if (source.format !== "jsonl") return { source, raw };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tsField = source.tsField ?? "ts";
    const value = parsed[tsField];
    if (typeof value === "string" || typeof value === "number") {
      return { source, raw, ts: String(value) };
    }
  } catch {
    // 非 JSON 行按 text 语义透传（不含 ts）
  }
  return { source, raw };
}
