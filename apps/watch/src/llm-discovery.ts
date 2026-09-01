/**
 * Hermes 原生模型发现：只读解析 config.yaml / .env / 运行日志。
 *
 * 优先用 Node 直读（Docker 挂载与宿主直跑都可用）；当 hermes 根目录对当前进程
 * 不可达（例如 Windows 宿主上指向 WSL 内的路径）时，退回原有的 python3 通道。
 * 决不能把解析出的 apiKey 写入日志或序列化输出（上层导入前会做脱敏）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CommandExecutor } from "@butler/adapter-hermes";

export interface DiscoveredLlmItem {
  id: string;
  source: string;
  provider: string;
  protocol: "openai-compatible";
  endpoint: string;
  model: string;
  apiKey: string;
  importable: boolean;
  runtimeObserved: boolean;
}

interface EnvFileEntries {
  [key: string]: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 与原 python 脚本同口径：KEY=VALUE、忽略注释与空行、去掉成对引号。 */
function parseEnvFile(text: string): EnvFileEntries {
  const entries: EnvFileEntries = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim().toUpperCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== "") entries[key] = value;
  }
  return entries;
}

function readLogObservedModel(logText: string): string {
  const lines = logText.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 2000));
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const match = /\bmodel=([A-Za-z0-9][A-Za-z0-9._:/-]{1,159})/.exec(tail[i]!);
    if (match?.[1]) return match[1];
  }
  return "";
}

/** 文本已可读时的发现逻辑，与原 python 脚本保持一致的字段与优先级。 */
function discoverFromSources(rootPath: string, cfgText: string | null, envText: string | null): DiscoveredLlmItem[] {
  const fileEnv: EnvFileEntries = envText === null ? {} : parseEnvFile(envText);
  let cfg: Record<string, unknown> = {};
  if (cfgText !== null) {
    try {
      const parsed = parseYaml(cfgText);
      const record = asRecord(parsed);
      if (record !== null) cfg = record;
    } catch {
      // 解析失败视为未提供，与原脚本 except 分支一致。
    }
  }

  const modelCfg = asRecord(cfg["model"]) ?? {};
  const provider = str(modelCfg["provider"]);
  const model0 = str(modelCfg["default"]) || str(modelCfg["model"]);
  let endpoint = str(modelCfg["base_url"]) || str(modelCfg["baseUrl"]);
  let model = model0;

  const custom = Array.isArray(cfg["custom_providers"]) ? cfg["custom_providers"] : [];
  for (const raw of custom) {
    const item = asRecord(raw);
    if (item === null) continue;
    const itemProvider = str(item["provider"]) || str(item["name"]) || str(item["id"]);
    const itemModel = str(item["model"]) || str(item["default"]);
    if ((provider !== "" && itemProvider.toLowerCase() === provider.toLowerCase()) || (model !== "" && itemModel === model)) {
      endpoint = endpoint || str(item["base_url"]) || str(item["baseUrl"]);
      model = model || itemModel;
      break;
    }
  }

  const prefix = provider.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  const merged: EnvFileEntries = { ...fileEnv, ...selectProcessEnv() };
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = merged[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return "";
  };

  const apiKey =
    str(modelCfg["api_key"]) ||
    (prefix !== "" ? pick(`${prefix}_API_KEY`) : "") ||
    pick("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY");
  endpoint =
    endpoint ||
    (prefix !== "" ? pick(`${prefix}_BASE_URL`) : "") ||
    pick("OPENAI_BASE_URL", "LLM_BASE_URL");
  model =
    model ||
    pick("HERMES_BUTLER_LLM_MODEL", "BUTLER_LLM_MODEL", "LLM_MODEL", "OPENAI_MODEL");

  if (provider !== "" || endpoint !== "" || model !== "" || apiKey !== "") {
    return [
      {
        id: "hermes-default",
        source: rootPath,
        provider: provider === "" ? "OpenAI-compatible" : provider,
        protocol: "openai-compatible",
        endpoint,
        model,
        apiKey,
        importable: Boolean(endpoint && model && apiKey),
        runtimeObserved: false,
      },
    ];
  }
  return [];
}

/** process.env 快照：与原脚本 os.environ 同口径（进程环境优先于 .env 文件）。 */
function selectProcessEnv(): EnvFileEntries {
  const entries: EnvFileEntries = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string") entries[key] = value;
  }
  return entries;
}

