/**
 * /api/skills-manager/* 端点测试：fake SkillsManagerCli 服务注入。
 * 覆盖：available 两种形态、dry-run（未 confirmed）参数、错误映射 409/503、未接线 503。
 */
import { afterEach, describe, expect, it } from "vitest";
import { SkillsManagerError, SKILLS_MANAGER_INSTALL_HINT, type SkillsManagerCli } from "../src/skills-manager.js";
import { startWatchHttp, type WatchHttp, type WatchHttpDeps } from "../src/http.js";

interface RecordedCall {
  op: string;
  input: unknown;
}

function makeService(overrides: Partial<SkillsManagerCli> = {}): {
  service: SkillsManagerCli;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const service: SkillsManagerCli = {
    cliPath: "/usr/local/bin/skills-manager-cli",
    cliHome: "/tmp/cli-home",
    hermesSkillsDir: "/tmp/hermes/skills",
    run: async () => ({}),
    available: () => true,
    ensureTarget: () => ({ agent: "claude_code", dir: "/tmp/hermes/skills", symlinked: true }),
    status: async () => {
      calls.push({ op: "status", input: null });
      return {
        available: true,
        cli: { path: "/usr/local/bin/skills-manager-cli", version: "v1.36.0" },
        repo: { skill_count: 1 },
        skills: [{ skill_id: "s1", name: "demo" }],
        deployAgent: { key: "claude_code" },
        deployTarget: { agent: "claude_code", dir: "/tmp/hermes/skills", symlinked: true },
      };
    },
    install: async (input) => {
      calls.push({ op: "install", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    deploy: async (input) => {
      calls.push({ op: "deploy", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    undeploy: async (input) => {
      calls.push({ op: "undeploy", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    check: async () => {
      calls.push({ op: "check", input: null });
      return [{ name: "demo", update_status: "up_to_date" }];
    },
    update: async (input) => {
      calls.push({ op: "update", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    remove: async (input) => {
      calls.push({ op: "remove", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    adopt: async (input) => {
      calls.push({ op: "adopt", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    search: async (input) => {
      calls.push({ op: "search", input });
      return [{ name: "demo-skill", install_ref: "github/a/demo-skill", installs: 3 }];
    },
    detail: async (name) => {
      calls.push({ op: "detail", input: name });
      return { show: { name }, status: { name, agents: [] } };
    },
    tags: async (input) => {
      calls.push({ op: "tags", input });
      return { ok: true };
    },
    setSource: async (input) => {
      calls.push({ op: "setSource", input });
      return { ok: true, dry_run: input.confirmed !== true };
    },
    updateAll: async () => {
      calls.push({ op: "updateAll", input: null });
      return { update: { ok: true }, checks: [{ name: "demo", update_status: "up_to_date" }] };
    },
    ...overrides,
  };
  return { service, calls };
}

function makeDeps(skillsManager?: SkillsManagerCli): WatchHttpDeps {
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
    skillsManager,
  };
}

describe("startWatchHttp /api/skills-manager 端点", () => {
  let http: WatchHttp;
  let base: string;

  async function boot(overrides: Partial<SkillsManagerCli> = {}): Promise<{ service: SkillsManagerCli; calls: RecordedCall[] }> {
    const fake = makeService(overrides);
    http = startWatchHttp(makeDeps(fake.service), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  afterEach(() => http.close());

  it("GET status 返回服务视图；服务返回 unavailable 形态时仍 200", async () => {
    const fake = await boot();
    const res = await fetch(`${base}/api/skills-manager/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; repo: { skill_count: number } };
    expect(body.available).toBe(true);
    expect(body.repo.skill_count).toBe(1);
    expect(fake.calls[0]?.op).toBe("status");

    await boot({ status: async () => ({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT }) });
    const degraded = await fetch(`${base}/api/skills-manager/status`);
    expect(degraded.status).toBe(200);
    expect(await degraded.json()).toEqual({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT });
  });

  it("GET updates 转发 check()；POST install 未 confirmed 走 dry-run 预览", async () => {
    const fake = await boot();
    const updates = await fetch(`${base}/api/skills-manager/updates`);
    expect(updates.status).toBe(200);
    expect(await updates.json()).toEqual([{ name: "demo", update_status: "up_to_date" }]);

    const preview = await fetch(`${base}/api/skills-manager/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner/repo", name: "demo" }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()) as { dry_run: boolean }).toMatchObject({ dry_run: true });
    expect(fake.calls.at(-1)).toEqual({
      op: "install",
      input: { source: "owner/repo", name: "demo", confirmed: false },
    });

    const applied = await fetch(`${base}/api/skills-manager/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner/repo", confirmed: true }),
    });
    expect(applied.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({
      op: "install",
      input: { source: "owner/repo", confirmed: true },
    });
  });

  it("deploy/undeploy/update/adopt 透传 confirmed 二段式", async () => {
    const fake = await boot();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await post("/api/skills-manager/deploy", { name: "demo" });
    expect(fake.calls.at(-1)).toEqual({ op: "deploy", input: { name: "demo", confirmed: false } });
    await post("/api/skills-manager/undeploy", { name: "demo", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "undeploy", input: { name: "demo", confirmed: true } });
    await post("/api/skills-manager/update", { name: "demo", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "update", input: { name: "demo", confirmed: true } });
    await post("/api/skills-manager/adopt", { dir: "/home/x/skills", confirmed: true });
    expect(fake.calls.at(-1)).toEqual({ op: "adopt", input: { dir: "/home/x/skills", confirmed: true } });
  });

  it("remove 未 confirmed 走 dry-run 预览，confirmed 透传（服务内部先 undeploy）", async () => {
    const fake = await boot();
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/skills-manager/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const preview = await post({ name: "demo" });
    expect(preview.status).toBe(200);
    expect((await preview.json()) as { dry_run: boolean }).toMatchObject({ dry_run: true });
    expect(fake.calls.at(-1)).toEqual({ op: "remove", input: { name: "demo", confirmed: false } });

    const applied = await post({ name: "demo", confirmed: true });
    expect(applied.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ op: "remove", input: { name: "demo", confirmed: true } });
  });

  it("缺参数返回 400，非 GET/POST 返回 405", async () => {
    await boot();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("/api/skills-manager/install", { name: "x" })).status).toBe(400);
    expect((await post("/api/skills-manager/deploy", {})).status).toBe(400);
    expect((await post("/api/skills-manager/undeploy", { name: "" })).status).toBe(400);
    expect((await post("/api/skills-manager/update", {})).status).toBe(400);
    expect((await post("/api/skills-manager/remove", {})).status).toBe(400);
    expect((await post("/api/skills-manager/adopt", {})).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/status`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/skills-manager/updates`, { method: "POST" })).status).toBe(405);
  });

  it("错误映射：TARGET_CONFLICT → 409，INVALID_ARGUMENT → 400，unavailable → 503 + installHint", async () => {
    await boot({
      deploy: async () => {
        throw new SkillsManagerError("TARGET_CONFLICT", "already deployed elsewhere");
      },
      install: async () => {
        throw new SkillsManagerError("INVALID_ARGUMENT", "bad git url");
      },
      check: async () => {
        throw new SkillsManagerError("skills-manager-unavailable", "cli missing");
      },
      status: async () => {
        throw new SkillsManagerError("deploy-target-conflict", "真实目录占用");
      },
      remove: async () => {
        throw new SkillsManagerError("TARGET_CONFLICT", "deploy target busy");
      },
    });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const conflict = await post("/api/skills-manager/deploy", { name: "demo", confirmed: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "TARGET_CONFLICT", message: "already deployed elsewhere" });

    const removeConflict = await post("/api/skills-manager/remove", { name: "demo", confirmed: true });
    expect(removeConflict.status).toBe(409);
    expect(await removeConflict.json()).toMatchObject({ code: "TARGET_CONFLICT" });

    const invalid = await post("/api/skills-manager/install", { source: "x", confirmed: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_ARGUMENT" });

    const unavailable = await fetch(`${base}/api/skills-manager/updates`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: "skills-manager-unavailable",
      installHint: SKILLS_MANAGER_INSTALL_HINT,
    });

    const targetConflict = await fetch(`${base}/api/skills-manager/status`);
    expect(targetConflict.status).toBe(409);
    expect(await targetConflict.json()).toMatchObject({ code: "deploy-target-conflict" });
  });

  it("未接线服务 → 503 skills-manager-unavailable", async () => {
    http = startWatchHttp(makeDeps(undefined), { port: 0 });
    const address = await http.start();
    base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/skills-manager/status`)).status).toBe(503);
    expect((await fetch(`${base}/api/skills-manager/updates`)).status).toBe(503);
    const res = await fetch(`${base}/api/skills-manager/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "skills-manager-unavailable" });
  });

  it("GET search 透传 query/limit；缺 query 与非法 limit → 400", async () => {
    const fake = await boot();
    const res = await fetch(`${base}/api/skills-manager/search?query=github&limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "demo-skill", install_ref: "github/a/demo-skill", installs: 3 }]);
    expect(fake.calls.at(-1)).toEqual({ op: "search", input: { query: "github", limit: 5 } });

    await fetch(`${base}/api/skills-manager/search?query=demo`);
    expect(fake.calls.at(-1)).toEqual({ op: "search", input: { query: "demo" } });

    expect((await fetch(`${base}/api/skills-manager/search`)).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/search?query=`)).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/search?query=x&limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/search?query=x&limit=abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/search?query=x`, { method: "POST" })).status).toBe(405);
  });

  it("GET skills/:name 返回详情聚合；空 name → 400", async () => {
    const fake = await boot();
    const res = await fetch(`${base}/api/skills-manager/skills/demo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ show: { name: "demo" }, status: { name: "demo", agents: [] } });
    expect(fake.calls.at(-1)).toEqual({ op: "detail", input: "demo" });

    const encoded = await fetch(`${base}/api/skills-manager/skills/${encodeURIComponent("my skill")}`);
    expect(encoded.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ op: "detail", input: "my skill" });
  });

  it("POST tags 校验 action/name/tags；合法输入透传", async () => {
    const fake = await boot();
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/skills-manager/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await post({ action: "add", name: "demo", tags: [" 运维 ", "prod", " "] });
    expect(res.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ op: "tags", input: { action: "add", name: "demo", tags: ["运维", "prod"] } });

    expect((await post({ action: "delete", name: "demo", tags: ["x"] })).status).toBe(400);
    expect((await post({ action: "add", name: "", tags: ["x"] })).status).toBe(400);
    expect((await post({ action: "add", name: "demo", tags: [] })).status).toBe(400);
    expect((await post({ action: "add", name: "demo", tags: "prod" })).status).toBe(400);
    expect((await fetch(`${base}/api/skills-manager/tags`)).status).toBe(405);
  });

  it("POST set-source 二段式透传 subpath/branch/force；缺 name/gitUrl → 400", async () => {
    const fake = await boot();
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/skills-manager/set-source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const preview = await post({ name: "demo", gitUrl: "owner/repo" });
    expect(preview.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ op: "setSource", input: { name: "demo", gitUrl: "owner/repo", force: false, confirmed: false } });

    const applied = await post({ name: "demo", gitUrl: "https://github.com/a/b.git", subpath: "skills/x", branch: "main", force: true, confirmed: true });
    expect(applied.status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({
      op: "setSource",
      input: { name: "demo", gitUrl: "https://github.com/a/b.git", subpath: "skills/x", branch: "main", force: true, confirmed: true },
    });

    expect((await post({ name: "", gitUrl: "x" })).status).toBe(400);
    expect((await post({ name: "demo" })).status).toBe(400);
  });

  it("批量 names：串行执行、单项失败聚合 ok:false、整体 200；空/超限/adopt → 400", async () => {
    const calls2: string[] = [];
    await boot({
      undeploy: async (input) => {
        calls2.push(input.name);
        if (input.name === "bad") throw new SkillsManagerError("TARGET_CONFLICT", "busy");
        return { ok: true };
      },
    });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const batch = await post("/api/skills-manager/undeploy", { names: ["a", "b", "bad"], confirmed: true });
    expect(batch.status).toBe(200);
    const body = (await batch.json()) as { batch: boolean; results: Array<{ name: string; ok: boolean; result?: unknown; error?: { code: string } }> };
    expect(body.batch).toBe(true);
    expect(body.results.map((item) => [item.name, item.ok])).toEqual([["a", true], ["b", true], ["bad", false]]);
    expect(body.results[2]!.error).toMatchObject({ code: "TARGET_CONFLICT" });
    expect(calls2).toEqual(["a", "b", "bad"]);

    expect((await post("/api/skills-manager/deploy", { names: [] })).status).toBe(400);
    expect((await post("/api/skills-manager/deploy", { names: ["  "] })).status).toBe(400);
    expect((await post("/api/skills-manager/adopt", { names: ["a"] })).status).toBe(400);
    expect((await post("/api/skills-manager/deploy", { names: Array.from({ length: 101 }, (_, i) => `s${i}`) })).status).toBe(400);
  });

  it("update { all:true } 走 updateAll（update --all + check --all）", async () => {
    const fake = await boot();
    const res = await fetch(`${base}/api/skills-manager/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ update: { ok: true }, checks: [{ name: "demo", update_status: "up_to_date" }] });
    expect(fake.calls.at(-1)).toEqual({ op: "updateAll", input: null });
  });

  it("install sourceType 白名单透传；非法值按缺省处理", async () => {
    const fake = await boot();
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/skills-manager/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post({ source: "github/a/b", sourceType: "skills", confirmed: true });
    expect(fake.calls.at(-1)).toMatchObject({ op: "install", input: { source: "github/a/b", sourceType: "skills", confirmed: true } });
    await post({ source: "owner/repo", sourceType: "bogus", confirmed: true });
    expect(fake.calls.at(-1)).toMatchObject({ op: "install", input: { source: "owner/repo", confirmed: true } });
  });
});
