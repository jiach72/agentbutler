import fs from "node:fs";
import path from "node:path";

import { fail, ok } from "@butler/contract";
import type {
  BridgeHealth,
  InstanceRef,
  MessagingAdapter,
  OutboxChangeBatch,
  PolicySnapshot,
  Result,
} from "@butler/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertQueue } from "../src/queue";
import {
  MESSAGE_RUNTIME_ENV,
  createHermesMessageRuntime,
  type HermesMessageRuntimeOptions,
} from "../src/message/runtime";
import { DEFAULT_MESSAGE_POLICY } from "../src/message/config";
import { decideOutboundPolicy } from "../src/message/policy";
import { MessagePolicyStore } from "../src/message/store";
import { createGatewayServer } from "../src/server";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const NOW = "2026-08-22T10:00:00.000Z";

class RuntimeAdapter implements MessagingAdapter {
  readonly calls: string[] = [];
  readonly instances: InstanceRef[] = [];
  policyFailure = false;
  policyErrorCode: "E302" | "E303" = "E303";
  ackMismatch = false;
  healthFailure = false;
  batchFor = (afterSequence: number): OutboxChangeBatch => ({
    afterSequence,
    nextSequence: afterSequence,
    items: [],
    taskEvents: [],
    inbound: [],
  });
  changesGate: Promise<void> | undefined;

  attachOutbound = async () => fail("E002", "not used");
  health = async (instance: InstanceRef): Promise<Result<BridgeHealth>> => {
    this.instances.push(instance);
    if (this.healthFailure) return fail("E302", "health unavailable");
    return ok({
      protocolVersion: 1,
      bridgeVersion: "test",
      instanceId: instance.instanceId,
      attached: true,
      outboxWritable: true,
      policyVersion: "message-policy-v1",
      channels: { weixin: "ok" },
    });
  };
  updatePolicy = async (instance: InstanceRef, snapshot: PolicySnapshot) => {
    this.calls.push("policy");
    this.instances.push(instance);
    if (this.policyFailure) {
      return fail(this.policyErrorCode, "policy refused");
    }
    if (this.ackMismatch) {
      return ok({ version: "other-version", sha256: "other-sha", appliedAt: NOW });
    }
    return ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: NOW });
  };
  listChanges = async (instance: InstanceRef, afterSequence: number) => {
    this.calls.push("changes");
    this.instances.push(instance);
    await this.changesGate;
    return ok(this.batchFor(afterSequence));
  };
  decideOutbound = async () => fail("E002", "not used");
  requeueOutbound = async () => fail("E002", "not used");
  resolveOutbound?: (
    instance: InstanceRef,
    messageId: string,
    outcome: "delivered" | "cancelled",
    reason?: string,
  ) => Promise<Result<OutboxMessageView>>;
  deliver = async () => fail("E002", "not used");
  forwardInbound = async () => fail("E002", "not used");
  subscribeTaskEvents = () => () => undefined;
  prewarmChannel = async () => fail("E002", "not used");
}

