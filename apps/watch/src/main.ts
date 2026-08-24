/**
 * butler-watch 可执行入口：读 env、启动、SIGTERM/SIGINT 优雅退出。
 */
import { pathToFileURL } from "node:url";
import { createWatchApp, type WatchApp } from "./watch.js";

export async function run(): Promise<WatchApp> {
  const app = await createWatchApp();
  const { config } = app;
  const httpAddr = app.watchHttp.address();
  const httpNote =
    httpAddr !== null ? `，控制通道 http://${httpAddr.host === "::1" ? "127.0.0.1" : httpAddr.host}:${httpAddr.port}` : "";
  console.log(
    `[butler-watch] 启动完成：检出实例 ${app.instances.length} 个，日志源 ${app.tailer.listSources().length} 个，巡检间隔 ${config.inspectIntervalMin} 分钟，日志轮询 ${config.tailPollSec} 秒${httpNote}`,
  );

  let exited = false;
  const shutdown = (signal: string): void => {
    if (exited) return;
    exited = true;
    console.log(`[butler-watch] 收到 ${signal}，优雅退出`);
    try {
      app.stop();
    } catch (error) {
      console.warn("[butler-watch] 退出清理异常:", error);
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return app;
}

// 直接执行（node dist/main.js / tsx src/main.ts）时启动；被 import 时不触发。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void run().catch((error) => {
    console.error("[butler-watch] 启动失败:", error);
    process.exit(1);
  });
}
