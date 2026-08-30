import { describe, expect, it } from "vitest";
import { guidanceForDiagnosis } from "../src/pages/troubleshoot/guidance.js";
import type { RecoveryDiagnosisView } from "../src/pages/dashboard/types.js";

function diagnosis(detail: string): RecoveryDiagnosisView {
  return {
    incidentId: "test",
    severity: "error",
    rootCause: detail,
    primaryFinding: null,
    findings: [],
    historicalFindingCount: 0,
    probes: [],
    recommendedActions: [],
    checkedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("排查下一步引导", () => {
  it("模型凭据问题直接指向模型设置", () => {
    expect(guidanceForDiagnosis(diagnosis("LLM API Key 鉴权失败"))).toMatchObject({
      to: "/settings",
      label: "检查模型与 API Key",
    });
  });

  it("消息和记忆问题分别指向实际处理页面", () => {
    expect(guidanceForDiagnosis(diagnosis("消息通道 gateway 断连")).to).toBe("/gateway");
    expect(guidanceForDiagnosis(diagnosis("记忆索引异常")).to).toBe("/skills");
  });
});
