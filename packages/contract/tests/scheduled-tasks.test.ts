import { describe, expect, it } from "vitest";
import { parseScheduledTaskRequest, parseScheduledTaskResponse } from "../src/scheduled-tasks.js";

describe("scheduled task trust boundary", () => {
  it("rejects arbitrary argv, unknown fields and invalid identifiers", () => {
    expect(parseScheduledTaskRequest({ action: "list", argv: ["--json"] })).toBeNull();
    expect(parseScheduledTaskRequest({ action: "runs", id: "--help", limit: 20 })).toBeNull();
    expect(parseScheduledTaskRequest({ action: "runs", id: "abc123", limit: 501 })).toBeNull();
    expect(parseScheduledTaskRequest({ action: "remove", id: "abc123", requestId: "request-12345678" })).toBeNull();
  });
  it("rejects invalid envelopes rather than claiming an empty success", () => {
    expect(parseScheduledTaskResponse("list", { supported: true, reachable: true, items: [] })).toBeNull();
    expect(parseScheduledTaskResponse("list", {
      schemaVersion: 1, supported: true, reachable: true, items: [{ id: "a", prompt: "SECRET" }],
    })).toBeNull();
  });
  it("accepts valid incidents including resolved state", () => {
    const valid = parseScheduledTaskResponse("incidents", {
      schemaVersion: 1, supported: true, reachable: true, items: [{
        id: "task-1", taskId: "task-1", state: "resolved", failureType: "timeout",
        firstSeenAt: "2026-09-20T10:00:00Z", lastSeenAt: "2026-09-20T10:30:00Z",
      }],
    });
    expect(valid).not.toBeNull();
    expect(valid?.items[0]?.state).toBe("resolved");
  });
});

