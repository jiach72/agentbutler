/**
 * 告警转发：订阅 bus 的 fingerprint-aggregated / fingerprint-escalated，
 * payload.alert === true 时 POST <gatewayUrl>/api/alerts（可注入 fetch，5s 超时）。
 *
 * - aggregated（新指纹待告警）：severity "warn"；escalated（突发升级）：severity "critical"；
 * - body { kind: "fingerprint", severity, title: 模板前 80 字符, body: 含
 *   signature/count/窗口信息, source: "butler-watch", dedupeKey: signature }；
 * - 网关不可达时对网络错误、408/425/429/5xx 做有限指数重试；
 *   最终失败 → console.warn + audit 记录（action "alert-forward-failed"），不崩溃。
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
  /** 通知 gateway 归档指定 dedupeKey 的告警（探针恢复时调用；失败只 warn + audit）。 */
  resolve(dedupeKey: string): Promise<void>;
  /** 等待在途 POST 全部落定（测试观测用）。 */
  flush(): Promise<void>;
}

export interface AlertPosterDeps {
  gatewayUrl: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** 单条告警的最大 HTTP 尝试次数（含首次；默认 3）。 */
  maxAttempts?: number;
  /** 重试基础等待毫秒数（默认 250；测试可注入 0）。 */
  retryBaseDelayMs?: number;
  /** 失败审计（可选；指纹转发与 runbook 告警共用同一动作名）。 */
  audit?: AuditLog;
  /** gateway Bearer 鉴权令牌（缺省读 BUTLER_ACCESS_TOKEN 环境变量）。 */
  accessToken?: string;
}

export const ALERT_FORWARD_FAILED_ACTION = "alert-forward-failed";
export const ALERT_SOURCE = "butler-watch";

/** 账户/计费类故障特征（与 describeFingerprint 余额不足分支共用，含 InsufficientBalance 连写）。 */
const BILLING_FAILURE_PATTERN = /\b402\b|insufficient[_\s]*balance|payment\s+required|billing/i;
/** 凭据/权限类故障特征（401/403、无效 Key）。 */
const CREDENTIAL_FAILURE_PATTERN = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid\s+(?:api[ _-]?)?key/i;
/** 配额/信用类故障特征（厂商文案变体）。 */
const QUOTA_FAILURE_PATTERN = /quota\s*(?:exceeded|exhausted)|exceeded\s+(?:your\s+)?(?:current\s+)?(?:quota|rate)|credit\s+balance/i;

/**
 * 外部依赖故障（账户/凭据/配额类）：故障在服务提供方侧，重启实例修不了。
 * 命中时自动修复（rb-restart）必须让路，改发 external-dependency 告警。
 */
export function isExternalDependencyFailure(detail: string): boolean {
  return (
    BILLING_FAILURE_PATTERN.test(detail) ||
    CREDENTIAL_FAILURE_PATTERN.test(detail) ||
    QUOTA_FAILURE_PATTERN.test(detail)
  );
}

/** 将内部归一化模板转换成通知中心可直接理解的短摘要。模板只用于去重，不能直接上屏。 */
export function describeFingerprint(template: string, sample?: string): { title: string; advice: string } {
  const text = `${sample ?? ""} ${template}`;
  if (BILLING_FAILURE_PATTERN.test(text)) {
    return { title: "模型账户余额不足", advice: "请充值或切换到可用的备用模型；重启服务无法解决余额问题。" };
  }
  if (CREDENTIAL_FAILURE_PATTERN.test(text)) {
    return { title: "模型凭据无效或权限不足", advice: "请检查 API Key、端点和账户权限。" };
  }
  if (/\b429\b|rate\s*limit|too\s+many\s+requests|限流/i.test(text)) {
    return { title: "请求过于频繁，正在等待恢复", advice: "管家会继续重试；若反复出现，请降低并发或检查限流设置。" };
  }
  if (/timeout|timed\s*out|超时/i.test(text)) {
    return { title: "外部服务响应超时", advice: "请检查网络和模型端点，管家会继续观察后续状态。" };
  }
  if (/econnrefused|connection\s+(?:to\s+)?[^\n]{0,40}refused|连接被拒绝/i.test(text)) {
    return { title: "外部服务连接失败", advice: "请确认目标服务正在运行并检查连接地址。" };
  }
  return { title: "智能体任务执行失败", advice: "请打开完整通知或日志查看详情；先确认原因，再决定是否重试。" };
}

