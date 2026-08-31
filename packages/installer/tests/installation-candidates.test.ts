import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectPlatform } from "../src/platform.js";
import { fakeExec } from "./helpers.js";

describe("installationCandidates", () => {
  it("returns active Hermes/OpenClaw candidates with fingerprints", async () => {
    const root = join(process.env.TEMP ?? process.env.TMP ?? ".", "butler-candidates-test");
    mkdirSync(join(root, "hermes-agent"), { recursive: true });
    mkdirSync(join(root, "openclaw"), { recursive: true });
    writeFileSync(join(root, "config.yaml"), "models: {}\n");
    writeFileSync(join(root, "openclaw", "openclaw.json"), "{}\n");
    try {
      const { exec } = fakeExec();
      const report = await detectPlatform(exec, { nodeVersion: "22.0.0", env: { BUTLER_HERMES_ROOT: root, BUTLER_OPENCLAW_ROOT: join(root, "openclaw"), BUTLER_FRAMEWORK: "hermes" }, readFile: () => "" });
      expect(report.installationCandidates?.some((item) => item.framework === "hermes" && item.active)).toBe(true);
      expect(report.installationCandidates?.some((item) => item.framework === "openclaw")).toBe(true);
      expect(report.installationCandidates?.every((item) => item.fingerprint !== null)).toBe(true);
    } finally {
      (await import("node:fs")).rmSync(root, { recursive: true, force: true });
    }
  });
});
