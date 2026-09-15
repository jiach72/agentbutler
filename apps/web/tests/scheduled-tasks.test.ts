import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/server.js";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup(body: unknown) {
  const home = makeTempDir();
  const uiDist = makeUiDist(home);
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
  const app: FastifyInstance = createWebServer({ home, uiDist, fetchImpl, watchUrl: "http://watch", accessToken: "" });
  cleanups.push(async () => { await app.close(); rmTempDir(home); });
  return { app, fetchImpl };
}
const empty = { schemaVersion: 1, supported: true, reachable: true, items: [] };
describe("scheduled task BFF", () => {
  it("validates responses and strips forbidden fields from list", async () => {
    const { app } = setup({ ...empty, items: [{
      id: "abc123", name: "Task", enabled: true, scheduleLabel: "0 9 * * *", nextRunAt: null, lastRunAt: null,
      lastStatus: "never", failureStreak: 0, deliveryEnabled: false, editable: false,
      prompt: "SECRET_PROMPT", error: "SECRET_ERROR", base_url: "SECRET_URL",
    }], token: "SECRET_TOKEN" });
    const response = await app.inject({ method: "GET", url: "/api/scheduled-tasks" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("SECRET");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("does not fabricate success for malformed upstream payloads", async () => {
    const { app } = setup({ ...empty, items: [{ id: "bad" }] });
    expect((await app.inject({ method: "GET", url: "/api/scheduled-tasks" })).json())
      .toMatchObject({ reachable: false, reason: "invalid_response" });
  });
  it("rejects nested draft extras and query overrides before forwarding", async () => {
    const { app, fetchImpl } = setup(empty);
    expect((await app.inject({ method: "GET", url: "/api/scheduled-tasks?argv=run" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/scheduled-tasks", payload: {
      requestId: "create-bff-000001", draft: { name: "Task", prompt: "secret",
        schedule: { kind: "interval", everyMinutes: 30 }, delivery: { enabled: false }, script: "bad.sh" },
    } })).statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("allows prompt only in explicit editor detail and validated editor writes", async () => {
    const draft = { name: "Task", prompt: "EDITOR_ONLY", schedule: { kind: "interval", everyMinutes: 30 },
      delivery: { enabled: false }, advanced: { model: "", workdir: "" } };
    const { app, fetchImpl } = setup({ schemaVersion: 1, supported: true, reachable: true, editable: true, draft });
    expect((await app.inject({ method: "GET", url: "/api/scheduled-tasks/abc123" })).json().draft.prompt).toBe("EDITOR_ONLY");
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, supported: true, reachable: true,
      requestId: "edit-bff-00000001", taskId: "abc123", outcome: "succeeded" })));
    expect((await app.inject({ method: "PATCH", url: "/api/scheduled-tasks/abc123",
      payload: { requestId: "edit-bff-00000001", draft } })).json().outcome).toBe("succeeded");
  });
  it("returns unknown on write timeout without retrying or echoing exception/JSON input", async () => {
    const { app, fetchImpl } = setup(empty);
    fetchImpl.mockRejectedValueOnce(new Error("SECRET_PROMPT"));
    const result = await app.inject({ method: "POST", url: "/api/scheduled-tasks/abc123/pause",
      payload: { requestId: "pause-bff-0000001" } });
    expect(result.json()).toMatchObject({ outcome: "unknown", reason: "bridge_unreachable" });
    expect(result.body).not.toContain("SECRET");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const bad = await app.inject({ method: "POST", url: "/api/scheduled-tasks",
      headers: { "content-type": "application/json" }, payload: '{"prompt":"SECRET_PROMPT"' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("SECRET");
  });
});
