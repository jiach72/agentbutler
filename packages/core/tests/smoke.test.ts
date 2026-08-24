import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index";

describe("@butler/core", () => {
  it("smoke test", () => {
    expect(1 + 1).toBe(2);
    expect(CORE_VERSION).toMatch(/^core@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+/);
  });
});