/** 原有 python3 通道：仅当 hermes 根目录对本进程不可读时使用（Windows 宿主 + WSL 路径场景）。 */
async function discoverViaPython(rootPath: string, exec: CommandExecutor): Promise<DiscoveredLlmItem[]> {
  const script = [
    "import json, os, re, sys",
    "from pathlib import Path",
    "root = Path(sys.argv[1])",
    "env = {}",
    "try:",
    "  for raw in (root / '.env').read_text(errors='ignore').splitlines():",
    "    line = raw.strip()",
    "    if line and not line.startswith('#') and '=' in line:",
    "      k, v = line.split('=', 1); env[k.strip().upper()] = v.strip().strip(\"'\\\"\")",
    "except OSError: pass",
    "cfg = {}",
    "try:",
    "  import yaml",
    "  value = yaml.safe_load((root / 'config.yaml').read_text(errors='ignore')) or {}",
    "  cfg = value if isinstance(value, dict) else {}",
    "except Exception: pass",
    "model_cfg = cfg.get('model') if isinstance(cfg.get('model'), dict) else {}",
    "provider = str(model_cfg.get('provider') or '').strip()",
    "model = str(model_cfg.get('default') or model_cfg.get('model') or '').strip()",
    "endpoint = str(model_cfg.get('base_url') or model_cfg.get('baseUrl') or '').strip()",
    "custom = cfg.get('custom_providers') if isinstance(cfg.get('custom_providers'), list) else []",
    "for item in custom:",
    "  if not isinstance(item, dict): continue",
    "  item_provider = str(item.get('provider') or item.get('name') or item.get('id') or '').strip()",
    "  item_model = str(item.get('model') or item.get('default') or '').strip()",
    "  if (provider and item_provider.lower() == provider.lower()) or (model and item_model == model):",
    "    endpoint = endpoint or str(item.get('base_url') or item.get('baseUrl') or '').strip()",
    "    model = model or item_model",
    "    break",
    "prefix = re.sub(r'[^A-Za-z0-9]+', '_', provider).strip('_').upper()",
    "merged = {**env, **os.environ}",
    "key = str(model_cfg.get('api_key') or (merged.get(prefix + '_API_KEY') if prefix else '') or merged.get('OPENAI_API_KEY') or merged.get('DEEPSEEK_API_KEY') or merged.get('OPENROUTER_API_KEY') or merged.get('LLM_API_KEY') or '').strip()",
    "endpoint = endpoint or str(env.get(prefix + '_BASE_URL') or env.get('OPENAI_BASE_URL') or env.get('LLM_BASE_URL') or '').strip()",
    "model = model or next((str(merged.get(k)).strip() for k in ('HERMES_BUTLER_LLM_MODEL', 'BUTLER_LLM_MODEL', 'LLM_MODEL', 'OPENAI_MODEL') if merged.get(k)), '')",
    "if provider or endpoint or model or key:",
    "  print(json.dumps([{'id':'hermes-default','source':str(root),'provider':provider or 'OpenAI-compatible','protocol':'openai-compatible','endpoint':endpoint,'model':model,'apiKey':key,'importable':bool(endpoint and model and key),'runtimeObserved':False}], ensure_ascii=False))",
    "else:",
    "  observed = ''",
    "  try:",
    "    lines = (root / 'logs' / 'agent.log').read_text(errors='ignore').splitlines()[-2000:]",
    "    for line in reversed(lines):",
    "      match = re.search(r'\\bmodel=([A-Za-z0-9][A-Za-z0-9._:/-]{1,159})', line)",
    "      if match: observed = match.group(1); break",
    "  except OSError: pass",
    "  print(json.dumps([{'id':'hermes-runtime-log','source':str(root / 'logs' / 'agent.log'),'provider':'Hermes runtime','protocol':'openai-compatible','endpoint':'','model':observed,'apiKey':'','importable':False,'runtimeObserved':True}], ensure_ascii=False) if observed else '[]')",
  ].join("\n");
  const result = await exec.exec("python3", ["-c", script, rootPath], { timeoutMs: 8_000 });
  if (result.code !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>)["id"] === "string" && typeof (item as Record<string, unknown>)["apiKey"] === "string",
    )
    .map((item) => ({
      id: String(item["id"]),
      source: typeof item["source"] === "string" ? item["source"] : rootPath,
      provider: typeof item["provider"] === "string" ? item["provider"] : "OpenAI-compatible",
      protocol: "openai-compatible" as const,
      endpoint: typeof item["endpoint"] === "string" ? item["endpoint"] : "",
      model: typeof item["model"] === "string" ? item["model"] : "",
      apiKey: String(item["apiKey"]),
      importable: item["importable"] !== false,
      runtimeObserved: item["runtimeObserved"] === true,
    }));
}

/** 运行日志观测：仅当 config.yaml/.env 均未给出模型配置时作为只读信号。 */
async function readRuntimeObserved(rootPath: string): Promise<DiscoveredLlmItem[]> {
  let logText: string;
  try {
    logText = await readFile(join(rootPath, "logs", "agent.log"), "utf8");
  } catch {
    return [];
  }
  const observed = readLogObservedModel(logText);
  if (observed === "") return [];
  return [
    {
      id: "hermes-runtime-log",
      source: join(rootPath, "logs", "agent.log"),
      provider: "Hermes runtime",
      protocol: "openai-compatible",
      endpoint: "",
      model: observed,
      apiKey: "",
      importable: false,
      runtimeObserved: true,
    },
  ];
}

export async function discoverHermesLlm(
  rootPath: string,
  options: { exec?: CommandExecutor } = {},
): Promise<DiscoveredLlmItem[]> {
  let envText: string | null = null;
  let cfgText: string | null = null;
  try {
    envText = await readFile(join(rootPath, ".env"), "utf8");
  } catch {
    // .env 不存在或不可读，继续看 config.yaml。
  }
  try {
    cfgText = await readFile(join(rootPath, "config.yaml"), "utf8");
  } catch {
    // config.yaml 不存在或不可读。
  }
  if (envText !== null || cfgText !== null) {
    const discovered = discoverFromSources(rootPath, cfgText, envText);
    if (discovered.length > 0) return discovered;
    return readRuntimeObserved(rootPath);
  }
  // 两个文件都读不到：目录可能不在本进程可达范围（Windows 宿主 + WSL 路径）。
  if (options.exec !== undefined) return discoverViaPython(rootPath, options.exec);
  return [];
}
