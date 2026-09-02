/**
 * 技能库管理器（skills-manager）代理测试：status/updates 读取与五个写动作透传，
 * watch 不可达时的降级形态。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/server";
import { makeTempDir, makeUiDist, rmTempDir } from "./helpers";

const WATCH_URL = "http://127.0.0.1:7533";

interface RecordedCall {
  path: string;
  init: RequestInit | undefined;
}

function makeFetch(
  respond: (path: string) => { body: unknown; status?: number } | null,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fake: typeof fetch = async (input, init) => {
    const path = String(input).replace(WATCH_URL, "");
    calls.push({ path, init });
    const res = respond(path);
    if (res === null) throw new Error("watch offline");
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fake, calls };
}

describe("butler-web 技能库管理器代理", () => {
  let tmp: string;
  let uiDist: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    tmp = makeTempDir();
    uiDist = makeUiDist(tmp);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    rmTempDir(tmp);
  });

  function build(fetchImpl: typeof fetch): FastifyInstance {
    const app = createWebServer({ home: tmp, uiDist, watchUrl: WATCH_URL, fetchImpl });
    apps.push(app);
    return app;
  }

  it("GET status/updates 透传 watch 响应", async () => {
    const transport = makeFetch((path) => {
      if (path === "/api/skills-manager/status") {
        return {
          body: {
            available: true,
            cli: { version: "v1.36.0" },
            repo: { skill_count: 2 },
            skills: [{ skill_id: "s1", name: "demo" }],
            deployTarget: { agent: "claude_code", dir: "/hermes/skills", symlinked: true },
          },
        };
      }
      if (path === "/api/skills-manager/updates") {
        return { body: [{ name: "demo", update_status: "up_to_date" }] };
      }
      return null;
    });
    const app = build(transport.fetch);

    const status = await app.inject({ method: "GET", url: "/api/skills-manager/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ available: true, repo: { skill_count: 2 } });

    const updates = await app.inject({ method: "GET", url: "/api/skills-manager/updates" });
    expect(updates.statusCode).toBe(200);
    expect(updates.json()).toEqual([{ name: "demo", update_status: "up_to_date" }]);

    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/skills-manager/status",
      "/api/skills-manager/updates",
    ]);
  });

  it("POST 写动作透传请求体与 watch 语义", async () => {
    const transport = makeFetch((path) => {
      if (path.startsWith("/api/skills-manager/")) {
        const action = path.replace("/api/skills-manager/", "");
        if (action === "install") return { body: { ok: true, skill_id: "s1", dry_run: false } };
        if (action === "deploy") return { body: { ok: true, action: "deploy", changed_pairs: 1 } };
        if (action === "undeploy") return { body: { ok: true, action: "undeploy" } };
        if (action === "update") return { body: { ok: true, action: "update" } };
        if (action === "adopt") return { body: { ok: true, adopted: [] } };
      }
      return null;
    });
    const app = build(transport.fetch);
    const post = (url: string, body: unknown): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> =>
      app.inject({ method: "POST", url, payload: body as Record<string, unknown> });

    const install = await post("/api/skills-manager/install", { source: "owner/repo", confirmed: true });
    expect(install.statusCode).toBe(200);
    expect(install.json()).toMatchObject({ ok: true, skill_id: "s1" });

    for (const action of ["deploy", "undeploy", "update", "adopt"] as const) {
      const res = await post(`/api/skills-manager/${action}`, { name: "demo", confirmed: true });
      expect(res.statusCode).toBe(200);
    }
    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/skills-manager/install",
      "/api/skills-manager/deploy",
      "/api/skills-manager/undeploy",
      "/api/skills-manager/update",
      "/api/skills-manager/adopt",
    ]);
    const installInit = transport.calls[0]?.init;
    expect(String(installInit?.body)).toContain('"confirmed":true');
  });

  it("watch 不可达：GET 降级 503 { available:false }，POST 降级 502 watch-unreachable", async () => {
    const offline: typeof fetch = async () => {
      throw new Error("watch offline");
    };
    const app = build(offline);

    const status = await app.inject({ method: "GET", url: "/api/skills-manager/status" });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toMatchObject({ available: false });

    const updates = await app.inject({ method: "GET", url: "/api/skills-manager/updates" });
    expect(updates.statusCode).toBe(503);
    expect(updates.json()).toMatchObject({ available: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills-manager/install",
      payload: { source: "owner/repo" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "watch-unreachable" });
  });
});
