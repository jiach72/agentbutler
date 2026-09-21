import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretVault } from "./llm-credentials.js";
import type { SqliteStore } from "./store.js";
import type {
  ApiCredentialCategory,
  ApiCredentialRow,
  ApiCredentialStatus,
} from "./repositories/api-credentials.js";
import { atomicWriteText } from "./atomic-write.js";

export interface ApiCredentialPreset {
  id: string;
  name: string;
  category: ApiCredentialCategory;
  envVar: string;
  provider: string;
  docsUrl: string;
  description: string;
  defaultEndpoint?: string;
  probeType: "http-get" | "http-post" | "none";
}

export const API_CREDENTIAL_PRESETS: ApiCredentialPreset[] = [
  // Web Search
  {
    id: "preset-tavily",
    name: "Tavily Search",
    category: "search",
    envVar: "TAVILY_API_KEY",
    provider: "tavily",
    docsUrl: "https://tavily.com",
    description: "专为 AI Agent 优化的搜索与网页提取 API",
    probeType: "http-post",
  },
  {
    id: "preset-brave",
    name: "Brave Search",
    category: "search",
    envVar: "BRAVE_API_KEY",
    provider: "brave",
    docsUrl: "https://brave.com/search/api",
    description: "独立隐私搜索引擎 API，提供丰富网页索引",
    probeType: "http-get",
  },
  {
    id: "preset-serper",
    name: "Serper (Google Search)",
    category: "search",
    envVar: "SERPER_API_KEY",
    provider: "serper",
    docsUrl: "https://serper.dev",
    description: "极速稳定的 Google 搜索结果 API",
    probeType: "http-post",
  },
  {
    id: "preset-exa",
    name: "Exa Search",
    category: "search",
    envVar: "EXA_API_KEY",
    provider: "exa",
    docsUrl: "https://exa.ai",
    description: "面向语义与嵌入的神经搜索引擎 API",
    probeType: "http-post",
  },
  {
    id: "preset-bing",
    name: "Bing Search",
    category: "search",
    envVar: "BING_API_KEY",
    provider: "bing",
    docsUrl: "https://azure.microsoft.com/services/cognitive-services/bing-web-search-api",
    description: "微软 Bing 网页检索服务",
    probeType: "http-get",
  },

  // Vision
  {
    id: "preset-google-vision",
    name: "Google Gemini Vision",
    category: "vision",
    envVar: "GOOGLE_API_KEY",
    provider: "google",
    docsUrl: "https://aistudio.google.com",
    description: "Google 视觉多模态理解能力（Hermes 原生支持）",
    probeType: "http-get",
  },
  {
    id: "preset-openai-vision",
    name: "OpenAI Vision",
    category: "vision",
    envVar: "OPENAI_API_KEY",
    provider: "openai",
    docsUrl: "https://platform.openai.com",
    description: "OpenAI GPT-4o / 多模态视觉接口",
    probeType: "http-get",
  },

  // LLM Models
  {
    id: "preset-deepseek",
    name: "DeepSeek",
    category: "llm",
    envVar: "DEEPSEEK_API_KEY",
    provider: "deepseek",
    docsUrl: "https://platform.deepseek.com",
    description: "DeepSeek 大语言模型与推理模型",
    probeType: "http-get",
  },
  {
    id: "preset-anthropic",
    name: "Anthropic Claude",
    category: "llm",
    envVar: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    docsUrl: "https://console.anthropic.com",
    description: "Anthropic Claude 系列模型",
    probeType: "http-get",
  },
  {
    id: "preset-moonshot",
    name: "Moonshot / Kimi",
    category: "llm",
    envVar: "MOONSHOT_API_KEY",
    provider: "moonshot",
    docsUrl: "https://platform.moonshot.cn",
    description: "Moonshot Kimi 长文本大模型",
    probeType: "http-get",
  },
  {
    id: "preset-qwen",
    name: "阿里百炼 / 通义千问",
    category: "llm",
    envVar: "DASHSCOPE_API_KEY",
    provider: "dashscope",
    docsUrl: "https://dashscope.console.aliyun.com",
    description: "阿里云百炼大模型服务平台",
    probeType: "http-get",
  },
  {
    id: "preset-zhipu",
    name: "智谱 GLM",
    category: "llm",
    envVar: "ZHIPUAI_API_KEY",
    provider: "zhipu",
    docsUrl: "https://open.bigmodel.cn",
    description: "智谱 BigModel 开放平台",
    probeType: "http-get",
  },

  // Memory & Tools
  {
    id: "preset-hindsight",
    name: "Hindsight 知识图谱记忆",
    category: "memory",
    envVar: "HINDSIGHT_API_KEY",
    provider: "hindsight",
    docsUrl: "https://hindsight.vectorize.io",
    description: "图谱记忆与跨会话 Reflect 综合推理服务",
    defaultEndpoint: "https://api.hindsight.vectorize.io",
    probeType: "http-get",
  },
  {
    id: "preset-mem0",
    name: "Mem0 记忆服务",
    category: "memory",
    envVar: "MEM0_API_KEY",
    provider: "mem0",
    docsUrl: "https://mem0.ai",
    description: "智能体长期记忆平台",
    probeType: "http-get",
  },
  {
    id: "preset-typesafe",
    name: "TypeSafe (Jev)",
    category: "llm",
    envVar: "TYPESAFE_API_KEY",
    provider: "typesafe",
    docsUrl: "https://typesafe.ai",
    description: "TypeSafe Jev System One 类型化判断与决策模型",
    defaultEndpoint: "https://api.typesafe.ai",
    probeType: "http-get",
  },
  {
    id: "preset-github",
    name: "GitHub Token",
    category: "tool",
    envVar: "GITHUB_TOKEN",
    provider: "github",
    docsUrl: "https://github.com/settings/tokens",
    description: "GitHub 访问令牌，用于技能安装与 API 提额",
    probeType: "http-get",
  },
  {
    id: "preset-e2b",
    name: "E2B Code Sandbox",
    category: "tool",
    envVar: "E2B_API_KEY",
    provider: "e2b",
    docsUrl: "https://e2b.dev",
    description: "云端安全代码执行沙箱",
    probeType: "http-get",
  },
];

