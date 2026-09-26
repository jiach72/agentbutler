import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCore, type Core } from "@butler/core";
import { createEvolutionAnalyticsService } from "../src/evolution-analytics.js";
import type { EvolutionService } from "../src/evolution.js";

let home: string | undefined;
let core: Core | undefined;

function makeService(lines: string[], ledger: Array<Record<string, unknown>> = []) {
  home = mkdtempSync(join(tmpdir(), "butler-evolution-analytics-"));
  core = createCore({ home });
  core.store.saveInstance({ instanceId: "hermes-main", frameworkId: "hermes", state: "Serving", runtime: "test", rootPath: "/hermes", version: null, confidence: 1, capabilityJson: null, detailJson: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const evolution = { status: () => ({ minHoldoutCount: 10, defaultDependencies: [], defaultEndpoint: "", ledger, hermes: { status: "ready", root: "/hermes", detail: "ready" }, endpointHealth: { status: "pass", category: "ok", detail: "ok", checkedAt: new Date().toISOString() }, blocked: [], tasks: [], history: [] }) } as unknown as EvolutionService;
  return createEvolutionAnalyticsService({ core, evolution, analyzeLogs: () => ({ issues: [], scannedSources: 1, scannedLines: lines.length, analyzedAt: new Date().toISOString() }), logs: { listSources: () => [{ id: "hermes", path: "hermes.log" }], readTail: () => ({ lines }) }, now: () => Date.parse("2026-08-30T12:00:00.000Z") });
}

afterEach(() => {
  core?.close();
  core = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("evolution analytics", () => {
  it("keeps health score unknown when the sample gate is not met", async () => {
    const service = makeService([
      "2026-08-30T11:00:00Z tool call: search success duration=20ms session_id=s1",
      "2026-08-30T11:01:00Z session_id=s1 completed success",
    ]);
    const view = await service.overview("hermes-main", "7d");
    expect(view.totals.toolCalls).toBe(1);
    expect(view.totals.healthScore).toBeNull();
    expect(view.totals.sampleStatus).toBe("insufficient");
    expect(view.datasets.realSamples).toBe(1);
    expect(view.actionItems.some((item) => item.category === "dataset")).toBe(true);
  });

  it("prefers structured adapter outcomes over log-only estimation", async () => {
    const service = makeService([]);
    core!.bus.emit("adapter-call-completed", { instanceId: "hermes-main", method: "search", success: true, durationMs: 18, sessionId: "session-structured" });
    const view = await service.overview("hermes-main", "7d");
    expect(view.source).toBe("structured");
    expect(view.completeness.structuredObservations).toBe(1);
    expect(view.totals.successfulToolCalls).toBe(1);
    expect(view.totals.p50DurationMs).toBe(18);
  });

  it("calculates the documented score from explicit outcomes only", async () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, index) => `2026-08-30T10:${String(index).padStart(2, "0")}:00Z tool call: search ${index < 16 ? "success" : "failed"} duration=${index + 1}ms session_id=s${index}`),
      ...Array.from({ length: 5 }, (_, index) => `2026-08-30T11:0${index}:00Z session_id=s${index} completed success`),
    ];
    const service = makeService(lines);
    const view = await service.overview("hermes-main", "7d");
    expect(view.totals.reliability).toBe(0.8);
    expect(view.totals.completion).toBe(1);
    expect(view.totals.coverage).toBe(1);
    expect(view.totals.healthScore).toBe(88);
    expect(view.totals.p50DurationMs).toBe(10);
    expect(view.totals.p95DurationMs).toBe(19);
  });

  it("maps gain scores transparently and reopens resolved actions on recurrence", async () => {
    const service = makeService([], [
      { runId: "accepted-1", updatedAt: "2026-08-30T10:00:00.000Z", instanceId: "hermes-main", status: "accepted", holdoutCount: 10, baselineMetric: 0.3, candidateMetric: 0.4, delta: 0.1, conclusion: "", disposition: "accepted" },
      { runId: "kept-1", updatedAt: "2026-08-30T09:00:00.000Z", instanceId: "hermes-main", status: "kept-baseline", holdoutCount: 10, baselineMetric: 0.3, candidateMetric: 0.3, delta: 0, conclusion: "", disposition: "kept" },
      { runId: "regression-1", updatedAt: "2026-08-30T08:00:00.000Z", instanceId: "hermes-main", status: "rejected-regression", holdoutCount: 10, baselineMetric: 0.3, candidateMetric: 0.2, delta: -0.1, conclusion: "", disposition: "rejected" },
    ]);
    const view = await service.overview("hermes-main", "7d");
    expect(view.runs.map((run) => run.gainScore)).toEqual([100, 50, 0]);
    const datasetAction = view.actionItems.find((item) => item.category === "dataset");
    expect(datasetAction).toBeDefined();
    core!.store.updateEvolutionActionItemStatus(datasetAction!.actionId, "resolved");
    const reopened = await service.overview("hermes-main", "7d");
    expect(reopened.actionItems.find((item) => item.actionId === datasetAction!.actionId)?.status).toBe("open");
  });

  it("多次分析不累加行动清单 occurrences 次数 (Issue 45)", async () => {
    const service = makeService([
      "2026-08-30T10:00:00Z tool call: search failed duration=20ms session_id=s1",
      "2026-08-30T10:01:00Z tool call: search failed duration=20ms session_id=s1",
    ]);
    const firstView = await service.overview("hermes-main", "7d");
    const firstAction = firstView.actionItems.find((item) => item.title.includes("search") || item.category === "runtime");
    const initialOccurrences = firstAction?.occurrences ?? 0;
    expect(initialOccurrences).toBeGreaterThan(0);

    // 模拟多次调用分析，occurrences 不得膨胀
    for (let i = 0; i < 5; i += 1) {
      await service.overview("hermes-main", "7d");
    }
    const finalView = await service.overview("hermes-main", "7d");
    const finalAction = finalView.actionItems.find((item) => item.actionId === firstAction?.actionId);
    expect(finalAction?.occurrences).toBe(initialOccurrences);
  });

  it("过滤不相关的非工具/会话总线事件，避免污染观测表 (Issue 48)", async () => {
    const service = makeService([]);
    // 触发系统级无 tool/session 的杂散事件
    core!.bus.emit("config-reloaded", { instanceId: "hermes-main", timestamp: "2026-08-30T11:00:00Z" });
    core!.bus.emit("heartbeat-ping", { instanceId: "hermes-main", ok: true });
    
    const obs = core!.store.listEvolutionObservations({ instanceId: "hermes-main" });
    expect(obs).toHaveLength(0);

    // 真正的工具调用事件依然被正确捕获
    core!.bus.emit("adapter-call-completed", { instanceId: "hermes-main", method: "search", success: true, durationMs: 18, sessionId: "session-1" });
    const obsAfter = core!.store.listEvolutionObservations({ instanceId: "hermes-main" });
    expect(obsAfter).toHaveLength(1);
    expect(obsAfter[0]?.name).toBe("search");
  });
});

