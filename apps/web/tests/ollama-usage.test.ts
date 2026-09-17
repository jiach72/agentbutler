import { describe, expect, it } from "vitest";
import { OllamaUsageStore } from "../src/ollama-usage-store.js";
import { createWebServer } from "../src/server.js";

describe("OllamaUsageStore", () => {
  it("records usage and calculates tokens per second", () => {
    const store = new OllamaUsageStore(":memory:");
    const record = store.recordUsage({
      model: "qwen2.5:0.5b",
      promptTokens: 25,
      completionTokens: 50,
      durationMs: 500,
      status: "success",
    });

    expect(record.id).toBe(1);
    expect(record.model).toBe("qwen2.5:0.5b");
    expect(record.promptTokens).toBe(25);
    expect(record.completionTokens).toBe(50);
    expect(record.totalTokens).toBe(75);
    expect(record.durationMs).toBe(500);
    // 50 tokens / 0.5s = 100 tokens/s
    expect(record.tokensPerSecond).toBe(100);
    expect(record.status).toBe("success");
    store.close();
  });

  it("aggregates daily summary and pads consecutive dates", () => {
    const store = new OllamaUsageStore(":memory:");
    const today = new Date().toISOString().slice(0, 10);

    store.recordUsage({
      model: "qwen2.5:0.5b",
      promptTokens: 100,
      completionTokens: 200,
      durationMs: 1000,
      tokensPerSecond: 200,
      timestamp: `${today}T10:00:00.000Z`,
    });

    store.recordUsage({
      model: "qwen2.5:1.5b",
      promptTokens: 50,
      completionTokens: 50,
      durationMs: 1000,
      tokensPerSecond: 50,
      timestamp: `${today}T12:00:00.000Z`,
    });

    const summary = store.getDailySummary(7);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalTokens).toBe(400);
    expect(summary.totalPromptTokens).toBe(150);
    expect(summary.totalCompletionTokens).toBe(250);
    expect(summary.todayCalls).toBe(2);
    expect(summary.todayTokens).toBe(400);
    expect(summary.avgTokensPerSecond).toBe(125); // (200 + 50) / 2

    // Daily history length should equal 7 days
    expect(summary.dailyHistory.length).toBe(7);
    const todayMetric = summary.dailyHistory[summary.dailyHistory.length - 1];
    expect(todayMetric?.date).toBe(today);
    expect(todayMetric?.callCount).toBe(2);
    expect(todayMetric?.totalTokens).toBe(400);

    store.close();
  });

  it("lists recent records in descending order", () => {
    const store = new OllamaUsageStore(":memory:");
    store.recordUsage({
      model: "model-1",
      promptTokens: 10,
      completionTokens: 20,
      durationMs: 100,
    });
    store.recordUsage({
      model: "model-2",
      promptTokens: 30,
      completionTokens: 40,
      durationMs: 200,
    });

    const records = store.getRecentRecords(10);
    expect(records.length).toBe(2);
    expect(records[0]?.model).toBe("model-2");
    expect(records[1]?.model).toBe("model-1");
    store.close();
  });
});

describe("Ollama Usage & Chat HTTP Endpoints", () => {
  it("returns summary and records via Fastify API", async () => {
    const store = new OllamaUsageStore(":memory:");
    store.recordUsage({
      model: "qwen2.5:0.5b",
      promptTokens: 40,
      completionTokens: 60,
      durationMs: 500,
      tokensPerSecond: 120,
    });

    const app = createWebServer({
      ollamaUsageStore: store,
    });

    // Test GET /api/ollama/usage/summary
    const summaryRes = await app.inject({
      method: "GET",
      url: "/api/ollama/usage/summary?days=7",
    });
    expect(summaryRes.statusCode).toBe(200);
    const summaryJson = JSON.parse(summaryRes.payload) as {
      ok: boolean;
      summary: { totalCalls: number; totalTokens: number };
    };
    expect(summaryJson.ok).toBe(true);
    expect(summaryJson.summary.totalCalls).toBe(1);
    expect(summaryJson.summary.totalTokens).toBe(100);

    // Test GET /api/ollama/usage/records
    const recordsRes = await app.inject({
      method: "GET",
      url: "/api/ollama/usage/records",
    });
    expect(recordsRes.statusCode).toBe(200);
    const recordsJson = JSON.parse(recordsRes.payload) as {
      ok: boolean;
      records: Array<{ model: string; totalTokens: number }>;
    };
    expect(recordsJson.ok).toBe(true);
    expect(recordsJson.records.length).toBe(1);
    expect(recordsJson.records[0]?.model).toBe("qwen2.5:0.5b");

    // Test POST /api/ollama/test-chat validation
    const chatValidateRes = await app.inject({
      method: "POST",
      url: "/api/ollama/test-chat",
      payload: { model: "", prompt: "" },
    });
    expect(chatValidateRes.statusCode).toBe(400);

    store.close();
  });
});
