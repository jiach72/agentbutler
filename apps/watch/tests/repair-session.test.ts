import { describe, expect, it } from "vitest";
import { RepairSessionService, type RepairAction, type RepairDiagnosis } from "../src/repair-session.js";

const lowRisk: RepairAction = {
  id: "refresh-probe",
  label: "重新巡检",
  description: "触发一次新的状态巡检",
  risk: "low",
  impact: "不会修改配置",
  estimatedSeconds: 5,
  requiresConfirmation: false,
  available: true,
};

const highRisk: RepairAction = {
  id: "restart-instance",
  label: "重启实例",
  description: "重启受管 Hermes 实例并复验",
  risk: "high",
  impact: "实例会短暂不可用",
  estimatedSeconds: 30,
  requiresConfirmation: true,
  available: true,
};

function diagnosis(severity: RepairDiagnosis["severity"], rootCause: string | null = null): RepairDiagnosis {
  return {
    incidentId: "incident-1",
    severity,
    summary: severity === "ok" ? "检查通过" : "发现运行问题",
    safeToRetry: severity !== "error",
    rootCause,
    primaryFinding: rootCause === null ? null : {
      title: rootCause,
      detail: "探针发现连接异常",
      suggestedAction: "rb-restart",
      evidence: { source: "hermes", kind: "connection", lastSeenLabel: "刚刚", occurrences: 2 },
    },
    probes: [{ id: "connection", label: "连接", status: severity === "ok" ? "pass" : "fail", detail: "连接状态" }],
    recommendedActions: [],
    checkedAt: "2026-09-04T00:00:00.000Z",
  };
}

async function waitForTerminal(service: RepairSessionService, sessionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = service.get(sessionId)!;
    if (["done", "blocked", "failed"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("session did not finish");
}

describe("RepairSessionService", () => {
  it("自动执行低风险动作并在复验通过后完成", async () => {
    let calls = 0;
    const audit: Array<{ action: string; detail?: unknown }> = [];
    const service = new RepairSessionService({
      diagnose: async () => {
        calls += 1;
        return diagnosis(calls === 1 ? "warn" : "ok", calls === 1 ? "连接短暂中断" : null);
      },
      actions: () => [lowRisk],
      execute: async (actionId) => ({ ok: actionId === lowRisk.id, detail: "巡检已触发", changes: ["触发重新巡检"] }),
      getJob: () => undefined,
      advisor: {
        recommend: async () => ({
          actionId: lowRisk.id,
          source: "deterministic-policy" as const,
          promptDispatched: false,
          detail: "测试固定低风险动作",
        }),
      },
      audit: { append: (entry) => audit.push(entry) },
      pollMs: 5,
    });

    const started = service.start("hermes-main");
    const finished = await waitForTerminal(service, started.sessionId);
    expect(finished.status).toBe("done");
    expect(finished.changes).toEqual(["触发重新巡检"]);
    expect(finished.verification.status).toBe("passed");
    expect(audit.map((entry) => entry.action)).toEqual([
      "repair-session-started",
      "repair-session-planned",
      "repair-session-applying",
      "repair-session-done",
    ]);
  });

  it("中高风险动作停在待确认，批准后才执行", async () => {
    let executeCalls = 0;
    const service = new RepairSessionService({
      diagnose: async () => diagnosis("error", "实例无响应"),
      actions: () => [highRisk],
      execute: async () => {
        executeCalls += 1;
        return { ok: false, detail: "不应在审批前执行", changes: [] };
      },
      getJob: () => undefined,
      pollMs: 5,
    });
    const started = service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.get(started.sessionId)?.status).toBe("awaiting-approval");
    expect(executeCalls).toBe(0);
    service.approve(started.sessionId);
    const finished = await waitForTerminal(service, started.sessionId);
    expect(finished.status).toBe("failed");
    expect(executeCalls).toBe(1);
  });

  it("顾问返回非白名单动作时阻断，不执行自由文本", async () => {
    let executeCalls = 0;
    const service = new RepairSessionService({
      diagnose: async () => diagnosis("warn", "未知问题"),
      actions: () => [lowRisk],
      execute: async () => {
        executeCalls += 1;
        return { ok: true, detail: "unexpected", changes: [] };
      },
      getJob: () => undefined,
      advisor: {
        recommend: async () => ({
          actionId: "rm -rf /",
          source: "background-advisor",
          promptDispatched: true,
          detail: "后台顾问建议",
        }),
      },
      pollMs: 5,
    });
    const finished = await waitForTerminal(service, service.start().sessionId);
    expect(finished.status).toBe("blocked");
    expect(executeCalls).toBe(0);
    expect(finished.advisor.promptDispatched).toBe(true);
  });
});
