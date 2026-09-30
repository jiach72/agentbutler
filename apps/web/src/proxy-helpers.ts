import type { FastifyReply } from "fastify";

export interface ProxyHelpers {
  fetchWatch: (watchPath: string, timeoutMs?: number) => Promise<Response | null>;
  proxyWatchPost: (
    watchPath: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs?: number,
    extraHeaders?: Record<string, string>,
  ) => Promise<FastifyReply>;
  proxyWatchGet: (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
  proxyWatchDelete: (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
}

export function watchAuthHeaders(): Record<string, string> {
  const accessToken = (process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();
  const internalToken = (process.env["BUTLER_INTERNAL_TOKEN"] ?? "").trim();
  return {
    ...(accessToken === "" ? {} : { "x-butler-token": accessToken }),
    ...(internalToken === "" ? {} : { "x-butler-internal-token": internalToken }),
  };
}

/**
 * 面板决策凭据（审批升级单防绕过）：仅附加在 web → watch 的审批决策代理上。
 * watch 端以该头判定 allowEscalatedInline，网关等只持内部口令的调用方拿不到
 * 此凭据（BUTLER_PANEL_DECISION_TOKEN 只注入 butler-web 与 butler-watch）。
 * 未配置时不上传头：watch 侧对升级单 fail-closed（保持「需面板确认」）。
 */
export function panelDecisionHeaders(): Record<string, string> {
  const token = (process.env["BUTLER_PANEL_DECISION_TOKEN"] ?? "").trim();
  return token === "" ? {} : { "x-butler-panel-decision": token };
}

export function createProxyHelpers(
  doFetch: typeof fetch,
  watchUrl: string,
): ProxyHelpers {
  const fetchWatch = async (
    watchPath: string,
    timeoutMs = 5_000,
  ): Promise<Response | null> => {
    try {
      return await doFetch(`${watchUrl}${watchPath}`, {
        headers: watchAuthHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  };

  const proxyWatchPost = async (
    watchPath: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs = 5_000,
    extraHeaders?: Record<string, string>,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...watchAuthHeaders(),
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    const raw = await res.text();
    let parsed: unknown = {};
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }
    return reply.status(res.status).send(parsed);
  };

  const proxyWatchGet = async (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs = 5_000,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, {
        headers: watchAuthHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // 容错与启动瞬态补偿：短促等待 200ms 重试一次（针对连接拒绝或抖动），避免瞬态 502
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        res = await doFetch(`${watchUrl}${watchPath}`, {
          headers: watchAuthHeaders(),
          signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
        });
      } catch {
        return reply.status(502).send({ error: "watch-unreachable" });
      }
    }
    const raw = await res.text();
    let parsed: unknown = {};
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }
    return reply.status(res.status).send(parsed);
  };

  const proxyWatchDelete = async (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs = 5_000,
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, {
        method: "DELETE",
        headers: watchAuthHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply.status(502).send({ error: "watch-unreachable" });
    }
    if (res.status === 204) return reply.status(204).send();
    const raw = await res.text();
    let parsed: unknown = {};
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }
    return reply.status(res.status).send(parsed);
  };

  return { fetchWatch, proxyWatchPost, proxyWatchGet, proxyWatchDelete };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
