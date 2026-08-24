/**
 * 通道收发 dry-run 探针（channel-probe，Task 6.2）。
 *
 * 真实 API Server 勘察结论（2026-08-20，仅 GET / openapi/docs 无害请求 + 只读源码
 * gateway/platforms/api_server.py 路由表；服务监听 127.0.0.1:8642，aiohttp，无
 * openapi.json/docs，GET / 404）：
 * - POST /api/sessions：创建空 Hermes 会话，body 可带 `id`（探针填
 *   "butler-probe-<ts>" 作专用会话标识，绝不进用户会话流）、`title`、`source`；
 *   需 `Authorization: Bearer <API_SERVER_KEY>`（即 config.yaml
 *   platforms.api_server.extra.key，readHermesConfig 已解析为 apiServer.key）；成功 201。
 * - POST /api/sessions/{session_id}/chat：真实消息通道（触发 LLM），探针 dry-run 不用。
 * - DELETE /api/sessions/{session_id}：可清理探针会话。
 *
 * 实现：可配置 dry-run（endpoint 模板 + payload 模板 + 探针专用会话标识占位
 * {{probeSession}}/{{ts}}）→ 经可注入 fetch POST，校验响应 2xx。
 * 配置缺失或端点未知 → 降级静态检查：config.yaml platforms.weixin 存在 +
 * API Server 端口探活（复用 hermes defaultProber）→ pass with note。
 * 发送失败 → fail；超时 30s（探针纪律，discipline.ts probe 行）。
 */
import { readHermesConfig, defaultProber, type PortProber } from "@butler/adapter-hermes";
import type { HermesConfig } from "@butler/adapter-hermes";
import { apiEndpointOf, type InspectionStage } from "../pipeline.js";
import { defaultFetchLike, type FetchLike } from "../dashboard-signal.js";

export const CHANNEL_PROBE_CHECK_ID = "channel-probe";
export const CHANNEL_PROBE_STATIC_NOTE = "静态检查（dry-run 端点未配置）";
/** 探针纪律：probe 类调用 30s 超时、不自动重试（packages/contract discipline.ts）。 */
export const PROBE_DISCIPLINE_TIMEOUT_MS = 30_000;
/** 默认 payload 模板：对应 POST /api/sessions，创建探针专用空会话。 */
export const DEFAULT_CHANNEL_PAYLOAD_TEMPLATE = '{"id":"{{probeSession}}","source":"butler-probe"}';

/** dry-run 配置（env BUTLER_CHANNEL_DRYRUN_* 或显式注入）。 */
export interface ChannelDryRunConfig {
  /** 端点模板（可含 {{probeSession}}/{{ts}} 占位）。 */
  endpointTemplate: string;
  /** payload JSON 模板（缺省创建探针专用空会话）。 */
  payloadTemplate?: string;
}

export interface ChannelProbeDeps {
  /** dry-run 配置；缺省走静态检查。 */
  dryRun?: ChannelDryRunConfig;
  fetchFn?: FetchLike;
  prober?: PortProber;
  /** config.yaml 加载器（默认 readHermesConfig，测试可注入）。 */
  configLoader?: (rootPath: string) => Promise<HermesConfig | null>;
  /** 单请求超时（默认 30s 探针纪律）。 */
  timeoutMs?: number;
  now?: () => number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 渲染模板占位：{{probeSession}} / {{ts}}。 */
function renderTemplate(template: string, probeSession: string, ts: number): string {
  return template.replaceAll("{{probeSession}}", probeSession).replaceAll("{{ts}}", String(ts));
}

export function createChannelProbeStage(deps: ChannelProbeDeps = {}): InspectionStage {
  const fetchFn = deps.fetchFn ?? defaultFetchLike;
  const prober = deps.prober ?? defaultProber;
  const configLoader = deps.configLoader ?? readHermesConfig;
  const timeoutMs = deps.timeoutMs ?? PROBE_DISCIPLINE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  return {
    id: CHANNEL_PROBE_CHECK_ID,
    label: "通道收发 dry-run",
    async run(ctx) {
      // config.yaml 供 dry-run Bearer key 与静态检查共用。
      const config = await configLoader(ctx.rootPath);

      if (deps.dryRun === undefined) {
        // 静态检查降级：platforms.weixin 声明存在 + API Server 端口探活。
        if (config === null || config.weixinExtra === null) {
          return {
            id: CHANNEL_PROBE_CHECK_ID,
            status: "skipped",
            detail: "config.yaml 未声明 platforms.weixin，静态检查无对象",
          };
        }
        const endpoint = apiEndpointOf(config);
        const alive = await prober(endpoint.host, endpoint.port, timeoutMs);
        if (!alive) {
          return {
            id: CHANNEL_PROBE_CHECK_ID,
            status: "fail",
            detail: `静态检查：weixin 已配置但 API Server ${endpoint.host}:${endpoint.port} 端口不活`,
          };
        }
        return {
          id: CHANNEL_PROBE_CHECK_ID,
          status: "pass",
          detail: `${CHANNEL_PROBE_STATIC_NOTE}：platforms.weixin 已配置，API Server ${endpoint.host}:${endpoint.port} 探活成功`,
        };
      }

      // dry-run：探针专用会话标识，绝不进用户会话流。
      const ts = now();
      const probeSession = `butler-probe-${ts}`;
      const endpoint = renderTemplate(deps.dryRun.endpointTemplate, probeSession, ts);
      const payload = renderTemplate(
        deps.dryRun.payloadTemplate ?? DEFAULT_CHANNEL_PAYLOAD_TEMPLATE,
        probeSession,
        ts,
      );
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config?.apiServer.key) {
        headers["authorization"] = `Bearer ${config.apiServer.key}`; // 密钥只进请求头，绝不进 detail/日志
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(endpoint, { method: "POST", headers, body: payload, signal: controller.signal });
        if (!response.ok) {
          return {
            id: CHANNEL_PROBE_CHECK_ID,
            status: "fail",
            detail: `dry-run 发送失败：${endpoint} 响应 HTTP ${response.status}`,
          };
        }
        return {
          id: CHANNEL_PROBE_CHECK_ID,
          status: "pass",
          detail: `dry-run 发送成功：${endpoint}（会话 ${probeSession}）HTTP ${response.status}`,
        };
      } catch (error) {
        return {
          id: CHANNEL_PROBE_CHECK_ID,
          status: "fail",
          detail: `dry-run 发送异常: ${describe(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
