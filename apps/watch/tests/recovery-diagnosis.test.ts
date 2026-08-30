/**
 * 诊断结论的可信度测试。
 *
 * 这个问题的真实形态：日志目录里有横跨数周的文件，其中三周前的一次 OOM，
 * 在实例完全健康时会被当成"根因"报出来。用户看到后要么白紧张，要么真去点那个
 * 会中断服务 30-90 秒的重启按钮。
 *
 * 这组用例守住：探针没坏就不许叫"根因"，陈年日志只算历史，证据必须给全。
 */
import { describe, expect, it } from "vitest";
import {
  startWatchHttp,
  type RecoveryDiagnosisView,
  type WatchHttpDeps,
} from "../src/http.js";
import type { LogAnalyzeView, LogIssueView } from "../src/log-analyzer.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

const HOUR = 60 * 60 * 1000;

const upgradeStub: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};

const gatewayStub: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

function issue(over: Partial<LogIssueView> & { id: string }): LogIssueView {
  return {
    kind: "generic-error",
    severity: "error",
    title: "系统错误",
    detail: "日志中出现未归类的错误",
    count: 1,
    sources: ["hermes:logs:agent.log"],
    examples: [],
    suggestedAction: null,
    actionLabel: null,
    lastSeenAt: null,
    ...over,
  };
}

function makeDeps(
  issues: LogIssueView[],
  connectionState: "connected" | "disconnected" = "connected",
): WatchHttpDeps {
  const logView: LogAnalyzeView = {
    issues,
    scannedSources: 1,
    scannedLines: 100,
    analyzedAt: new Date().toISOString(),
  };
  return {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    connections: {
      status: () => ({
        checkedAt: new Date().toISOString(),
        connections: [
          {
            instanceId: "hermes-main",
            connectionState,
            connected: connectionState === "connected",
          },
        ],
      }),
      check: async () => ({ status: "checked" }),
      connect: async () => ({ status: "connected" }),
      disconnect: async () => ({ status: "disconnected" }),
    },
    runbooks: () => [{ id: "rb-restart", label: "重启", description: "" }],
    executeRunbook: async () => ({ status: "started", instanceId: "hermes-main" }),
    resetRunbookBreaker: async () => ({ status: "reset", keys: [] }),
    upgrade: upgradeStub,
    gateway: gatewayStub,
    analyzeLogs: () => logView,
  };
}

