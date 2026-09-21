export interface ApiKeyProbeResult {
  status: "pass" | "fail";
  category: "ok" | "unauthorized" | "network" | "rate-limit" | "not-found" | "error";
  detail: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function redactApiKey(str: string, key: string): string {
  if (!key || key.length < 4) return str;
  return str.split(key).join("[REDACTED]");
}

export async function probeApiKey(
  provider: string,
  apiKey: string,
  options: { endpoint?: string | null; fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<ApiKeyProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const cleanKey = apiKey.trim();
  const prov = provider.toLowerCase().trim();

  try {
    let url = "";
    let method = "GET";
    const headers: Record<string, string> = {};
    let body: string | undefined = undefined;

    switch (prov) {
      case "tavily":
        url = "https://api.tavily.com/search";
        method = "POST";
        headers["content-type"] = "application/json";
        body = JSON.stringify({ api_key: cleanKey, query: "ping", max_results: 1 });
        break;

      case "brave":
        url = "https://api.search.brave.com/res/v1/web/search?q=ping&count=1";
        headers["Accept"] = "application/json";
        headers["X-Subscription-Token"] = cleanKey;
        break;

      case "serper":
        url = "https://google.serper.dev/search";
        method = "POST";
        headers["content-type"] = "application/json";
        headers["X-API-KEY"] = cleanKey;
        body = JSON.stringify({ q: "ping", num: 1 });
        break;

      case "exa":
        url = "https://api.exa.ai/search";
        method = "POST";
        headers["content-type"] = "application/json";
        headers["x-api-key"] = cleanKey;
        body = JSON.stringify({ query: "ping", numResults: 1 });
        break;

      case "bing":
        url = "https://api.bing.microsoft.com/v7.0/search?q=ping&count=1";
        headers["Ocp-Apim-Subscription-Key"] = cleanKey;
        break;

      case "google":
      case "gemini":
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
        break;

      case "openai":
        url = (options.endpoint?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "") + "/models";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        break;

      case "deepseek":
        url = "https://api.deepseek.com/models";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        break;

      case "anthropic":
        url = "https://api.anthropic.com/v1/models";
        headers["x-api-key"] = cleanKey;
        headers["anthropic-version"] = "2023-06-01";
        break;

      case "moonshot":
        url = "https://api.moonshot.cn/v1/models";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        break;

      case "dashscope":
      case "qwen":
        url = "https://dashscope.aliyuncs.com/api/v1/services/models";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        break;

      case "zhipu":
      case "zhipuai":
        url = "https://open.bigmodel.cn/api/paas/v4/models";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        break;

      case "mem0":
        url = "https://api.mem0.ai/v1/memories/?page_size=1";
        headers["Authorization"] = `Token ${cleanKey}`;
        break;

      case "github":
        url = "https://api.github.com/user";
        headers["Authorization"] = `Bearer ${cleanKey}`;
        headers["User-Agent"] = "Agent-Butler";
        break;

      default:
        if (options.endpoint && options.endpoint.trim() !== "") {
          url = options.endpoint.trim();
          headers["Authorization"] = `Bearer ${cleanKey}`;
        } else {
          return {
            status: "pass",
            category: "ok",
            detail: "已配置（此服务无需外部网络探测）",
          };
        }
        break;
    }

    const res = await fetchFn(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    if (res.status >= 200 && res.status < 300) {
      return {
        status: "pass",
        category: "ok",
        detail: `连接成功 (HTTP ${res.status})`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: "fail",
        category: "unauthorized",
        detail: `认证失败：API Key 无效或权限不足 (HTTP ${res.status})`,
      };
    }

    if (res.status === 429) {
      return {
        status: "fail",
        category: "rate-limit",
        detail: "请求受限：调用频次超限或额度已耗尽 (HTTP 429)",
      };
    }

    if (res.status === 404) {
      return {
        status: "fail",
        category: "not-found",
        detail: `端点不存在或模型未找到 (HTTP 404)`,
      };
    }

    return {
      status: "fail",
      category: "error",
      detail: `服务返回异常状态 (HTTP ${res.status})`,
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
    if (isAbort) {
      return {
        status: "fail",
        category: "network",
        detail: `连接超时（超过 ${timeoutMs / 1000} 秒未响应）`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    const cleanMsg = redactApiKey(message, cleanKey);
    return {
      status: "fail",
      category: "network",
      detail: `网络请求失败：${cleanMsg}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
