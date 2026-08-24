/**
 * butler-gateway 可执行入口（Task 8）：读 env → 起服务 → SIGTERM/SIGINT 优雅退出。
 *
 * 优雅退出顺序：停投递循环 → 关队列库 → 关 HTTP 服务。
 */
import { pathToFileURL } from "node:url";
import { resolveButlerHome } from "@butler/core";
import { createGatewayServer } from "./server.js";

async function main(): Promise<void> {
  const host = process.env["BUTLER_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const port = Number(process.env["BUTLER_GATEWAY_PORT"]?.trim() || 7532);

  const app = createGatewayServer(); // home 由 BUTLER_HOME / ~/.agent-butler 解析
  await app.listen({ host, port });
  console.log(`[gateway] listening on http://${host}:${port} (home=${resolveButlerHome()})`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[gateway] 收到 ${signal}，开始优雅退出`);
    try {
      await app.gateway.close();
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
