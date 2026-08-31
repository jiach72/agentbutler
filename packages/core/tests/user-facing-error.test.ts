import { describe, expect, it } from "vitest";
import { normalizeErrorText, toUserFacingError } from "../src/user-facing-error.js";

describe("user-facing-error", () => {
  it("removes ANSI/control characters and classifies permissions", () => {
    expect(normalizeErrorText("\u001b[31mpermission denied\u001b[0m\n/path/to/file")).toContain("permission denied");
    const result = toUserFacingError(new Error("EACCES: permission denied: C:\\Users\\alice\\secret.json"));
    expect(result.code).toBe("permission");
    expect(result.detail).not.toContain("alice");
    expect(result.nextStep).toContain("权限");
  });

  it("provides an actionable fallback", () => {
    const result = toUserFacingError(new Error("something unexpected"));
    expect(result.code).toBe("unknown");
    expect(result.nextStep).toContain("诊断报告");
  });
});
