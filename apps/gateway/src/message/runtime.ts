import fs from "node:fs";
import path from "node:path";

import { createHermesMessaging, type HermesMessagingOptions } from "@butler/adapter-hermes";
import type { MessagingAdapter } from "@butler/contract";

import { DEFAULT_MESSAGE_POLICY } from "./config.js";
import { MessageGatewayService, type Scheduler } from "./service.js";
import { MessagePolicyStore } from "./store.js";
import type { MessagePolicyConfig } from "./types.js";

export const MESSAGE_RUNTIME_ENV = {
  bridgeUrl: "BUTLER_HERMES_BRIDGE_URL",
  instanceId: "BUTLER_HERMES_INSTANCE_ID",
  hermesRoot: "BUTLER_HERMES_ROOT",
  tokenFile: "BUTLER_HERMES_BRIDGE_TOKEN_FILE",
  projectionDbFile: "BUTLER_MESSAGE_PROJECTION_DB",
  pollIntervalMs: "BUTLER_MESSAGE_POLL_INTERVAL_MS",
  stopTimeoutMs: "BUTLER_MESSAGE_STOP_TIMEOUT_MS",
} as const;

export interface HermesMessageRuntimeOptions {
  bridgeUrl?: string;
  instanceId?: string;
  hermesRoot?: string;
  tokenFile?: string;
  projectionDbFile?: string;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
  requestTimeoutMs?: number;
  policy?: MessagePolicyConfig;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  scheduler?: Scheduler;
  randomUUID?: () => string;
  messagingFactory?: (options: HermesMessagingOptions) => MessagingAdapter;
  storeFactory?: (dbFile: string) => MessagePolicyStore;
}

export interface HermesMessageRuntime {
  service: MessageGatewayService;
  store: MessagePolicyStore;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ResolvedRuntimeConfig {
  bridgeUrl: string;
  instanceId: string;
  hermesRoot: string;
  tokenFile: string;
  projectionDbFile: string;
  pollIntervalMs: number;
  stopTimeoutMs: number;
  requestTimeoutMs: number | undefined;
}

/**
 * Composes the durable Butler-side Hermes message worker without owning the user's
 * existing gateway entry files. Token material is loaded only from a private file.
 */
export function createHermesMessageRuntime(
  options: HermesMessageRuntimeOptions = {},
): HermesMessageRuntime {
  const config = resolveConfig(options);
  const token = readPrivateToken(config.tokenFile);
  const messagingFactory = options.messagingFactory ?? createHermesMessaging;
  const storeFactory = options.storeFactory ?? ((dbFile: string) => new MessagePolicyStore(dbFile));
  const adapter = messagingFactory({
    baseUrl: config.bridgeUrl,
    token,
    fetchImpl: options.fetchImpl,
    timeoutMs: config.requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });
  const store = storeFactory(config.projectionDbFile);
  let service: MessageGatewayService;
  try {
    service = new MessageGatewayService({
      adapter,
      instance: {
        instanceId: config.instanceId,
        rootPath: config.hermesRoot,
        runtime: "process",
      },
      store,
      config: options.policy ?? DEFAULT_MESSAGE_POLICY,
      intervalMs: config.pollIntervalMs,
      clock: options.clock,
      scheduler: options.scheduler,
      randomUUID: options.randomUUID,
    });
  } catch (error) {
    store.close();
    throw error;
  }

  let state: "idle" | "starting" | "running" | "stopping" | "closed" = "idle";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let closeRequested = false;
  let storeClosed = false;

  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };

  const start = (): Promise<void> => {
    if (state === "closed" || state === "stopping" || closeRequested) {
      return Promise.reject(new Error("Hermes message runtime is closed"));
    }
    if (state === "running") return Promise.resolve();
    if (startPromise !== undefined) return startPromise;

    state = "starting";
    const operation = (async () => {
      try {
        await service.start();
        if (!closeRequested) state = "running";
      } catch (error) {
        closeRequested = true;
        try {
          await service.stop(config.stopTimeoutMs);
        } finally {
          closeStore();
          state = "closed";
        }
        throw error;
      }
    })();
    startPromise = operation;
    operation.then(
      () => {
        if (startPromise === operation) startPromise = undefined;
      },
      () => {
        if (startPromise === operation) startPromise = undefined;
      },
    );
    return operation;
  };

  const stop = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    if (stopPromise !== undefined) return stopPromise;

    closeRequested = true;
    state = "stopping";
    const operation = (async () => {
      await service.stop(config.stopTimeoutMs);
      closeStore();
      state = "closed";
    })();
    stopPromise = operation;
    operation.then(
      () => {
        if (stopPromise === operation) stopPromise = undefined;
      },
      () => {
        if (stopPromise === operation) stopPromise = undefined;
      },
    );
    return operation;
  };

  return { service, store, start, stop };
}

