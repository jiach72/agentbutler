import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** platforms.api_server.extra 的可用字段（host/port 可缺失，key 可缺失）。 */
export interface HermesApiServerConfig {
  host: string | null;
  port: number | null;
  /**
   * API 鉴权 key（敏感值）。
   * 仅供适配器内部使用，绝不能写入 evidence、日志、测试断言或任何序列化输出。
   */
  key: string | null;
}

/** 从 ~/.hermes/config.yaml 提取的、适配器关注的配置子集。 */
export interface HermesConfig {
  apiServer: HermesApiServerConfig;
  /** platforms.weixin.extra 的节流参数原样键值（如 min_send_interval_seconds）。 */
  weixinExtra: Record<string, unknown> | null;
  /** config.yaml 是否声明 dashboard 段。 */
  hasDashboard: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 读取并解析 <rootPath>/config.yaml，只读、无副作用。
 * 文件缺失或 YAML 解析失败时返回 null（视为无可用的 api_server 配置）。
 */
export async function readHermesConfig(rootPath: string): Promise<HermesConfig | null> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, "config.yaml"), "utf8");
  } catch {
    return null;
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch {
    return null;
  }

  const root = asRecord(doc);
  if (!root) return null;

  const platforms = asRecord(root["platforms"]);
  const apiServerExtra = platforms ? asRecord(asRecord(platforms["api_server"])?.["extra"]) : null;
  const weixinExtra = platforms ? asRecord(asRecord(platforms["weixin"])?.["extra"]) : null;

  const host = typeof apiServerExtra?.["host"] === "string" ? (apiServerExtra["host"] as string) : null;
  const port = typeof apiServerExtra?.["port"] === "number" ? (apiServerExtra["port"] as number) : null;
  const key = typeof apiServerExtra?.["key"] === "string" ? (apiServerExtra["key"] as string) : null;

  return {
    apiServer: { host, port, key },
    weixinExtra: weixinExtra ? { ...weixinExtra } : null,
    hasDashboard: "dashboard" in root,
  };
}
