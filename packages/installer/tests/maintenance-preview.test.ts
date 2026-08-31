import { describe, expect, it } from "vitest";
import { buildMaintenancePreview } from "../src/install.js";

describe("buildMaintenancePreview", () => {
  it("describes destructive and preserved items before execution", () => {
    const preview = buildMaintenancePreview("reset", "C:/butler", ["C:/units/butler.service"], false);
    expect(preview.canRun).toBe(false);
    expect(preview.deleteItems).toContain("C:/butler/*");
    expect(preview.keepItems).toContain("Hermes/OpenClaw 受管实例目录");
    expect(preview.manualNextStep[0]).toContain("--yes");
  });
});
