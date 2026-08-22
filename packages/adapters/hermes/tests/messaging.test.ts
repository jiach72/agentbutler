import { describe, expect, it } from "vitest";
import type { BridgeHealth, OutboxChangeBatch, PolicySnapshot } from "@butler/contract";
import { createHermesAdapter } from "../src/index.js";
import { createHermesMessaging, HermesBridgeClient } from "../src/messaging/index.js";

const HEALTH: BridgeHealth = {
  protocolVersion: 1,
  bridgeVersion: "0.1.0",
  instanceId: "hermes-main",
  attached: true,
  outboxWritable: true,
  policyVersion: "policy-1",
  channels: { weixin: "ok", a2a: "ok" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HermesBridgeClient", () => {
  it("health maps Bridge v1 JSON and sends bearer/version headers", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse(HEALTH);
    };
    const client = new HermesBridgeClient({
      baseUrl: "http://127.0.0.1:8754/",
      token: "secret",
      fetchImpl,
    });

    await expect(client.health()).resolves.toEqual(HEALTH);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8754/v1/health");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(calls[0]!.headers.get("x-butler-bridge-version")).toBe("1");
  });

  it("uses exact policy, change, decision, delivery, inbound, and prewarm routes", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const batch: OutboxChangeBatch = {
      afterSequence: 2,
      nextSequence: 2,
      items: [],
      taskEvents: [],
      inbound: [],
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      calls.push({ url: String(input), method: init?.method ?? "GET", body });
      const url = String(input);
      if (url.includes("/changes")) return jsonResponse(batch);
      if (url.endsWith("/policy")) {
        return jsonResponse({ version: "p1", sha256: "hash", appliedAt: "2026-08-22T00:00:00.000Z" });
      }
      if (url.endsWith("/prewarm")) {
        return jsonResponse({
          channel: "weixin",
          warmed: false,
          checkedAt: "2026-08-22T00:00:00.000Z",
          expiresAt: null,
        });
      }
      return jsonResponse(body);
    };
    const client = new HermesBridgeClient({
      baseUrl: "http://127.0.0.1:8754",
      token: "secret",
      fetchImpl,
    });
    const policy: PolicySnapshot = { version: "p1", sha256: "hash", payload: {} };

    await client.installPolicy(policy);
    await client.listChanges(2, 25);
    await client.decide({
      messageId: "m 1",
      expectedContentSha256: "hash",
      state: "ready",
      transformTrace: [],
      policyVersion: "p1",
      reason: "ready",
    });
    await client.deliver({ messageId: "m1", attemptId: "a1", expectedContentSha256: "hash" });
    await client.forwardInbound({
      inboundMessageId: "in/1",
      action: "forward",
      optimizedText: "hello",
      transformTrace: [],
    });
    await client.prewarm("weixin");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8754/v1/policy",
      "GET http://127.0.0.1:8754/v1/outbox/changes?after=2&limit=25",
      "POST http://127.0.0.1:8754/v1/outbox/m%201/decision",
      "POST http://127.0.0.1:8754/v1/deliver",
      "POST http://127.0.0.1:8754/v1/inbound/in%2F1/decision",
      "POST http://127.0.0.1:8754/v1/prewarm",
    ]);
  });
});

describe("createHermesMessaging", () => {
  it("converts unreachable Bridge to E302", async () => {
    const messaging = createHermesMessaging({
      baseUrl: "http://127.0.0.1:8754",
      token: "secret",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    const result = await messaging.health({
      instanceId: "hermes-main",
      rootPath: "/home/jiach/.hermes/hermes-agent",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E302");
  });

  it("converts Bridge 401 to E303", async () => {
    const messaging = createHermesMessaging({
      baseUrl: "http://127.0.0.1:8754",
      token: "wrong",
      fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    });

    const result = await messaging.health({ instanceId: "hermes-main" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E303");
  });

  it("is injected only when Bridge URL and token are both configured", () => {
    expect(createHermesAdapter().messaging).toBeUndefined();
    expect(
      createHermesAdapter({
        messaging: {
          bridgeUrl: "http://127.0.0.1:8754",
          bridgeToken: "secret",
          fetchImpl: async () => jsonResponse(HEALTH),
        },
      }).messaging,
    ).toBeDefined();
  });
});
