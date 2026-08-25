import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogSource } from "@butler/contract";

export function logSources(rootPath: string): LogSource[] {
  const dirs = [join(rootPath, "logs"), join(rootPath, "state", "logs")];
  const out: LogSource[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".log") || entry.name.endsWith(".jsonl"))) {
          out.push({
            id: `openclaw:logs:${entry.name}`,
            path: resolve(dir, entry.name),
            format: entry.name.endsWith(".jsonl") ? "jsonl" : "text",
            ...(entry.name.endsWith(".jsonl") ? { tsField: "timestamp" } : {}),
          });
        }
      }
    } catch {
      // 日志目录可选，缺失不应阻断其它发现能力。
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
