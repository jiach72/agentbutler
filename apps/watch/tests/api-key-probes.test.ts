import { describe, it, expect, vi } from "vitest";
import { probeApiKey } from "../src/probes/api-key-probes.js";

describe("probeApiKey", () => {
  it("Tavily 探针：200 返回 pass，401 返回 unauthorized", async () => {
    const fakeFetch200 = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const okRes = await probeApiKey("tavily", "tvly-valid", { fetchFn: fakeFetch200 });
    expect(okRes.status).toBe("pass");
    expect(okRes.category).toBe("ok");

    const fakeFetch401 = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const failRes = await probeApiKey("tavily", "tvly-invalid", { fetchFn: fakeFetch401 });
    expect(failRes.status).toBe("fail");
    expect(failRes.category).toBe("unauthorized");
  });

  it("Brave 探针：请求带 X-Subscription-Token 头", async () => {
    const fakeFetch = vi.fn().mockImplementation((url, init) => {
      expect(init?.headers?.["X-Subscription-Token"]).toBe("brave-token-123");
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const res = await probeApiKey("brave", "brave-token-123", { fetchFn: fakeFetch });
    expect(res.status).toBe("pass");
  });

  it("Google Gemini / Vision 探针：测试 key 参数", async () => {
    const fakeFetch = vi.fn().mockImplementation((url) => {
      expect(url).toContain("key=google-key-abc");
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const res = await probeApiKey("google", "google-key-abc", { fetchFn: fakeFetch });
    expect(res.status).toBe("pass");
  });

  it("未知服务未指定 endpoint 时返回无需探测", async () => {
    const res = await probeApiKey("custom-service", "some-key");
    expect(res.status).toBe("pass");
    expect(res.category).toBe("ok");
    expect(res.detail).toContain("无需外部网络探测");
  });

  it("网络报错或超时脱敏 API Key", async () => {
    const secretKey = "super-secret-key-987654";
    const fakeFetchError = vi.fn().mockRejectedValue(new Error(`Failed to connect with ${secretKey}`));
    const res = await probeApiKey("tavily", secretKey, { fetchFn: fakeFetchError });
    expect(res.status).toBe("fail");
    expect(res.category).toBe("network");
    expect(res.detail).not.toContain(secretKey);
    expect(res.detail).toContain("[REDACTED]");
  });
});
