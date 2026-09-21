import type { FastifyInstance } from "fastify";
import { defaultOllamaService, detectHardwareProfile, evaluateHardwareTier } from "../ollama-service.js";
import type { OllamaUsageStore } from "../ollama-usage-store.js";

export interface OllamaRouteOptions {
  ollamaUrl: string;
  ollamaUsageStore?: OllamaUsageStore | null;
}

/**
 * Ollama 本地模型管理路由插件。
 */
export async function registerOllamaRoutes(
  app: FastifyInstance,
  options: OllamaRouteOptions,
): Promise<void> {
  const { ollamaUrl, ollamaUsageStore } = options;

  /** Ollama 服务健康与版本探活 */
  app.get("/api/ollama/status", async () => {
    return defaultOllamaService.getStatus(ollamaUrl);
  });

  /** 动态读取当前宿主机客观硬件档案与自适应推荐模型 */
  app.get("/api/ollama/hardware-profile", async () => {
    const hw = detectHardwareProfile();
    const evaluation = evaluateHardwareTier(hw);
    return { hardware: hw, evaluation };
  });

  /** 获取 Ollama 当前已下载的模型列表 */
  app.get("/api/ollama/models", async () => {
    return defaultOllamaService.getModels(ollamaUrl);
  });

  /** 发起拉取新模型任务 */
  app.post("/api/ollama/pull", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const name = typeof body?.["name"] === "string" ? body["name"] : "";
    if (!name.trim()) {
      return reply.status(400).send({ ok: false, message: "模型名称不能为空" });
    }
    return defaultOllamaService.pullModel(ollamaUrl, name);
  });

  /** 获取当前活跃拉取进度 */
  app.get("/api/ollama/pull-status", async () => {
    return { pull: defaultOllamaService.getPullStatus() };
  });

  /** 删除本地已下载的模型 */
  app.delete("/api/ollama/models/:name", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const name = params["name"] || "";
    if (!name) {
      return reply.status(400).send({ ok: false, message: "模型名称不能为空" });
    }
    return defaultOllamaService.deleteModel(ollamaUrl, name);
  });

  /** 发起在线模型对话测试并记录 Token 与吞吐 */
  app.post("/api/ollama/test-chat", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const model = typeof body?.["model"] === "string" ? body["model"].trim() : "";
    const prompt = typeof body?.["prompt"] === "string" ? body["prompt"].trim() : "";
    const system = typeof body?.["system"] === "string" ? body["system"].trim() : undefined;
    if (!model) {
      return reply.status(400).send({ ok: false, message: "模型名称不能为空" });
    }
    if (!prompt) {
      return reply.status(400).send({ ok: false, message: "测试提示词不能为空" });
    }
    return defaultOllamaService.testChat(ollamaUrl, model, prompt, {
      system,
      usageStore: ollamaUsageStore ?? undefined,
    });
  });

  /** 获取最近每日 Token 调用量与汇总指标 */
  app.get("/api/ollama/usage/summary", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const days = query["days"] ? Number(query["days"]) : 14;
    const summary = ollamaUsageStore
      ? ollamaUsageStore.getDailySummary(days)
      : {
          todayCalls: 0,
          todayPromptTokens: 0,
          todayCompletionTokens: 0,
          todayTokens: 0,
          totalCalls: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          avgTokensPerSecond: 0,
          dailyHistory: [],
        };
    return { ok: true, summary };
  });

  /** 获取最近调用明细记录 */
  app.get("/api/ollama/usage/records", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = query["limit"] ? Number(query["limit"]) : 20;
    const records = ollamaUsageStore ? ollamaUsageStore.getRecentRecords(limit) : [];
    return { ok: true, records };
  });
}
