import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MessagePolicyConfig } from "../src/message/types";
import { createPolicySnapshot, DEFAULT_MESSAGE_POLICY } from "../src/message/config";
import { MessagePolicyStore } from "../src/message/store";
import { createGatewayServer, type GatewayApp } from "../src/server";
import { AlertQueue } from "../src/queue";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const NOW = "2026-08-22T10:00:00.000Z";

describe("gateway message HTTP API", () => {
  let tmp: string;
  let queue: AlertQueue;
  let store: MessagePolicyStore;
  let app: GatewayApp;
  let wakeCount: number;
  let failPolicyInstall: boolean;
  let failStatus: boolean;
  let statusLastError: string | null;

  beforeEach(() => {
    tmp = makeTempDir();
    queue = new AlertQueue(gatewayDbFile(tmp));
    store = new MessagePolicyStore(`${tmp}/messages.sqlite`);
    store.savePolicy(DEFAULT_MESSAGE_POLICY);
    store.ingestBatch(
      {
        afterSequence: 0,
        nextSequence: 1,
        items: [
          {
            messageId: "m-held",
            instanceId: "hermes-main",
            adapterId: "hermes",
            channel: "weixin",
            chatId: "chat-1",
            sessionId: "session-1",
            runId: "run-1",
            messageKind: "task-progress",
            transport: "queued-push",
            priority: "normal",
            content: "still working",
            contentSha256: "hash-held",
            metadata: {},
            capturedAt: NOW,
            sequence: 1,
            state: "held_dnd",
            availableAt: "2026-08-22T12:00:00.000Z",
            attemptCount: 0,
            providerMessageId: null,
            deliveredAt: null,
            lastError: null,
            transformTrace: ["dnd:held"],
          },
        ],
        taskEvents: [
          {
            runId: "run-1",
            sequence: 1,
            sessionId: "session-1",
            kind: "progress",
            summary: "working",
            occurredAt: NOW,
          },
        ],
        inbound: [],
      },
      "hermes-main",
    );
    wakeCount = 0;
    failPolicyInstall = false;
    failStatus = false;
    statusLastError = null;
    const messageService = {
      status: async () => {
        if (failStatus) throw new Error("token must-not-leak");
        return {
          running: true,
          inFlight: false,
          bridgeConnected: true,
          bridgeHealth: {
            protocolVersion: 1,
            bridgeVersion: "bridge-test",
            instanceId: "hermes-main",
            attached: true,
            outboxWritable: true,
            policyVersion: DEFAULT_MESSAGE_POLICY.version,
            channels: { weixin: "ok", a2a: "ok" },
            coverage: { runtime: "ok", apiJson: "ok", apiSse: "ok" },
            startedAt: NOW,
          },
          policyVersion: DEFAULT_MESSAGE_POLICY.version,
          policyHash: store.loadPolicy()?.sha256 ?? null,
          lastCycleAt: NOW,
          lastError: statusLastError,
          counts: store.counts(),
        };
      },
      updatePolicy: async (config: MessagePolicyConfig) => {
        if (failPolicyInstall) throw new Error("bearer super-secret");
        return store.savePolicy(createPolicySnapshot(config));
      },
      wake: () => {
        wakeCount += 1;
      },
    };
    const options = {
      queue,
      channels: [],
      startLoop: false,
      messageStore: store,
      messageService,
      messageMode: "observe" as const,
    };
    app = createGatewayServer(options);
  });

  afterEach(async () => {
    await app.close();
    store.close();
    queue.close();
    rmTempDir(tmp);
  });

  it("reports projected status and exposes message and task details", async () => {
    const status = await app.inject({ method: "GET", url: "/api/messages/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      bridge: {
        connected: true,
        attached: true,
        outboxWritable: true,
        protocolVersion: 1,
        bridgeVersion: "bridge-test",
        policyVersion: "message-policy-v1",
        running: true,
        channels: { weixin: "ok", a2a: "ok" },
        coverage: { runtime: "ok", apiJson: "ok", apiSse: "ok" },
      },
      mode: "observe",
      nativeMinIntervalSec: 45,
      counts: { held_dnd: 1, delivery_unknown: 0 },
    });

    const list = await app.inject({ method: "GET", url: "/api/messages?limit=1&state=held_dnd" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ messageId: "m-held", state: "held_dnd" }] });

    const detail = await app.inject({ method: "GET", url: "/api/messages/m-held" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ messageId: "m-held", runId: "run-1" });

    const task = await app.inject({ method: "GET", url: "/api/messages/tasks/run-1" });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({ runId: "run-1", events: [{ summary: "working" }] });
  });

  it("returns zero-filled delivery history up to the 365-day retention limit", async () => {
    const history = await app.inject({ method: "GET", url: "/api/messages/delivery-history?days=365" });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ days: 365, retentionDays: 365 });
    expect((history.json() as { items: unknown[] }).items).toHaveLength(365);

    const invalid = await app.inject({ method: "GET", url: "/api/messages/delivery-history?days=366" });
    expect(invalid.statusCode).toBe(400);
  });

  it("upserts, lists, validates, and deletes scoped DND rules", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/messages/dnd/session/weixin%3Achat-1",
      payload: { timeZone: "Asia/Shanghai", startMinute: 1320, endMinute: 420, enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      scope: "session",
      scopeKey: "weixin:chat-1",
      enabled: true,
    });

    const list = await app.inject({ method: "GET", url: "/api/messages/dnd" });
    expect(list.json().items).toHaveLength(1);

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/messages/dnd/channel/weixin",
      payload: { timeZone: "Mars/Olympus", startMinute: 0, endMinute: 60, enabled: true },
    });
    expect(invalid.statusCode).toBe(400);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/messages/dnd/${encodeURIComponent(put.json().ruleId)}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/messages/dnd" })).json().items).toEqual(
      [],
    );
  });

  it("returns policy metadata, rejects unknown fields, and sanitizes Bridge failures", async () => {
    const current = await app.inject({ method: "GET", url: "/api/messages/policy" });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      version: DEFAULT_MESSAGE_POLICY.version,
      payload: { inlineResponse: "allow" },
    });

    const updatedPolicy = structuredClone(DEFAULT_MESSAGE_POLICY);
    updatedPolicy.digest.windowSec = 180;
    const updated = await app.inject({
      method: "PUT",
      url: "/api/messages/policy",
      payload: updatedPolicy,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      version: DEFAULT_MESSAGE_POLICY.version,
      sha256: expect.any(String),
    });

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/messages/policy",
      payload: { ...updatedPolicy, unexpected: true },
    });
    expect(unknown.statusCode).toBe(400);

    const invalidRate = structuredClone(updatedPolicy);
    invalidRate.channels.weixin.initialRatePerMin = -1;
    expect(
      (await app.inject({ method: "PUT", url: "/api/messages/policy", payload: invalidRate }))
        .statusCode,
    ).toBe(400);

    failPolicyInstall = true;
    const unavailable = await app.inject({
      method: "PUT",
      url: "/api/messages/policy",
      payload: updatedPolicy,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: "E303", error: "Hermes Bridge unavailable" });
    expect(unavailable.body).not.toContain("super-secret");

    statusLastError = "Authorization: Bearer must-not-leak";
    const degraded = await app.inject({ method: "GET", url: "/api/messages/status" });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json().bridge.lastError).toBe("Hermes Bridge unavailable");
    expect(degraded.body).not.toContain("must-not-leak");

    failStatus = true;
    const disconnected = await app.inject({ method: "GET", url: "/api/messages/status" });
    expect(disconnected.statusCode).toBe(503);
    expect(disconnected.json()).toEqual({ code: "E302", error: "Hermes Bridge unavailable" });
    expect(disconnected.body).not.toContain("must-not-leak");
  });

  it("dedupes internal hints and wakes reconciliation without trusting hint payloads as state", async () => {
    const outbound = {
      method: "POST" as const,
      url: "/internal/hermes/outbound",
      payload: { messageId: "m-new" },
    };
    expect((await app.inject(outbound)).json()).toEqual({ accepted: true, deduped: false });
    expect((await app.inject(outbound)).json()).toEqual({ accepted: true, deduped: true });

    const task = {
      method: "POST" as const,
      url: "/internal/hermes/task-event",
      payload: { runId: "run-2", sequence: 3 },
    };
    expect((await app.inject(task)).json()).toEqual({ accepted: true, deduped: false });
    expect((await app.inject(task)).json()).toEqual({ accepted: true, deduped: true });

    const inbound = {
      method: "POST" as const,
      url: "/internal/hermes/inbound",
      payload: { inboundMessageId: "in-1" },
    };
    expect((await app.inject(inbound)).json()).toEqual({ accepted: true, deduped: false });
    expect((await app.inject(inbound)).json()).toEqual({ accepted: true, deduped: true });
    expect(wakeCount).toBe(3);
    expect(store.messageView("m-new")).toBeUndefined();
  });

  it("returns optimization history from the runtime callback", async () => {
    const historyApp = createGatewayServer({
      queue,
      channels: [],
      startLoop: false,
      messageStore: store,
      messageService: {
        status: async () => ({
          running: true,
          inFlight: false,
          bridgeConnected: true,
          bridgeHealth: null,
          policyVersion: null,
          policyHash: null,
          lastCycleAt: null,
          lastError: null,
          counts: store.counts(),
        }),
        updatePolicy: async (config: MessagePolicyConfig) =>
          store.savePolicy(createPolicySnapshot(config)),
        wake: () => undefined,
      },
      inboundHistory: async (limit) => {
        expect(limit).toBe(20);
        return {
          ok: true,
          data: {
            items: [
              {
                inboundMessageId: "in-opt-1",
                inbound: {
                  inboundMessageId: "in-opt-1",
                  instanceId: "hermes-main",
                  adapterId: "weixin",
                  channel: "weixin",
                  chatId: "chat-1",
                  content: "帮我把那个论文技能弄好点",
                  receivedAt: NOW,
                },
                decision: {
                  inboundMessageId: "in-opt-1",
                  action: "forward",
                  optimizedText: "改进论文技能",
                  transformTrace: ["optimize:strip-filler"],
                  mode: "rule",
                  changes: ["去掉开头的客套话"],
                },
                decidedAt: NOW,
              },
            ],
          },
          durationMs: 1,
        };
      },
    });
    try {
      const response = await historyApp.inject({
        method: "GET",
        url: "/api/messages/optimization-history?limit=20",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        reachable: true,
        items: [
          {
            inboundMessageId: "in-opt-1",
            decision: { optimizedText: "改进论文技能", mode: "rule" },
          },
        ],
      });
    } finally {
      await historyApp.close();
    }
  });

  it("degrades optimization history when callback is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/messages/optimization-history",
    });
    expect(response.statusCode).toBe(503);
  });

  it("caps JSON request bodies at one MiB", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/internal/hermes/inbound",
      payload: { inboundMessageId: "large", content: "x".repeat(1024 * 1024) },
    });
    expect(response.statusCode).toBe(413);
  });

  it("reports native mode instead of returning a misleading Bridge 503 when runtime is disabled", async () => {
    const nativeApp = createGatewayServer({ queue, channels: [], startLoop: false, messageMode: "native" });
    try {
      const response = await nativeApp.inject({ method: "GET", url: "/api/messages/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        mode: "native",
        nativeMinIntervalSec: 45,
        hermesGateway: { authoritative: true, connected: true, running: false },
        bridge: { connected: false },
      });
    } finally {
      await nativeApp.close();
    }
  });
});