export interface ApiCredentialView {
  id: string;
  name: string;
  category: ApiCredentialCategory;
  envVar: string;
  provider: string;
  endpoint: string | null;
  maskedKey: string;
  status: ApiCredentialStatus;
  probeStatus: "pass" | "fail" | "unknown";
  probeCategory: string | null;
  probeDetail: string | null;
  probedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isPreset: boolean;
  docsUrl?: string;
  description?: string;
}

export interface SaveApiCredentialInput {
  id?: string;
  name: string;
  category: ApiCredentialCategory;
  envVar: string;
  provider: string;
  endpoint?: string | null;
  apiKey: string;
  status?: ApiCredentialStatus;
}

export class ApiKeyCredentialService {
  constructor(
    private readonly store: SqliteStore,
    private readonly vault: SecretVault,
  ) {}

  /** 列出所有受管 API 密钥（含脱敏掩码与预设元信息）。 */
  listCredentials(): ApiCredentialView[] {
    const rows = this.store.credentials.listAll();
    return rows.map((row) => this.toView(row));
  }

  /** 获取解密后的明文密钥（仅供内部探活与同步写入使用）。 */
  getDecryptedKey(id: string): string | null {
    if (!this.vault.available) return null;
    const row = this.store.credentials.getById(id);
    if (!row) return null;
    try {
      return this.vault.decrypt({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
      });
    } catch {
      return null;
    }
  }

  /** 获取解密后的明文密钥（按环境变量名查询）。 */
  getDecryptedKeyByEnvVar(envVar: string): string | null {
    if (!this.vault.available) return null;
    const row = this.store.credentials.getByEnvVar(envVar);
    if (!row) return null;
    try {
      return this.vault.decrypt({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
      });
    } catch {
      return null;
    }
  }

