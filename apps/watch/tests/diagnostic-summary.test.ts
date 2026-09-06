import { describe, expect, it } from "vitest";
import { buildDiagnosticSummary, summarizeLocalOutcomes } from "../src/diagnostics.js";

describe("buildDiagnosticSummary", () => {
  it("returns redacted machine-readable health data", async () => {
    const summary = await buildDiagnosticSummary({
      core: { instances: { listInstances: () => [{ instanceId: "i", frameworkId: "hermes", state: "Serving", version: "1.0.0", rootPath: "/home/alice/.hermes", runtime: "process", confidence: 1, capability: null, detail: {}, createdAt: "", updatedAt: "" }] }, store: {} } as never,
      butler: { version: () => ({ version: "1", source: "", branch: null, commit: null, tag: null, repository: null, checkedAt: "" }) },
      analyzeLogs: () => ({ issues: [{ id: "x", kind: "oom", severity: "warn", title: "内存提醒", detail: "detail", count: 2, sources: [], examples: [], suggestedAction: null, actionLabel: null }], scannedSources: 1, scannedLines: 2, analyzedAt: "" }),
      security: { status: async () => ({ totalSecretFiles: 1, insecureSecretFiles: 0, invariants: [] }) } as never,
      gateway: { stats: async () => ({ overall: "ok", last24h: 0, totalEvents: 0 }) } as never,
      now: () => Date.parse("2026-08-30T00:00:00Z"),
    });
    expect(summary.schemaVersion).toBe("diagnostic-summary-v1");
    expect(summary.redacted).toBe(true);
    expect(summary.instances[0]?.root).toBe("~/.hermes");
    expect(summary.localOutcomes.outcomes.find((item) => item.id === "backup")?.completed).toBe(0);
  });

  it("只聚合审计中有明确终态的本地结果，不把记录数伪装为成功率", () => {
    const summary = summarizeLocalOutcomes(
      [
        { ts: "2026-08-20T00:00:00.000Z", action: "backup-full", detail: {} },
        { ts: "2026-08-21T00:00:00.000Z", action: "runbook", detail: { success: true } },
        { ts: "2026-08-22T00:00:00.000Z", action: "runbook", detail: { success: false } },
        { ts: "2026-08-23T00:00:00.000Z", action: "upgrade-done", detail: {} },
        { ts: "2026-08-24T00:00:00.000Z", action: "self-upgrade-rollback", detail: {} },
        { ts: "2026-07-01T00:00:00.000Z", action: "backup-memory", detail: {} },
        { ts: "not-a-date", action: "upgrade-failed", detail: {} },
      ],
      Date.parse("2026-08-30T00:00:00.000Z"),
    );

    expect(summary.schemaVersion).toBe("local-outcome-summary-v1");
    expect(summary.evidenceNote).toContain("不代表成功率");
    expect(summary.outcomes).toMatchObject([
      { id: "backup", completed: 1, knownFailures: 0, lastCompletedAt: "2026-08-20T00:00:00.000Z" },
      { id: "repair", completed: 1, knownFailures: 1, lastFailureAt: "2026-08-22T00:00:00.000Z" },
      { id: "upgrade", completed: 1, knownFailures: 0 },
      { id: "rollback", completed: 1, knownFailures: 0 },
    ]);
  });
});
