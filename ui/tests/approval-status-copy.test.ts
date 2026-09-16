/**
 * 审批状态/来源展示辅助的纯函数测试：
 * - isAuditApproval：仅 detail.origin=auto-detect 判真，非对象 detail 判假；
 * - approvalStatusLabel：4 状态 × gate/audit 两套文案分流；
 * - approvalStatusTone：色语义不随来源变化。
 */
import { describe, expect, it } from "vitest";
import { approvalStatusLabel, approvalStatusTone, isAuditApproval } from "../src/pages/approvals/helpers.js";

describe("isAuditApproval（audit=事后确认来源判定）", () => {
  it("detail.origin=auto-detect 判真，其余 origin 判假", () => {
    expect(isAuditApproval({ detail: { origin: "auto-detect" } })).toBe(true);
    expect(isAuditApproval({ detail: { origin: "explicit" } })).toBe(false);
    expect(isAuditApproval({ detail: { target: "/a" } })).toBe(false);
  });

  it("detail 非对象（字符串/null/undefined/数组）一律按 gate 处理", () => {
    expect(isAuditApproval({ detail: "raw" })).toBe(false);
    expect(isAuditApproval({ detail: null })).toBe(false);
    expect(isAuditApproval({ detail: undefined })).toBe(false);
    expect(isAuditApproval({ detail: ["auto-detect"] })).toBe(false);
    expect(isAuditApproval({ detail: 42 })).toBe(false);
  });
});

describe("approvalStatusLabel（gate 事前放行 / audit 事后确认 文案分流）", () => {
  it("gate 文案：待放行 / 已批准 / 已拒绝 / 超时拦截", () => {
    expect(approvalStatusLabel("pending", false)).toBe("待放行");
    expect(approvalStatusLabel("approved", false)).toBe("已批准");
    expect(approvalStatusLabel("denied", false)).toBe("已拒绝");
    expect(approvalStatusLabel("expired", false)).toBe("超时拦截");
  });

  it("audit 文案：待核验 / 已追认 / 已标记存疑 / 超时未确认", () => {
    expect(approvalStatusLabel("pending", true)).toBe("待核验");
    expect(approvalStatusLabel("approved", true)).toBe("已追认");
    expect(approvalStatusLabel("denied", true)).toBe("已标记存疑");
    expect(approvalStatusLabel("expired", true)).toBe("超时未确认");
  });

  it("未知状态原样返回，不臆造标签", () => {
    expect(approvalStatusLabel("mystery", false)).toBe("mystery");
    expect(approvalStatusLabel("mystery", true)).toBe("mystery");
  });
});

describe("approvalStatusTone（语义色映射）", () => {
  it("四态映射稳定，未知回退 unknown", () => {
    expect(approvalStatusTone("pending")).toBe("warn");
    expect(approvalStatusTone("approved")).toBe("ok");
    expect(approvalStatusTone("denied")).toBe("error");
    expect(approvalStatusTone("expired")).toBe("error");
    expect(approvalStatusTone("whatever")).toBe("unknown");
  });

  it("audit 的 expired 降级为中性 unknown（非红色的警报）", () => {
    expect(approvalStatusTone("expired", true)).toBe("unknown");
    expect(approvalStatusTone("expired", false)).toBe("error");
  });
});
