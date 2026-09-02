import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatewayServer } from "../src/server.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = process.env["BUTLER_HERMES_ROOT"];

let capturedUrl = "";
let capturedAuth = "";
let capturedBody: unknown = null;
let fetchBehavior: "ok" | "unauthorized" | "refused" = "ok";

function fakeApiServerResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "已收到求助，我会检查日志。" } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("POST /api/agent-message", () => {
  beforeEach(() => {
    capturedUrl = "";
    capturedAuth = "";
    capturedBody = null;
    fetchBehavior = "ok";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-root-"));
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      "platforms:\n  api_server:\n    enabled: true\n    extra:\n      host: 127.0.0.1\n      port: 18642\n      key: test-secret-key\n",
      "utf8",
    );
    process.env["BUTLER_HERMES_ROOT"] = dir;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      capturedBody = init?.body === undefined ? null : JSON.parse(String(init.body));
      if (fetchBehavior === "refused") throw new TypeError("connect ECONNREFUSED");
      if (fetchBehavior === "unauthorized") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return fakeApiServerResponse();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ENV === undefined) delete process.env["BUTLER_HERMES_ROOT"];
    else process.env["BUTLER_HERMES_ROOT"] = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  function buildApp() {
    return createGatewayServer({ startLoop: false });
  }

  it("把求助提示词转发给 api_server 并返回回复；key 不出现在响应里", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-message",
        payload: { text: "帮我排查一个反复出现的错误" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, reply: "已收到求助，我会检查日志。" });
      expect(capturedUrl).toContain("127.0.0.1:18642/v1/chat/completions");
      expect(capturedAuth).toBe("Bearer test-secret-key");
      expect(JSON.stringify(res.json())).not.toContain("test-secret-key");
      const body = capturedBody as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0]).toMatchObject({ role: "user", content: "帮我排查一个反复出现的错误" });
    } finally {
      await app.close();
    }
  });

  it("text 缺失返回 400", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/agent-message", payload: {} });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("找不到 api_server 配置返回 503", async () => {
    process.env["BUTLER_HERMES_ROOT"] = fs.mkdtempSync(path.join(os.tmpdir(), "empty-root-"));
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-message",
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "agent-api-unavailable" });
    } finally {
      await app.close();
    }
  });

  it("连接被拒时回退候选主机后返回 502", async () => {
    fetchBehavior = "refused";
    const app = buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-message",
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: "agent-unreachable" });
    } finally {
      await app.close();
    }
  });
});
