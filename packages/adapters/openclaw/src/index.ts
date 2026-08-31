import { fail, type AdapterBundle, type DiscoveryAdapter, type InstanceRef, type ManagedMarkdownCandidate } from "@butler/contract";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

function managedMarkdownFiles(ref: InstanceRef): ManagedMarkdownCandidate[] {
  const root = rootPathFromRef(ref);
  const nestedMemory = root === null ? undefined : findNestedMemory(root, "workspace");
  const pick = (key: ManagedMarkdownCandidate["key"], label: string, paths: string[], editable = true, readOnlyReason?: string): ManagedMarkdownCandidate => ({
    key,
    label,
    relativePath: root === null ? paths[0] : (paths.find((item) => existsSync(join(root, item))) ?? paths[0]),
    editable,
    ...(readOnlyReason ? { readOnlyReason } : {}),
  });
  return [
    pick("user", "USER.md", ["workspace/USER.md", "workspace/user.md", "USER.md", "user.md"]),
    pick("agent", "AGENT.md", ["workspace/AGENT.md", "workspace/agent.md", "AGENT.md", "agent.md"]),
    pick("soul", "SOUL.md", ["workspace/SOUL.md", "workspace/soul.md", "SOUL.md", "soul.md"]),
    pick("memory", "MEMORY.md", ["workspace/MEMORY.md", "workspace/memory.md", ...(nestedMemory ? [nestedMemory] : []), "memory/MEMORY.md", "memory/memory.md"], false, "运行时记忆与人工 Markdown 分开管理"),
  ];
}

function findNestedMemory(root: string, relativeDir: string): string | undefined {
  const absolute = join(root, relativeDir);
  if (!existsSync(absolute)) return undefined;
  try {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const next = `${relativeDir}/${entry.name}`;
      if (entry.isFile() && /^(MEMORY|memory)\.md$/.test(entry.name)) return next;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const found = findNestedMemory(root, next);
        if (found) return found;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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
    managedMarkdownFiles,
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
