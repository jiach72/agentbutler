import { afterEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

function makeDeps(renderDiagnostics?: () => Promise<string>): WatchHttpDeps {
  return {
    scheduler: {
      runNow: () => true,
      status: () => ({ lastAt: null, nextAt: null, intervalMin: 60, inFlight: false }),
    },
    runbooks: () => [],
    executeRunbook: async () => ({ status: "no-servicing-instance" }),
    upgrade: {
      startUpgrade: () => ({ status: "missing-target-version" }),
      status: () => null,
      listVersions: async () => ({ reachable: false, versions: [] }),
      rollbackSnapshot: async () => ({ status: "snapshot-not-found" }),
    },
    gateway: {
      stats: async () => ({ overall: "ok", totalEvents: 0, last24h: 0, matched: [], suggestions: [] }),
      patches: async () => [],
      applyPatch: async () => ({ status: "unknown-patch" }),
      reapplyPatch: async () => ({ status: "unknown-patch" }),
      detectPatch: async () => ({ status: "unknown-patch" }),
    },
    renderDiagnostics,
  };
}

describe("startWatchHttp 诊断报告端点", () => {
  let http: WatchHttp;
  let base: string;

  afterEach(() => http.close());

  it("未接线时返回 503", async () => {
    http = startWatchHttp(makeDeps(), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/diagnostics/report`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostics-unavailable" });
  });

  it("GET 返回 markdown 附件，POST 返回 405", async () => {
    http = startWatchHttp(
      makeDeps(async () => "# Agent Butler 诊断报告\n\n- 脱敏示例\n"),
      { port: 0 },
    );
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/diagnostics/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toContain("attachment; filename=\"agent-butler-diagnostic-");
    await expect(response.text()).resolves.toContain("# Agent Butler 诊断报告");

    const post = await fetch(`${base}/api/diagnostics/report`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