describe("诊断结论可信度", () => {
  /** 每个用例只开一个服务，用完即关；端口由系统分配。 */
  async function diagnose(deps: WatchHttpDeps): Promise<RecoveryDiagnosisView> {
    const app = startWatchHttp(deps, { port: 0 });
    const addr = await app.start();
    expect(addr.port).toBeGreaterThan(0);
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/recovery/diagnose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      return (await res.json()) as RecoveryDiagnosisView;
    } finally {
      app.close();
    }
  }

  it("探针全绿 + 只有三周前的日志问题 → 不命名为根因，问题归入历史", async () => {
    const deps = makeDeps([
      issue({
        id: "old-oom",
        kind: "oom",
        title: "内存不足",
        count: 105,
        lastSeenAt: new Date(Date.now() - 21 * 24 * HOUR).toISOString(),
      }),
    ]);
    const view = await diagnose(deps);

    expect(view.rootCause).toBeNull();
    expect(view.primaryFinding).toBeNull();
    expect(view.findings).toEqual([]);
    expect(view.historicalFindingCount).toBe(1);
    expect(view.severity).toBe("ok");

    const logsProbe = view.probes.find((probe) => probe.id === "logs");
    expect(logsProbe?.status).toBe("pass");
    expect(logsProbe?.detail).toContain("历史提醒");
  });

  it("探针全绿 + 24 小时内仍在发生 → 给发现、附证据，但仍然不叫根因", async () => {
    const deps = makeDeps([
      issue({
        id: "recent-rate-limit",
        kind: "rate-limit",
        title: "消息限流",
        detail: "接口返回 429，发送被限流。",
        severity: "warn",
        count: 17,
        sources: ["hermes:logs:gateway.log"],
        lastSeenAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
    ]);
    const view = await diagnose(deps);

    expect(view.rootCause).toBeNull();
    expect(view.severity).toBe("warn");
    expect(view.primaryFinding).toMatchObject({
      id: "recent-rate-limit",
      title: "消息限流",
      detail: "接口返回 429，发送被限流。",
    });

    const evidence = view.primaryFinding!.evidence;
    expect(evidence.recent).toBe(true);
    expect(evidence.occurrences).toBe(17);
    expect(evidence.source).toBe("hermes:logs:gateway.log");
    expect(evidence.lastSeenLabel).toBe("30 分钟前");
  });

  it("探针真的失败 → 才叫根因", async () => {
    const deps = makeDeps([], "disconnected");
    const view = await diagnose(deps);

    expect(view.severity).toBe("error");
    expect(view.rootCause).not.toBeNull();
    expect(view.rootCause).toContain("消息通道未连接");
  });

  it("日志没写时间戳 → 无法证明是当下问题，归入历史", async () => {
    const deps = makeDeps([issue({ id: "undated", title: "系统错误", count: 5, lastSeenAt: null })]);
    const view = await diagnose(deps);

    expect(view.findings).toEqual([]);
    expect(view.historicalFindingCount).toBe(1);
    expect(view.rootCause).toBeNull();
  });

  it("多条发现按严重度优先、其次按次数排序", async () => {
    const recent = new Date(Date.now() - 2 * HOUR).toISOString();
    const deps = makeDeps([
      issue({ id: "warn-many", severity: "warn", title: "提醒：出现很多次", count: 99, lastSeenAt: recent }),
      issue({ id: "error-few", severity: "error", title: "错误：只出现一次", count: 1, lastSeenAt: recent }),
      issue({ id: "warn-few", severity: "warn", title: "提醒：只出现一次", count: 1, lastSeenAt: recent }),
    ]);
    const view = await diagnose(deps);

    expect(view.findings.map((item) => item.id)).toEqual(["error-few", "warn-many", "warn-few"]);
  });

  it("最近与历史并存时，只把最近的算作当前发现", async () => {
    const deps = makeDeps([
      issue({ id: "recent", title: "新问题", lastSeenAt: new Date(Date.now() - HOUR).toISOString() }),
      issue({ id: "old-1", title: "老问题一", lastSeenAt: new Date(Date.now() - 10 * 24 * HOUR).toISOString() }),
      issue({ id: "old-2", title: "老问题二", lastSeenAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() }),
    ]);
    const view = await diagnose(deps);

    expect(view.findings.map((item) => item.id)).toEqual(["recent"]);
    expect(view.historicalFindingCount).toBe(2);
  });

  it("最近一次的时间说成人话（24 小时内的表达）", async () => {
    const cases: Array<[number, string]> = [
      [30 * 1000, "刚刚"],
      [45 * 60 * 1000, "45 分钟前"],
      [5 * HOUR, "5 小时前"],
    ];
    for (const [ago, expected] of cases) {
      const deps = makeDeps([
        issue({ id: `t-${ago}`, lastSeenAt: new Date(Date.now() - ago).toISOString() }),
      ]);
      const view = await diagnose(deps);
      expect(view.primaryFinding?.evidence.lastSeenLabel).toBe(expected);
    }
  });

  it("超过时间窗的问题不再展示为当前发现，但仍计入历史数量", async () => {
    const deps = makeDeps([
      issue({ id: "three-days", lastSeenAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString() }),
    ]);
    const view = await diagnose(deps);
    expect(view.primaryFinding).toBeNull();
    expect(view.historicalFindingCount).toBe(1);
  });
});
