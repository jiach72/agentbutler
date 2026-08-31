export * from "./common.js";
export * from "./errors.js";
export * from "./manifest.js";
export * from "./discipline.js";
export * from "./discovery.js";
export * from "./control.js";
export * from "./messaging.js";
export * from "./drivers.js";
export * from "./operations.js";

import type { ControlAdapter } from "./control.js";
import type { DiscoveryAdapter } from "./discovery.js";
import type { ConfigDriver, MemoryDriver, PluginDriver, SkillDriver } from "./drivers.js";
import type { Manifest } from "./manifest.js";
import type { MessagingAdapter } from "./messaging.js";

/** 适配器按类可选的驱动集合。 */
export interface AdapterBundleDrivers {
  skill?: SkillDriver;
  plugin?: PluginDriver;
  memory?: MemoryDriver;
  config?: ConfigDriver;
}

/**
 * 适配器聚合交付物：
 * - manifest + discovery 必选（最小可接入形态为 L0 观察面）；
 * - control / messaging / drivers 按声明的能力位可选。
 */
export interface AdapterBundle {
  manifest: Manifest;
  discovery: DiscoveryAdapter;
  control?: ControlAdapter;
  messaging?: MessagingAdapter;
  drivers?: AdapterBundleDrivers;
}
