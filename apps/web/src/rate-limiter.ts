import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitRule {
  /** 路由前缀匹配 */
  prefix: string;
  /** 时间窗口内允许的最大请求数 */
  max: number;
  /** 时间窗口（毫秒），缺省 60,000（1 分钟） */
  windowMs?: number;
}

/**
 * 精准速率限制规则（ENG-04）：
 * - 静态资源、WebSocket、/api/health：完全豁免；
 * - 轮询聚合端点（/api/dashboard, /api/messages/status, /api/alerts）：宽容限流 600/min；
 * - 高危与破坏性端点：
 *   - /api/killswitch：严格限制 10/min；
 *   - /api/upgrade/run：限制 5/min；
 *   - /api/inspect/run：限制 10/min。
 */
export const TIERED_RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  { prefix: "/api/upgrade/run", max: 5, windowMs: 60_000 },
  { prefix: "/api/killswitch", max: 10, windowMs: 60_000 },
  { prefix: "/api/inspect/run", max: 10, windowMs: 60_000 },
  { prefix: "/api/dashboard", max: 600, windowMs: 60_000 },
  { prefix: "/api/messages/status", max: 600, windowMs: 60_000 },
  { prefix: "/api/alerts", max: 600, windowMs: 60_000 },
] as const;

interface ClientRecord {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private readonly clients = new Map<string, ClientRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly rules: readonly RateLimitRule[] = TIERED_RATE_LIMIT_RULES) {
    // 定期（每 60 秒）清理过期客户端记录，防止内存泄漏
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  public destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clients.clear();
  }

  /**
   * 检查请求是否命中限流规则。
   * 返回 null 表示豁免或放行；返回 object 表示被限流（含 retryAfterSeconds）。
   */
  public check(
    clientIp: string,
    pathname: string,
  ): { limited: boolean; limit: number; remaining: number; retryAfterSeconds: number } | null {
    // 豁免路径
    if (
      !pathname.startsWith("/api/") ||
      pathname === "/api/health" ||
      pathname === "/api/status" ||
      pathname === "/ws"
    ) {
      return null;
    }

    // 匹配最具体的规则
    const matchedRule = this.rules.find((r) => pathname.startsWith(r.prefix));
    if (!matchedRule) {
      // 未配置规则的普通 API 端点不限流
      return null;
    }

    const windowMs = matchedRule.windowMs ?? 60_000;
    const now = Date.now();
    const windowStart = now - windowMs;
    const key = `${clientIp}:${matchedRule.prefix}`;

    let record = this.clients.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.clients.set(key, record);
    }

    // 剔除窗口外的旧时间戳
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= matchedRule.max) {
      const oldest = record.timestamps[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return {
        limited: true,
        limit: matchedRule.max,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    // 计入当前请求
    record.timestamps.push(now);
    return {
      limited: false,
      limit: matchedRule.max,
      remaining: matchedRule.max - record.timestamps.length,
      retryAfterSeconds: 0,
    };
  }

  public cleanup(): void {
    const now = Date.now();
    const maxWindow = Math.max(60_000, ...this.rules.map((r) => r.windowMs ?? 60_000));
    for (const [key, record] of this.clients.entries()) {
      record.timestamps = record.timestamps.filter((ts) => ts > now - maxWindow);
      if (record.timestamps.length === 0) {
        this.clients.delete(key);
      }
    }
  }
}

/**
 * 为 Fastify 应用装载精准速率限制插件
 */
export function registerRateLimiting(
  app: FastifyInstance,
  limiter: SlidingWindowRateLimiter = new SlidingWindowRateLimiter(),
): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? "/";
    const q = url.indexOf("?");
    const pathname = q === -1 ? url : url.slice(0, q);
    const clientIp = request.ip || request.socket.remoteAddress || "127.0.0.1";

    const result = limiter.check(clientIp, pathname);
    if (result === null) {
      return;
    }

    reply.header("x-ratelimit-limit", String(result.limit));
    reply.header("x-ratelimit-remaining", String(result.remaining));

    if (result.limited) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      return reply.status(429).send({
        error: "too-many-requests",
        message: "操作过于频繁，请稍后再试",
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  });

  app.addHook("onClose", async () => {
    limiter.destroy();
  });
}
