import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_SIGNAL_CHECK_ID,
  DASHBOARD_UNREACHABLE_NOTE,
  probeDashboardSignal,
  type FetchLike,
  type ResponseLike,
} from "../src/dashboard-signal.js";

let tmp: string;
let fetchCalls: Array<{ url: string; method?: string }>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "watch-dashboard-"));
  fetchCalls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 写 config.yaml；withDashboard=false 时省略 dashboard 段。 */
function writeConfig(withDashboard: boolean): void {
  const lines = ["platforms:", "  api_server:", "    extra:", '      host: "127.0.0.1"', "      port: 18642"];
  if (withDashboard) lines.push("dashboard:", "  port: 9119");
  writeFileSync(join(tmp, "config.yaml"), [...lines, ""].join("\n"));
}

function jsonResponse(body: unknown, status = 200): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function recordFetch(response: () => Promise<ResponseLike> = async () => jsonResponse({})): FetchLike {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method });
    return await response();
  };
}

describe("probeDashboardSignal", () => {
  it("未启用 dashboard（config 无 dashboard 段）→ 不发起请求、无信号", async () => {
    writeConfig(false);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: recordFetch(),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(outcome.check).toBeUndefined();
    expect(outcome.confidenceDelta).toBe(0);
  });

  it("config.yaml 缺失 → 不发起请求", async () => {
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: recordFetch(),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(outcome.confidenceDelta).toBe(0);
  });

  it("可达：200 JSON → 补充信号 pass、detail 取顶层键值子集、不降置信", async () => {
    writeConfig(true);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: recordFetch(async () =>
        jsonResponse({ status: "ok", version: "0.20.4", uptime_sec: 120, healthy: true, nested: { x: 1 }, list: [1] }),
      ),
    });
    expect(fetchCalls).toEqual([{ url: "http://127.0.0.1:9119/api/status", method: "GET" }]);
    expect(outcome.confidenceDelta).toBe(0);
    expect(outcome.check).toBeDefined();
    expect(outcome.check!.id).toBe(DASHBOARD_SIGNAL_CHECK_ID);
    expect(outcome.check!.status).toBe("pass");
    expect(outcome.check!.detail).toContain("status=ok");
    expect(outcome.check!.detail).toContain("version=0.20.4");
    expect(outcome.check!.detail).toContain("healthy=true");
    // 嵌套对象与数组不进入 detail
    expect(outcome.check!.detail).not.toContain("nested");
  });

  it("不可达（fetch reject）→ confidence -0.1、note 说明、检查项无 fail", async () => {
    writeConfig(true);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(outcome.confidenceDelta).toBe(-0.1);
    expect(outcome.note).toBe(DASHBOARD_UNREACHABLE_NOTE);
    expect(outcome.check!.status).toBe("skipped");
    expect(outcome.check!.detail).toContain(DASHBOARD_UNREACHABLE_NOTE);
  });

  it("HTTP 500 → 按不可达处理（不判故障）", async () => {
    writeConfig(true);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: recordFetch(async () => jsonResponse({ error: "boom" }, 500)),
    });
    expect(outcome.confidenceDelta).toBe(-0.1);
    expect(outcome.check!.status).toBe("skipped");
    expect(outcome.check!.detail).toContain("HTTP 500");
  });

  it("响应非 JSON → 按不可达处理", async () => {
    writeConfig(true);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
    });
    expect(outcome.confidenceDelta).toBe(-0.1);
    expect(outcome.check!.status).toBe("skipped");
  });

  it("超时（默认注入 AbortSignal）→ 按不可达处理", async () => {
    writeConfig(true);
    const outcome = await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119",
      timeoutMs: 20,
      fetchFn: (url, init) =>
        new Promise<ResponseLike>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        }),
    });
    expect(outcome.confidenceDelta).toBe(-0.1);
    expect(outcome.check!.status).toBe("skipped");
  });

  it("dashboardUrl 尾斜杠被归一", async () => {
    writeConfig(true);
    await probeDashboardSignal({
      rootPath: tmp,
      dashboardUrl: "http://127.0.0.1:9119/",
      fetchFn: recordFetch(),
    });
    expect(fetchCalls[0]!.url).toBe("http://127.0.0.1:9119/api/status");
  });
});
