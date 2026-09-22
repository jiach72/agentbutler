/**
 * Web 面板鉴权与 Origin 校验纯函数（从 server.ts 抽出，便于单测与复用）。
 */
import { timingSafeEqual } from "node:crypto";

export function pathOf(rawUrl: string | undefined): string {
  const url = rawUrl ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** 来源是否指向本机；解析失败按不受信任处理。 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** 从 Host / URL 中提取可比较的主机名。 */
export function hostNameOf(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  const raw = value.trim();
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
    if (bracketed?.[1] !== undefined) return bracketed[1].toLowerCase();
    const hostWithPort = /^([^:]+):\d+$/.exec(raw);
    if (hostWithPort?.[1] !== undefined) return hostWithPort[1].toLowerCase();
    return raw.toLowerCase();
  }
}

/**
 * 首次使用便利通道：从本机发起的连接（TCP 对端为 loopback）无需查找口令。
 * 信任源是连接层对端地址而非 Host / Sec-Fetch 等客户端可控头——后者可被
 * 局域网攻击者伪造（审计 F-03）。跨设备访问的对端不是 loopback，仍须凭口令。
 */
export function isLoopbackConnection(socket: { remoteAddress?: string } | undefined): boolean {
  const raw = socket?.remoteAddress ?? "";
  const normalized = raw.replace(/^::ffff:/i, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** Origin 与当前请求 Host 相同即为同源请求，允许受口令保护的局域网面板正常写入。 */
export function isSameRequestOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") return false;
  try {
    return new URL(origin).host.toLowerCase() === new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return false;
  }
}

/** 额外可信 Origin 仅用于反向代理等 Host 不可直接比较的部署。 */
export function hasAllowedOrigin(origin: string): boolean {
  return (process.env["BUTLER_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .includes(origin);
}

export function isTrustedOrigin(origin: string, hostHeader: string | undefined): boolean {
  return isLoopbackOrigin(origin) || isSameRequestOrigin(origin, hostHeader) || hasAllowedOrigin(origin);
}

/** 从请求中提取访问口令：Authorization 头 > x-butler-token 头。不接受 URL query。 */
export function extractRequestToken(request: { headers: Record<string, unknown>; url: string }): string {
  const auth = request.headers["authorization"];
  if (typeof auth === "string" && auth.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const headerToken = request.headers["x-butler-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) return headerToken.trim();
  return "";
}

/** /ws 握手专用一次性短时凭据的有效期。 */
export const WS_TICKET_TTL_MS = 60_000;

/** 从 URL 提取 /ws 握手 ticket（?ticket=）。 */
export function extractRequestTicket(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  if (q === -1) return "";
  return new URLSearchParams(raw.slice(q + 1)).get("ticket")?.trim() ?? "";
}

/** 常量时间口令比较（对齐 gateway/updater，避免短路比较泄露前缀/长度信息）。 */
export function tokensMatch(presented: string, expected: string): boolean {
  if (expected === "") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
