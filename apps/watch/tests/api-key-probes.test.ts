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

  it("SSRF 防护：拦截云厂商元数据地址与非法协议", async () => {
    const fakeFetch = vi.fn();
    const resMeta = await probeApiKey("custom", "test-key", {
      endpoint: "http://169.254.169.254/latest/meta-data/",
      fetchFn: fakeFetch,
    });
    expect(resMeta.status).toBe("fail");
    expect(resMeta.category).toBe("error");
    expect(resMeta.detail).toContain("安全拦截");
    expect(fakeFetch).not.toHaveBeenCalled();

    const resGcp = await probeApiKey("custom", "test-key", {
      endpoint: "http://metadata.google.internal/computeMetadata/v1/",
      fetchFn: fakeFetch,
    });
    expect(resGcp.status).toBe("fail");
    expect(fakeFetch).not.toHaveBeenCalled();

    const resFile = await probeApiKey("custom", "test-key", {
      endpoint: "file:///etc/passwd",
      fetchFn: fakeFetch,
    });
    expect(resFile.status).toBe("fail");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("TypeSafe 探针：正确向 /v1/systemone 发起探活 ping 请求", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const fakeFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse((init?.body as string) || "{}");
      return new Response(JSON.stringify({ answers: { ping: { type: "noul", noul: 1.0 } } }), { status: 200 });
    });

    const res = await probeApiKey("typesafe", "ts_test_key", { fetchFn: fakeFetch });
    expect(res.status).toBe("pass");
    expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(capturedBody.model).toBe("jev-latest");
    expect(capturedBody.questions.ping.type).toBe("noul");
  });
});
