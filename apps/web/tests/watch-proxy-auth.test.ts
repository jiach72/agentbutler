import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/server.js";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers.js";

describe("Web to Watch Proxy Layer Auth Token Passthrough", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    rmTempDir(tmp);
  });

  it("DELETE /api/llm/profiles/:id 经 proxyWatchDelete 穿透鉴权 token 至 Watch", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const prevToken = process.env["BUTLER_ACCESS_TOKEN"];
    process.env["BUTLER_ACCESS_TOKEN"] = "test-auth-token-xyz";

    try {
      const app = createWebServer({
        home: tmp,
        uiDist,
        watchUrl: "http://watch.internal",
        gatewayUrl: "http://gateway.internal",
        fetchImpl,
        accessToken: "",
      });
      apps.push(app);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/llm/profiles/ollama-llama3",
      });

      expect(res.statusCode).toBe(200);
      expect(capturedHeaders.length).toBeGreaterThan(0);
      expect(capturedHeaders[0]?.["x-butler-token"]).toBe("test-auth-token-xyz");
    } finally {
      if (prevToken === undefined) {
        delete process.env["BUTLER_ACCESS_TOKEN"];
      } else {
        process.env["BUTLER_ACCESS_TOKEN"] = prevToken;
      }
    }
  });

  it("DELETE /api/credentials/:id 与 DELETE /api/llm/bindings/:id 均穿透鉴权 token", async () => {
    const capturedRequests: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      capturedRequests.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(null, { status: 204 });
    });

    const prevToken = process.env["BUTLER_ACCESS_TOKEN"];
    process.env["BUTLER_ACCESS_TOKEN"] = "test-auth-token-xyz";

    try {
      const app = createWebServer({
        home: tmp,
        uiDist,
        watchUrl: "http://watch.internal",
        gatewayUrl: "http://gateway.internal",
        fetchImpl,
        accessToken: "",
      });
      apps.push(app);

      const delCredRes = await app.inject({
        method: "DELETE",
        url: "/api/credentials/cred-1",
      });
      expect(delCredRes.statusCode).toBe(204);

      const delBindRes = await app.inject({
        method: "DELETE",
        url: "/api/llm/bindings/binding-1",
      });
      expect(delBindRes.statusCode).toBe(204);

      expect(capturedRequests).toHaveLength(2);
      expect(capturedRequests[0]?.headers["x-butler-token"]).toBe("test-auth-token-xyz");
      expect(capturedRequests[0]?.method).toBe("DELETE");
      expect(capturedRequests[1]?.headers["x-butler-token"]).toBe("test-auth-token-xyz");
      expect(capturedRequests[1]?.method).toBe("DELETE");
    } finally {
      if (prevToken === undefined) {
        delete process.env["BUTLER_ACCESS_TOKEN"];
      } else {
        process.env["BUTLER_ACCESS_TOKEN"] = prevToken;
      }
    }
  });

  it("DELETE /api/approvals/rules/:fingerprint 与 POST /api/memory/export 均注入鉴权 token", async () => {
    const captured: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      captured.push({
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      if (String(url).includes("/api/memory/export")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const prevToken = process.env["BUTLER_ACCESS_TOKEN"];
    process.env["BUTLER_ACCESS_TOKEN"] = "secure-approval-token";

    try {
      const app = createWebServer({
        home: tmp,
        uiDist,
        watchUrl: "http://watch.internal",
        gatewayUrl: "http://gateway.internal",
        fetchImpl,
        accessToken: "",
      });
      apps.push(app);

      const delRuleRes = await app.inject({
        method: "DELETE",
        url: "/api/approvals/rules/rule-fp-abc",
      });
      expect(delRuleRes.statusCode).toBe(200);

      const exportRes = await app.inject({
        method: "POST",
        url: "/api/memory/export",
        payload: { format: "json" },
      });
      expect(exportRes.statusCode).toBe(200);

      expect(captured).toHaveLength(2);
      expect(captured[0]?.headers["x-butler-token"]).toBe("secure-approval-token");
      expect(captured[1]?.headers["x-butler-token"]).toBe("secure-approval-token");
    } finally {
      if (prevToken === undefined) {
        delete process.env["BUTLER_ACCESS_TOKEN"];
      } else {
        process.env["BUTLER_ACCESS_TOKEN"] = prevToken;
      }
    }
  });
});
