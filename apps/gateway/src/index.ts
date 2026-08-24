/**
 * @butler/gateway —— 告警网关（Task 8）。
 *
 * 模块：queue（SQLite 持久告警队列）/ channels（Telegram/SMTP/面板通道）/
 * loop（配速缓释投递循环）/ server（HTTP API + 装配）/ main（可执行入口）。
 */
import { CONTRACT_VERSION } from "@butler/contract";
import { CORE_VERSION } from "@butler/core";

export const APP_NAME = "@butler/gateway";

export function describeApp(): string {
  return `${APP_NAME} core=${CORE_VERSION} contract=${CONTRACT_VERSION}`;
}

export * from "./queue.js";
export * from "./channels.js";
export * from "./loop.js";
export * from "./server.js";
export * from "./message/types.js";
export * from "./message/config.js";
