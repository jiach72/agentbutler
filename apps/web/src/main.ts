/**
 * butler-web 可执行入口：读 env、做启动前安全自检、监听地址、SIGTERM/SIGINT 优雅退出。
 *
 * 启动自检的目的：面板能重启实例、改配置、读写记忆，一旦监听非回环地址却没有访问口令，
 * 等于把本机 AI 的控制权交给同一网络里的任何人。这种情况直接拒绝启动，而不是打一行警告了事。
 */
import { createWebServer, isLoopback } from "./server.js";

const host = process.env["BUTLER_WEB_HOST"]?.trim() || "127.0.0.1";
const publishHost = process.env["BUTLER_WEB_PUBLISH_HOST"]?.trim() || host;
const port = Number(process.env["BUTLER_WEB_PORT"] ?? 7531);
const accessToken = (process.env["BUTLER_ACCESS_TOKEN"] ?? "").trim();

/**
 * 启动前安全门禁：非回环监听 + 无口令 = 拒绝启动。
 * 逃生舱：显式设置 BUTLER_ALLOW_INSECURE_PUBLIC=1 可绕过（仅在用户明确知晓风险时使用），
 * 启动时仍会打印醒目警告。
 */
function assertSafeBinding(): void {
  if (isLoopback(publishHost) || accessToken !== "") return;
  if (process.env["BUTLER_ALLOW_INSECURE_PUBLIC"] === "1") {
    console.warn("");
    console.warn("⚠  危险：面板监听在公开地址且没有访问口令，已按 BUTLER_ALLOW_INSECURE_PUBLIC=1 强制启动。");
    console.warn(`⚠  同一网络内的任何人都可以操作你的 AI（${publishHost}:${port}）。`);
    console.warn("");
    return;
  }
  console.error("");
  console.error("butler-web 拒绝启动：面板监听地址不是本机地址，但没有设置访问口令。");
  console.error(`  当前发布地址：${publishHost}:${port}`);
  console.error("");
  console.error("  面板可以重启 AI、修改配置、读写记忆。这样的地址一旦没有口令保护，");
  console.error("  同一网络（家里 Wi-Fi、公司内网、公共热点）里的任何人都能操作你的 AI。");
  console.error("");
  console.error("  请选择其中一种方式后重新启动：");
  console.error("    1）只在本机使用（推荐）：BUTLER_WEB_HOST=127.0.0.1");
  console.error("    2）需要跨设备访问：设置 BUTLER_ACCESS_TOKEN=<一串随机字符>，");
  console.error("       例如 BUTLER_ACCESS_TOKEN=$(openssl rand -base64 32)");
  console.error("");
  console.error("  如果你完全清楚风险并坚持要无口令公开访问，可设置 BUTLER_ALLOW_INSECURE_PUBLIC=1。");
  console.error("");
  process.exit(1);
}

assertSafeBinding();

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

/**
 * 端口占用是最常见的启动失败，EADDRINUSE 的英文堆栈对普通用户毫无帮助。
 * 这里翻译成中文并给出可执行的下一步。
 */
function explainListenError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "EADDRINUSE") {
    return [
      `端口 ${port} 已经被别的程序占用了，管家没法在这里启动。`,
      "",
      "  可以这样做：",
      `    1）换一个端口启动：BUTLER_WEB_PORT=7541 corepack pnpm --filter @butler/web start`,
      "    2）或者先停掉占用这个端口的程序：",
      `       Windows PowerShell： netstat -ano | findstr :${port}`,
      `       然后：                taskkill /PID <上面查到的 PID> /F`,
      `       macOS / Linux：        lsof -i :${port}`,
      "    3）也可能是管家已经在运行了，直接打开页面看看。",
    ].join("\n");
  }
  if (code === "EACCES") {
    return [
      `没有权限监听 ${host}:${port}。`,
      "  1024 以下的端口需要管理员权限，建议换到 7531 这类高位端口。",
      `  原始错误：${message}`,
    ].join("\n");
  }
  if (code === "EADDRNOTAVAIL") {
    return [
      `地址 ${host} 在本机不存在，无法监听。`,
      "  请检查 BUTLER_WEB_HOST 是否写错；只在本机使用时填 127.0.0.1。",
      `  原始错误：${message}`,
    ].join("\n");
  }
  return message;
}

try {
  await app.listen({ host, port });
  console.log(`butler-web 已启动: http://${host}:${port}`);
  if (accessToken !== "") {
    console.log("访问口令已启用：打开页面后需要输入口令才能使用。");
    if (!isLoopback(host)) {
      console.log(`注意：面板监听在 ${host}，同一网络的设备可以访问，请确认你信任当前网络。`);
    }
  } else {
    console.log("提示：当前只有本机可以访问，未设置访问口令。");
  }
} catch (err) {
  console.error(`butler-web 启动失败：${explainListenError(err)}`);
  process.exit(1);
}
