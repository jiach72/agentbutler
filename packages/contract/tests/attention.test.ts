import { describe, expect, it } from "vitest";
import { deriveUserHealthSummary, isActionableAlert, isInstanceOnline, normalizeInstanceState, type UserHealthInput } from "../src/attention.js";

const healthy: UserHealthInput = {
  observedAt: "2026-09-15T10:00:00.000Z",
  instances: [{ instanceId: "hermes-main", state: "Serving", connected: true }],
  alerts: [], pendingApprovals: 0,
  messages: { connected: true, failed: 0, unknown: 0 },
  model: "available", memory: "available",
};

describe("shared user health", () => {
  it("requires factual connection as well as an online lifecycle", () => {
    for (const state of ["Serving", "running", "healthy", " ACTIVE "]) {
      expect(normalizeInstanceState(state)).toBe("online");
      expect(isInstanceOnline({ instanceId: "x", state, connected: true })).toBe(true);
      expect(isInstanceOnline({ instanceId: "x", state })).toBe(false);
    }
    expect(isInstanceOnline({ instanceId: "x", state: "Stopped", connected: true })).toBe(false);
  });
  it("is healthy only when all user capabilities are verified", () => {
    expect(deriveUserHealthSummary(healthy)).toMatchObject({ status: "healthy", attention: [] });
  });
  it("not-applicable capability state is skipped and does not generate attention items", () => {
    expect(deriveUserHealthSummary({ ...healthy, memory: "not-applicable", model: "not-applicable" })).toMatchObject({
      status: "healthy",
      attention: [],
    });
  });
  it("online service plus memory failure requires action", () => {
    expect(deriveUserHealthSummary({ ...healthy, memory: "unavailable" })).toMatchObject({ status: "action_required", attention: [expect.objectContaining({ id: "memory" })] });
  });
  it("unknown message outcomes require verification, never imply healthy", () => {
    expect(deriveUserHealthSummary({ ...healthy, messages: { connected: true, failed: 0, unknown: 2 } }).status).toBe("action_required");
    expect(deriveUserHealthSummary({ ...healthy, messages: null }).status).toBe("degraded");
  });
  it("delivered, read, resolved and expired notifications alone are not actionable", () => {
    for (const status of ["delivered", "read", "resolved", "expired", "pending", "delivering"]) expect(isActionableAlert({ status, severity: "critical" })).toBe(false);
    expect(deriveUserHealthSummary({ ...healthy, alerts: [{ status: "expired", severity: "critical" }], pendingApprovals: 0 }).status).toBe("healthy");
    expect(isActionableAlert({ status: "delivered", resolutionStatus: "open", requiresAction: true })).toBe(true);
    expect(isActionableAlert({ status: "delivered", resolutionStatus: "resolved", requiresAction: true })).toBe(false);
  });
  it("counts only caller-provided pending approvals", () => {
    expect(deriveUserHealthSummary({ ...healthy, pendingApprovals: 2 }).attention[0]?.evidenceCount).toBe(2);
  });
  it("does not hide missing inputs, or cap the shared attention collection", () => {
    const result = deriveUserHealthSummary({ observedAt: healthy.observedAt, instances: null, alerts: null, pendingApprovals: null, messages: null, memory: "unknown", model: "unknown" });
    expect(result.status).toBe("degraded");
    expect(result.attention.length).toBeGreaterThan(5);
    expect(result).toEqual(deriveUserHealthSummary({ observedAt: healthy.observedAt, instances: null, alerts: null, pendingApprovals: null, messages: null, memory: "unknown", model: "unknown" }));
  });
});
