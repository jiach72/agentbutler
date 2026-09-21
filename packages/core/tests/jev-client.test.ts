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

    it("配置 API Key 且 Jev 响应正常时，返回 Jev 判定结果", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/choice")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choice: "mem0_docker",
              confidence: 0.94,
              probabilities: { mem0_docker: 0.85, hindsight_docker: 0.15 },
            }),
          };
        }
        if (url.includes("/v1/score")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              score: 5,
              confidence: 0.9,
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

    it("配置 API Key 时正确调用 Jev Choice & Score 进行类型化归因", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/choice")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choice: "network_or_offline",
              confidence: 0.96,
            }),
          };
        }
        if (url.includes("/v1/score")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              score: 4,
              confidence: 0.91,
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

    it("配置 API Key 时调用 Jev Noul 与 Choice 获得类型化概率与分类", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/noul")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              probability: 0.88,
            }),
          };
        }
        if (url.includes("/v1/choice")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choice: "critical_failure",
              confidence: 0.95,
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
