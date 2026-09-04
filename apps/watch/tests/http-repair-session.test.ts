import { afterEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp } from "../src/http.js";
import { RepairSessionService } from "../src/repair-session.js";
import type { GatewayPanelService } from "../src/gateway-stats.js";
import type { UpgradeService } from "../src/upgrade.js";

const upgrade: UpgradeService = {
  startUpgrade: () => ({ status: "missing-target-version" }),
  status: () => null,
  listVersions: async () => ({ reachable: false, versions: [] }),
  rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
};

const gateway: GatewayPanelService = {
  stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
  patches: async () => [],
  applyPatch: async () => ({ status: "no-instance" }),
  reapplyPatch: async () => ({ status: "no-instance" }),
  detectPatch: async () => ({ status: "no-instance" }),
};

describe("修复会话 HTTP 接口", () => {
  let http: WatchHttp | null = null;

  afterEach(() => {
    http?.close();
    http = null;
  });

  it("创建、读取和审批会话，且审批路由不会混入普通详情路由", async () => {
    let executeCalls = 0;
    const service = new RepairSessionService({
      diagnose: async () => ({
        incidentId: "incident-http",
        severity: "error",
        summary: "实例无响应",
        safeToRetry: false,
        rootCause: "实例无响应",
        primaryFinding: {
          title: "实例无响应",
          detail: "连接探针失败",
          suggestedAction: "rb-restart",
          evidence: { source: "hermes", kind: "connection", lastSeenLabel: "刚刚", occurrences: 1 },
        },
        probes: [{ id: "connection", label: "连接", status: "fail", detail: "失败" }],
        recommendedActions: [],
        checkedAt: "2026-09-04T00:00:00.000Z",
      }),
      actions: () => [{
        id: "restart-instance",
        label: "重启实例",
        description: "重启实例",
        risk: "high",
        impact: "短暂中断",
        estimatedSeconds: 30,
        requiresConfirmation: true,
        available: true,
      }],
      execute: async () => {
        executeCalls += 1;
        return { ok: true, detail: "已启动", changes: ["重启实例"] };
      },
      getJob: () => undefined,
      pollMs: 5,
    });
    http = startWatchHttp({
      scheduler: { runNow: () => true, status: () => ({ lastAt: null, nextAt: null, intervalMin: 1, inFlight: false }) },
      runbooks: () => [],
      executeRunbook: async () => ({ status: "started", instanceId: "hermes-main" }),
      upgrade,
      gateway,
      repairSessions: service,
    }, { port: 0 });
    const address = await http.start();
    const base = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${base}/api/recovery/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(created.status).toBe(202);
    const initial = await created.json() as { sessionId: string };
    const detail = await fetch(`${base}/api/recovery/sessions/${encodeURIComponent(initial.sessionId)}`);
    expect(detail.status).toBe(200);
    const pending = await detail.json() as { status: string };
    expect(pending.status).toBe("awaiting-approval");

    const wrongMethod = await fetch(`${base}/api/recovery/sessions/${encodeURIComponent(initial.sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(wrongMethod.status).toBe(405);
    const approved = await fetch(`${base}/api/recovery/sessions/${encodeURIComponent(initial.sessionId)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(approved.status).toBe(202);
    expect(executeCalls).toBe(1);
  });
});
