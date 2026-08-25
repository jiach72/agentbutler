import { fail, type AdapterBundle, type DiscoveryAdapter, type InstanceRef } from "@butler/contract";
import { capabilityScan, parseRootPath } from "./capability-scan.js";
import { createOpenClawConfigDriver, createOpenClawMemoryDriver, createOpenClawPluginDriver, createOpenClawSkillDriver } from "./drivers.js";
import { createOpenClawControl, type OpenClawControlOptions } from "./control.js";
import { detect } from "./detect.js";
import type { PortProber } from "./detect.js";
import { logSources } from "./log-sources.js";
import { openClawManifest } from "./manifest.js";

function rootPathFromRef(ref: InstanceRef): string | null {
  return ref.rootPath ?? (ref.instanceId.includes("|") ? parseRootPath(ref.instanceId) : null);
}

export type OpenClawAdapterOptions = OpenClawControlOptions & { prober?: PortProber };

export function createOpenClawAdapter(options: OpenClawAdapterOptions = {}): AdapterBundle {
  const discovery: DiscoveryAdapter = {
    frameworkId: "openclaw",
    detect: (hint) => detect(hint, { prober: options.prober }),
    capabilityScan: async (ref) => {
      const rootPath = rootPathFromRef(ref);
      if (!rootPath) return fail("E002", "InstanceRef must carry rootPath for OpenClaw capability scan", { userHint: "缺少 OpenClaw 实例根路径" });
      return capabilityScan(rootPath, { prober: options.prober });
    },
    logSources: (ref) => {
      const rootPath = rootPathFromRef(ref);
      return rootPath ? logSources(rootPath) : [];
    },
  };
  return {
    manifest: openClawManifest,
    discovery,
    control: createOpenClawControl(options),
    drivers: {
      skill: createOpenClawSkillDriver(),
      plugin: createOpenClawPluginDriver(),
      memory: createOpenClawMemoryDriver(),
      config: createOpenClawConfigDriver(),
    },
  };
}

export { openClawManifest } from "./manifest.js";
export { detect } from "./detect.js";
export { capabilityScan, parseRootPath } from "./capability-scan.js";
export { logSources } from "./log-sources.js";
export { createOpenClawControl, type OpenClawControlOptions, type OpenClawExecutor } from "./control.js";
export { createOpenClawConfigDriver, createOpenClawMemoryDriver, createOpenClawPluginDriver, createOpenClawSkillDriver } from "./drivers.js";
