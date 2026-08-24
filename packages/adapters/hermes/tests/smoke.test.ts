import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@butler/contract";
import { createHermesAdapter } from "../src/index.js";
import { hermesManifest } from "../src/manifest.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("@butler/adapter-hermes", () => {
  it("manifest 通过契约校验", () => {
    const adapter = createHermesAdapter();
    const r = parseManifest(adapter.manifest);
    expect(r.ok).toBe(true);
    expect(r.data?.frameworkId).toBe("hermes");
    expect(r.data?.declaredLevel).toBe(2);
    expect(r.data?.capabilities).not.toContain("messaging");
  });

  it("包根 manifest.json 与 src/manifest.ts 内容一致", () => {
    expect(JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"))).toEqual(
      hermesManifest,
    );
    expect(
      parseManifest(JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"))).ok,
    ).toBe(true);
  });

  it("discovery 接线完整，缺 rootPath 的 ref 返回 E002 / 空日志源", async () => {
    const { discovery } = createHermesAdapter();
    expect(discovery.frameworkId).toBe("hermes");
    expect(typeof discovery.detect).toBe("function");
    expect(typeof discovery.capabilityScan).toBe("function");
    expect(typeof discovery.logSources).toBe("function");

    const scan = await discovery.capabilityScan({ instanceId: "hermes-main" });
    expect(scan.ok).toBe(false);
    expect(scan.error?.code).toBe("E002");
    expect(scan.error?.userHint).toBeTruthy();

    expect(discovery.logSources({ instanceId: "hermes-main" })).toEqual([]);
    expect(discovery.logSources({ instanceId: "hermes-main|/nonexistent-hermes-root" })).toEqual(
      [],
    );
  });
});
