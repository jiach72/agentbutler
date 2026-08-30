/**
 * @butler/watch 公开 API：巡检框架（pipeline/scheduler/probes）+ Dashboard 信号 +
 * 告警转发 + runbook/熔断 + 升级服务 + HTTP 控制通道 + 应用组装。
 */
import { CONTRACT_VERSION } from "@butler/contract";
import { CORE_VERSION } from "@butler/core";

export const APP_NAME = "@butler/watch";

export function describeApp(): string {
  return `${APP_NAME} core=${CORE_VERSION} contract=${CONTRACT_VERSION}`;
}

export * from "./config.js";
export * from "./pipeline.js";
export * from "./probes/index.js";
export * from "./dashboard-signal.js";
export * from "./scheduler.js";
export * from "./alert-forward.js";
export * from "./http.js";
export * from "./runbook/index.js";
export * from "./upgrade.js";
export * from "./evolution.js";
export * from "./evolution-insights.js";
export * from "./evolution-analytics.js";
export * from "./prompt-optimization.js";
export * from "./watch.js";
export { run } from "./main.js";
