/**
 * butler-web 可执行入口（Task 9）：读 env、监听回环地址、SIGTERM/SIGINT 优雅退出。
 *
 * 启动日志包含监听地址与安全黄条提示（V1 面板未鉴权，仅限本机使用）。
 */
import { createWebServer } from "./server.js";

const host = process.env["BUTLER_WEB_HOST"]?.trim() || "127.0.0.1";
const port = Number(process.env["BUTLER_WEB_PORT"] ?? 7531);

const app = createWebServer();

let exiting = false;
async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  console.log(`butler-web 收到 ${signal}，正在关闭…`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host, port });
  console.log(`butler-web 已启动: http://${host}:${port}`);
  console.log("⚠  安全提示: 面板未启用鉴权，仅监听回环地址，请勿将其暴露到不可信网络");
} catch (err) {
  console.error("butler-web 启动失败:", err);
  process.exit(1);
}
