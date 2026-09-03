/**
 * /api/github-token 端点测试：配置状态查询（绝不回显值）、写入校验、清除，
 * 以及 deps.dataDir 未接线时的 503。文件落在注入的临时数据目录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";
import { tokenFilePath } from "../src/github-token.js";

function makeDeps(dataDir?: string): WatchHttpDeps {
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
    dataDir,
  };
}

describe("startWatchHttp /api/github-token 端点", () => {
  let http: WatchHttp;
  let base: string;
  let tmp: string;

  function boot(dataDir?: string): void {
    http = startWatchHttp(makeDeps(dataDir), { port: 0 });
  }

  afterEach(() => {
    http.close();
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined as unknown as string;
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/github-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("写入 → configured true，且响应与状态查询绝不回显令牌值", async () => {
    tmp = mkdtempSync(join(tmpdir(), "butler-http-github-token-"));
    boot(tmp);
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/api/github-token`)).json()).resolves.toMatchObject({ configured: false });

    const saved = await post({ token: "ghp_super_secret_value" });
    expect(saved.status).toBe(200);
    const savedBody = await saved.text();
    expect(JSON.parse(savedBody)).toEqual({ configured: true });
    expect(savedBody).not.toContain("ghp_super_secret_value");

    const status = await fetch(`${base}/api/github-token`);
    const statusBody = await status.text();
    expect(JSON.parse(statusBody)).toEqual({ configured: true });
    expect(statusBody).not.toContain("ghp_super_secret_value");
    // 值落在注入的数据目录文件里
    expect(JSON.parse(readFileSync(tokenFilePath(tmp), "utf8"))).toEqual({ token: "ghp_super_secret_value" });
  });

  it("clear:true 删除令牌文件并返回 configured false", async () => {
    tmp = mkdtempSync(join(tmpdir(), "butler-http-github-token-"));
    boot(tmp);
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    await post({ token: "ghp_super_secret_value" });
    expect(existsSync(tokenFilePath(tmp))).toBe(true);

    const cleared = await post({ clear: true });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ configured: false });
    expect(existsSync(tokenFilePath(tmp))).toBe(false);
    expect(await (await fetch(`${base}/api/github-token`)).json()).toMatchObject({ configured: false });
  });

  it("token trim 后按 8..200 校验：过短/过长 400，边界值与带空白输入通过", async () => {
    tmp = mkdtempSync(join(tmpdir(), "butler-http-github-token-"));
    boot(tmp);
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;

    expect((await post({ token: "1234567" })).status).toBe(400);
    expect((await post({ token: "  1234567  " })).status).toBe(400);
    expect((await post({ token: "x".repeat(201) })).status).toBe(400);
    expect((await post({ token: "x".repeat(8) })).status).toBe(200);
    expect((await post({ token: "x".repeat(200) })).status).toBe(200);
    expect((await post({ token: "  12345678  " })).status).toBe(200);
    // 存的是 trim 后的值
    expect(JSON.parse(readFileSync(tokenFilePath(tmp), "utf8"))).toEqual({ token: "12345678" });
  });

  it("非 GET/POST → 405；deps.dataDir 未接线 → 503", async () => {
    boot(undefined);
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/github-token`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${base}/api/github-token`)).json()).resolves.toMatchObject({
      error: "github-token-unavailable",
    });
    expect((await post({ token: "12345678" })).status).toBe(503);
    expect((await post({ clear: true })).status).toBe(503);
  });
});
