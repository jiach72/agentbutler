/**
 * M7 安全基线（Task 18.1/18.3）：配置不变式 + 密钥文件权限扫描。
 *
 * V1 只做三条不变式（全部来自日志教训）：
 * - I1 open-policy-whitelist：开放策略必须伴随白名单（open policy 无限重启教训）；
 * - I2 message-throttle：消息外发必须有 ≥45s 间隔（限流断流教训，真实来源为
 *   网关补丁面板参数）；
 * - I3 key-endpoint-pairing：密钥必须与端点成对（密钥配错端点教训）。
 *
 * 密钥扫描只读文件名与权限位，不读取、不展示任何密钥内容；明文密钥文件
 * （.env / auth.json / *secret* / *token* / *.pem 等）权限非 0600 时在面板明示风险。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { PatchPanelView } from "./gateway-stats.js";

export interface InvariantCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail" | "unknown";
  detail: string;
  rule: string;
}

export interface SecretFileView {
  rel: string;
  path: string;
  mode: string;
  secure: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface SecurityStatusView {
  checkedAt: string;
  invariants: InvariantCheck[];
  secrets: SecretFileView[];
  totalSecretFiles: number;
  insecureSecretFiles: number;
  message: string;
}

export interface SecurityServiceOptions {
  hermesRoot: string;
  /** 网关补丁面板服务（可选；不可用时 I2 标记 unknown，不误报通过）。 */
  gateway?: {
    patches(): Promise<PatchPanelView[]>;
  };
  now?: () => number;
  pollIntervalMs?: number;
  onInvariantChange?: (view: SecurityStatusView) => void | Promise<void>;
}

export interface SecurityService {
  status(): Promise<SecurityStatusView>;
  refresh(): Promise<SecurityStatusView>;
  start(): void;
  stop(): void;
}

/** 开放策略关键词（命中即需要白名单伴随）。 */
const OPEN_POLICY_PATTERNS = [/open[_ -]?policy/i, /OPEN_POLICYs*=/];
/** 白名单/名单类关键词（满足任一视为有名单约束）。 */
const WHITELIST_PATTERNS = [
  /whitelist/i,
  /allowlist/i,
  /allow[_ -]?list/i,
  /permitted/i,
  /restricted[_ -]?users/i,
  /allowed[_ -]?users/i,
];

/** 密钥文件名模式（只用于定位，不读取内容）。 */
/** 代码/文档扩展名不当作密钥文件（避免把源码文件误报为风险）。 */
const SECRET_SKIP_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx",
  ".md", ".html", ".css", ".sh",
]);
const SECRET_NAME_PATTERNS = [
  /.env$/i,
  /.env.[a-z0-9]+$/i,
  /auth.json$/i,
  /credentials/i,
  /secret/i,
  /token/i,
  /.pem$/i,
  /.key$/i,
  /.p12$/i,
  /.pfx$/i,
];

