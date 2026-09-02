/**
 * 管家首页新增展示辅助的纯函数测试：
 * uptime 格式化、占用百分比、实例短名、巡检最近耗时回退链，
 * 以及 fingerprint 徽标语义（open → error、known → muted）。
 */
import { describe, expect, it } from "vitest";
import {
  fingerprintBadge,
  formatUptime,
  instanceShortName,
  recentInspectionDurationMs,
  usedPercentOf,
} from "../src/pages/dashboard/helpers.js";
import type { InspectionView, InspectStatusView } from "../src/pages/dashboard/types.js";

describe("formatUptime", () => {
  it("按天/小时/分钟组合人性化展示", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3_600)).toBe("3 天 4 小时");
    expect(formatUptime(3 * 86_400)).toBe("3 天");
    expect(formatUptime(5 * 3_600 + 30 * 60)).toBe("5 小时 30 分钟");
    expect(formatUptime(25 * 60)).toBe("25 分钟");
    expect(formatUptime(42)).toBe("42 秒");
  });

  it("无效值显示占位符", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(0)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});

describe("usedPercentOf", () => {
  it("计算 used/total 百分比并四舍五入", () => {
    expect(usedPercentOf(250, 1_000)).toBe(25);
    expect(usedPercentOf(1, 3)).toBe(33);
  });

  it("封顶 100、地板 0，无效输入返回 null", () => {
    expect(usedPercentOf(1_500, 1_000)).toBe(100);
    expect(usedPercentOf(-5, 1_000)).toBe(0);
    expect(usedPercentOf(null, 1_000)).toBeNull();
    expect(usedPercentOf(100, null)).toBeNull();
    expect(usedPercentOf(100, 0)).toBeNull();
  });
});

describe("instanceShortName", () => {
  it("取实例 id 的框架前缀，空 id 回退主实例", () => {
    expect(instanceShortName("hermes-main")).toBe("hermes");
    expect(instanceShortName("openclaw-a")).toBe("openclaw");
    expect(instanceShortName("solo")).toBe("solo");
    expect(instanceShortName("")).toBe("主实例");
  });
});

describe("recentInspectionDurationMs", () => {
  const inspectStatus = {
    reachable: true,
    criticalProbe: {
      intervalMin: 1,
      slaMin: 10,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextAt: null,
      deadlineAt: null,
      lastDurationMs: 1234,
      lastStatus: "pass",
      lastWithinSla: true,
      overdue: false,
      inFlight: false,
      runCount: 1,
      missedTicks: 0,
    },
  } as InspectStatusView;

  it("优先取关键记忆探针耗时", () => {
    expect(recentInspectionDurationMs(inspectStatus, [])).toBe(1234);
  });

  it("探针缺省时回退最近一次巡检各 check 均值", () => {
    const inspection: InspectionView = {
      instanceId: "hermes-main",
      ts: "2026-09-01T08:00:00.000Z",
      overall: "healthy",
      confidence: 1,
      checks: [
        { id: "a", status: "pass", detail: null, durationMs: 100 },
        { id: "b", status: "pass", detail: null, durationMs: 300 },
        { id: "c", status: "skipped", detail: null, durationMs: null },
      ],
    };
    expect(recentInspectionDurationMs(null, [inspection])).toBe(200);
  });

  it("两者都不可用时返回 null", () => {
    expect(recentInspectionDurationMs(null, [])).toBeNull();
  });
});

describe("fingerprintBadge 徽标语义", () => {
  it("open 为 error（待处理），known 为 muted（已知问题）", () => {
    expect(fingerprintBadge("open")).toEqual({ tone: "error", label: "待处理" });
    expect(fingerprintBadge("known")).toEqual({ tone: "muted", label: "已知问题" });
  });

  it("未知状态回退 muted", () => {
    expect(fingerprintBadge("whatever")).toEqual({ tone: "muted", label: "whatever" });
  });
});
