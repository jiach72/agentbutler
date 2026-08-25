/**
 * butler-gateway 可执行入口（Task 8）：读 env → 起服务 → SIGTERM/SIGINT 优雅退出。
 *
 * 优雅退出顺序：停投递循环 → 关队列库 → 关 HTTP 服务。
 */
import { pathToFileURL } from "node:url";
import { resolveButlerHome } from "@butler/core";
import { createGatewayServer } from "./server.js";
import {
  createHermesMessageRuntime,
  MESSAGE_RUNTIME_ENV,
  type HermesMessageRuntime,
} from "./message/runtime.js";

const RUNTIME_FLAG = "BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME";

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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

/**
 * 默认 Gateway 仍支持无 Bridge 的只读/告警模式；配置完整时自动装配
 * Hermes 消息运行时。Bridge 暂时不可用由 MessageGatewayService 自己重试，
 * 不再因为一次启动时序问题让 7532 整体退出。
 */
async function createConfiguredRuntime(env: NodeJS.ProcessEnv): Promise<HermesMessageRuntime | null> {
  const flag = env[RUNTIME_FLAG]?.trim().toLowerCase();
  const explicit = isTruthy(flag);
  const auto = flag === undefined || flag === "" || flag === "auto";
  if (!explicit && !(auto && hasHermesRuntimeConfiguration(env))) return null;
  if (explicit && !hasHermesRuntimeConfiguration(env)) {
    throw new Error(`${RUNTIME_FLAG}=true requires complete Hermes Bridge configuration`);
  }
  const runtime = createHermesMessageRuntime({ env });
  await runtime.start();
  return runtime;
}

async function main(): Promise<void> {
  const env = process.env;
  const host = process.env["BUTLER_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const port = Number(process.env["BUTLER_GATEWAY_PORT"]?.trim() || 7532);

  let runtime: HermesMessageRuntime | null = null;
  try {
    runtime = await createConfiguredRuntime(env);
  } catch (error) {
    if (isTruthy(env[RUNTIME_FLAG])) throw error;
    console.warn("[gateway] Hermes Bridge 配置不完整，消息运行时保持离线:", error);
  }

  const app = createGatewayServer({
    messageService: runtime?.service,
    messageStore: runtime?.store,
    inboundHistory: runtime ? (limit) => runtime!.inboundHistory(limit) : undefined,
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
