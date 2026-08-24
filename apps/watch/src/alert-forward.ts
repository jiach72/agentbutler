/**
 * 告警转发：订阅 bus 的 fingerprint-aggregated / fingerprint-escalated，
 * payload.alert === true 时 POST <gatewayUrl>/api/alerts（可注入 fetch，5s 超时）。
 *
 * - aggregated（新指纹待告警）：severity "warn"；escalated（突发升级）：severity "critical"；
 * - body { kind: "fingerprint", severity, title: 模板前 80 字符, body: 含
 *   signature/count/窗口信息, source: "butler-watch", dedupeKey: signature }；
 * - 失败 → console.warn + audit 记录（action "alert-forward-failed"），
 *   不重试不崩溃（gateway 侧有持久化与补发）。
 *
 * 公共 POST 网关能力抽为 createAlertPoster（Task 7 runbook 升级告警 /
 * 熔断告警复用，行为与指纹转发一致）。
 */
import type { AuditLog, EventBus } from "@butler/core";
import type { FetchLike } from "./dashboard-signal.js";

/** 网关告警统一 body 形态（/api/alerts）。 */
export interface GatewayAlertBody {
  kind: string;
  severity: "warn" | "critical";
  title: string;
  body: string;
  source: string;
  dedupeKey: string;
}

export interface AlertForwardBody {
  kind: "fingerprint";
  severity: "warn" | "critical";
  title: string;
  body: string;
  source: "butler-watch";
  dedupeKey: string;
}

export interface AlertPoster {
  /** POST 一条告警到 gateway（失败只 warn + audit，不抛异常）。 */
  post(body: GatewayAlertBody): Promise<void>;
  /** 等待在途 POST 全部落定（测试观测用）。 */
  flush(): Promise<void>;
}

export interface AlertPosterDeps {
  gatewayUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** 失败审计（可选；指纹转发与 runbook 告警共用同一动作名）。 */
  audit?: AuditLog;
}

export const ALERT_FORWARD_FAILED_ACTION = "alert-forward-failed";
export const ALERT_SOURCE = "butler-watch";

/** 公共告警 POST 器：超时保护 + 失败 warn/audit 不重试（gateway 侧有持久化与补发）。 */
export function createAlertPoster(deps: AlertPosterDeps): AlertPoster {
  const doFetch = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? 5000;
  const endpoint = `${deps.gatewayUrl.replace(/\/+$/, "")}/api/alerts`;
  const inFlight = new Set<Promise<void>>();

  function recordFailure(body: GatewayAlertBody, message: string): void {
    console.warn(`[butler-watch] 告警转发失败（不重试，gateway 侧有补发）: ${message}`);
    deps.audit?.append({
      actor: ALERT_SOURCE,
      action: ALERT_FORWARD_FAILED_ACTION,
      target: body.dedupeKey,
      detail: { message, severity: body.severity, title: body.title },
    });
  }

  async function post(body: GatewayAlertBody): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        recordFailure(body, `gateway 响应 HTTP ${response.status}`);
      }
    } catch (error) {
      recordFailure(body, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    post: (body) => {
      const task = post(body);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
      return task;
    },
    flush: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

export interface AlertForwarder {
  /** 退订总线事件（停止转发）。 */
  stop(): void;
  /** 等待在途 POST 全部落定（测试观测用）。 */
  flush(): Promise<void>;
}

export interface AlertForwarderDeps {
  bus: EventBus;
  audit: AuditLog;
  gatewayUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** 启动告警转发订阅，返回控制句柄。 */
export function startAlertForwarder(deps: AlertForwarderDeps): AlertForwarder {
  const poster = createAlertPoster({
    gatewayUrl: deps.gatewayUrl,
    fetchFn: deps.fetchFn,
    timeoutMs: deps.timeoutMs,
    audit: deps.audit,
  });

  function dispatch(body: AlertForwardBody): void {
    void poster.post(body);
  }

  const offAggregated = deps.bus.on("fingerprint-aggregated", (event) => {
    const payload = event.payload;
    if (payload.alert !== true) return; // 已知模式复现只记档，不转发
    dispatch({
      kind: "fingerprint",
      severity: "warn",
      title: payload.template.slice(0, 80),
      body: `错误指纹 ${payload.signature} 于 ${payload.windowStart} 开启聚合窗口，已累计 ${payload.count} 条（首见: ${payload.isFirstEver}）。模板: ${payload.template}`,
      source: "butler-watch",
      dedupeKey: payload.signature,
    });
  });

  const offEscalated = deps.bus.on("fingerprint-escalated", (event) => {
    const payload = event.payload;
    dispatch({
      kind: "fingerprint",
      severity: "critical",
      title: payload.template.slice(0, 80),
      body: `错误指纹 ${payload.signature} 突发升级：本窗 ${payload.count} 条，上一窗口 ${payload.prevCount} 条。模板: ${payload.template}`,
      source: "butler-watch",
      dedupeKey: payload.signature,
    });
  });

  return {
    stop: () => {
      offAggregated();
      offEscalated();
    },
    flush: () => poster.flush(),
  };
}
