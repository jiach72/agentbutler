import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/atomic-write.js";
import { makeTempDir, rmTempDir } from "./helpers.js";

describe("atomicWriteJson", () => {
  it("writes complete JSON and replaces an existing file", () => {
    const root = makeTempDir();
    try {
      const file = join(root, "nested", "state.json");
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(file, "{\"old\":true}");
      atomicWriteJson(file, { ok: true, count: 2 });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true, count: 2 });
      expect(existsSync(join(root, "nested", ".state.json"))).toBe(false);
    } finally {
      rmTempDir(root);
    }
  });
});
