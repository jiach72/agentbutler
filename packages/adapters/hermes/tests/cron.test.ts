import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HermesCronClient } from "../src/cron.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function client(response: unknown, status = 200) {
  const root = mkdtempSync(join(tmpdir(), "cron-client-")); roots.push(root);
  const tokenFile = join(root, "token"); writeFileSync(tokenFile, "PRIVATE_TOKEN");
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status }));
  return { api: new HermesCronClient({ baseUrl: "http://bridge", tokenFile, fetchImpl }), fetchImpl };
}
const summary = { id: "abc123", name: "Test task", enabled: true, scheduleLabel: "every 30m", nextRunAt: null,
  lastRunAt: null, lastStatus: "never", failureStreak: 0, deliveryEnabled: false, editable: true };
describe("Hermes cron client", () => {
  it("sends fixed action to the control bridge and strips unknown response fields", async () => {
    const { api, fetchImpl } = client({ schemaVersion: 1, supported: true, reachable: true,
      items: [{ ...summary, prompt: "SECRET_PROMPT", base_url: "SECRET_URL" }], token: "SECRET_TOKEN" });
    const result = await api.request({ action: "list" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result).toMatchObject({ reachable: true, items: [summary] });
    expect(fetchImpl).toHaveBeenCalledWith("http://bridge/v1/cron", expect.objectContaining({
      method: "POST", redirect: "error", body: '{"action":"list"}',
      headers: { authorization: "Bearer PRIVATE_TOKEN", "content-type": "application/json" },
    }));
  });
  it.each([
    { schemaVersion: 1, supported: true, reachable: true, items: [{ ...summary, enabled: "yes" }] },
    { schemaVersion: 1, supported: true, reachable: true, items: [{ ...summary, failureStreak: -1 }] },
    { schemaVersion: 1, supported: true, reachable: true, items: [{ ...summary, nextRunAt: "tomorrow" }] },
    { schemaVersion: 2, supported: true, reachable: true, items: [] },
  ])("rejects malformed structured output", async (response) => {
    expect(await client(response).api.request({ action: "list" })).toMatchObject({ reachable: false, reason: "invalid_response" });
  });
  it("does not retry a timed-out write or expose the exception", async () => {
    const { api, fetchImpl } = client({});
    fetchImpl.mockRejectedValue(new Error("SECRET_PROMPT"));
    const result = await api.request({ action: "pause", id: "abc123", requestId: "request-timeout-01" });
    expect(result).toMatchObject({ outcome: "unknown", reason: "bridge_unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("rejects wrong request identities and never treats HTTP failure as success", async () => {
    const input = { action: "pause" as const, id: "abc123", requestId: "request-mismatch-01" };
    const response = { schemaVersion: 1, supported: true, reachable: true, requestId: input.requestId,
      outcome: "succeeded", taskId: "abc123" };
    expect(await client({ ...response, requestId: "request-other-0001" }).api.request(input)).toMatchObject({ outcome: "unknown" });
    expect(await client(response, 503).api.request(input)).toMatchObject({ outcome: "unknown" });
  });
  it("maps 401/403 to unauthorized and 503 token_unavailable to token_unavailable", async () => {
    const listInput = { action: "list" as const };
    expect(await client({ error: "unauthorized" }, 401).api.request(listInput)).toMatchObject({
      reachable: false, reason: "unauthorized",
    });
    expect(await client({ error: "forbidden" }, 403).api.request(listInput)).toMatchObject({
      reachable: false, reason: "unauthorized",
    });
    expect(await client({ error: "token_unavailable" }, 503).api.request(listInput)).toMatchObject({
      reachable: false, reason: "token_unavailable",
    });
  });
});
