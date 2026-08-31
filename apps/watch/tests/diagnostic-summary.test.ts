import { describe, expect, it } from "vitest";
import { buildDiagnosticSummary } from "../src/diagnostics.js";

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
  });
});