/** 环境变量密钥名 → 期望的端点/基础地址变量名。 */
const KEY_ENDPOINT_PAIRS: Array<{ keyRe: RegExp; endpointRe: RegExp; label: string }> = [
  { keyRe: /^(OPENAI|AZURE_OPENAI)_API_KEY/i, endpointRe: /^(OPENAI|AZURE_OPENAI)_(BASE_URL|ENDPOINT)/i, label: "OpenAI" },
  { keyRe: /^ANTHROPIC_API_KEY/i, endpointRe: /^ANTHROPIC_(BASE_URL|API_URL)/i, label: "Anthropic" },
  { keyRe: /^DEEPSEEK_API_KEY/i, endpointRe: /^DEEPSEEK_(BASE_URL|API_URL|ENDPOINT)/i, label: "DeepSeek" },
  { keyRe: /^MOONSHOT_API_KEY/i, endpointRe: /^MOONSHOT_(BASE_URL|API_URL)/i, label: "Moonshot" },
  { keyRe: /^KIMI_API_KEY/i, endpointRe: /^KIMI_(BASE_URL|API_URL)/i, label: "Kimi" },
  { keyRe: /^LITELLM_API_KEY/i, endpointRe: /^LITELLM_(BASE_URL|HOST|API_URL)/i, label: "LiteLLM" },
  { keyRe: /^GEMINI_API_KEY/i, endpointRe: /^GEMINI_(BASE_URL|API_URL)/i, label: "Gemini" },
  { keyRe: /^QWEN_API_KEY/i, endpointRe: /^QWEN_(BASE_URL|API_URL)/i, label: "Qwen" },
];

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function scanSecretFiles(root: string, maxDepth = 1, limit = 100): SecretFileView[] {
  const found: SecretFileView[] = [];
  const rootResolved = resolve(root);
  if (!existsSync(rootResolved)) return found;
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过明显缓存/代码目录，降低误扫与开销
        if (/^(cache|node_modules|.git|venv|.venv|__pycache__|logs|tmp|backups|snapshots|checkpoints)$/i.test(entry.name)) {
          continue;
        }
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = SECRET_NAME_PATTERNS.some((re) => re.test(entry.name));
      if (!match) continue;
      const ext = basename(entry.name).slice(basename(entry.name).lastIndexOf(".")).toLowerCase();
      if (SECRET_SKIP_EXTENSIONS.has(ext)) continue;
      // 示例/占位文件和 .envrc 这类环境钩子不算风险
      if (entry.name.endsWith(".example") || entry.name === ".envrc") continue;
      try {
        const st = statSync(full);
        const mode = process.platform === "win32" ? "—" : (st.mode & 0o777).toString(8).padStart(3, "0");
        const secure = process.platform === "win32" || (st.mode & 0o077) === 0;
        found.push({
          rel: relative(rootResolved, full),
          path: full,
          mode: mode === "—" ? "—" : `0${mode}`,
          secure,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      } catch {
        // 单个文件不可读则跳过
      }
    }
  };
  walk(rootResolved, 0);
  return found;
}

function checkOpenPolicy(hermesRoot: string): InvariantCheck {
  const text = readText(join(hermesRoot, "config.yaml")) + "\n" + readText(join(hermesRoot, ".env"));
  const hasOpenPolicy = OPEN_POLICY_PATTERNS.some((re) => re.test(text));
  if (!hasOpenPolicy) {
    return {
      id: "open-policy-whitelist",
      title: "开放策略必须有名单限制",
      status: "pass",
      detail: "没有发现开放策略配置，不涉及名单要求。",
      rule: "开放策略必须伴随白名单，防止配置失误导致无限重启。",
    };
  }
  const hasWhitelist = WHITELIST_PATTERNS.some((re) => re.test(text));
  return {
    id: "open-policy-whitelist",
    title: "开放策略必须有名单限制",
    status: hasWhitelist ? "pass" : "fail",
    detail: hasWhitelist
      ? "发现开放策略配置，同时存在名单限制。"
      : "发现开放策略配置，但没有找到任何名单限制，建议先加白名单再启用。",
    rule: "开放策略必须伴随白名单，防止配置失误导致无限重启。",
  };
}

