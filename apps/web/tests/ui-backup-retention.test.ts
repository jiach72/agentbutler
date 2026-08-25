import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "ui", "src", relativePath), "utf8");
}

describe("UI 备份保留策略", () => {
  it("Settings 明确区分升级快照与日常备份", () => {
    const settings = readUiSource("pages/Settings.tsx");

    expect(settings).toContain("/api/butler/self");
    expect(settings).toContain("升级快照");
    expect(settings).toContain("日常备份");
    expect(settings).toContain("backupRetention.full");
    expect(settings).toContain("backupRetention.memory");
    expect(settings).toContain("backupRetention.event");
  });
});
