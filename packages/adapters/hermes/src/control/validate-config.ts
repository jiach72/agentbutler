/**
 * 配置不变式校验（只读，无副作用；规则细节 Task 18 扩展为全量）。
 *
 * 三条不变式均来自真实日志教训：
 * - INV-weixin-open-policy（block）：WEIXIN_GROUP_POLICY=open 必须伴随白名单
 *   （.env WEIXIN_GROUP_WHITELIST 或 config.yaml platforms.weixin 白名单字段非空）；
 * - INV-api-key-pairing（block）：api_server 监听非本地回环地址时必须配置鉴权 key；
 * - INV-throttle-floor（warn）：weixin extra 的 min_send_interval_seconds 低于安全下限 45。
 *
 * 尽力而为原则：字段缺失不误报；鉴权 key 值绝不进入任何输出（detail 只含 host/interval）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ConfigValidation, ConfigViolation } from "@butler/contract";
import { readHermesConfig } from "../config.js";

/** 微信发送间隔的安全下限（秒）。 */
export const THROTTLE_FLOOR_SECONDS = 45;

/** 本地回环 host 集合（其余地址视为对外暴露）。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** config.yaml platforms.weixin 段中识别为 policy 的键。 */
const POLICY_KEYS = new Set(["policy", "group_policy"]);

/** config.yaml platforms.weixin 段中识别为白名单的键名模式。 */
const WHITELIST_KEY_PATTERN = /whitelist|allowlist|allowed_groups/i;

/** 解析 .env（尽力而为）：KEY=VALUE 行，忽略注释与空行，值去引号。 */
export function parseEnvFile(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 读取 config.yaml 的 platforms.weixin 段（文件缺失/损坏返回 null）。 */
async function readWeixinSection(rootPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = readFileSync(join(rootPath, "config.yaml"), "utf8");
  } catch {
    return null;
  }
  try {
    const doc = asRecord(parse(raw));
    const platforms = asRecord(doc?.["platforms"]);
    return asRecord(platforms?.["weixin"]);
  } catch {
    return null;
  }
}

/** 白名单值非空判定：非空字符串（非 "[]"）或非空数组。 */
function whitelistNonEmpty(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && trimmed !== "[]";
  }
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/** 校验 Hermes 配置并返回违例清单（passed = 无 block 级违例）。 */
export async function validateHermesConfig(rootPath: string): Promise<ConfigValidation> {
  const violations: ConfigViolation[] = [];
  const config = await readHermesConfig(rootPath);
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(readFileSync(join(rootPath, ".env"), "utf8"));
  } catch {
    // .env 缺失视为无环境侧声明，不误报。
  }
  const weixin = await readWeixinSection(rootPath);

  // INV-weixin-open-policy（block）
  const policyOpenFromEnv = env["WEIXIN_GROUP_POLICY"]?.trim().toLowerCase() === "open";
  const policyOpenFromConfig = [...POLICY_KEYS].some(
    (key) => typeof weixin?.[key] === "string" && (weixin[key] as string).trim().toLowerCase() === "open",
  );
  if (policyOpenFromEnv || policyOpenFromConfig) {
    const envWhitelist = whitelistNonEmpty(env["WEIXIN_GROUP_WHITELIST"]);
    const configWhitelist =
      weixin !== null &&
      Object.entries(weixin).some(([key, value]) => WHITELIST_KEY_PATTERN.test(key) && whitelistNonEmpty(value));
    if (!envWhitelist && !configWhitelist) {
      violations.push({
        invariant: "INV-weixin-open-policy",
        severity: "block",
        detail: "WEIXIN_GROUP_POLICY=open 但未配置任何群白名单（.env WEIXIN_GROUP_WHITELIST 或 config.yaml platforms.weixin 白名单字段为空）",
      });
    }
  }

  // INV-api-key-pairing（block）：密钥与端点配对（detail 不回显 key 值）
  const host = config?.apiServer.host;
  if (config && host && !LOOPBACK_HOSTS.has(host.toLowerCase()) && !config.apiServer.key) {
    violations.push({
      invariant: "INV-api-key-pairing",
      severity: "block",
      detail: `api_server host=${host} 非本地回环，必须配置鉴权 key（密钥与端点配对）`,
    });
  }

  // INV-throttle-floor（warn）
  const interval = config?.weixinExtra?.["min_send_interval_seconds"];
  if (typeof interval === "number" && interval < THROTTLE_FLOOR_SECONDS) {
    violations.push({
      invariant: "INV-throttle-floor",
      severity: "warn",
      detail: `min_send_interval_seconds=${interval} 低于安全下限 ${THROTTLE_FLOOR_SECONDS}`,
    });
  }

  return { passed: !violations.some((v) => v.severity === "block"), violations };
}
