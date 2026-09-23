import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayServer } from "../src/server.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = process.env["BUTLER_HERMES_ROOT"];

let capturedHeaders: Record<string, string> = {};
let capturedBody: unknown = null;

describe("Gateway Pantheon Bot & Jev Endpoints", () => {
  let tmpHermesRoot = "";

  beforeEach(() => {
    capturedHeaders = {};
    capturedBody = null;
    tmpHermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gateway-test-"));
    fs.writeFileSync(
      path.join(tmpHermesRoot, "config.yaml"),
      "platforms:\n  api_server:\n    enabled: true\n    extra:\n      host: 127.0.0.1\n      port: 18642\n      key: test-secret-key\n",
      "utf8",
    );
    process.env["BUTLER_HERMES_ROOT"] = tmpHermesRoot;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = {};
      new Headers(init?.headers).forEach((v, k) => {
        capturedHeaders[k] = v;
      });
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "智能体已执行分析。" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ENV === undefined) delete process.env["BUTLER_HERMES_ROOT"];
    else process.env["BUTLER_HERMES_ROOT"] = ORIGINAL_ENV;
    if (tmpHermesRoot && fs.existsSync(tmpHermesRoot)) {
      fs.rmSync(tmpHermesRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function buildApp() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "butler-gw-bot-test-"));
    return createGatewayServer({ home, startLoop: false });
  }

  it("GET /api/bots 返回包含预设 3 大 Bot 的名册", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/bots" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ok: boolean; bots: Array<{ id: string }> };
    expect(data.ok).toBe(true);
    expect(data.bots.length).toBeGreaterThanOrEqual(3);
    const ids = data.bots.map((b) => b.id);
    expect(ids).toContain("butler");
    expect(ids).toContain("inspector");
    expect(ids).toContain("scout");
  });

  it("POST /api/agent-message 携带 botId 时注入 x-hermes-profile 请求头与 SOUL.md system 提示词", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-message",
      payload: {
        text: "请检查系统健康",
        botId: "inspector",
        sessionId: "session-test",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.botId).toBe("inspector");

    // 验证发往 api_server 的请求头与请求体
    expect(capturedHeaders["x-hermes-profile"]).toBe("inspector");
    const sentBody = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(sentBody.messages[0].role).toBe("system");
    expect(sentBody.messages[0].content).toContain("审查员 (Inspector)");
    expect(sentBody.messages[1].content).toBe("请检查系统健康");
  });

  it("POST /api/bots/dispatch 能够完成群聊智能分流调度", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/bots/dispatch",
      payload: {
        message: "有 500 错误日志，麻烦审查一下",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.selectedBotId).toBe("inspector");
  });

  it("POST /api/bots/handoff 能够判定是否触发流水线接力", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/bots/handoff",
      payload: {
        currentBotId: "scout",
        botResponse: "文档已抓取，请 @inspector 继续审查代码质量",
        turnCount: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.needsHandoff).toBe(true);
    expect(json.nextBotId).toBe("inspector");
  });

  it("POST /api/bots/compliance 能够完成 Bot 人设与安全合规打分", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/bots/compliance",
      payload: {
        botId: "inspector",
        responseContent: "分析完成，未发现异常。",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.ok).toBe(true);
    expect(json.score).toBeGreaterThanOrEqual(3);
    expect(json.compliant).toBe(true);
  });
});
