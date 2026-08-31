import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
  description?: string;
}

/** 写入临时文件并 fsync 后替换目标，避免进程中断留下半个 JSON。 */
export function atomicWriteFile(file: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const mode = options.mode ?? (existsSync(file) ? statSync(file).mode & 0o777 : 0o600);
  const temp = join(parent, `.${file.split(/[\\/]/).pop() ?? "atomic"}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    const bytes = typeof content === "string" ? Buffer.from(content, options.encoding ?? "utf8") : Buffer.from(content);
    writeSync(fd, bytes, 0, bytes.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(temp, file);
    } catch (error) {
      // Windows cannot replace an existing file with renameSync.
      if (process.platform !== "win32" || !existsSync(file)) throw error;
      unlinkSync(file);
      renameSync(temp, file);
    }
  } catch (error) {
    const label = options.description === undefined ? file : options.description;
    throw new Error(`${label} 写入失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
  }
}

export function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions = {}): void {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function atomicWriteText(file: string, content: string, options: AtomicWriteOptions = {}): void {
  atomicWriteFile(file, content, options);
}

export function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
