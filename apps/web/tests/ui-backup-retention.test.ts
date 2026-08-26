import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSettingsDirSource(): string {
  const dir = path.resolve(process.cwd(), "ui", "src", "pages", "settings");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

describe("UI 备份保留策略", () => {
  it("Settings 明确区分升级快照与日常备份", () => {
    const settings = readSettingsDirSource();

    expect(settings).toContain("/api/butler/self");
    expect(settings).toContain("升级快照");
    expect(settings).toContain("日常备份");
    expect(settings).toContain("backupRetention.full");
    expect(settings).toContain("backupRetention.memory");
    expect(settings).toContain("backupRetention.event");
  });
});