  /** 新增或更新 API 密钥并加密保存。 */
  saveCredential(input: SaveApiCredentialInput): ApiCredentialView {
    if (!this.vault.available) {
      throw new Error("secret-vault-unavailable");
    }
    const envVar = input.envVar.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(envVar)) {
      throw new Error("invalid-env-var-name");
    }
    if (!input.apiKey || input.apiKey.trim() === "") {
      throw new Error("empty-api-key");
    }

    const envelope = this.vault.encrypt(input.apiKey.trim());
    const saved = this.store.credentials.upsert({
      id: input.id,
      name: input.name.trim(),
      category: input.category,
      envVar,
      provider: input.provider.trim(),
      endpoint: input.endpoint ? input.endpoint.trim() : null,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      keyVersion: envelope.keyVersion,
      status: input.status ?? "active",
    });

    return this.toView(saved);
  }

  /** 删除指定的 API 密钥。 */
  deleteCredential(id: string): boolean {
    return this.store.credentials.deleteById(id);
  }

  /** 更新连通性测试探针结果。 */
  updateProbe(
    id: string,
    probeStatus: "pass" | "fail",
    probeCategory: string,
    probeDetail: string,
  ): boolean {
    return this.store.credentials.updateProbeResult(id, probeStatus, probeCategory, probeDetail);
  }

  /**
   * 将当前数据库中全部受管活跃密钥安全同步回写至 ~/.hermes/.env。
   * - 维持 0600 权限基线；
   * - 保留原有的注释与非受管变量；
   * - 写入前自动备份（.env.bak）。
   */
  async syncToHermesEnv(hermesRoot: string): Promise<{ updated: number; path: string }> {
    if (!this.vault.available) {
      throw new Error("secret-vault-unavailable");
    }
    const envPath = join(hermesRoot, ".env");
    const credentials = this.store.credentials.listAll();
    const managedMap = new Map<string, { value: string; status: ApiCredentialStatus }>();

    for (const cred of credentials) {
      try {
        const decrypted = this.vault.decrypt({
          ciphertext: cred.ciphertext,
          nonce: cred.nonce,
          authTag: cred.authTag,
        });
        managedMap.set(cred.envVar, { value: decrypted, status: cred.status });
      } catch {
        // 忽略解密失败项
      }
    }

    let originalLines: string[] = [];
    if (existsSync(envPath)) {
      try {
        const raw = readFileSync(envPath, "utf8");
        originalLines = raw.split("\n");
      } catch {
        originalLines = [];
      }
    }

    const processedKeys = new Set<string>();
    const newLines: string[] = [];

    for (const line of originalLines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) {
        newLines.push(line);
        continue;
      }

      const eqIndex = line.indexOf("=");
      const key = line.slice(0, eqIndex).trim().toUpperCase();

      if (managedMap.has(key)) {
        processedKeys.add(key);
        const item = managedMap.get(key)!;
        if (item.status === "active") {
          newLines.push(`${key}="${item.value}"`);
        } else {
          // 已禁用的保留为注释
          newLines.push(`# ${key}="${item.value}" (disabled via Agent Butler)`);
        }
      } else {
        newLines.push(line);
      }
    }

    // 追加未在文件中存在的活跃受管变量
    let hasAppended = false;
    for (const [key, item] of managedMap.entries()) {
      if (!processedKeys.has(key) && item.status === "active") {
        if (!hasAppended) {
          newLines.push("");
          newLines.push("# Managed by Agent Butler API Credentials");
          hasAppended = true;
        }
        newLines.push(`${key}="${item.value}"`);
      }
    }

    const outputContent = newLines.join("\n").replace(/\n+$/, "\n");

    // 备份原有 .env
    if (existsSync(envPath)) {
      try {
        const backupPath = join(hermesRoot, ".env.bak");
        atomicWriteText(backupPath, readFileSync(envPath, "utf8"), { mode: 0o600 });
      } catch {
        // 备份尽力而为
      }
    }

    atomicWriteText(envPath, outputContent, { mode: 0o600, description: "Hermes .env 同步" });
    return { updated: managedMap.size, path: envPath };
  }

  /** 从 ~/.hermes/.env 中移除指定的环境变量行。 */
  removeEnvVarFromHermesEnv(hermesRoot: string, envVar: string): boolean {
    const envPath = join(hermesRoot, ".env");
    if (!existsSync(envPath)) return false;
    try {
      const raw = readFileSync(envPath, "utf8");
      const upperVar = envVar.trim().toUpperCase();
      const lines = raw.split("\n");
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) return true;
        const key = trimmed.slice(0, trimmed.indexOf("=")).trim().toUpperCase();
        return key !== upperVar;
      });
      atomicWriteText(envPath, filtered.join("\n").replace(/\n+$/, "\n"), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 首次启动/初始化时全量强制迁移：
   * 自动扫描 ~/.hermes/.env 中的全部已知及候选 Key，加密受管接管。
   */
  async autoMigrateFromHermesEnv(
    hermesRoot: string,
  ): Promise<{ migratedCount: number; keys: string[] }> {
    if (!this.vault.available) return { migratedCount: 0, keys: [] };
    const envPath = join(hermesRoot, ".env");
    if (!existsSync(envPath)) return { migratedCount: 0, keys: [] };

    let raw: string;
    try {
      raw = readFileSync(envPath, "utf8");
    } catch {
      return { migratedCount: 0, keys: [] };
    }

    const migratedKeys: string[] = [];
    const lines = raw.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

      const eqIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIndex).trim().toUpperCase();
      let value = trimmed.slice(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).trim();
      }

      if (!value || value === "") continue;

      // 判断是否是候选 API Key 变量
      const isKnownPreset = API_CREDENTIAL_PRESETS.some((p) => p.envVar === key);
      const isKeyCandidate =
        isKnownPreset ||
        /(?:API_KEY|ACCESS_TOKEN|_TOKEN|_SECRET|_KEY)$/i.test(key);

      if (!isKeyCandidate) continue;

      // 检查是否已经在 SQLite 中受管
      const existing = this.store.credentials.getByEnvVar(key);
      if (existing) continue;

      // 自动识别类别和预设
      const preset = API_CREDENTIAL_PRESETS.find((p) => p.envVar === key);
      const category: ApiCredentialCategory = preset
        ? preset.category
        : /search/i.test(key)
          ? "search"
          : /vision/i.test(key)
            ? "vision"
            : /model|llm|openai|deepseek|claude|gemini/i.test(key)
              ? "llm"
              : /token/i.test(key)
                ? "tool"
                : "custom";

      const name = preset ? preset.name : key;
      const provider = preset ? preset.provider : key.toLowerCase().replace(/[^a-z0-9]+/g, "_");

      try {
        const envelope = this.vault.encrypt(value);
        this.store.credentials.upsert({
          name,
          category,
          envVar: key,
          provider,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          authTag: envelope.authTag,
          keyVersion: envelope.keyVersion,
          status: "active",
        });
        migratedKeys.push(key);
      } catch {
        // 忽略单条加密失败
      }
    }

    return { migratedCount: migratedKeys.length, keys: migratedKeys };
  }

  private toView(row: ApiCredentialRow): ApiCredentialView {
    const preset = API_CREDENTIAL_PRESETS.find((p) => p.envVar === row.envVar);
    let maskedKey = "******";
    if (this.vault.available) {
      try {
        const decrypted = this.vault.decrypt({
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.authTag,
        });
        maskedKey = this.vault.mask(decrypted);
      } catch {
        maskedKey = "******";
      }
    }

    return {
      id: row.id,
      name: row.name,
      category: row.category,
      envVar: row.envVar,
      provider: row.provider,
      endpoint: row.endpoint,
      maskedKey,
      status: row.status,
      probeStatus: row.probeStatus,
      probeCategory: row.probeCategory,
      probeDetail: row.probeDetail,
      probedAt: row.probedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isPreset: Boolean(preset),
      docsUrl: preset?.docsUrl,
      description: preset?.description,
    };
  }
}