async function checkMessageThrottle(hermesRoot: string, gateway?: SecurityServiceOptions["gateway"]): Promise<InvariantCheck> {
  const base = {
    id: "message-throttle",
    title: "消息外发间隔至少 45 秒",
    rule: "消息外发必须保持 ≥45 秒间隔，防止微信/iLink 限流断流。",
  };
  if (gateway === undefined) {
    return { ...base, status: "unknown", detail: "网关面板暂时不可用，无法核对外发间隔。" };
  }
  try {
    // 先读 Hermes config.yaml 的真实间隔参数（如 min_send_interval_seconds），
    // 再叠加网关补丁参数，避免“没有补丁”时跳过真实配置。
    const intervalValues: number[] = [];
    const configText = readText(join(hermesRoot, "config.yaml"));
    for (const line of configText.split(/\r?\n/)) {
      const m = /(?:min_send_interval_seconds|send_interval_seconds|throttle_interval|dispatch_interval_seconds)\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(line);
      if (m !== null) {
        const value = Number(m[1]);
        if (Number.isFinite(value) && value > 0) intervalValues.push(value);
      }
    }
    const view = await gateway.patches();
    const applied = view.filter((p) => p.applied !== null);
    for (const patch of applied) {
      for (const [key, value] of Object.entries(patch.applied?.params ?? {})) {
        if (/interval|间隔|delay/i.test(key)) {
          const num = Number(value);
          if (Number.isFinite(num) && num > 0) intervalValues.push(num);
        }
      }
    }
    if (intervalValues.length === 0) {
      return { ...base, status: "unknown", detail: "还没找到可核验的外发间隔，建议先应用消息节流补丁。" };
    }
    const min = Math.min(...intervalValues);
    if (min < 45) {
      return { ...base, status: "fail", detail: `当前最小外发间隔 ${min} 秒，低于 45 秒安全线（日志里微信/iLink 限流的主因）。` };
    }
    return { ...base, status: "pass", detail: `当前最小外发间隔 ${min} 秒，达到安全线。` };
  } catch {
    return { ...base, status: "unknown", detail: "网关面板读取失败，无法核对外发间隔。" };
  }
}

function checkKeyEndpointPairing(hermesRoot: string): InvariantCheck {
  const env = readText(join(hermesRoot, ".env"));
  const config = readText(join(hermesRoot, "config.yaml"));
  const text = env + "\n" + config;
  const missing: string[] = [];
  const present: string[] = [];
  for (const pair of KEY_ENDPOINT_PAIRS) {
    const hasKey = text.split(/\r?\n/).some((line) => pair.keyRe.test(line.trim()));
    if (!hasKey) continue;
    const hasEndpoint = text.split(/\r?\n/).some((line) => pair.endpointRe.test(line.trim()));
    if (hasEndpoint) present.push(pair.label);
    else missing.push(pair.label);
  }
  if (missing.length === 0) {
    return {
      id: "key-endpoint-pairing",
      title: "密钥与接口地址成对",
      status: present.length === 0 ? "pass" : "pass",
      detail:
        present.length === 0
          ? "没有发现需要核对的密钥，本项自动通过。"
          : `${present.join("、")} 的密钥与接口地址都在配置里。`,
      rule: "密钥必须与接口地址成对配置，避免密钥配错端点。",
    };
  }
  return {
    id: "key-endpoint-pairing",
    title: "密钥与接口地址成对",
    status: "warn",
    detail: `发现 ${missing.join("、")} 的密钥，但没有找到对应接口地址，建议补上再使用。`,
    rule: "密钥必须与接口地址成对配置，避免密钥配错端点。",
  };
}

export function createSecurityService(options: SecurityServiceOptions): SecurityService {
  const hermesRoot = resolve(options.hermesRoot);
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousFingerprint: string | null = null;
  let inFlight = false;

  async function status(): Promise<SecurityStatusView> {
      const invariants = [
        checkOpenPolicy(hermesRoot),
        await checkMessageThrottle(hermesRoot, options.gateway),
        checkKeyEndpointPairing(hermesRoot),
      ];
      const secrets = scanSecretFiles(hermesRoot);
      const insecure = secrets.filter((s) => !s.secure);
      return {
        checkedAt: new Date(now()).toISOString(),
        invariants,
        secrets,
        totalSecretFiles: secrets.length,
        insecureSecretFiles: insecure.length,
        message:
          insecure.length === 0
            ? "密钥文件权限正常，面板仅本机可见。"
            : `有 ${insecure.length} 个密钥文件权限过宽，建议尽快改为仅本人可读（0600）。`,
      };
  }

  async function refresh(): Promise<SecurityStatusView> {
    const view = await status();
    const fingerprint = JSON.stringify(
      view.invariants.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
    );
    if (previousFingerprint !== null && previousFingerprint !== fingerprint) {
      await options.onInvariantChange?.(view);
    }
    previousFingerprint = fingerprint;
    return view;
  }

  return {
    status,
    refresh,
    start(): void {
      if (timer !== undefined) return;
      void refresh();
      timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        void refresh().finally(() => {
          inFlight = false;
        });
      }, pollIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