/** 公共告警 POST 器：超时保护 + 瞬时故障有限重试 + 最终失败审计。 */
export function createAlertPoster(deps: AlertPosterDeps): AlertPoster {
  const doFetch = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? 5000;
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(deps.maxAttempts ?? 3)));
  const retryBaseDelayMs = Math.max(0, Math.min(30_000, Math.floor(deps.retryBaseDelayMs ?? 250)));
  const endpoint = `${deps.gatewayUrl.replace(/\/+$/, "")}/api/alerts`;
  const accessToken = (deps.accessToken ?? process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();
  const alertHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(accessToken !== "" ? { "x-butler-token": accessToken } : {}),
  });
  const inFlight = new Set<Promise<void>>();

  function recordFailure(
    body: GatewayAlertBody | { dedupeKey: string },
    message: string,
    severity?: GatewayAlertBody["severity"],
    title?: string,
  ): void {
    console.warn(`[butler-watch] 告警转发失败（有限重试后仍未送达）: ${message}`);
    deps.audit?.append({
      actor: ALERT_SOURCE,
      action: ALERT_FORWARD_FAILED_ACTION,
      target: body.dedupeKey,
      detail: { message, severity, title },
    });
  }

  async function post(body: GatewayAlertBody): Promise<void> {
    let lastError = "未知错误";
    let attempted = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempted = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: alertHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) return;
        lastError = `gateway 响应 HTTP ${response.status}`;
        if (!isRetryableAlertStatus(response.status)) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) {
        const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    recordFailure(body, `${lastError}；已尝试 ${attempted} 次`, body.severity, body.title);
  }

  async function resolve(dedupeKey: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${endpoint}/resolve`, {
        method: "POST",
        headers: alertHeaders(),
        body: JSON.stringify({ dedupeKey }),
        signal: controller.signal,
      });
      if (response.ok) return;
      recordFailure({ dedupeKey }, `gateway 归档响应 HTTP ${response.status}`);
    } catch (error) {
      recordFailure(
        { dedupeKey },
        error instanceof Error ? error.message : String(error),
      );
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
    resolve: (dedupeKey) => {
      const task = resolve(dedupeKey);
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

function isRetryableAlertStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
  /** gateway Bearer 鉴权令牌（缺省读 BUTLER_ACCESS_TOKEN 环境变量）。 */
  accessToken?: string;
}

/** 启动告警转发订阅，返回控制句柄。 */
export function startAlertForwarder(deps: AlertForwarderDeps): AlertForwarder {
  const poster = createAlertPoster({
    gatewayUrl: deps.gatewayUrl,
    fetchFn: deps.fetchFn,
    timeoutMs: deps.timeoutMs,
    audit: deps.audit,
    accessToken: deps.accessToken,
  });

  function dispatch(body: AlertForwardBody): void {
    void poster.post(body);
  }

  const offAggregated = deps.bus.on("fingerprint-aggregated", (event) => {
    const payload = event.payload;
    if (payload.alert !== true) return; // 已知模式复现只记档，不转发
    const summary = describeFingerprint(payload.template, payload.sample);
    dispatch({
      kind: "fingerprint",
      severity: "warn",
      title: summary.title,
      body: `${summary.title}。${summary.advice}这是首次发现的可重复问题，已开始合并相同提醒；当前窗口累计 ${payload.count} 条，开始于 ${payload.windowStart}。通知编号 ${payload.signature}。`,
      source: "butler-watch",
      dedupeKey: payload.signature,
    });
  });

  const offEscalated = deps.bus.on("fingerprint-escalated", (event) => {
    const payload = event.payload;
    const summary = describeFingerprint(payload.template);
    dispatch({
      kind: "fingerprint",
      severity: "critical",
      title: `${summary.title}（正在加剧）`,
      body: `${summary.title}正在加剧：当前窗口 ${payload.count} 条，上一窗口 ${payload.prevCount} 条。${summary.advice}通知编号 ${payload.signature}。`,
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
