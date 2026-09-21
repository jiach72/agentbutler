import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JevClient } from "../src/typesafe/client.js";

describe("JevClient (TypeSafe)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("当未配置 API Key 时，isAvailable 为 false 且 adviseMemorySystem 自动降级为启发式推荐", async () => {
    const client = new JevClient({ apiKey: "" });
    expect(client.isAvailable).toBe(false);

    // 场景 1: 充足内存推荐 Hindsight (Docker)
    const res1 = await client.adviseMemorySystem({
      scenario: "日常自动化助理，需要复杂推理与事实追踪",
      expectedQps: 5,
      retentionMonths: 6,
      localMemoryGb: 16,
      needsGraph: true,
      hasDocker: true,
    });

    expect(res1.usedFallback).toBe(true);
    expect(res1.recommendation.engineId).toBe("hindsight");
    expect(res1.recommendation.deployMode).toBe("docker");
    expect(res1.recommendation.confidence).toBeGreaterThanOrEqual(0.8);
    expect(res1.recommendation.rationale).toContain("启发式规则推荐");

    // 场景 2: 内存不足 (4GB) 且强调轻量
    const res2 = await client.adviseMemorySystem({
      scenario: "资源受限设备轻量运行",
      expectedQps: 1,
      retentionMonths: 1,
      localMemoryGb: 4,
      needsGraph: false,
      hasDocker: false,
    });

    expect(res2.usedFallback).toBe(true);
    expect(res2.recommendation.engineId).toBe("sqlite");
    expect(res2.recommendation.deployMode).toBe("local");
  });

  it("当配置了 API Key 时，isAvailable 为 true，并正确通过 Jev 判定接口返回结构化结果", async () => {
    const mockResponseData = {
      judgment: "hindsight",
      confidence: 0.95,
      tokens_used: 120,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponseData,
    }) as any;

    const client = new JevClient({ apiKey: "ts_test_key_123" });
    expect(client.isAvailable).toBe(true);

    const res = await client.adviseMemorySystem({
      scenario: "需要跨会话知识图谱与反思提炼",
      expectedQps: 10,
      retentionMonths: 12,
      localMemoryGb: 32,
      needsGraph: true,
      hasDocker: true,
    });

    expect(res.usedFallback).toBe(false);
    expect(res.recommendation.engineId).toBe("hindsight");
    expect(res.recommendation.confidence).toBe(0.95);
    expect(res.tokensUsed).toBe(120);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/choice"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ts_test_key_123",
        }),
      })
    );
  });

  it("当网络或 API 报错时，adviseMemorySystem 平滑捕获异常并安全降级", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network offline"));

    const client = new JevClient({ apiKey: "ts_broken_key" });
    const res = await client.adviseMemorySystem({
      scenario: "网络不可用测试",
      expectedQps: 1,
      retentionMonths: 1,
      localMemoryGb: 16,
      needsGraph: false,
      hasDocker: true,
    });

    expect(res.usedFallback).toBe(true);
    expect(res.recommendation.rationale).toContain("Jev 调用失败");
  });
});
