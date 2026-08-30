import { describe, expect, it } from "vitest";
import { buildConclusions } from "../src/pages/dashboard/conclusions.js";
import type { DashboardPayload } from "../src/pages/dashboard/types.js";

function dashboard(overrides: Partial<DashboardPayload>): DashboardPayload {
  return {
    instances: [],
    latestInspections: [],
    fingerprints: [],
    inspectStatus: { reachable: true, inFlight: false, lastCompletedAt: null },
    ...overrides,
  } as DashboardPayload;
}

describe("首页问题卡下一步", () => {
  it("未发现实例时直达首次设置", () => {
    const conclusions = buildConclusions(dashboard({}), null);

    expect(conclusions.issues).toContainEqual(expect.objectContaining({
      id: "no-instance",
      action: { label: "继续设置", to: "/setup" },
    }));
  });

  it("实例异常时带着报错现象进入排查", () => {
    const conclusions = buildConclusions(dashboard({
      latestInspections: [{
        instanceId: "hermes-main",
        ts: "2026-08-30T08:00:00.000Z",
        overall: "down",
        confidence: 0.9,
        checks: [{ id: "service", status: "fail", detail: "服务不可达", durationMs: 1 }],
      }],
    }), null);

    expect(conclusions.issues).toContainEqual(expect.objectContaining({
      id: "down-hermes-main",
      action: { label: "开始排查", to: "/troubleshoot?symptom=error" },
    }));
  });

  it("实例降级时带着不确定现象进入排查", () => {
    const conclusions = buildConclusions(dashboard({
      latestInspections: [{
        instanceId: "hermes-main",
        ts: "2026-08-30T08:00:00.000Z",
        overall: "degraded",
        confidence: 0.8,
        checks: [{ id: "memory", status: "warn", detail: "记忆索引延迟", durationMs: 1 }],
      }],
    }), null);

    expect(conclusions.issues).toContainEqual(expect.objectContaining({
      id: "degraded-hermes-main",
      action: { label: "帮我看看", to: "/troubleshoot?symptom=not-sure" },
    }));
  });

  it("管家控制通道离线时指向本机安全设置", () => {
    const conclusions = buildConclusions(dashboard({
      inspectStatus: { reachable: false, inFlight: false, lastCompletedAt: null },
    }), null);

    expect(conclusions.issues).toContainEqual(expect.objectContaining({
      id: "watch-offline",
      action: { label: "查看本机安全", to: "/settings" },
    }));
  });

  it("没有检查结果时提供原地检查动作", () => {
    const conclusions = buildConclusions(dashboard({
      instances: [{
        instanceId: "hermes-main",
        frameworkId: "hermes",
        state: "running",
        runtime: "docker",
        version: "0.20.4",
        confidence: 0.9,
      }],
    }), null);

    expect(conclusions.issues).toContainEqual(expect.objectContaining({
      id: "no-result",
      action: { label: "立即检查" },
    }));
  });
});
