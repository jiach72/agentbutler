import type { FastifyInstance } from "fastify";
import type { UnifiedModelOption } from "@butler/contract";
import { defaultOllamaService } from "../ollama-service.js";
import type { ProxyHelpers } from "../proxy-helpers.js";

export interface ModelRouteOptions {
  ollamaUrl: string;
  proxy: ProxyHelpers;
  doFetch: typeof fetch;
  watchUrl: string;
}

interface CredentialItem {
  id: string;
  name: string;
  category: string;
  envVar: string;
  provider: string;
  endpoint: string | null;
  maskedKey: string;
  status: string;
  probeStatus: "pass" | "fail" | "unknown";
  probeDetail: string | null;
}

interface ProfileItem {
  profileId: string;
  provider: string;
  protocol: "openai-compatible" | "anthropic" | "gemini";
  endpoint: string;
  model: string;
  status: string;
  maskedKey: string;
  probe: { status: "pass" | "fail"; detail: string } | null;
}

const KNOWN_PROVIDER_MODELS: Record<string, Array<{ model: string; name: string; isLowCost?: boolean }>> = {
  deepseek: [
    { model: "deepseek-chat", name: "DeepSeek V3", isLowCost: true },
    { model: "deepseek-reasoner", name: "DeepSeek R1 (推理)" },
  ],
  openai: [
    { model: "gpt-4o", name: "GPT-4o" },
    { model: "gpt-4o-mini", name: "GPT-4o mini", isLowCost: true },
    { model: "o3-mini", name: "o3-mini (推理)", isLowCost: true },
  ],
  anthropic: [
    { model: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
    { model: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", isLowCost: true },
  ],
  dashscope: [
    { model: "qwen-plus", name: "通义千问 Plus", isLowCost: true },
    { model: "qwen-turbo", name: "通义千问 Turbo", isLowCost: true },
    { model: "qwen-max", name: "通义千问 Max" },
  ],
  qwen: [
    { model: "qwen-plus", name: "通义千问 Plus", isLowCost: true },
    { model: "qwen-turbo", name: "通义千问 Turbo", isLowCost: true },
    { model: "qwen-max", name: "通义千问 Max" },
  ],
  zhipu: [
    { model: "glm-4-flash", name: "GLM-4 Flash (轻量/高性价比)", isLowCost: true },
    { model: "glm-4-plus", name: "GLM-4 Plus" },
  ],
  moonshot: [
    { model: "moonshot-v1-8k", name: "Kimi 8K", isLowCost: true },
    { model: "moonshot-v1-32k", name: "Kimi 32K" },
  ],
  google: [
    { model: "gemini-1.5-flash", name: "Gemini 1.5 Flash", isLowCost: true },
    { model: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
    { model: "gemini-2.0-flash", name: "Gemini 2.0 Flash", isLowCost: true },
  ],
};

function defaultEndpointForProvider(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "deepseek") return "https://api.deepseek.com/v1";
  if (p === "openai") return "https://api.openai.com/v1";
  if (p === "anthropic") return "https://api.anthropic.com";
  if (p === "dashscope" || p === "qwen") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (p === "zhipu") return "https://open.bigmodel.cn/api/paas/v4";
  if (p === "moonshot") return "https://api.moonshot.cn/v1";
  if (p === "google") return "https://generativelanguage.googleapis.com";
  return "https://api.openai.com/v1";
}

/**
 * 统一模型中枢路由插件：
 * - GET /api/models/unified-options：聚合本地 Ollama 模型 + 已存商业 API 凭据 + Profile
 * - GET /api/models/primary：获取当前系统主模型
 * - POST /api/models/primary：安全更新主模型（带时间戳备份）
 */
export async function registerModelRoutes(
  app: FastifyInstance,
  options: ModelRouteOptions,
): Promise<void> {
  const { ollamaUrl, proxy, doFetch, watchUrl } = options;
  const { proxyWatchGet, proxyWatchPost } = proxy;

  /** 1. 统一模型候选池聚合接口 */
  app.get("/api/models/unified-options", async () => {
    const unifiedOptions: UnifiedModelOption[] = [];

    // A. 读取本地 Ollama 模型
    try {
      const ollamaRes = await defaultOllamaService.getModels(ollamaUrl);
      if (ollamaRes.ok && Array.isArray(ollamaRes.models)) {
        for (const m of ollamaRes.models) {
          const isEmbedding =
            m.name.toLowerCase().includes("embed") ||
            m.details?.family?.toLowerCase().includes("bert") === true;

          unifiedOptions.push({
            id: `ollama:${m.name}`,
            name: `${m.name} (本地 Ollama)`,
            provider: "ollama",
            model: m.name,
            protocol: "openai-compatible",
            endpoint: `${ollamaUrl}/v1`,
            source: "ollama",
            category: "local",
            costCategory: "free",
            ready: true,
            probeStatus: "pass",
            isEmbedding,
            description: isEmbedding
              ? `向量嵌入模型 · 体积: ${m.sizeFormatted}`
              : `本地免成本 · 体积: ${m.sizeFormatted}`,
          });
        }
      }
    } catch {
      // Ollama 离线或不可达时优雅降级
    }

    // B. 读取已保存的受管 API 密钥凭据 (Watch /api/credentials)
    try {
      const credRes = await doFetch(`${watchUrl}/api/credentials`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (credRes.ok) {
        const credData = (await credRes.json()) as { credentials?: CredentialItem[] };
        const credentials = credData.credentials ?? [];

        for (const cred of credentials) {
          if (cred.category !== "llm" && cred.category !== "custom") continue;

          const providerKey = cred.provider.toLowerCase();
          const knownList = KNOWN_PROVIDER_MODELS[providerKey];

          if (knownList && knownList.length > 0) {
            for (const item of knownList) {
              unifiedOptions.push({
                id: `cred:${cred.id}:${item.model}`,
                name: `${item.name} (${cred.name})`,
                provider: cred.provider,
                model: item.model,
                protocol:
                  cred.provider.toLowerCase() === "anthropic"
                    ? "anthropic"
                    : cred.provider.toLowerCase() === "google"
                      ? "gemini"
                      : "openai-compatible",
                endpoint: cred.endpoint || defaultEndpointForProvider(cred.provider),
                source: "credential",
                category: "cloud",
                costCategory: item.isLowCost ? "low" : "standard",
                ready: cred.probeStatus === "pass" || cred.status === "active",
                probeStatus: cred.probeStatus,
                probeDetail: cred.probeDetail ?? undefined,
                envVar: cred.envVar,
                maskedKey: cred.maskedKey,
                description: `${cred.name} · ${cred.envVar}`,
              });
            }
          } else {
            // 自定义或者未在预设中的 LLM 服务商
            unifiedOptions.push({
              id: `cred:${cred.id}:default`,
              name: `${cred.name} (自定义模型)`,
              provider: cred.provider,
              model: cred.provider,
              protocol: "openai-compatible",
              endpoint: cred.endpoint || defaultEndpointForProvider(cred.provider),
              source: "credential",
              category: "cloud",
              costCategory: "standard",
              ready: cred.probeStatus === "pass" || cred.status === "active",
              probeStatus: cred.probeStatus,
              probeDetail: cred.probeDetail ?? undefined,
              envVar: cred.envVar,
              maskedKey: cred.maskedKey,
              description: `${cred.name} · ${cred.envVar}`,
            });
          }
        }
      }
    } catch {
      // Watch 暂时不可达时忽略
    }

    // C. 读取已存在的受管 Profile (Watch /api/llm/profiles)
    try {
      const profRes = await doFetch(`${watchUrl}/api/llm/profiles`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (profRes.ok) {
        const profData = (await profRes.json()) as { profiles?: ProfileItem[] };
        const profiles = profData.profiles ?? [];

        for (const profile of profiles) {
          const isOllama =
            profile.provider.toLowerCase().includes("ollama") ||
            profile.profileId.startsWith("ollama-") ||
            /11434/.test(profile.endpoint);

          // 严格去重：本地 Ollama 模型只要 model 名称一致即视为同一项；云端模型按 provider/model 去重
          const alreadyIncluded = unifiedOptions.some((opt) => {
            if (opt.model.toLowerCase() !== profile.model.toLowerCase()) return false;
            if (isOllama && (opt.source === "ollama" || opt.category === "local" || opt.provider.toLowerCase().includes("ollama"))) {
              return true;
            }
            const p1 = opt.provider.toLowerCase().replace(/[^a-z0-9]/g, "");
            const p2 = profile.provider.toLowerCase().replace(/[^a-z0-9]/g, "");
            return p1 === p2 || p1.includes(p2) || p2.includes(p1);
          });

          if (!alreadyIncluded) {
            const isEmbedding =
              profile.model.toLowerCase().includes("embed") ||
              profile.provider.toLowerCase().includes("embed");

            unifiedOptions.push({
              id: `profile:${profile.profileId}`,
              name: `${profile.model} (${profile.provider})`,
              provider: isOllama ? "ollama" : profile.provider,
              model: profile.model,
              protocol: profile.protocol,
              endpoint: profile.endpoint,
              source: isOllama ? "ollama" : "profile",
              category: isOllama ? "local" : "cloud",
              costCategory: isOllama ? "free" : "standard",
              ready: profile.status === "active" || profile.probe?.status === "pass",
              probeStatus: profile.probe?.status ?? "unknown",
              probeDetail: profile.probe?.detail ?? undefined,
              maskedKey: profile.maskedKey,
              isEmbedding,
              description: isOllama
                ? "本地免成本模型 (来自 Profile)"
                : `Profile 配置: ${profile.provider}`,
            });
          }
        }
      }
    } catch {
      // 容错处理
    }

    // 最终防御性去重：确保同名本地模型绝对只出现一条，同服务商同模型绝对只出现一条
    const finalOptions: UnifiedModelOption[] = [];
    const seenOptionKeys = new Set<string>();
    for (const opt of unifiedOptions) {
      const isLocal =
        opt.category === "local" ||
        opt.source === "ollama" ||
        opt.provider.toLowerCase().includes("ollama");
      const key = isLocal
        ? `local:${opt.model.toLowerCase()}`
        : `${opt.provider.toLowerCase().replace(/[^a-z0-9]/g, "")}:${opt.model.toLowerCase()}`;
      if (!seenOptionKeys.has(key)) {
        seenOptionKeys.add(key);
        finalOptions.push(opt);
      }
    }

    // 排序策略：本地零成本模型 (free) 优先置顶，其次是低成本 (low)，最后是商业按量 (standard)
    finalOptions.sort((a, b) => {
      const rank = (c: string) => (c === "free" ? 0 : c === "low" ? 1 : 2);
      if (rank(a.costCategory) !== rank(b.costCategory)) {
        return rank(a.costCategory) - rank(b.costCategory);
      }
      return a.name.localeCompare(b.name, "zh-CN");
    });

    return { ok: true, options: finalOptions };
  });

  /** 2. 主模型读取代理 */
  app.get("/api/models/primary", async (_request, reply) => {
    return proxyWatchGet("/api/models/primary", reply);
  });

  /** 3. 主模型修改代理 */
  app.post("/api/models/primary", async (request, reply) => {
    return proxyWatchPost("/api/models/primary", request.body, reply, 30_000);
  });
}
