import { describe, expect, it } from "vitest";
import { checkUpgradeCompatibility } from "../src/upgrade.js";

describe("upgrade compatibility", () => {
  it("blocks cross-major upgrades", () => {
    const result = checkUpgradeCompatibility({ instanceId: "i", currentVersion: "1.4.0", targetVersion: "2.0.0", rootPath: "/tmp/i" });
    expect(result.compatible).toBe(false);
    expect(result.checks.find((item) => item.id === "major")?.status).toBe("fail");
  });
});
