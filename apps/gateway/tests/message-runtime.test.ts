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
import { createGatewayServer } from "../src/server";
import { gatewayDbFile, makeTempDir, rmTempDir } from "./helpers";

const NOW = "2026-08-22T10:00:00.000Z";

class RuntimeAdapter implements MessagingAdapter {
  readonly calls: string[] = [];
  readonly instances: InstanceRef[] = [];
  policyFailure = false;
  policyErrorCode: "E302" | "E303" = "E303";
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
    return this.policyFailure
      ? fail(this.policyErrorCode, "policy refused")
      : ok({ version: snapshot.version, sha256: snapshot.sha256, appliedAt: NOW });
  };
  listChanges = async (instance: InstanceRef, afterSequence: number) => {
    this.calls.push("changes");
    this.instances.push(instance);
    await this.changesGate;
    return ok(this.batchFor(afterSequence));
  };
  decideOutbound = async () => fail("E002", "not used");
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

  it("rolls back startup and closes its projection when policy installation fails", async () => {
    const tmp = tempDir();
    const adapter = new RuntimeAdapter();
    adapter.policyFailure = true;
    const runtime = createHermesMessageRuntime(runtimeOptions(tmp, adapter));

    await expect(runtime.start()).rejects.toThrow(/policy install failed/);
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
});
