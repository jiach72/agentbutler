/**
 * LLM 端点探针（llm-probe，Task 6.3）。
 *
 * env（全部可注入覆盖）：BUTLER_LLM_BASE_URL / BUTLER_LLM_API_KEY /
 * BUTLER_LLM_MODEL / BUTLER_LLM_BALANCE_URL。
 * LLM 为可选依赖：未配置 BASE_URL → skipped "未配置 LLM 探针端点"。
 * 已配置流程：
 * ① 端点探测：GET base，fetch 有响应即视为可达（OpenAI 兼容服务 GET / 常 404，
 *    可达性以能否建立 HTTP 会话为准）；连接异常 → fail。
 * ② 1 token 补全：POST {base}/chat/completions，body { model, messages:
 *    [{role:"user",content:"ping"}], max_tokens: 1 }，Authorization Bearer，
 *    30s 超时（探针纪律）；非 2xx / 异常 → fail。
 * ③ 余额查询：仅 BALANCE_URL 配置了才查（GET Bearer）；失败仅记 note，不 fail。
 */
import type { InspectionStage } from "../pipeline.js";
import { defaultFetchLike, type FetchLike } from "../dashboard-signal.js";
import { PROBE_DISCIPLINE_TIMEOUT_MS } from "./channel-probe.js";

export const LLM_PROBE_CHECK_ID = "llm-probe";
export const LLM_PROBE_NOT_CONFIGURED_NOTE = "未配置 LLM 探针端点";

/** LLM 探针 env 形态（loadWatchConfig 读 env，测试经 StageDeps 注入）。 */
export interface LlmProbeEnv {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  balanceUrl?: string;
}

export interface LlmProbeDeps {
  /** env 覆盖；至少需要 baseUrl 才会执行探测。 */
  env?: LlmProbeEnv;
  fetchFn?: FetchLike;
  /** 单请求超时（默认 30s 探针纪律）。 */
  timeoutMs?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(fetchFn: FetchLike, url: string, init: Parameters<FetchLike>[1], timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchFn(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function createLlmProbeStage(deps: LlmProbeDeps = {}): InspectionStage {
  const fetchFn = deps.fetchFn ?? defaultFetchLike;
  const timeoutMs = deps.timeoutMs ?? PROBE_DISCIPLINE_TIMEOUT_MS;
  return {
    id: LLM_PROBE_CHECK_ID,
    label: "LLM 端点",
    async run() {
      const env = deps.env ?? {};
      const baseUrl = env.baseUrl?.trim();
      if (!baseUrl) {
        return { id: LLM_PROBE_CHECK_ID, status: "skipped", detail: LLM_PROBE_NOT_CONFIGURED_NOTE };
      }
      const base = baseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (env.apiKey) headers["authorization"] = `Bearer ${env.apiKey}`;

      // ① 端点探测：可达即可（任意 HTTP 状态码都证明端点在服务）。
      try {
        await withTimeout(fetchFn, base, { method: "GET" }, timeoutMs);
      } catch (error) {
        return { id: LLM_PROBE_CHECK_ID, status: "fail", detail: `LLM 端点不可达 (${base}): ${describe(error)}` };
      }

      // ② 1 token 补全。
      const body = JSON.stringify({
        model: env.model ?? "",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      try {
        const response = await withTimeout(
          fetchFn,
          `${base}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...headers }, body },
          timeoutMs,
        );
        if (!response.ok) {
          return {
            id: LLM_PROBE_CHECK_ID,
            status: "fail",
            detail: `补全请求失败：POST ${base}/chat/completions 响应 HTTP ${response.status}`,
          };
        }
      } catch (error) {
        return { id: LLM_PROBE_CHECK_ID, status: "fail", detail: `补全请求异常: ${describe(error)}` };
      }

      // ③ 余额查询（可选；失败仅 note 不 fail）。
      const notes: string[] = [];
      if (env.balanceUrl?.trim()) {
        try {
          const response = await withTimeout(fetchFn, env.balanceUrl.trim(), { method: "GET", headers }, timeoutMs);
          if (!response.ok) {
            notes.push(`余额查询响应 HTTP ${response.status}（仅 note）`);
          }
        } catch (error) {
          notes.push(`余额查询失败: ${describe(error)}（仅 note）`);
        }
      }
      return {
        id: LLM_PROBE_CHECK_ID,
        status: "pass",
        detail: `端点可达且 1 token 补全成功 (${base}${notes.length > 0 ? `；${notes.join(";")}` : ""})`,
      };
    },
  };
}
