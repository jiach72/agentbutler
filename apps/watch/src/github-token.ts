/**
 * GitHub 访问令牌存储（设置页「安全」写入，版本查询/技能市场消费）：
 * - 文件固定在数据目录根：<dataDir>/github-token.json，内容 { token }；
 * - 写入走 @butler/core 的原子写（tmp + rename + fsync）并 chmod 0600，
 *   与 self-upgrade 状态文件同一套落盘保障；
 * - 读取防御式：文件缺失 / 非法 JSON / 字段缺失一律按「未配置」（null），
 *   绝不把令牌值带进任何响应体。
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonOr } from "@butler/core";

/** 令牌文件路径：固定在数据目录根下（与消费端 upgrade/skill-assets 同源解析）。 */
export function tokenFilePath(dataDir: string): string {
  return join(dataDir, "github-token.json");
}

/** 读取已保存的令牌；未配置 / 文件损坏返回 null（调用方按匿名限流降级）。 */
export function readGithubToken(dataDir: string): string | null {
  const parsed = readJsonOr<{ token?: unknown } | null>(tokenFilePath(dataDir), null);
  if (parsed === null || typeof parsed !== "object") return null;
  const token = parsed.token;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/** 写入令牌（传 null 清除：删除文件，本就不存在时保持幂等）。 */
export function writeGithubToken(dataDir: string, token: string | null): void {
  const file = tokenFilePath(dataDir);
  if (token === null) {
    try {
      unlinkSync(file);
    } catch {
      // 文件不存在即已处于目标状态
    }
    return;
  }
  atomicWriteJson(file, { token }, { mode: 0o600, description: "GitHub 访问令牌" });
}
