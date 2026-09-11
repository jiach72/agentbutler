/**
 * 访问口令的浏览器侧存取。
 *
 * 面板能重启 AI、改配置、读写记忆，所以监听非回环地址时后端会要求访问口令。
 * 口令存在 localStorage，登录一次即可；登出或口令失效时清空。
 * 同时支持从地址栏 ?token=xxx 自动填充，方便把带口令的地址存成书签。
 */

const STORAGE_KEY = "butler.accessToken";
const UNAUTHORIZED_EVENT = "butler:unauthorized";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 地址栏口令只提取一次，避免每次请求都改写 history。 */
let urlTokenConsumed = false;

function consumeUrlToken(): void {
  if (urlTokenConsumed) return;
  urlTokenConsumed = true;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl === null || fromUrl.trim() === "") return;
    setAccessToken(fromUrl);
    // 口令不该留在地址栏与浏览历史里
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  } catch {
    // URL 解析异常时忽略
  }
}

/** 读取已保存的访问口令；地址栏 ?token= 优先一次，便于书签直达。 */
export function getAccessToken(): string {
  consumeUrlToken();
  return storage()?.getItem(STORAGE_KEY) ?? "";
}

export function setAccessToken(token: string): void {
  try {
    const value = token.trim();
    if (value === "") storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // 隐私模式下 localStorage 不可写，退化为仅本次会话有效
  }
}

export function clearAccessToken(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

export function hasAccessToken(): boolean {
  return getAccessToken() !== "";
}

/** 请求被拒绝（401）时广播，由 AccessGate 弹出口令输入。 */
export function notifyUnauthorized(): void {
  try {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  } catch {
    // 忽略
  }
}

/** 订阅口令失效事件，返回取消订阅函数。 */
export function subscribeUnauthorized(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = () => handler();
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}
