import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ok,
  type AdapterBundle,
  type CapabilityReport,
  type DetectedInstance,
  type DiscoveryAdapter,
  type LogSource,
  type Manifest,
} from "@butler/contract";

/** 每个测试文件用它建独立临时目录，避免污染真实 ~/.agent-butler。 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butler-core-"));
}

export function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function fakeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    frameworkId: "fake-fw",
    displayName: "Fake Framework",
    contractVersion: "1.x",
    adapterVersion: "0.1.0",
    declaredLevel: 2,
    capabilities: ["probe", "control"],
    drivers: [],
    ...overrides,
  };
}

export function fakeCapabilityReport(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    effectiveLevel: 2,
    capabilities: {
      probe: "ok",
      control: "ok",
      messaging: "not-implemented",
      "skill-driver": "not-implemented",
      "memory-driver": "not-implemented",
      "config-driver": "not-implemented",
    },
    anomalies: [],
    ...overrides,
  };
}

export function fakeDiscoveryAdapter(frameworkId = "fake-fw"): DiscoveryAdapter {
  return {
    frameworkId,
    async detect() {
      const instances: DetectedInstance[] = [
        {
          instanceId: `${frameworkId}-main`,
          version: "1.0.0",
          rootPath: "/tmp/fake-root",
          runtime: "process",
          confidence: 0.9,
          evidence: ["fake-evidence"],
        },
      ];
      return ok(instances);
    },
    async capabilityScan() {
      return ok(fakeCapabilityReport());
    },
    logSources(): LogSource[] {
      return [];
    },
  };
}

export function fakeBundle(manifest: Manifest = fakeManifest()): AdapterBundle {
  return { manifest, discovery: fakeDiscoveryAdapter(manifest.frameworkId) };
}

/** 写一个子目录 manifest.json（loadFromDir 测试用）。 */
export function writeManifestDir(parent: string, name: string, manifest: unknown): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return dir;
}
