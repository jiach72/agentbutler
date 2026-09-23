import type { FastifyReply } from "fastify";

export interface ProxyHelpers {
  fetchWatch: (watchPath: string, timeoutMs?: number) => Promise<Response | null>;
  proxyWatchPost: (
    watchPath: string,
    body: unknown,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
  proxyWatchGet: (
    watchPath: string,
    reply: FastifyReply,
    timeoutMs?: number,
  ) => Promise<FastifyReply>;
}

export function createProxyHelpers(
  doFetch: typeof fetch,
  watchUrl: string,
): ProxyHelpers {
  const watchAuthHeaders = (): Record<string, string> => {
    const accessToken = (process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();
    const internalToken = (process.env["BUTLER_INTERNAL_TOKEN"] ?? "").trim();
    return {
      ...(accessToken === "" ? {} : { "x-butler-token": accessToken }),
      ...(internalToken === "" ? {} : { "x-butler-internal-token": internalToken }),
    };
  };

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
  ): Promise<FastifyReply> => {
    let res: Response;
    try {
      res = await doFetch(`${watchUrl}${watchPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...watchAuthHeaders(),
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

  return { fetchWatch, proxyWatchPost, proxyWatchGet };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
