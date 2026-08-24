/**
 * 统一 fetch 封装：网络失败 / 非 2xx / 解析失败一律吞并为 null。
 *
 * 面板组件拿到 null 时按"无数据"处理（降级展示），
 * 服务端本身已对 db/网关不可达返回 200 降级载荷，这里只兜底传输层错误。
 */
export async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
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