function resolveConfig(options: HermesMessageRuntimeOptions): ResolvedRuntimeConfig {
  const env = options.env ?? process.env;
  const bridgeUrl = requiredValue(
    options.bridgeUrl,
    env[MESSAGE_RUNTIME_ENV.bridgeUrl],
    MESSAGE_RUNTIME_ENV.bridgeUrl,
  );
  const instanceId = requiredValue(
    options.instanceId,
    env[MESSAGE_RUNTIME_ENV.instanceId],
    MESSAGE_RUNTIME_ENV.instanceId,
  );
  const hermesRoot = requiredPath(
    options.hermesRoot,
    env[MESSAGE_RUNTIME_ENV.hermesRoot],
    MESSAGE_RUNTIME_ENV.hermesRoot,
  );
  const tokenFile = requiredPath(
    options.tokenFile,
    env[MESSAGE_RUNTIME_ENV.tokenFile],
    MESSAGE_RUNTIME_ENV.tokenFile,
  );
  const projectionDbFile = requiredPath(
    options.projectionDbFile,
    env[MESSAGE_RUNTIME_ENV.projectionDbFile],
    MESSAGE_RUNTIME_ENV.projectionDbFile,
  );

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instanceId)) {
    throw new Error(`${MESSAGE_RUNTIME_ENV.instanceId} contains unsupported characters`);
  }
  const rootStat = statPath(hermesRoot, MESSAGE_RUNTIME_ENV.hermesRoot);
  if (!rootStat.isDirectory())
    throw new Error(`${MESSAGE_RUNTIME_ENV.hermesRoot} must identify a directory`);
  if (samePortablePath(tokenFile, projectionDbFile)) {
    throw new Error("Bridge token file and projection database must be different paths");
  }

  return {
    bridgeUrl: validateBridgeUrl(bridgeUrl),
    instanceId,
    hermesRoot,
    tokenFile,
    projectionDbFile,
    pollIntervalMs: numericOption(
      options.pollIntervalMs,
      env[MESSAGE_RUNTIME_ENV.pollIntervalMs],
      MESSAGE_RUNTIME_ENV.pollIntervalMs,
      1_000,
      10,
      60_000,
    ),
    stopTimeoutMs: numericOption(
      options.stopTimeoutMs,
      env[MESSAGE_RUNTIME_ENV.stopTimeoutMs],
      MESSAGE_RUNTIME_ENV.stopTimeoutMs,
      5_000,
      1,
      60_000,
    ),
    requestTimeoutMs: optionalPositiveInteger(options.requestTimeoutMs, "requestTimeoutMs"),
  };
}

function readPrivateToken(tokenFile: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(tokenFile);
  } catch {
    throw new Error(`cannot access ${MESSAGE_RUNTIME_ENV.tokenFile}`);
  }
  if (!stat.isFile()) throw new Error(`${MESSAGE_RUNTIME_ENV.tokenFile} must be a regular file`);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${MESSAGE_RUNTIME_ENV.tokenFile} must be a private mode 0600 file`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${MESSAGE_RUNTIME_ENV.tokenFile} must be owned by the Gateway process user`);
  }

  let token: string;
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(`cannot read ${MESSAGE_RUNTIME_ENV.tokenFile}`);
  }
  if (token === "" || /\s/.test(token)) {
    throw new Error(`${MESSAGE_RUNTIME_ENV.tokenFile} must contain one non-empty token`);
  }
  return token;
}

function validateBridgeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${MESSAGE_RUNTIME_ENV.bridgeUrl} must be an absolute HTTP URL`);
  }
  if (url.protocol !== "http:")
    throw new Error(`${MESSAGE_RUNTIME_ENV.bridgeUrl} must use http on loopback`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${MESSAGE_RUNTIME_ENV.bridgeUrl} must use a loopback host`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `${MESSAGE_RUNTIME_ENV.bridgeUrl} must not contain credentials, query, or fragment`,
    );
  }
  if (url.pathname !== "/")
    throw new Error(`${MESSAGE_RUNTIME_ENV.bridgeUrl} must not contain a path`);
  return url.origin;
}

function requiredValue(
  explicit: string | undefined,
  fromEnv: string | undefined,
  envName: string,
): string {
  const value = explicit ?? fromEnv;
  if (value === undefined || value.trim() === "")
    throw new Error(`missing required configuration: ${envName}`);
  return value.trim();
}

function requiredPath(
  explicit: string | undefined,
  fromEnv: string | undefined,
  envName: string,
): string {
  const value = requiredValue(explicit, fromEnv, envName);
  if (!isPortableAbsolute(value)) throw new Error(`${envName} must be an absolute path`);
  return normalizePortablePath(value);
}

function numericOption(
  explicit: number | undefined,
  fromEnv: string | undefined,
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw =
    explicit ?? (fromEnv === undefined || fromEnv.trim() === "" ? fallback : Number(fromEnv));
  if (!Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new Error(
      `${envName} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return raw;
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new Error(`${field} must be an integer between 1 and 60000`);
  }
  return value;
}

function statPath(value: string, field: string): fs.Stats {
  try {
    return fs.statSync(value);
  } catch (error) {
    throw new Error(`cannot access ${field}: ${errorMessage(error)}`);
  }
}

function isPortableAbsolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function normalizePortablePath(value: string): string {
  if (path.isAbsolute(value)) return path.normalize(value);
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value);
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  return path.resolve(value);
}

function samePortablePath(left: string, right: string): boolean {
  const normalize =
    process.platform === "win32"
      ? (value: string) => value.toLowerCase()
      : (value: string) => value;
  return normalize(left) === normalize(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
