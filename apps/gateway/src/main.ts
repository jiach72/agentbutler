/**
 * butler-gateway 可执行入口（Task 8）：读 env → 起服务 → SIGTERM/SIGINT 优雅退出。
 *
 * 优雅退出顺序：停投递循环 → 关队列库 → 关 HTTP 服务。
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveButlerHome } from "@butler/core";
import { createGatewayServer } from "./server.js";
import {
  createHermesMessageRuntime,
  MESSAGE_RUNTIME_ENV,
  type HermesMessageRuntime,
} from "./message/runtime.js";

export const RUNTIME_FLAG = "BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME";

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldEnableHermesMessageRuntime(value: string | undefined): boolean {
  return isTruthy(value);
}

export type HermesMessageRuntimeMode = "enabled" | "auto" | "disabled";

/** auto enables the runtime when the Bridge configuration is complete. */
export function resolveHermesMessageRuntimeMode(
  value: string | undefined,
): HermesMessageRuntimeMode {
  const normalized = value?.trim().toLowerCase();
  if (isTruthy(normalized)) return "enabled";
  if (normalized === "auto" || normalized === undefined || normalized === "") return "auto";
  return "disabled";
}

function hasHermesRuntimeConfiguration(env: NodeJS.ProcessEnv): boolean {
  return [
    MESSAGE_RUNTIME_ENV.bridgeUrl,
    MESSAGE_RUNTIME_ENV.instanceId,
    MESSAGE_RUNTIME_ENV.hermesRoot,
    MESSAGE_RUNTIME_ENV.tokenFile,
    MESSAGE_RUNTIME_ENV.projectionDbFile,
  ].every((name) => typeof env[name] === "string" && env[name]!.trim() !== "");
}

/** 配置齐全时自动接入；Bridge 短暂离线由运行时持续重试。 */
async function createConfiguredRuntime(env: NodeJS.ProcessEnv): Promise<HermesMessageRuntime | null> {
  const effectiveEnv = withHostHermesDefaults(env);
  const mode = resolveHermesMessageRuntimeMode(effectiveEnv[RUNTIME_FLAG]);
  const configured = hasHermesRuntimeConfiguration(effectiveEnv);
  if (mode === "disabled" || (mode === "auto" && !configured)) return null;
  if (mode === "enabled" && !configured) {
    throw new Error(`${RUNTIME_FLAG}=true requires complete Hermes Bridge configuration`);
  }
  const runtime = createHermesMessageRuntime({ env: effectiveEnv });
  await runtime.start();
  return runtime;
}

/**
 * Host installs historically launched services from a shell that only loaded
 * ~/.agent-butler/env. Fill in the stable local Hermes paths when the Bridge
 * token and root are present, while preserving every explicit value.
 */
export function withHostHermesDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const framework = env["BUTLER_FRAMEWORK"]?.trim().toLowerCase();
  if (framework !== "hermes") return env;

  const home = env["HOME"]?.trim() || os.homedir();
  const hermesRoot = env[MESSAGE_RUNTIME_ENV.hermesRoot]?.trim() || path.join(home, ".hermes");
  const tokenFile =
    env[MESSAGE_RUNTIME_ENV.tokenFile]?.trim() ||
    path.join(hermesRoot, "agent-butler", "bridge.token");
  try {
    if (!fs.statSync(hermesRoot).isDirectory() || !fs.statSync(tokenFile).isFile()) return env;
  } catch {
    return env;
  }

  const butlerHome = env["BUTLER_HOME"]?.trim() || path.join(home, ".agent-butler");
  return {
    ...env,
    [MESSAGE_RUNTIME_ENV.bridgeUrl]:
      env[MESSAGE_RUNTIME_ENV.bridgeUrl]?.trim() || "http://127.0.0.1:8754",
    [MESSAGE_RUNTIME_ENV.instanceId]:
      env[MESSAGE_RUNTIME_ENV.instanceId]?.trim() || "hermes-main",
    [MESSAGE_RUNTIME_ENV.hermesRoot]: hermesRoot,
    [MESSAGE_RUNTIME_ENV.tokenFile]: tokenFile,
    [MESSAGE_RUNTIME_ENV.projectionDbFile]:
      env[MESSAGE_RUNTIME_ENV.projectionDbFile]?.trim() || path.join(butlerHome, "messages.sqlite"),
    [MESSAGE_RUNTIME_ENV.allowNonLoopback]:
      env[MESSAGE_RUNTIME_ENV.allowNonLoopback]?.trim() || "false",
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const host = process.env["BUTLER_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const port = Number(process.env["BUTLER_GATEWAY_PORT"]?.trim() || 7532);

  const runtime = await createConfiguredRuntime(env);

  const app = createGatewayServer({
    messageService: runtime?.service,
    messageStore: runtime?.store,
    inboundHistory: runtime ? (limit) => runtime!.inboundHistory(limit) : undefined,
    messageMode: runtime === null ? "native" : "observe",
  }); // home 由 BUTLER_HOME / ~/.agent-butler 解析
  await app.listen({ host, port });
  console.log(`[gateway] listening on http://${host}:${port} (home=${resolveButlerHome()})`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[gateway] 收到 ${signal}，开始优雅退出`);
    try {
      await app.gateway.close();
      await runtime?.stop();
      process.exit(0);
    } catch (err) {
      console.error("[gateway] 优雅退出失败:", err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[gateway] 启动失败:", err);
    process.exit(1);
  });
}
