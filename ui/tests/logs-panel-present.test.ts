import { describe, expect, it } from "vitest";
import { LOG_ISSUE_VISIBLE_COUNT, presentLogIssues } from "../src/pages/dashboard/LogPanel.js";
import type { LogIssueView } from "../src/pages/dashboard/types.js";

function issue(overrides: Partial<LogIssueView> = {}): LogIssueView {
  return {
    id: "i1",
    kind: "k",
    severity: "warn",
    title: "t",
    detail: "d",
    count: 1,
    sources: [],
    examples: [],
    suggestedAction: null,
    actionLabel: null,
    lastSeenAt: null,
    ...overrides,
  };
}

describe("presentLogIssues（日志分析列表的修复闭环展示）", () => {
  const base = [
    issue({ id: "a", count: 10, lastSeenAt: "2026-09-06T10:00:00Z" }),
    issue({ id: "b", count: 5, suggestedAction: "rb-restart", lastSeenAt: "2026-09-06T09:00:00Z" }),
    issue({ id: "c", count: 3, suggestedAction: "rb-restart", lastSeenAt: "2026-09-06T11:00:00Z" }),
    issue({ id: "d", count: 1, lastSeenAt: null }),
  ];

  it("修复进行中：同动作的问题标记 repairing，其余不受影响", () => {
    const { visible } = presentLogIssues(base, { repairingActionId: "rb-restart" });
    expect(visible.find((item) => item.issue.id === "b")!.postFix).toBe("repairing");
    expect(visible.find((item) => item.issue.id === "c")!.postFix).toBe("repairing");
    expect(visible.find((item) => item.issue.id === "a")!.postFix).toBe("none");
  });

  it("修复完成后：复发问题标记 recurred，未复发沉底标记 cleared", () => {
    const lastRepairAt = Date.parse("2026-09-06T10:30:00Z");
    const { visible, clearedCount } = presentLogIssues(base, { lastRepairAt });
    expect(visible.find((item) => item.issue.id === "c")!.postFix).toBe("recurred");
    expect(visible.find((item) => item.issue.id === "a")!.postFix).toBe("cleared");
    expect(visible[visible.length - 1]!.issue.id).toBe("b"); // cleared 沉底
    expect(clearedCount).toBe(2);
  });

  it("默认只展示前 N 类，展开后不截断", () => {
    const many = Array.from({ length: 12 }, (_, index) => issue({ id: `x${index}` }));
    const folded = presentLogIssues(many, {});
    expect(folded.visible).toHaveLength(LOG_ISSUE_VISIBLE_COUNT);
    expect(folded.hiddenCount).toBe(12 - LOG_ISSUE_VISIBLE_COUNT);
    const expanded = presentLogIssues(many, { expanded: true });
    expect(expanded.visible).toHaveLength(12);
    expect(expanded.hiddenCount).toBe(0);
  });
});
