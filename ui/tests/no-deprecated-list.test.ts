import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function getAllSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Ant Design v6 API Hygiene - Deprecated List Component Elimination (Round 22)", () => {
  it("ensures zero usage of deprecated <List> or <List.Item> across the entire ui/src directory", () => {
    const srcDir = path.resolve(__dirname, "../src");
    const sourceFiles = getAllSourceFiles(srcDir);

    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        // Match <List or <List.Item as a JSX tag
        if (/<List(\.Item|\s|>)/.test(line)) {
          violations.push({
            file: path.relative(srcDir, filePath),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(
      violations,
      `Found deprecated Ant Design <List> component in ${violations.length} places:\n` +
        violations.map((v) => `  at ${v.file}:${v.line} -> ${v.match}`).join("\n"),
    ).toEqual([]);
  });
});