function privateToken(file: string, value = "bridge-test-token\n"): void {
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function runtimeOptions(
  tmp: string,
  adapter: RuntimeAdapter,
  overrides: Partial<HermesMessageRuntimeOptions> = {},
): HermesMessageRuntimeOptions {
  const hermesRoot = path.join(tmp, "hermes");
  const tokenFile = path.join(tmp, "bridge.token");
  const pollIntervalMs = overrides.pollIntervalMs ?? 25;
  fs.mkdirSync(hermesRoot, { recursive: true });
  privateToken(tokenFile);
  return {
    bridgeUrl: "http://127.0.0.1:9124",
    instanceId: "hermes-main",
    hermesRoot,
    tokenFile,
    projectionDbFile: path.join(tmp, "projection", "messages.sqlite"),
    pollIntervalMs,
    stopTimeoutMs: 250,
    messagingFactory: (options) => {
      expect(options).toMatchObject({
        baseUrl: "http://127.0.0.1:9124",
        token: "bridge-test-token",
        pollIntervalMs,
      });
      return adapter;
    },
    ...overrides,
  };
}

describe("createHermesMessageRuntime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tmp of tempDirs.splice(0)) rmTempDir(tmp);
  });

  function tempDir(): string {
    const tmp = makeTempDir();
    tempDirs.push(tmp);
    return tmp;
  }

  it("requires complete configuration and ignores plaintext token environment variables", () => {
    const tmp = tempDir();
    const hermesRoot = path.join(tmp, "hermes");
    fs.mkdirSync(hermesRoot);
    expect(() =>
      createHermesMessageRuntime({
        env: {
          [MESSAGE_RUNTIME_ENV.bridgeUrl]: "http://127.0.0.1:9124",
          [MESSAGE_RUNTIME_ENV.instanceId]: "hermes-main",
          [MESSAGE_RUNTIME_ENV.hermesRoot]: hermesRoot,
          [MESSAGE_RUNTIME_ENV.projectionDbFile]: path.join(tmp, "projection.sqlite"),
          BUTLER_HERMES_BRIDGE_TOKEN: "must-not-be-used",
        },
      }),
    ).toThrow(new RegExp(MESSAGE_RUNTIME_ENV.tokenFile));
  });

  it("rejects non-private and non-regular token files before opening the projection", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const options = runtimeOptions(tmp, adapter);
    if (process.platform === "win32") {
      // NTFS ACLs are not represented by Node's synthetic POSIX mode bits.
      // POSIX permission enforcement is covered in Linux/WSL CI.
      fs.chmodSync(options.tokenFile!, 0o644);
      const permissiveRuntime = createHermesMessageRuntime(options);
      await permissiveRuntime.stop();
    } else {
      fs.chmodSync(options.tokenFile!, 0o644);
      expect(() => createHermesMessageRuntime(options)).toThrow(/private.*0600|group\/world/i);
    }

    const directoryToken = path.join(tmp, "token-directory");
    fs.mkdirSync(directoryToken);
    expect(() => createHermesMessageRuntime({ ...options, tokenFile: directoryToken })).toThrow(
      /regular file/i,
    );

    fs.chmodSync(options.tokenFile!, 0o600);
    const runtime = createHermesMessageRuntime(options);
    await runtime.stop();
  });

  it("uses the real Hermes messaging adapter by default", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const requests: Array<{ url: string; authorized: boolean }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorized: headers.get("authorization") === "Bearer bridge-test-token",
      });
      if (url.endsWith("/v1/policy")) {
        const snapshot = JSON.parse(String(init?.body)) as PolicySnapshot;
        return new Response(
          JSON.stringify({
            version: snapshot.version,
            sha256: snapshot.sha256,
            appliedAt: NOW,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/outbox/changes?")) {
        return new Response(
          JSON.stringify({
            afterSequence: 0,
            nextSequence: 0,
            items: [],
            taskEvents: [],
            inbound: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/health")) {
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            bridgeVersion: "test",
            instanceId: "hermes-main",
            attached: true,
            outboxWritable: true,
            policyVersion: "message-policy-v1",
            channels: { weixin: "ok" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, {
        messagingFactory: undefined,
        fetchImpl,
        pollIntervalMs: 60_000,
      }),
    );

    await runtime.start();
    expect((await runtime.service.status()).bridgeConnected).toBe(true);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/policy",
      "/v1/outbox/changes",
      "/v1/health",
    ]);
    expect(requests.every((request) => request.authorized)).toBe(true);
    await runtime.stop();
  });

  it("does not open the projection when adapter composition fails", () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const options = runtimeOptions(tmp, adapter, {
      messagingFactory: () => {
        throw new Error("factory failed");
      },
    });

    expect(() => createHermesMessageRuntime(options)).toThrow(/factory failed/);
    expect(fs.existsSync(options.projectionDbFile!)).toBe(false);
  });

  it("installs policy before reconciliation and owns concurrent start/stop exactly once", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    let releaseChanges: (() => void) | undefined;
    adapter.changesGate = new Promise<void>((resolve) => {
      releaseChanges = resolve;
    });
    const runtime = createHermesMessageRuntime(runtimeOptions(tmp, adapter));

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    expect(firstStart).toBe(secondStart);
    await vi.waitFor(() => expect(adapter.calls).toEqual(["policy", "changes"]));

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    releaseChanges?.();
    await Promise.all([firstStart, secondStart, stopping]);
    expect(adapter.calls).toEqual(["policy", "changes"]);
    expect(
      adapter.instances.every((instance) => instance.rootPath === path.join(tmp, "hermes")),
    ).toBe(true);
    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow(/closed/i);
  });

  it("degrades a refused policy install at startup to periodic retry instead of a crash loop", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    adapter.policyFailure = true;
    adapter.policyErrorCode = "E303";
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );

    await runtime.start();
    expect((await runtime.service.status()).running).toBe(true);
    expect((await runtime.service.status()).lastError).toMatch(/policy install failed/);

    adapter.policyFailure = false;
    runtime.service.wake();
    await vi.waitFor(async () => {
      expect((await runtime.service.status()).bridgeConnected).toBe(true);
    });
    expect(adapter.calls.filter((call) => call === "policy").length).toBeGreaterThanOrEqual(2);
    await runtime.stop();
  });

  it("fails fast and rolls back when Bridge acknowledges a different policy snapshot", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    adapter.ackMismatch = true;
    const runtime = createHermesMessageRuntime(runtimeOptions(tmp, adapter));

    await expect(runtime.start()).rejects.toThrow(/different policy snapshot/);
    expect(() => runtime.store.counts()).toThrow();
    await runtime.stop();
  });

  it("keeps Gateway running through a Bridge outage and reconnects on the next cycle", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    adapter.policyFailure = true;
    adapter.policyErrorCode = "E302";
    adapter.healthFailure = true;
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );

    await runtime.start();
    expect((await runtime.service.status()).running).toBe(true);
    expect((await runtime.service.status()).bridgeConnected).toBe(false);

    adapter.policyFailure = false;
    adapter.healthFailure = false;
    runtime.service.wake();
    await vi.waitFor(async () => {
      expect((await runtime.service.status()).bridgeConnected).toBe(true);
    });
    expect(adapter.calls.filter((call) => call === "policy").length).toBeGreaterThanOrEqual(2);
    await runtime.stop();
  });

  it("persists its projection across restart and backs the real Gateway HTTP routes", async () => {
    const tmp = tempDir();
    const projectionDbFile = path.join(tmp, "projection", "messages.sqlite");
    const firstAdapter = new RuntimeAdapter();
    firstAdapter.batchFor = (afterSequence) => ({
      afterSequence,
      nextSequence: afterSequence === 0 ? 1 : afterSequence,
      items: [],
      taskEvents:
        afterSequence === 0
          ? [
              {
                runId: "run-runtime",
                sequence: 1,
                sessionId: "session-runtime",
                kind: "started",
                occurredAt: NOW,
              },
            ]
          : [],
      inbound: [],
    });
    const first = createHermesMessageRuntime(
      runtimeOptions(tmp, firstAdapter, {
        projectionDbFile,
        pollIntervalMs: 60_000,
      }),
    );
    await first.start();
    expect(first.store.taskView("run-runtime")?.events).toHaveLength(1);
    await first.stop();

    const secondAdapter = new RuntimeAdapter();
    const second = createHermesMessageRuntime(
      runtimeOptions(tmp, secondAdapter, {
        projectionDbFile,
        pollIntervalMs: 60_000,
      }),
    );
    await second.start();
    expect(second.store.taskView("run-runtime")?.events).toHaveLength(1);

    const queue = new AlertQueue(gatewayDbFile(tmp));
    const app = createGatewayServer({
      queue,
      channels: [],
      startLoop: false,
      messageService: second.service,
      messageStore: second.store,
    });
    const status = await app.inject({ method: "GET", url: "/api/messages/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      bridge: { connected: true, running: true, policyVersion: "message-policy-v1" },
    });
    const task = await app.inject({ method: "GET", url: "/api/messages/tasks/run-runtime" });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({ runId: "run-runtime", events: [{ kind: "started" }] });

    await app.close();
    queue.close();
    await second.stop();
  }, 15_000);

  it("expedite re-issues a waiting message as ready with availableAt now", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const decisions: Array<{
      messageId: string;
      state?: string;
      availableAt?: string;
      expectedContentSha256?: string;
    }> = [];
    const waiting = {
      messageId: "exp-ready",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      messageKind: "final" as const,
      transport: "queued-push" as const,
      priority: "normal" as const,
      content: "done",
      contentSha256: "content-sha-1",
      metadata: {},
      capturedAt: NOW,
      sequence: 1,
      state: "held_pacing" as const,
      availableAt: "2026-08-22T10:05:00.000Z" as string | null,
      attemptCount: 0,
      providerMessageId: null,
      deliveredAt: null,
      lastError: null,
      transformTrace: [] as string[],
    };
    adapter.decideOutbound = async (_instance, decision) => {
      decisions.push(decision);
      return ok({
        ...waiting,
        state: "ready",
        availableAt: decision.availableAt ?? null,
        transformTrace: decision.transformTrace,
      });
    };
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );
    try {
      runtime.store.ingestBatch({
        afterSequence: 0,
        nextSequence: 1,
        items: [waiting],
        taskEvents: [],
        inbound: [],
      });

      const wakeSpy = vi.spyOn(runtime.service, "wake");
      const result = await runtime.expediteMessage("exp-ready");
      expect(result.ok).toBe(true);
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      expect(decisions).toHaveLength(1);
      const decision = decisions[0]!;
      expect(decision.messageId).toBe("exp-ready");
      expect(decision.state).toBe("ready");
      expect(decision.expectedContentSha256).toBe("content-sha-1");
      expect(decision.transformTrace).toContain("policy:manual-expedite");
      expect(decision.availableAt).toBeDefined();
      expect(Math.abs(Date.parse(decision.availableAt!) - Date.now())).toBeLessThan(10_000);
      expect(runtime.store.messageView("exp-ready")?.state).toBe("ready");
      expect(runtime.store.messageView("exp-ready")?.transformTrace).toContain("policy:manual-expedite");
      expect(runtime.store.pendingDecision("exp-ready")).toBeUndefined();

      // 已终态/不存在的消息不能触发立即发送。
      runtime.store.ingestBatch({
        afterSequence: 1,
        nextSequence: 2,
        items: [
          {
            ...waiting,
            messageId: "exp-done",
            state: "delivered",
            deliveredAt: NOW,
            availableAt: null,
            sequence: 2,
          },
        ],
        taskEvents: [],
        inbound: [],
      });
      const delivered = await runtime.expediteMessage("exp-done");
      expect(delivered.ok).toBe(false);
      const missing = await runtime.expediteMessage("exp-missing");
      expect(missing.ok).toBe(false);
      expect(decisions).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  it("expediteMessage 尊重注入的 clock 时钟返回精确 availableAt", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const decisions: Array<{
      messageId: string;
      availableAt?: string;
    }> = [];
    const waiting = {
      messageId: "exp-clock",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      messageKind: "final" as const,
      transport: "queued-push" as const,
      priority: "normal" as const,
      content: "done",
      contentSha256: "content-sha-1",
      metadata: {},
      capturedAt: NOW,
      sequence: 1,
      state: "held_pacing" as const,
      availableAt: "2026-08-22T10:05:00.000Z" as string | null,
      attemptCount: 0,
      providerMessageId: null,
      deliveredAt: null,
      lastError: null,
      transformTrace: [] as string[],
    };
    adapter.decideOutbound = async (_instance, decision) => {
      decisions.push(decision);
      return ok({ ...waiting, state: "ready", availableAt: decision.availableAt ?? null });
    };
    const mockTime = "2026-08-22T10:01:23.456Z";
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, {
        pollIntervalMs: 60_000,
        clock: () => new Date(mockTime),
      }),
    );
    try {
      runtime.store.ingestBatch({
        afterSequence: 0,
        nextSequence: 1,
        items: [waiting],
        taskEvents: [],
        inbound: [],
      });

      const result = await runtime.expediteMessage("exp-clock");
      expect(result.ok).toBe(true);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.availableAt).toBe(mockTime);
    } finally {
      await runtime.stop();
    }
  });

  it("MessageGatewayService 在上一轮执行在途中接收 wake 时不丢失信号并顺延执行下一轮", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    let gateResolve: (() => void) | undefined;
    adapter.changesGate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });

    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );
    try {
      // 启动并触发首轮 reconcile（此时阻塞在 changesGate）
      const startPromise = runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 在首轮尚未结束时发出 wake 信号
      runtime.service.wake();

      // 放行首轮，后续无需再阻塞
      adapter.changesGate = undefined;
      gateResolve?.();
      await startPromise;

      // 等待由 wake 顺延触发的第二轮调用
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 验证 listChanges 被至少调用了 2 次（首轮 + wake 顺延轮）
      const changeCalls = adapter.calls.filter((c) => c === "changes");
      expect(changeCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      gateResolve?.();
      await runtime.stop();
    }
  });

  it("requeueMessage 成功时立即清除 pending_decision、原子对账 store 状态为 policy_pending 并唤醒 service", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const deadLetterMsg = {
      messageId: "requeue-msg-1",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      messageKind: "final" as const,
      transport: "queued-push" as const,
      priority: "normal" as const,
      content: "failed message",
      contentSha256: "content-sha-requeue",
      metadata: {},
      capturedAt: NOW,
      sequence: 10,
      state: "dead_letter" as const,
      availableAt: null,
      attemptCount: 5,
      providerMessageId: null,
      deliveredAt: null,
      lastError: "upstream timeout",
      transformTrace: ["delivery:dead_letter"],
    };
    adapter.requeueOutbound = async (_instance, messageId) => {
      expect(messageId).toBe("requeue-msg-1");
      return ok({
        ...deadLetterMsg,
        state: "policy_pending",
        lastError: null,
        attemptCount: 0,
        transformTrace: [...deadLetterMsg.transformTrace, "requeue:accepted"],
      });
    };
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );
    try {
      runtime.store.ingestBatch({
        afterSequence: 0,
        nextSequence: 1,
        items: [deadLetterMsg],
        taskEvents: [],
        inbound: [],
      });
      // 模拟历史残留的 pendingDecision
      runtime.store.stageDecision("requeue-msg-1", {
        decisionId: "stale-decision-1",
        messageId: "requeue-msg-1",
        expectedContentSha256: "content-sha-requeue",
        state: "held_pacing",
        transformTrace: ["policy:queued-push"],
        policyVersion: "message-policy-v1",
        reason: "stale hold",
      });
      expect(runtime.store.pendingDecision("requeue-msg-1")).toBeDefined();

      const wakeSpy = vi.spyOn(runtime.service, "wake");
      const result = await runtime.requeueMessage("requeue-msg-1");
      expect(result.ok).toBe(true);
      expect(wakeSpy).toHaveBeenCalledTimes(1);

      // 验证本地 store 投影原子同步与 pending_decision 彻底清空
      const local = runtime.store.messageView("requeue-msg-1");
      expect(local?.state).toBe("policy_pending");
      expect(local?.attemptCount).toBe(0);
      expect(local?.lastError).toBeNull();
      expect(runtime.store.pendingDecision("requeue-msg-1")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it("resolveUnknownMessage 成功时立即清除 pending_decision、原子对账 store 状态并唤醒 service", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    const unknownMsg = {
      messageId: "unknown-msg-1",
      instanceId: "hermes-main",
      adapterId: "hermes",
      channel: "weixin",
      chatId: "chat-1",
      sessionId: "session-1",
      messageKind: "final" as const,
      transport: "queued-push" as const,
      priority: "normal" as const,
      content: "uncertain message",
      contentSha256: "content-sha-unknown",
      metadata: {},
      capturedAt: NOW,
      sequence: 20,
      state: "delivery_unknown" as const,
      availableAt: null,
      attemptCount: 1,
      providerMessageId: null,
      deliveredAt: null,
      lastError: "transport disconnected",
      transformTrace: ["delivery:delivery_unknown"],
    };
    adapter.resolveOutbound = async (_instance, messageId, outcome, reason) => {
      expect(messageId).toBe("unknown-msg-1");
      expect(outcome).toBe("delivered");
      return ok({
        ...unknownMsg,
        state: outcome,
        deliveredAt: NOW,
        lastError: reason ?? null,
        transformTrace: [...unknownMsg.transformTrace, `resolved:${outcome}`],
      });
    };
    const runtime = createHermesMessageRuntime(
      runtimeOptions(tmp, adapter, { pollIntervalMs: 60_000 }),
    );
    try {
      runtime.store.ingestBatch({
        afterSequence: 0,
        nextSequence: 1,
        items: [unknownMsg],
        taskEvents: [],
        inbound: [],
      });
      // 模拟历史残留的 pendingDecision
      runtime.store.stageDecision("unknown-msg-1", {
        decisionId: "stale-unknown-decision",
        messageId: "unknown-msg-1",
        expectedContentSha256: "content-sha-unknown",
        state: "ready",
        transformTrace: ["policy:queued-push"],
        policyVersion: "message-policy-v1",
        reason: "stale ready",
      });

      const wakeSpy = vi.spyOn(runtime.service, "wake");
      const result = await runtime.resolveUnknownMessage("unknown-msg-1", "delivered", "人工确认已送达");
      expect(result.ok).toBe(true);
      expect(wakeSpy).toHaveBeenCalledTimes(1);

      // 验证本地 store 投影原子同步与 pending_decision 彻底清空
      const local = runtime.store.messageView("unknown-msg-1");
      expect(local?.state).toBe("delivered");
      expect(local?.deliveredAt).toBe(NOW);
      expect(runtime.store.pendingDecision("unknown-msg-1")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it("手动立即发送的消息即使处于免打扰 DND 时段与频率限制下依然绕过拦截并保持 ready", () => {
    const tmp = tempDir();
    const store = new MessagePolicyStore(path.join(tmp, "messages.sqlite"));
    try {
      // 设置全天 24 小时生效的免打扰规则 (startMinute 0, endMinute 0)
      store.upsertDndRule({
        ruleId: "dnd-all-day",
        scope: "global",
        scopeKey: null,
        timeZone: "UTC",
        startMinute: 0,
        endMinute: 0,
        pausedUntil: null,
        enabled: true,
        source: "admin",
      });

      const message = {
        messageId: "expedited-bypass-msg",
        instanceId: "hermes-main",
        adapterId: "hermes",
        channel: "weixin",
        chatId: "chat-1",
        sessionId: "session-1",
        messageKind: "final" as const,
        transport: "queued-push" as const,
        priority: "normal" as const,
        content: "expedited content",
        contentSha256: "sha-expedited",
        metadata: {},
        capturedAt: NOW,
        sequence: 1,
        state: "ready" as const,
        availableAt: NOW,
        attemptCount: 0,
        providerMessageId: null,
        deliveredAt: null,
        lastError: null,
        transformTrace: ["policy:queued-push", "policy:manual-expedite"],
      };

      // 验证 policy.ts 对带 manual-expedite 的消息绕过 DND 与 Pacing
      const policyResult = decideOutboundPolicy({
        message,
        taskEvents: [],
        dndRules: store.resolveDndRules(),
        channelLane: {
          laneKey: "channel:weixin",
          channel: "weixin",
          chatId: null,
          ratePerMin: 1,
          successCount: 0,
          cooldownUntil: "2099-01-01T00:00:00.000Z", // 强行处于拥塞冷却中
          lastSentAt: NOW,
          lastCongestionReason: "429",
          updatedAt: NOW,
        },
        chatLane: {
          laneKey: "chat:weixin:chat-1",
          channel: "weixin",
          chatId: "chat-1",
          ratePerMin: 1,
          successCount: 0,
          cooldownUntil: "2099-01-01T00:00:00.000Z",
          lastSentAt: NOW,
          lastCongestionReason: "429",
          updatedAt: NOW,
        },
        now: NOW,
        config: DEFAULT_MESSAGE_POLICY,
      });

      expect(policyResult.decision.state).toBe("ready");
      expect(policyResult.decision.transformTrace).toContain("dnd:bypass-manual-expedite");
      expect(policyResult.decision.transformTrace).toContain("pacing:bypass-manual-expedite");
    } finally {
      store.close();
    }
  });
});
