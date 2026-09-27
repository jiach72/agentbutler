/**
 * 统一模型与凭据枢纽契约：
 * 统一抽象本地模型（Ollama）与云端商业模型（API Key / Profile），
 * 为系统主模型、记忆探针、记忆库与受管任务提供统一直接点选能力。
 */

export type ModelCostCategory = "free" | "low" | "standard";
export type ModelSourceType = "ollama" | "credential" | "profile" | "discovered";

export interface UnifiedModelOption {
  /** 唯一标识，例如 "ollama:qwen2.5:0.5b" 或 "cred:preset-deepseek:deepseek-chat" */
  id: string;
  /** 友好展示名，例如 "Qwen 2.5 0.5B (本地 Ollama)" 或 "DeepSeek V3 (已配置 Key)" */
  name: string;
  /** 提供商标识，如 "ollama", "deepseek", "openai", "dashscope", "anthropic" 等 */
  provider: string;
  /** 实际模型标识，如 "qwen2.5:0.5b", "deepseek-chat" */
  model: string;
  /** 协议类型 */
  protocol: "openai-compatible" | "anthropic" | "gemini";
  /** 服务端点 Base URL */
  endpoint: string;
  /** 来源类型 */
  source: ModelSourceType;
  /** 部署类型：本地 vs 云端 */
  category: "local" | "cloud";
  /** 计费分类：free(0成本), low(高性价比/轻量), standard(商业按量) */
  costCategory: ModelCostCategory;
  /** 是否可用（本地服务在线或已存有有效 Key） */
  ready: boolean;
  /** 连通性测试状态 */
  probeStatus?: "pass" | "fail" | "unknown";
  probeDetail?: string;
  /** 绑定的环境变量名（若来自 API Key，如 DEEPSEEK_API_KEY） */
  envVar?: string;
  /** 脱敏 Key（若存在） */
  maskedKey?: string;
  /** 是否为向量嵌入模型（无法执行聊天与事实抽取） */
  isEmbedding?: boolean;
  /** 模型体积或描述说明（如 "397 MB"、"官方大语言模型"） */
  description?: string;
}

export interface PrimaryModelConfig {
  provider: string;
  model: string;
  endpoint: string;
  source: ModelSourceType;
  selectedOptionId?: string;
  updatedAt?: string;
}

export interface MemoryProbeConfig {
  intervalMin: number;
  modelId?: string;
  modelName?: string;
  endpoint?: string;
  isLocal?: boolean;
}
