/**
 * @butler/web —— 面板服务公共 API（Task 9）。
 *
 * createWebServer 组装 Fastify 服务（静态 SPA + 只读 API + /ws 事件流），
 * main.ts 为可执行入口；事件推送纯函数一并导出供复用与测试。
 */
import { CONTRACT_VERSION } from "@butler/contract";
import { CORE_VERSION } from "@butler/core";

export {
  createWebServer,
  DEFAULT_GATEWAY_URL,
  WEB_VERSION,
  type InstanceApiView,
  type WebServerOptions,
} from "./server.js";
export { recentEventsAscending, selectNewEvents } from "./events-pump.js";

export const APP_NAME = "@butler/web";

export function describeApp(): string {
  return `${APP_NAME} core=${CORE_VERSION} contract=${CONTRACT_VERSION}`;
}
