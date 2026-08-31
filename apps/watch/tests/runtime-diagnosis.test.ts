import { describe, expect, it } from "vitest";
import { classifyRuntimeState } from "../src/runtime-diagnosis.js";

describe("classifyRuntimeState", () => {
  it("does not turn warnings into a root cause when probes are healthy", () => {
    const result = classifyRuntimeState([
      { id: "connection", status: "pass", detail: "消息通道正常" },
      { id: "logs", status: "warn", detail: "最近一天发现 1 类提醒" },
    ]);
    expect(result.stateCode).toBe("healthy");
    expect(result.severity).toBe("warn");
    expect(result.summary).toContain("当前运行正常");
  });

  it("classifies a missing token as non-retryable", () => {
    const result = classifyRuntimeState([{ id: "auth", status: "fail", detail: "gateway token missing" }]);
    expect(result.stateCode).toBe("auth_missing");
    expect(result.safeToRetry).toBe(false);
    expect(result.evidence[0]?.source).toBe("auth");
  });
});
