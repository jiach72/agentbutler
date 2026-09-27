import { describe, expect, it } from "vitest";
import { createWebServer } from "../src/server.js";

describe("Unified Models Hub (/api/models/*)", () => {
  it("GET /api/models/unified-options 返回聚合的模型列表且包含预期结构", async () => {
    const app = createWebServer({
      accessToken: "",
      ollamaUrl: "http://127.0.0.1:59999", // 离线降级测试
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/api/credentials")) {
          return new Response(
            JSON.stringify({
              credentials: [
                {
                  id: "cred-deepseek",
                  name: "DeepSeek 官方",
                  category: "llm",
                  envVar: "DEEPSEEK_API_KEY",
                  provider: "deepseek",
                  endpoint: "https://api.deepseek.com/v1",
                  maskedKey: "sk-****1234",
                  status: "active",
                  probeStatus: "pass",
                  probeDetail: "连接正常",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("/api/llm/profiles")) {
          return new Response(
            JSON.stringify({ profiles: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/models/unified-options",
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.options)).toBe(true);

    // 验证 DeepSeek 凭据映射到了具体模型项
    const deepseekChat = json.options.find((o: any) => o.model === "deepseek-chat");
    expect(deepseekChat).toBeDefined();
    expect(deepseekChat.provider).toBe("deepseek");
    expect(deepseekChat.source).toBe("credential");
    expect(deepseekChat.category).toBe("cloud");
    expect(deepseekChat.costCategory).toBe("low");
    expect(deepseekChat.ready).toBe(true);
    expect(deepseekChat.probeStatus).toBe("pass");

    await app.close();
  });

  it("POST /api/models/primary 正常转发至 Watch 控制服务", async () => {
    let capturedBody: any = null;
    const app = createWebServer({
      accessToken: "",
      watchUrl: "http://127.0.0.1:7533",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/api/models/primary") && init?.method === "POST") {
          capturedBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              ok: true,
              primary: {
                provider: capturedBody.provider,
                model: capturedBody.model,
                endpoint: capturedBody.endpoint,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/models/primary",
      payload: {
        provider: "ollama",
        model: "qwen2.5:0.5b",
        endpoint: "http://ollama:11434/v1",
        source: "ollama",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      provider: "ollama",
      model: "qwen2.5:0.5b",
    });

    await app.close();
  });
});
