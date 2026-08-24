import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogSource } from "@butler/contract";

/**
 * 枚举 <rootPath>/logs/*.log 日志源（同步、只读）。
 * 排除轮转文件（.1/.2/.3 后缀，因不以 .log 结尾自然被过滤）与子目录（如 curator/）。
 */
export function logSources(rootPath: string): LogSource[] {
  const logsDir = join(rootPath, "logs");
  let entries;
  try {
    entries = readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      id: `hermes:logs:${entry.name}`,
      path: resolve(logsDir, entry.name),
      format: "text" as const,
    }));
}
