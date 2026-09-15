import { afterEach, describe, expect, it, vi } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import { createScheduledTaskService } from "../src/scheduled-tasks.js";
import type { ScheduledTaskResponse } from "@butler/contract";

const servers: WatchHttp[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function setup(response: ScheduledTaskResponse) {
  const request = vi.fn(async (_input: unknown) => response);
  const server = startWatchHttp({ scheduledTasks: { request } } as unknown as WatchHttpDeps, { host: "127.0.0.1", port: 0 });
  servers.push(server);
  const address = await server.start();
  return { request, url: `http://127.0.0.1:${address.port}` };
}
const empty = { schemaVersion: 1 as const, supported: true, reachable: true, items: [] };
describe("Watch scheduled task routing", () => {
  it("routes all read actions without forwarding unknown parameters", async () => {
    const { url, request } = await setup(empty);
    for (const path of ["", "/incidents", "/abc123/runs?limit=20"]) {
      expect((await fetch(url + "/api/scheduled-tasks" + path)).status).toBe(200);
    }
    expect(request.mock.calls).toEqual([[{ action: "list" }], [{ action: "incidents" }], [{ action: "runs", id: "abc123", limit: 20 }]]);
    for (const path of ["?command=run", "/abc123/runs?limit=0", "/abc123/runs?limit=1&limit=2", "/--help"]) {
      expect((await fetch(url + "/api/scheduled-tasks" + path)).status).toBe(400);
    }
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("rejects unknown write fields, malformed IDs, oversized bodies and cross-origin requests", async () => {
    const { url, request } = await setup(empty);
    for (const body of [{ requestId: "request-valid-0001", args: ["--help"] }, { requestId: "short" }]) {
      expect((await fetch(url + "/api/scheduled-tasks/abc123/pause", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await fetch(url + "/api/scheduled-tasks/abc123/pause", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x".repeat(70000) }) })).status).toBe(413);
    expect((await fetch(url + "/api/scheduled-tasks/abc123/pause", { method: "POST",
      headers: { origin: "https://evil.invalid", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-valid-0001" }) })).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });
  it("forwards validated mutation and delete confirmation and disables caching", async () => {
    const { url, request } = await setup({ schemaVersion: 1, supported: true, reachable: true,
      requestId: "request-delete-0001", taskId: "abc123", outcome: "succeeded" });
    const response = await fetch(url + "/api/scheduled-tasks/abc123", { method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-delete-0001", confirmName: "Test task" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(request).toHaveBeenCalledWith({ action: "remove", id: "abc123",
      requestId: "request-delete-0001", confirmName: "Test task" });
  });
  it("distinguishes unsupported frameworks and unavailable bridges", async () => {
    expect(await createScheduledTaskService({ framework: "openclaw" }).request({ action: "list" }))
      .toMatchObject({ supported: false, reachable: false, reason: "unsupported_framework" });
    expect(await createScheduledTaskService({ framework: "hermes" }).request({ action: "list" }))
      .toMatchObject({ supported: true, reachable: false, reason: "bridge_not_configured" });
  });
});
