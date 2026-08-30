/**
 * 统一 fetch 封装：网络失败 / 非 2xx / 解析失败一律吞并为 null。
 *
 * 面板组件拿到 null 时按"无数据"处理（降级展示），
 * 服务端本身已对 db/网关不可达返回 200 降级载荷，这里只兜底传输层错误。
 */
import { getAccessToken, notifyUnauthorized } from "./accessToken.js";

/** 带上访问口令的请求头；未配置口令时返回空对象，不改变原有行为。 */
function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token === "" ? {} : { "x-butler-token": token };
}

/** 401 表示口令缺失或不正确：广播给 AccessGate 弹出口令输入。 */
function handleUnauthorized(res: Response): void {
  if (res.status === 401) notifyUnauthorized();
}

export async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    handleUnauthorized(res);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POST 结果：status 为 HTTP 状态码（0 表示传输层失败），data 为解析后的响应体（可能为 null）。 */
export interface PostResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/**
 * 统一 POST 封装（Task 10 大盘控制动作用）：
 * 网络失败不抛异常（status=0），非 2xx 也不吞并 —— 调用方需要区分 202/409/502 等分支。
 */
export async function postJson(url: string, body?: unknown, timeoutMs = 5000): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    handleUnauthorized(res);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // 空 body / 非 JSON 响应忽略
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/**
 * 纯文本响应（诊断报告是 Markdown，不是 JSON）。
 * 同样要带访问口令，否则设置了口令之后这个入口会一直 401。
 */
export async function fetchText(
  url: string,
  timeoutMs = 20_000,
): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401) {
        notifyUnauthorized();
        return { ok: false, status: 401, reason: "需要访问口令" };
      }
      return { ok: false, status: res.status, reason: `服务返回 ${res.status}` };
    }
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false, status: 0, reason: "网络连接失败，请检查管家服务是否在运行" };
  }
}

/** 二进制附件响应（诊断 ZIP 等）；沿用统一访问口令和 401 广播。 */
export async function fetchBlob(
  url: string,
  timeoutMs = 30_000,
): Promise<{ ok: true; blob: Blob } | { ok: false; status: number; reason: string }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401) {
        notifyUnauthorized();
        return { ok: false, status: 401, reason: "需要访问口令" };
      }
      return { ok: false, status: res.status, reason: `服务返回 ${res.status}` };
    }
    return { ok: true, blob: await res.blob() };
  } catch {
    return { ok: false, status: 0, reason: "网络连接失败，请检查管家服务是否在运行" };
  }
}

/** DELETE 等其他方法；与 postJson 一样区分状态码。 */
export async function deleteJson(url: string, timeoutMs = 5000): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: "DELETE",
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    handleUnauthorized(res);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // 空 body 忽略
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** GET 的可区分结果：不再把失败吞成 null，让“加载失败”成为可表达的状态。 */
export type LoadResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** 可区分 GET：非 2xx 时尽力从响应体提取 error/detail 文案。 */
export async function loadJson<T>(url: string, timeoutMs = 5000): Promise<LoadResult<T>> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401) {
        notifyUnauthorized();
        return { ok: false, reason: "需要访问口令才能查看，请输入管家面板的访问口令" };
      }
      let reason = `服务返回 ${res.status}`;
      try {
        const body: unknown = await res.json();
        if (body !== null && typeof body === "object") {
          const record = body as Record<string, unknown>;
          if (typeof record.error === "string" && record.error.trim() !== "") reason = record.error;
          else if (typeof record.detail === "string" && record.detail.trim() !== "")
            reason = record.detail;
        }
      } catch {
        // 响应体不是 JSON 时保留默认文案
      }
      return { ok: false, reason };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: "网络连接失败，请检查管家服务是否在运行" };
  }
}

/** 页面数据三态：loading / ready / failed。failed 必须可见且可重试。 */
export type FetchState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; reason: string };
