import { describe, it, expect, vi, afterEach } from "vitest";
import { JevClient } from "../src/typesafe/client.js";

describe("JevClient (TypeSafe System One)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("API Key 配置与可用性", () => {
    it("当未配置 API Key 时，isAvailable 和 isConfigured 均为 false", () => {
      const client = new JevClient({ apiKey: "" });
      expect(client.isConfigured).toBe(false);
      expect(client.isAvailable).toBe(false);
    });

    it("当配置有效 API Key 时，isAvailable 和 isConfigured 均为 true", () => {
      const client = new JevClient({ apiKey: "ts_live_test_key_123" });
      expect(client.isConfigured).toBe(true);
      expect(client.isAvailable).toBe(true);
    });
  });

  describe("systemOne 核心原语与批量评估", () => {
    it("正确向 /v1/systemone 发送结构化 payload 并解析 answers", async () => {
      let capturedUrl = "";
      let capturedBody: any = null;
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse((init?.body as string) || "{}");
        capturedHeaders = (init?.headers as Record<string, string>) || {};

        return {
          ok: true,
          status: 200,
          json: async () => ({
            answers: {
              q_cat: {
                type: "choice",
                choice: "security",
                confidence: 0.95,
                probabilities: { security: 0.95, bug: 0.05 },
              },
              q_score: {
                type: "score",
                score: 4,
                confidence: 0.88,
              },
              q_noul: {
                type: "noul",
                noul: 0.92,
              },
            },
          }),
        };
      });

      const client = new JevClient({ apiKey: "ts_live_key_test" });
      const answers = await client.systemOne({
        state: { test: true },
        questions: {
          q_cat: {
            type: "choice",
            instructions: "分类该漏洞",
            criteria: { security: "安全漏洞", bug: "普通功能缺陷" },
          },
          q_score: {
            type: "score",
            instructions: "评估严重等级",
            criteria: ["低", "中", "高", "严重", "紧急"],
          },
          q_noul: {
            type: "noul",
            instructions: "是否需要立即修复？",
          },
        },
      });

      expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
      expect(capturedHeaders["Authorization"]).toBe("Bearer ts_live_key_test");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedBody.model).toBe("jev-latest");
      expect(Object.keys(capturedBody.questions)).toHaveLength(3);

      expect(answers).toBeDefined();
      expect(answers?.q_cat?.type).toBe("choice");
      expect((answers?.q_cat as any).choice).toBe("security");
      expect((answers?.q_score as any).score).toBe(4);
      expect((answers?.q_noul as any).noul).toBe(0.92);
    });

    it("便利方法 choice, score, noul 均正确转译为 /v1/systemone", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) || "{}");
        const q = body.questions.item;
        if (q.type === "choice") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                item: { type: "choice", choice: "option_a", confidence: 0.91 },
              },
            }),
          };
        }
        if (q.type === "score") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                item: { type: "score", score: 3, confidence: 0.85 },
              },
            }),
          };
        }
        if (q.type === "noul") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                item: { type: "noul", noul: 0.77 },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const client = new JevClient({ apiKey: "ts_live_key_test" });
      const c = await client.choice({
        state: "state_data",
        instructions: "选择方案",
        criteria: { option_a: "方案 A", option_b: "方案 B" },
      });
      expect(c?.choice).toBe("option_a");
      expect(c?.confidence).toBe(0.91);

      const s = await client.score({
        state: "state_data",
        instructions: "打分",
        criteria: ["1", "2", "3", "4", "5"],
      });
      expect(s?.score).toBe(3);

      const n = await client.noul({
        state: "state_data",
        instructions: "是否可行？",
      });
      expect(n?.probability).toBe(0.77);
    });
  });

  describe("adviseMemorySystem 选型顾问", () => {
    it("未配置 API Key 时自动平滑降级为确定性启发式推荐", async () => {
      const client = new JevClient({ apiKey: "" });

      // 场景 1: 低内存环境推荐轻量 SQLite
      const resLowMem = await client.adviseMemorySystem({
        scenario: "小型本地设备轻量运行",
        hardware: { memoryGb: 4 },
      });
      expect(resLowMem.source).toBe("heuristic");
      expect(resLowMem.engine).toBe("hermes");
      expect(resLowMem.mode).toBe("builtin");

      // 场景 2: 高配置反思环境推荐 Hindsight Docker
      const resHighMem = await client.adviseMemorySystem({
        scenario: "深度反思与复杂知识图谱分析",
        hardware: { memoryGb: 32 },
        priorities: { privacy: 5, reasoningDepth: 5 },
      });
      expect(resHighMem.source).toBe("heuristic");
      expect(resHighMem.engine).toBe("hindsight");
      expect(resHighMem.mode).toBe("docker");
    });

    it("配置 API Key 且 Jev 响应正常时，单次请求并发返回 Jev 判定结果", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/systemone")) {
          const body = JSON.parse((init?.body as string) || "{}");
          expect(Object.keys(body.questions)).toHaveLength(2);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                recommendation: {
                  type: "choice",
                  choice: "mem0_docker",
                  confidence: 0.94,
                  probabilities: { mem0_docker: 0.85, hindsight_docker: 0.15 },
                },
                hardwareFit: {
                  type: "score",
                  score: 4,
                  confidence: 0.9,
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const client = new JevClient({ apiKey: "ts_key_ok" });
      const res = await client.adviseMemorySystem({
        scenario: "高频对话长期记忆自适应检索",
        hardware: { memoryGb: 16 },
      });

      expect(res.source).toBe("jev");
      expect(res.engine).toBe("mem0");
      expect(res.mode).toBe("docker");
      expect(res.confidence).toBe(0.94);
      expect(res.hardwareFitScore).toBe(5);
    });
  });

  describe("diagnoseTaskError 任务错误诊断与归因", () => {
    it("未配置 Key 时通过启发式规则精准识别 401 凭据失效", async () => {
      const client = new JevClient({ apiKey: "" });
      const res = await client.diagnoseTaskError({
        taskName: "每日模型巡检",
        errorSnippet: "Error: 401 Unauthorized - Invalid API key provided",
        exitCode: 1,
      });

      expect(res.source).toBe("heuristic");
      expect(res.rootCause).toBe("credential_expired");
      expect(res.severity).toBeGreaterThanOrEqual(4);
      expect(res.recommendedAction).toContain("检查并更新");
    });

    it("未配置 Key 时精准识别 429 限流错误", async () => {
      const client = new JevClient({ apiKey: "" });
      const res = await client.diagnoseTaskError({
        taskName: "数据批量同步",
        errorSnippet: "HTTP 429 Too Many Requests: Rate limit exceeded",
      });

      expect(res.source).toBe("heuristic");
      expect(res.rootCause).toBe("rate_limited");
      expect(res.recommendedAction).toContain("调低定时任务执行频率");
    });

    it("未配置 Key 时精准识别超时终止与 OOM", async () => {
      const client = new JevClient({ apiKey: "" });
      const res = await client.diagnoseTaskError({
        taskName: "深度报告生成",
        errorSnippet: "Command failed: task timed out after 300000ms (SIGKILL)",
        exitCode: 137,
      });

      expect(res.source).toBe("heuristic");
      expect(res.rootCause).toBe("timeout_or_killed");
      expect(res.recommendedAction).toContain("超时时间");
    });

    it("配置 API Key 时正确调用 Jev System One 进行单次批量类型化归因", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/systemone")) {
          const body = JSON.parse((init?.body as string) || "{}");
          expect(Object.keys(body.questions)).toHaveLength(2);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                rootCause: {
                  type: "choice",
                  choice: "network_or_offline",
                  confidence: 0.96,
                },
                severity: {
                  type: "score",
                  score: 3,
                  confidence: 0.91,
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const client = new JevClient({ apiKey: "ts_key_active" });
      const res = await client.diagnoseTaskError({
        taskName: "Hermes 实例心跳同步",
        errorSnippet: "connect ECONNREFUSED 127.0.0.1:8754",
      });

      expect(res.source).toBe("jev");
      expect(res.rootCause).toBe("network_or_offline");
      expect(res.severity).toBe(4);
      expect(res.confidence).toBe(0.96);
      expect(res.recommendedAction).toContain("网络连接与宿主 Hermes 网关");
    });
  });

  describe("triageMessage 即时消息分流判定", () => {
    it("未配置 Key 时对于待审批和待确认消息标记为紧急打扰", async () => {
      const client = new JevClient({ apiKey: "" });
      const res = await client.triageMessage({
        channel: "telegram",
        sender: "Hermes Agent",
        summary: "是否允许执行高危操作：重启 Docker 容器并更新网关配置？",
        status: "pending_approval",
      });

      expect(res.source).toBe("heuristic");
      expect(res.requiresUrgentAttention).toBe(true);
      expect(res.category).toBe("approval_request");
    });

    it("未配置 Key 时对于普通任务完成播报标记为不打扰", async () => {
      const client = new JevClient({ apiKey: "" });
      const res = await client.triageMessage({
        channel: "webhook",
        summary: "定时巡检报告已成功完成，全量指标健康。",
        status: "delivered",
      });

      expect(res.source).toBe("heuristic");
      expect(res.requiresUrgentAttention).toBe(false);
      expect(res.category).toBe("task_completion");
    });

    it("配置 API Key 时调用 Jev System One 批量获得类型化概率与分类", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/systemone")) {
          const body = JSON.parse((init?.body as string) || "{}");
          expect(Object.keys(body.questions)).toHaveLength(2);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              answers: {
                is_urgent: {
                  type: "noul",
                  noul: 0.88,
                },
                category: {
                  type: "choice",
                  choice: "critical_failure",
                  confidence: 0.95,
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const client = new JevClient({ apiKey: "ts_key_msg" });
      const res = await client.triageMessage({
        channel: "slack",
        summary: "Hermes 网关 Bridge 进程意外断开，Outbox 消息积压超过 50 条",
        status: "failed",
      });

      expect(res.source).toBe("jev");
      expect(res.requiresUrgentAttention).toBe(true);
      expect(res.urgencyProbability).toBe(0.88);
      expect(res.category).toBe("critical_failure");
    });
  });
});
